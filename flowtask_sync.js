/*
 * FlowTask 共享盘同步引擎（零依赖，仅用 Node 内置模块）
 * ----------------------------------------------------------------
 * 定位：本地优先。本机数据永远先落在 DATA_DIR，共享盘只是镜像仓库。
 *       未配置 FLOWTASK_SHARE_DIR 时本引擎完全惰性（enabled=false），
 *       服务端行为与没有这个文件时一模一样——这既是回滚开关也是灰度开关。
 *
 * 目录契约（与《局域网多用户升级方案.md》一致）：
 *   <SHARE>\team\flowtask_auth.json        账户总表
 *   <SHARE>\team\flowtask_shared.json      团队共享库
 *   <SHARE>\users\<uid>\flowtask_data_<uid>.json   每人一份，唯一写者就是本人
 *   <SHARE>\locks\                          跨机锁（独占创建 + 超时抢占）
 *   <SHARE>\conflict\                       真冲突时双方留底
 *
 * 三条不容妥协的规则：
 *   1) 共享盘「读不到」分两种：ENOENT = 这份数据还不存在（可以推）；
 *      其它错误（网络断开 / 无权限 / 超时）= 不知道对面是什么，一律不动，绝不覆盖。
 *   2) 版本比 meta.rev，高者胜；rev 相同但内容哈希不同 = 真冲突 → 双方都复制到 conflict\
 *      再按 meta.lastSaved 定胜负。任何情况下不静默丢数据。
 *   3) 写 team\ 下任何文件前先抢 locks\<name>.lock；超过 60s 视为持锁进程已死可抢占。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const MERGE = require('./flowtask_merge.js');

const LOCK_TTL_MS = 60 * 1000;
const PUSH_DEBOUNCE_MS = 3000;
const AUTH_NAME = 'flowtask_auth.json';
const SHARED_NAME = 'flowtask_shared.json';
/* 个人库文件名 → uid。负向前瞻排除冲突副本/损坏隔离件：
   服务端把 flowtask_data_<uid>_conflict_<ts>.json 与 _corrupt_ 留底写在同一目录，
   不排除会被误认成 uid → 共享盘出现幽灵 users\ 目录、留底文件被推上盘。 */
const PERSONAL_RE = /^flowtask_data_(?!conflict_|corrupt_|.*_conflict_|.*_corrupt_)([a-z0-9_\-]{1,64})\.json$/i;

function hashOf(text){ return crypto.createHash('sha1').update(text).digest('hex'); }
function ensureDir(d){ try{ fs.mkdirSync(d, { recursive: true }); }catch(e){ if(e && e.code !== 'EEXIST') throw e; } }
function atomicWriteText(to, text){
  ensureDir(path.dirname(to));
  const tmp = to + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, to);            // 已实测：SMB 上覆盖式改名可用
}

/* 读文件并区分「不存在」与「读不了」——这条区分是防覆盖事故的关键
   （与 PowerShell 版 Read-OrMissing 保持一致：目录占位一律算「读不了」，不是「没有」） */
function readOrMissing(f){
  try{
    if(fs.existsSync(f) && fs.statSync(f).isDirectory()) return { ok:false, err:'is-a-directory' };
    return { ok:true, text: fs.readFileSync(f, 'utf8') };
  }
  catch(e){
    if(e && e.code === 'ENOENT') return { ok:true, text: null };
    return { ok:false, err: (e && e.code) || 'read error' };
  }
}
function metaOf(text){
  if(text === null || text === undefined) return { absent: true };
  try{
    const j = JSON.parse(text);
    if(!j || typeof j !== 'object') return { bad: true };
    return { rev: Number(j.meta && j.meta.rev) || 0, lastSaved: Number(j.meta && j.meta.lastSaved) || 0, hash: hashOf(text) };
  }catch(e){ return { bad: true }; }
}

