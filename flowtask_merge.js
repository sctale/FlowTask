/*
 * FlowTask 三路合并内核（零依赖、纯函数、可单测）
 * ------------------------------------------------------------------
 * 为什么需要它：共享盘只有存储、不跑任何代码，所以没有协调者能替我们判定
 * 「谁的改动该保留」。唯一的出路是每台机器本地都留一份「共同祖先」快照
 * （<DATA_DIR>\<库名>.base.json，绝不上共享盘），推送前用
 *   base（上次大家一起的样子） / mine（我改的） / theirs（盘上现在的）
 * 三份做三路合并：只有「两边都改了同一处」才算真冲突。
 *
 * 效果：两个人各建各的任务、各改不同项目 → 全部保留，不再互相顶掉。
 * 这条规则必须对称：同一份 (base, a, b) 在任意一台机器上算出的结果都相同，
 * 否则两台机器会各自收敛到不同状态，反而制造新冲突。所以标量冲突的 tie-break
 * 不能用「我这边的时间更新」，要用与主客无关的确定性规则。
 */
'use strict';

/* 数组元素若有 id 就按 id 对齐；没有 id 的（如 followers 里的 uid）按集合处理 */
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const hasIds = arr => Array.isArray(arr) && arr.length > 0 && arr.every(v => isObj(v) && v.id !== undefined);