/* ---------- 纯决策函数（单测直接打这里，不碰文件系统） ----------
   L / S：{absent:true} 表示该侧没有这份文件；{bad:true} 表示内容坏了；否则 {rev,lastSaved,hash}
   返回：noop | pull | push | conflict-push | conflict-pull | hold | invalid-local | invalid-remote */
function decideAction(L, S){
  if(L && L.absent && S && S.absent) return 'noop';
  if(L && L.bad) return 'invalid-local';          // 本地坏了：既不推也不拉，等人工/备份恢复
  if(S && S.bad) return 'invalid-remote';         // 共享盘那份坏了：不覆盖它，也不拉回来炸自己
  if(L && L.absent) return 'pull';                // 新电脑首次登录 → 从共享盘拉回个人库
  if(S && S.absent) return 'push';                // 共享盘还没有这份 → 推上去建立基线
  const lr = L.rev || 0, sr = S.rev || 0;
  if(lr > sr) return 'push';
  if(lr < sr) return 'pull';
  if(lr === sr && L.hash === S.hash) return 'noop';
  /* 同版本不同内容 = 真冲突：谁写得晚谁赢，但两边都先留底 */
  return (L.lastSaved >= S.lastSaved) ? 'conflict-push' : 'conflict-pull';
}

/* 本地文件名 → 共享盘目标路径；返回 null 表示这份文件不参与同步（如旧版单文件） */
function sharePathOf(shareDir, name){
  if(!shareDir) return null;
  if(name === AUTH_NAME || name === SHARED_NAME) return path.join(shareDir, 'team', name);
  const m = PERSONAL_RE.exec(name);
  if(m) return path.join(shareDir, 'users', m[1], name);
  return null;
}
function teamUidOf(name){ const m = PERSONAL_RE.exec(name); return m ? m[1] : null; }

/* ---------- 跨机锁 ---------- */
function acquireLock(shareDir, name, owner){
  const dir = path.join(shareDir, 'locks');
  ensureDir(dir);
  const f = path.join(dir, name + '.lock');
  const body = JSON.stringify({ owner, host: os.hostname(), pid: process.pid, ts: Date.now() });
  for(let attempt = 0; attempt < 2; attempt++){
    try{ fs.writeFileSync(f, body, { flag: 'wx' }); return { ok:true, file: f }; }   // 独占创建
    catch(e){
      if(e && e.code === 'EEXIST'){
        let stale = true;
        try{ const j = JSON.parse(fs.readFileSync(f, 'utf8')); stale = !j || !j.ts || (Date.now() - Number(j.ts) > LOCK_TTL_MS); }
        catch(_e){ stale = true; }                                                    // 读不懂的锁当过期处理
        if(!stale) return { ok:false, err:'locked' };
        try{ fs.rmSync(f, { force: true }); }catch(_e){ return { ok:false, err:'lock-stuck' }; }
        continue;                                                                     // 抢下过期锁，再试一次
      }
      return { ok:false, err: e.code || 'lock error' };
    }
  }
  return { ok:false, err:'locked' };
}
function releaseLock(lk){ if(lk && lk.file){ try{ fs.rmSync(lk.file, { force: true }); }catch(_e){} } }

/* ---------- 共享盘目录校验 ----------
   必须「已经存在的目录 + 写得动」，引擎绝不为它创建根目录。
   原因很实际：路径打错时若自动 mkdir，数据会静默落进一个谁都不知道的空目录，
   而界面还显示「已同步」——那是最坏的一种假象（用户以为资料在共享盘上）。 */