function stable(v){
  if(Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if(isObj(v)) return '{' + Object.keys(v).sort().map(k => k + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/* 实体自身的时间戳：只用于「两边都改了同一条」时给出确定的取舍依据 */
function stampOf(v){
  if(Array.isArray(v)) return v.reduce((m, x) => Math.max(m, stampOf(x)), 0);
  if(!isObj(v)) return 0;
  let m = 0;
  for(const k of ['ts', 'updatedAt', 'createdAt', 'completedAt', 'lastSaved', 'doneAt']){
    const n = Number(v[k]);
    if(n > m) m = n;
  }
  if(Array.isArray(v.activities)){
    for(const a of v.activities){ const n = Number(a && a.ts); if(n > m) m = n; }
  }
  if(Array.isArray(v.comments)){
    for(const c of v.comments){ const n = Number(c && c.ts); if(n > m) m = n; }
  }
  if(Array.isArray(v.statusUpdates)){
    for(const s of v.statusUpdates){ const n = Number(s && s.ts); if(n > m) m = n; }
  }
  return m;
}

/* 标量或结构整体变了：给出与「谁在算」无关的确定性选择。
   sm/st 是两侧「所属实体」各自的时间戳 —— 必须用实体时间而不是字段值时间：
   字段值常常是字符串（没有时间戳可用），拿它自己比会退化成按字符序取胜，
   于是"谁的标题排在前面谁赢"，看起来就像随机丢改动。 */
function pickDeterministic(a, b, sm, st){
  const sa = (sm === undefined) ? stampOf(a) : sm;
  const sb = (st === undefined) ? stampOf(b) : st;
  if(sa !== sb) return sa > sb ? a : b;
  return stable(a) <= stable(b) ? a : b;
}

/* ---------- 数组：按 id 对齐合并 ---------- */
function mergeArrayById(base, mine, theirs, path, out){
  const key = a => (Array.isArray(a) ? a : []).map(x => String(x.id)).join('|');
  const idx = arr => { const m = new Map(); (Array.isArray(arr) ? arr : []).forEach((x, i) => m.set(String(x.id), { item: x, i })); return m; };
  const B = idx(base), M = idx(mine), T = idx(theirs);
  /* 顺序必须与主客无关：交换 mine/theirs 得到同一份顺序（以 base 序为骨架，
     新增 id 按字符串序追加）。旧的「theirs 为主序」在两台机器上角色互换会算出
     不同顺序 → 内容哈希永不相同 → 合并本身成了新冲突源。 */
  const ordered = [];
  const seen = new Set();
  const push = id => { if(!seen.has(id)){ seen.add(id); ordered.push(id); } };
  (Array.isArray(base) ? base : []).forEach(x => push(String(x.id)));
  const added = new Set();
  (Array.isArray(mine) ? mine : []).forEach(x => { const id = String(x.id); if(!seen.has(id)) added.add(id); });
  (Array.isArray(theirs) ? theirs : []).forEach(x => { const id = String(x.id); if(!seen.has(id)) added.add(id); });
  Array.from(added).sort().forEach(push);

  for(const id of ordered){
    const b = B.has(id) ? B.get(id).item : undefined;
    const m = M.has(id) ? M.get(id).item : undefined;
    const t = T.has(id) ? T.get(id).item : undefined;
    const p = path + '#' + id;

    if(m === undefined && t === undefined) continue;                    // 两边都没了
    if(b === undefined){                                                // 双方各自新增
      if(m === undefined){ out.push(t); continue; }
      if(t === undefined){ out.push(m); continue; }
      if(stable(m) === stable(t)){ out.push(m); continue; }
      out.push(pickDeterministic(m, t));                                 // 同一个 id 被两台机器独立创建：极少见，取确定的一侧
      out.__conflicts.push({ path: p, kind: 'both-added' });
      continue;    }
    if(m === undefined || t === undefined){
      /* 一方删了、另一方还在：删的那方若同时改了内容 → 编辑优先，删除只在「没改」时生效 */
      const kept = m !== undefined ? m : t;
      const keptChanged = stable(kept) !== stable(b);
      if(!keptChanged){ continue; }                                     // 没改 → 尊重删除
      out.push(kept);
      out.__conflicts.push({ path: p, kind: 'deleted-vs-edited' });
      continue;
    }
    if(stable(m) === stable(t)){ out.push(m); continue; }               // 改成一样
    const mEq = stable(m) === stable(b), tEq = stable(t) === stable(b);
    if(mEq){ out.push(t); continue; }                                   // 只有对方改了
    if(tEq){ out.push(m); continue; }                                   // 只有我改了
    out.push(mergeValue(b, m, t, p, out.__conflicts, 1));               // 都改了 → 逐字段合并
  }
}

/* 集合语义的标量数组（followers / tags / memberIds）：谁加的都要留，两边都删才算删 */
function mergeScalarArray(base, mine, theirs){
  const set = a => (Array.isArray(a) ? a : []).map(stable);
  const cur = new Set(set(mine)), other = new Set(set(theirs));
  const out = [];
  const seen = new Set();
  const emit = item => {
    const k = stable(item);
    if(seen.has(k)) return;
    if(!cur.has(k) && !other.has(k)) return;                           // 两边都删了
    seen.add(k); out.push(item);
  };
  /* 顺序与主客无关（同 mergeArrayById）：base 序为骨架，新增项按规范化字符串序追加 */
  (Array.isArray(base) ? base : []).forEach(emit);
  const added = [];
  const addedKeys = new Set();
  const collect = a => { for(const item of (Array.isArray(a) ? a : [])){ const k = stable(item); if(seen.has(k) || addedKeys.has(k)) continue; if(!cur.has(k) && !other.has(k)) continue; addedKeys.add(k); added.push(item); } };
  collect(mine); collect(theirs);
  added.sort((x, y) => { const kx = stable(x), ky = stable(y); return kx < ky ? -1 : kx > ky ? 1 : 0; });
  added.forEach(emit);
  return out;
}

/* ---------- 通用值合并 ----------
   depth 限制递归深度，避免异常深的结构把栈打满 */
function mergeValue(base, mine, theirs, path, conflicts, depth, sm, st){
  if(stable(mine) === stable(theirs)) return mine;
  if(stable(mine) === stable(base)) return theirs;
  if(stable(theirs) === stable(base)) return mine;
  /* 往下递归时带上两侧所属实体的时间戳；调用方没给就用当前值自己的 */
  const nsm = (sm === undefined) ? stampOf(mine) : sm;
  const nst = (st === undefined) ? stampOf(theirs) : st;
  if(Array.isArray(mine) && Array.isArray(theirs)){
    if(hasIds(mine) || hasIds(theirs)){
      if(hasIds(mine) && hasIds(theirs) && (Array.isArray(base) ? base : []).every(x => x && x.id !== undefined)){
        const out = []; out.__conflicts = conflicts;
        mergeArrayById(base, mine, theirs, path, out);
        return out;
      }
    }
    if(!isObj(mine[0]) && !isObj(theirs[0])) return mergeScalarArray(base, mine, theirs);
  }
  if(isObj(mine) && isObj(theirs)){
    if(depth > 6) { conflicts.push({ path, kind: 'too-deep' }); return pickDeterministic(mine, theirs, nsm, nst); }
    const out = {};
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(mine), ...Object.keys(theirs)]);
    for(const k of Array.from(keys).sort()){
      const b = base ? base[k] : undefined, m = mine[k], t = theirs[k];
      if(!(k in mine) && !(k in theirs)) continue;
      if(!(k in mine) || !(k in theirs)){
        /* 一方删了这个字段、另一方改了它 → 保留存在的那侧，并记一条冲突 */
        const present = (k in mine) ? m : t;
        const changed = stable(present) !== stable(b);
        if(changed) conflicts.push({ path: path + '.' + k, kind: 'field-vs-delete' });
        else continue;                                                   // 没改 → 尊重删除
        out[k] = changed ? mergeValue(b, (k in mine) ? present : b, (k in theirs) ? present : b, path + '.' + k, conflicts, depth + 1, nsm, nst) : present;
        continue;
      }
      if(k === 'id'){ out[k] = t; continue; }                            // id 永远不动
      out[k] = mergeValue(b, m, t, path + '.' + k, conflicts, depth + 1, nsm, nst);
    }
    return out;
  }
  /* 标量两边都改成了不同值：真冲突，取确定的一侧并记录 */
  conflicts.push({ path, kind: 'scalar', base, mine, theirs });
  return pickDeterministic(mine, theirs, nsm, nst);
}

const TOP_ARRAYS = ['projects', 'tasks', 'notifications', 'tags', 'savedFilters', 'users'];
const TRASH_ARRAYS = ['tasks', 'projects'];

/* 主入口：三份 store → 合并结果 + 冲突清单 */
function mergeStores(base, mine, theirs){
  const conflicts = [];
  const b = isObj(base) ? base : {}, m = isObj(mine) ? mine : {}, t = isObj(theirs) ? theirs : {};
  const out = {};
  /* meta 单独处理：版本号取最大再 +1，避免合并结果被任何一方判成「更旧」。
     其余字段也必须与主客无关（旧版 m 无条件覆盖 t + Date.now()，两台机器
     对同一三元组算出的 meta 不同 → 内容哈希不同 → 反复触发冲突）：
     先比 rev、再比 lastSaved、最后比规范化字符串选出「较新一侧」，
     lastSaved 取两侧较大值而不是当前时间。 */
  const rev = Math.max(Number(b.meta && b.meta.rev) || 0, Number(m.meta && m.meta.rev) || 0, Number(t.meta && t.meta.rev) || 0) + 1;
  const mm = (m.meta && typeof m.meta === 'object') ? m.meta : {};
  const tm = (t.meta && typeof t.meta === 'object') ? t.meta : {};
  const newerSide = (() => {
    const ra = Number(mm.rev) || 0, rb = Number(tm.rev) || 0;
    if(ra !== rb) return ra > rb ? mm : tm;
    const la = Number(mm.lastSaved) || 0, lb = Number(tm.lastSaved) || 0;
    if(la !== lb) return la > lb ? mm : tm;
    return stable(mm) <= stable(tm) ? mm : tm;
  })();
  out.meta = Object.assign({}, newerSide, { rev, lastSaved: Math.max(Number(mm.lastSaved) || 0, Number(tm.lastSaved) || 0) });

  for(const k of TOP_ARRAYS){
    if(!(k in m) && !(k in t)) continue;
    if(hasIds(m[k]) || hasIds(t[k]) || hasIds(b[k])){
      const arr = []; arr.__conflicts = conflicts;
      mergeArrayById(b[k], m[k], t[k], k, arr);
      out[k] = arr;
    }else if(Array.isArray(m[k]) || Array.isArray(t[k])){
      out[k] = mergeScalarArray(b[k], m[k], t[k]);
    }else if(k in m || k in t){
      out[k] = mergeValue(b[k], m[k], t[k], k, conflicts, 0);
    }
  }
  /* 回收站是分桶对象，桶内再按 id 合并 */
  if(m.trash || t.trash || b.trash){
    out.trash = {};
    const keys = new Set([...Object.keys((m.trash || {})), ...Object.keys((t.trash || {})), ...Object.keys((b.trash || {}))]);
    for(const k of Array.from(keys).sort()){
      const bm = (b.trash || {})[k], mm = (m.trash || {})[k], tm = (t.trash || {})[k];
      if(hasIds(mm) || hasIds(tm)){
        const arr = []; arr.__conflicts = conflicts;
        mergeArrayById(bm, mm, tm, 'trash.' + k, arr);
        out.trash[k] = arr;
      }else{
        out.trash[k] = mergeValue(bm, mm, tm, 'trash.' + k, conflicts, 0);
      }
    }
  }
  /* 其它没列出的顶层键（老版本 / 将来新增的集合）一律参与合并，避免静默丢字段 */
  for(const k of new Set([...Object.keys(m), ...Object.keys(t)])){
    if(k === 'meta' || TOP_ARRAYS.indexOf(k) >= 0 || k === 'trash') continue;
    if(k in out) continue;
    out[k] = mergeValue(b[k], m[k], t[k], k, conflicts, 0);
  }
  return { merged: out, conflicts };
}

/* 是否需要走合并：三份都读得出来、且双方相对祖先都改过。
   任何一方缺失都不算「分歧」：本机没有这份 → 直接拉；盘上还没有 → 直接推。
   拿 null 参与合并会把版本号再顶高一次，新电脑拉回来的就不是别人刚推的那一版了。 */
function needsMerge(baseText, mineText, theirsText){
  if(!baseText || !mineText || !theirsText) return false;                // 缺任何一份就不合并（含 null / 空串）
  if(mineText === theirsText) return false;                             // 内容已经一样
  if(mineText === baseText || theirsText === baseText) return false;    // 只有一边改了 → 直接推/拉即可
  return true;
}

module.exports = { mergeStores, needsMerge, mergeValue, mergeArrayById, stampOf, stable, hasIds };