function checkShare(dir, probeName){
  if(!dir) return { ok:false, reason:'未配置共享盘目录' };
  let st = null;
  try{ st = fs.statSync(dir); }
  catch(e){ return { ok:false, reason:'目录不存在或共享盘不可达（' + ((e && e.code) || 'error') + '）——请核对 UNC 路径，或先在资源管理器里打开一次该共享' }; }
  if(!st.isDirectory()) return { ok:false, reason:'这个路径不是目录' };
  const probe = path.join(dir, probeName || '.flowtask-write-probe');
  try{
    fs.writeFileSync(probe, 'ok', { flag:'wx' });
    try{ fs.rmSync(probe, { force: true }); }catch(_e){}
  }catch(e){
    if(e && e.code === 'EEXIST') return { ok:true, reason:'' };        // 别人的探针还在 → 说明写得动
    return { ok:false, reason:'这个目录写不进去（' + ((e && e.code) || 'error') + '）——请检查共享盘的写入权限' };
  }
  return { ok:true, reason:'' };
}

/* ---------- 引擎 ---------- */
function create(opts){
  const o = opts || {};
  const dataDir = o.dataDir;
  /* shareDir / enabled 可变：界面里改了同步文件夹要能立刻生效，不必重启服务 */
  let shareDir = String(o.shareDir || '').trim();
  let enabled = !!shareDir;
  const log = o.log || (() => {});
  const now = o.now || (() => Date.now());
  const stateFile = path.join(dataDir, 'flowtask_sync.json');
  const timers = new Map();                 // name -> Timeout
  let inFlight = false;
  /* 启动时先校验一次；不通过也保持 enabled（共享盘可能只是暂时没连上），
     但把原因记下来供界面显示，并在每次同步前复查根目录是否存在 */
  let blockReason = '';
  function recheck(){
    blockReason = '';
    if(shareDir){
      const chk = checkShare(shareDir);
      if(!chk.ok) blockReason = chk.reason;
    }
    state.blockReason = blockReason;
    state.reachable = !blockReason;
    if(blockReason) state.lastError = blockReason;
  }
  function rootOk(){
    if(!shareDir) return false;
    try{ return fs.statSync(shareDir).isDirectory(); }catch(e){ return false; }
  }
  /* 拉取会改写本地文件：服务端那份 rev/hash 缓存必须作废，
     否则下一次客户端推送会拿旧指纹比，产生假冲突或漏判真冲突 */
  const onLocalChanged = typeof o.onLocalChanged === 'function' ? o.onLocalChanged : (() => {});
  function localChanged(name){ try{ onLocalChanged(name); }catch(e){ log('⚠️ 同步回调异常：' + (e && e.message)); } }

  let state = { files: {}, lastError: '', lastErrorAt: 0, lastSyncAt: 0, reachable: true, blockReason: '' };
  function loadState(){
    try{
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if(j && typeof j === 'object'){
        const fresh = j.files || {};
        Object.assign(state, j);
        state.files = fresh;
        /* 这三项一律以「本次启动的实测结果」为准，不能被上次留下的值覆盖，
           否则共享盘修好了界面还在报旧错，或者反过来假装正常 */
        state.blockReason = blockReason;
        state.reachable = !blockReason;
        if(blockReason) state.lastError = blockReason;
      }
    }catch(_e){ /* 首次或读不到：用默认值 */ }
  }
  function saveState(){
    try{ atomicWriteText(stateFile, JSON.stringify(state, null, 2)); }
    catch(e){ log('⚠️ 同步状态写入失败：' + (e && e.message)); }
  }
  recheck(); loadState();

  function noteError(err){
    state.lastError = String(err || ''); state.lastErrorAt = now(); state.reachable = false; saveState();
  }
  function noteOk(){
    state.reachable = true; state.lastSyncAt = now();
    if(state.blockReason){ state.blockReason = ''; state.lastError = ''; log('ℹ️ 共享盘已恢复可写，同步继续'); }
    saveState();
  }

  /* 冲突留底：双方各存一份，文件名带时间戳与方向 */
  function stashConflict(name, localText, remoteText){
    try{
      const dir = path.join(shareDir, 'conflict');
      ensureDir(dir);
      const p = n => path.join(dir, name.replace(/\.json$/, '') + '_' + n + '_' + stamp() + '.json');
      const out = [];
      if(localText !== null && localText !== undefined){ atomicWriteText(p('local'), localText); out.push(path.basename(p('local'))); }
      if(remoteText !== null && remoteText !== undefined){ atomicWriteText(p('remote'), remoteText); out.push(path.basename(p('remote'))); }
      return out;
    }catch(e){ log('⚠️ 冲突留底失败：' + (e && e.message)); return []; }
  }
  function stamp(){
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /* 单份文件的一次同步。
     mode 只用于记录调用来源（'boot' | 'login' | 'push' | 'pull' | 'manual'），
     不改变方向判断——方向永远由 decideAction 的版本规则决定。
     曾经用 mode 压制过方向，结果冲突留底也被一起压掉，等于静默丢数据，已废。 */
  function syncFile(name, mode){
    const target = sharePathOf(shareDir, name);
    if(!target) return { name, action: 'ignored' };
    const localFile = path.join(dataDir, name);
    const lockNeeded = name === AUTH_NAME || name === SHARED_NAME;

    const lr = readOrMissing(localFile);
    if(!lr.ok){ return { name, action: 'hold', err: 'local-read:' + lr.err }; }
    /* 根目录不在（路径打错 / 共享盘没连）时绝不 writes：
       否则 ensureDir 会把打错的路径凭空造出来，数据静默落进没人知道的空目录 */
    if(!rootOk()){
      const why = '共享盘目录不存在或不可达：' + shareDir;
      blockReason = why; state.blockReason = why;
      noteError(why);
      return { name, action: 'hold', err: 'share-root-missing' };
    }
    const rr = readOrMissing(target);
    if(!rr.ok){                                                              // 不知道对面是什么 → 绝不动
      noteError(name + ' share-read:' + rr.err);
      return { name, action: 'hold', err: 'share-read:' + rr.err };
    }

    /* 三路合并：双方都相对「共同祖先」改过 → 按实体合并，而不是整片二选一。
       没有基线（刚升级到本功能、或第一次见这份文件）时沿用版本号规则，
       并在成功后落下基线 —— 所以这条路径是渐进生效的，不需要迁移任何历史数据。
       注意基线文件是 {writtenAt,text} 包装，必须解包后再比，否则外层判断与
       合并内部的判断口径不一致，会误判成「需要合并」又立刻跳过，结果谁都不写。 */
    const baseFile = path.join(dataDir, name + '.base.json');
    const baseText = readBaseText(baseFile);
    if(MERGE.needsMerge(baseText, lr.text, rr.text)){
      return mergeRound({ name, mode, lockNeeded, baseFile, localFile, target });
    }

    const action = decideAction(metaOf(lr.text), metaOf(rr.text));
    const rec = state.files[name] = state.files[name] || {};
    rec.lastMode = mode || 'auto';
    if(action === 'noop' || action === 'ignored' || action === 'hold') return { name, action };
    if(action === 'invalid-local' || action === 'invalid-remote'){
      rec.lastResult = action; noteError(name + ' ' + action);
      return { name, action, err: action };
    }

    /* 真冲突：先双方留底，再定胜负。这一步必须在任何方向判断之前，且不受 mode 影响 */
    const isConflict = action === 'conflict-push' || action === 'conflict-pull';
    const conflicts = isConflict ? stashConflict(name, lr.text, rr.text) : [];
    const doPush = action === 'push' || action === 'conflict-push';
    if(isConflict){ rec.lastConflict = (rec.lastConflict || 0) + conflicts.length; }

    let lk = null;
    let done = false;
    if(lockNeeded){
      lk = acquireLock(shareDir, name, doPush ? (teamUidOf(name) || 'team') : 'puller');
      if(!lk.ok){ rec.lastResult = 'locked'; saveState(); return { name, action: 'locked', err: lk.err }; }
    }
    try{
      if(doPush){
        /* 推之前复核一次远端：拿锁期间可能又有人写过（锁不是万能，复核更稳） */
        const check = readOrMissing(target);
        if(!check.ok){ rec.lastResult = 'hold'; return { name, action: 'hold', err: 'share-read:' + check.err }; }
        const decided = decideAction(metaOf(lr.text), metaOf(check.text));
        if(decided === 'pull' || decided === 'conflict-pull'){
          /* 远端更新：这次不推，改成把对方的版本拉下来，避免用旧数据盖掉新数据 */
          if(check.text !== null){ atomicWriteText(localFile, check.text); localChanged(name); }
          rec.lastResult = 'pull-instead'; rec.lastPullAt = now(); rec.lastPullRev = metaOf(check.text).rev || 0;
          done = true; noteOk();
          return { name, action: 'pull', rev: rec.lastPullRev, note: 'recheck' };
        }
        atomicWriteText(target, lr.text);
        writeBase(name, baseFile, lr.text);                            // 盘上现在就是我这份 → 它就是新的共同祖先
        rec.lastPushAt = now(); rec.lastPushRev = metaOf(lr.text).rev || 0; rec.lastResult = 'push';
        done = true; noteOk();
        return { name, action: 'push', rev: rec.lastPushRev, conflicts };
      }
      /* 拉：共享盘那份覆盖本地 */
      if(rr.text === null){ rec.lastResult = 'noop'; return { name, action: 'noop' }; }
      atomicWriteText(localFile, rr.text);
      localChanged(name);
      writeBase(name, baseFile, rr.text);                              // 拉完两边一致 → 记为新的共同祖先
      rec.lastPullAt = now(); rec.lastPullRev = metaOf(rr.text).rev || 0; rec.lastResult = 'pull';
      done = true; noteOk();
      return { name, action: 'pull', rev: rec.lastPullRev, conflicts };
    }catch(e){
      rec.lastResult = 'error';
      noteError(name + ' ' + ((e && e.code) || (e && e.message) || 'sync error'));
      return { name, action: 'error', err: (e && e.code) || (e && e.message) || 'sync error' };
    }finally{
      releaseLock(lk);
      if(done || rec.lastResult === 'error' || rec.lastResult === 'pull-instead' || rec.lastResult === 'locked') saveState();
    }
  }

  /* 基线只存本机 DATA_DIR，绝不上共享盘：盘上没有协调者，合并只能在每台客户端各自算 */
  function writeBase(name, baseFile, text){
    try{ atomicWriteText(baseFile, JSON.stringify({ writtenAt: now(), text })); }
    catch(e){ log('⚠️ 合并基线写入失败（下次同步退回版本号规则）：' + (e && e.message)); }
  }
  function readBaseText(baseFile){
    const r = readOrMissing(baseFile);
    if(!r.ok || r.text === null) return null;
    try{ const j = JSON.parse(r.text); return typeof j.text === 'string' ? j.text : null; }catch(e){ return null; }
  }

  /* 一次合并：拿到锁后重读远端（可能又被人改过），合并结果同时写本机、共享盘与基线。
     有无法自动裁决的分歧时，整包留底到 conflict\，界面也明确告知。 */
  function mergeRound(ctx){
    const { name, mode, lockNeeded, baseFile, localFile, target } = ctx;
    const rec = state.files[name] = state.files[name] || {};
    rec.lastMode = mode || 'merge';
    let lk = null, done = false;
    if(lockNeeded){
      lk = acquireLock(shareDir, name, 'merger');
      if(!lk.ok){ rec.lastResult = 'locked'; saveState(); return { name, action: 'locked', err: lk.err }; }
    }
    try{
      const mine = readOrMissing(localFile);
      const theirs0 = readOrMissing(target);
      if(!mine.ok || !theirs0.ok){
        const err = !mine.ok ? ('local-read:' + mine.err) : ('share-read:' + theirs0.err);
        noteError(name + ' ' + err);
        return { name, action: 'hold', err };
      }
      const baseText = readBaseText(baseFile);
      if(!MERGE.needsMerge(baseText, mine.text, theirs0.text)){
        /* 拿锁期间对方又同步过、或本地已被别的请求改掉：这次不用合并，交给下一轮常规判断 */
        rec.lastResult = 'merge-skipped';
        return { name, action: 'noop', note: 'merge-not-needed' };
      }
      let merged, conflicts;
      try{
        const r = MERGE.mergeStores(JSON.parse(baseText), JSON.parse(mine.text), JSON.parse(theirs0.text));
        merged = JSON.stringify(r.merged); conflicts = r.conflicts;
      }catch(e){
        noteError(name + ' merge-failed:' + ((e && e.message) || e));
        rec.lastResult = 'merge-failed';
        return { name, action: 'error', err: 'merge-failed' };
      }
      /* 合并结果对三方都"更新"：本机、共享盘、基线同时落成同一份，两边下一次都比出"没改动" */
      atomicWriteText(localFile, merged); localChanged(name);
      atomicWriteText(target, merged);
      writeBase(name, baseFile, merged);
      const files = conflicts.length ? stashMerge(name, baseText, mine.text, theirs0.text, merged, conflicts) : [];
      rec.lastResult = 'merged'; rec.lastPushAt = now(); rec.lastPullAt = now();
      rec.lastPushRev = metaOf(merged).rev || 0;
      rec.lastMergeConflicts = (rec.lastMergeConflicts || 0) + conflicts.length;
      done = true; noteOk();
      return { name, action: 'merged', rev: rec.lastPushRev, autoResolved: true, conflicts: files, divergences: conflicts.length };
    }catch(e){
      rec.lastResult = 'error';
      noteError(name + ' ' + ((e && e.code) || (e && e.message) || 'merge error'));
      return { name, action: 'error', err: (e && e.code) || (e && e.message) || 'merge error' };
    }finally{
      releaseLock(lk);
      if(done || rec.lastResult === 'error' || rec.lastResult === 'merge-failed' || rec.lastResult === 'locked' || rec.lastResult === 'merge-skipped') saveState();
    }
  }

  /* 合并里确实无法自动裁决的部分：把三份原文与合并结果一起留底，人能看懂也能手工并回去 */
  function stashMerge(name, baseText, mineText, theirsText, mergedText, conflicts){
    try{
      const dir = path.join(shareDir, 'conflict');
      ensureDir(dir);
      const f = path.join(dir, name.replace(/\.json$/, '') + '_merge_' + stamp() + '.json');
      atomicWriteText(f, JSON.stringify({ at: new Date().toISOString(), host: os.hostname(),
        divergences: conflicts, base: safeParse(baseText), mine: safeParse(mineText), theirs: safeParse(theirsText), merged: safeParse(mergedText) }, null, 2));
      return [path.basename(f)];
    }catch(e){ log('⚠️ 合并留底写入失败：' + (e && e.message)); return []; }
  }
  function safeParse(t){ try{ return JSON.parse(t); }catch(e){ return null; } }

  /* 本地写成功后的去抖推送（不阻塞请求） */
  /* 拿不到锁 / 共享盘暂时读不到 ≠ 可以丢掉这次改动：必须退避重试，
     否则同事正好在推时，我的改动会一直躺在本地，直到下一次本地写入才顺带带出去 */
  const RETRY_DELAYS = [1500, 4000, 9000, 20000];
  const retries = new Map();
  function scheduleRetry(name){
    const n = (retries.get(name) || 0);
    if(n >= RETRY_DELAYS.length) return false;
    retries.set(name, n + 1);
    const t = setTimeout(() => {
      try{ const r = syncFile(name, 'retry'); if(r && ['locked','hold','error'].indexOf(r.action) >= 0) scheduleRetry(name); else retries.delete(name); }
      catch(e){ noteError((e && e.message) || 'retry error'); scheduleRetry(name); }
    }, RETRY_DELAYS[n]);
    if(t.unref) t.unref();
    return true;
  }
  function schedulePush(name, delayMs){
    if(!enabled) return;
    if(!sharePathOf(shareDir, name)) return;
    const t = timers.get(name);
    if(t) clearTimeout(t);
    const tm = setTimeout(() => {
      timers.delete(name);
      try{
        const r = syncFile(name, 'push');
        if(r && (r.action === 'locked' || r.action === 'hold' || r.action === 'error')) scheduleRetry(name);
        else retries.delete(name);
      }catch(e){ noteError((e && e.message) || 'push error'); scheduleRetry(name); }
    }, delayMs == null ? PUSH_DEBOUNCE_MS : delayMs);
    timers.set(name, tm);
    /* 定时器不该单独撑住进程退出（原来在 delete 之后才取，unref 从未生效） */
    if(tm.unref) tm.unref();
  }
  /* 定期从共享盘拉：长开的机器只在开机/登录各拉过一次，之后不拉的话，
     页面每 30 秒核对到的只是本机旧数据，「自动采纳同事的改动」就成了空话 */
  function pullPeriodic(){
    if(!enabled) return null;
    /* 2 秒预算：共享盘抖动时单次 SMB 往返可达数十秒，巡检卡太久会拖住请求路径
       （Node 的事件循环 / PS 的串行主循环）；没做完的文件下一轮接着做 */
    return syncFor([AUTH_NAME, SHARED_NAME].concat(localPersonalUids().map(u => 'flowtask_data_' + u + '.json')), 'periodic', 2000);
  }
  function flushPending(){
    for(const [name, t] of timers){ clearTimeout(t); timers.delete(name); try{ syncFile(name, 'push'); }catch(e){ noteError((e && e.message) || 'flush error'); } }
  }

  /* 服务端启动后的一次「先拉」：账户表 + 共享库 + 本机已有归属的所有个人库。
     个人库归属从本机 DATA_DIR 的文件名推出来（本机服务过谁，就替谁续传）。 */
  function localPersonalUids(){
    try{
      return fs.readdirSync(dataDir)
        .map(f => { const m = PERSONAL_RE.exec(f); return m ? m[1] : null; })
        .filter(Boolean);
    }catch(e){ return []; }
  }
  function pullOnBoot(uidList){
    if(!enabled) return { skipped: true };
    const uids = uidList || localPersonalUids();
    const names = [AUTH_NAME, SHARED_NAME].concat(uids.map(u => 'flowtask_data_' + u + '.json'));
    return syncFor(names, 'pull');
  }
  function syncFor(names, mode, budgetMs){
    if(!enabled) return { enabled:false, results: [] };
    const out = [];
    const t0 = Date.now();
    inFlight = true;
    try{
      for(const n of names){
        /* 文件之间检查预算（至少处理一个）：共享盘掉线时整轮巡检不至于无限期占住请求路径 */
        if(budgetMs && out.length && (Date.now() - t0) > budgetMs) break;
        out.push(syncFile(n, mode));
      }
    }
    finally{ inFlight = false; }
    return { enabled:true, results: out, status: status() };
  }

  function status(){
    return {
      enabled,
      reachable: !!state.reachable,
      lastSyncAt: state.lastSyncAt || 0,
      lastError: state.lastError || '',
      lastErrorAt: state.lastErrorAt || 0,
      blockReason: state.blockReason || '',
      shareDir: shareDir || '',
      pending: timers.size,
      busy: inFlight,
      files: Object.keys(state.files).map(n => Object.assign({ name: n }, state.files[n]))
    };
  }
  /* 重新探测一次共享盘（界面点「立即同步」或改完配置后可调）：
     返回原因字符串，空串代表可用 */
  function checkNow(){
    if(!enabled) return '未配置共享盘目录';
    const chk = checkShare(shareDir);
    blockReason = chk.ok ? '' : chk.reason;
    state.blockReason = blockReason;
    if(chk.ok){ noteOk(); } else { noteError(chk.reason); }
    return blockReason;
  }

  /* 登录时的一次定向拉取：把「这个人 / 这份团队库」的最新版本拉回本机。
     换电脑首次登录能立刻拿回自己的资料，靠的就是这一步。
     用 pull 模式：本机更新时只会 hold，不会覆盖本地，也不会把本机账户表推上去。 */
  function loginSync(uid){
    if(!enabled) return { enabled:false };
    const names = [AUTH_NAME, SHARED_NAME];
    if(uid) names.push('flowtask_data_' + uid + '.json');
    return syncFor(names, 'pull');
  }

  /* 手动「立即同步」：双向（谁的版本新就往哪个方向走） */
  function syncAll(mode, uid){
    const names = [AUTH_NAME, SHARED_NAME];
    if(uid) names.push('flowtask_data_' + uid + '.json');
    else for(const u of localPersonalUids()) names.push('flowtask_data_' + u + '.json');
    return syncFor(names, mode || 'auto');
  }

  /* 定期拉取定时器归引擎自己管：只在服务启动时按当时的 enabled 建（旧版做法），
     界面热启用同步的机器就永远等不到「自动采纳同事改动」，直到重启。
     现在 enabled 翻转即启停，与 reconfigure 同一入口。 */
  let pullTimer = null;
  function ensurePullTimer(){
    if(enabled && !pullTimer){
      pullTimer = setInterval(() => { try{ pullPeriodic(); }catch(e){ console.log('⚠️ 定期同步异常：' + ((e && e.message) || e)); } }, 30000);
      if(pullTimer.unref) pullTimer.unref();
    }else if(!enabled && pullTimer){
      clearInterval(pullTimer); pullTimer = null;
    }
  }

  /* 界面改路径 / 启停同步时热切换：清空旧路径的探测结果，重新校验并立刻把本机数据往新位置推一次 */
  function reconfigure(nextDir, nextEnabled){
    for(const [name, t] of timers){ clearTimeout(t); timers.delete(name); }
    shareDir = String(nextDir === undefined ? shareDir : nextDir).trim();
    enabled = nextEnabled === undefined ? !!shareDir : (!!nextEnabled && !!shareDir);
    if(!enabled) shareDir = '';
    recheck();
    ensurePullTimer();
    return { enabled, shareDir, blockReason };
  }

  /* 登录找不到人时按需补拉一次账户表：新机器开机时共享盘上可能还没有账户表，
     而 /api/sync 又要求会话（会话依赖账户表）——不补这一刀，新同事永远登不进来。 */
  function pullAuth(){
    if(!enabled) return { enabled:false };
    return syncFor([AUTH_NAME], 'login-refresh');
  }

  ensurePullTimer();   // 启动时若已启用同步，定时器即刻就位；之后由 reconfigure 负责启停
  return {
    /* enabled / shareDir 用取值函数暴露：它们会被 reconfigure 改，快照值会过期 */
    get enabled(){ return enabled; }, get shareDir(){ return shareDir; },
    status, syncFor, syncAll, pullOnBoot, pullPeriodic, loginSync, schedulePush, flushPending, checkNow, reconfigure, pullAuth, ensurePullTimer,
    /* 供单测直接驱动 */
    _internals: { decideAction, sharePathOf, metaOf, syncFile, acquireLock, releaseLock, hashOf, localPersonalUids, stateFile, checkShare }
  };
}

module.exports = { create, decideAction, sharePathOf, metaOf, hashOf, checkShare, AUTH_NAME, SHARED_NAME, PERSONAL_RE, LOCK_TTL_MS, PUSH_DEBOUNCE_MS };
