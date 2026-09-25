/*
 * 端到端验证「各改各的不互相顶掉」：一个共享盘 + 两个本机数据目录 + 两个服务实例，
 * 两人各自往同一份团队共享库里加不同任务，再让同步跑完，断言两边的任务都在。
 * 用法：node tests/sync_merge_e2e.js            （默认跑 Node 版两端）
 *       node tests/sync_merge_e2e.js ps1        （跑 PowerShell 版两端 —— 客户机上真正用的那个）
 * 需要合并生效必须有共同祖先，所以脚本会先做一次双方都同步过的「基线建立」步骤。
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WHICH = (process.argv[2] || 'node').toLowerCase();
const PORT_A = WHICH === 'node' ? 5601 : 5611, PORT_B = WHICH === 'node' ? 5602 : 5612;
const PW = 'Merge#2026', SALT = 's_mg_1';
const HASH_A = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(SALT), 100000, 32, 'sha256').toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(c, label, extra){ if(c){ passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (extra !== undefined ? '  [' + extra + ']' : '')); } }
function mkd(t){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mg-' + t + '-')); }
function req(port, method, p, headers, body){
  return new Promise(res => {
    const h = Object.assign({ Origin: 'http://127.0.0.1:' + port }, headers || {});
    if(body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ host:'127.0.0.1', port, path:p, method, headers:h, timeout:25000 }, x => {
      let d=''; x.on('data',c=>d+=c); x.on('end',()=>res({ status:x.statusCode, text:d, json:(()=>{try{return JSON.parse(d);}catch(e){return null;}})() }));
    });
    r.on('error', e => res({ status:'ERR', text:String(e.code) }));
    r.on('timeout', function(){ this.destroy(); res({ status:'TIMEOUT' }); });
    if(body) r.write(body); r.end();
  });
}
async function up(port){ for(let i=0;i<120;i++){ const r = await req(port,'GET','/api/ping'); if(r.status===200) return true; await sleep(300);} return false; }
function start(port, data, share){
  const args = WHICH === 'node' ? [path.join(ROOT,'flowtask_server.js')]
    : ['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(ROOT,'flowtask_server.ps1'),
       '-Port', String(port), '-HostIP','127.0.0.1', '-DataDir', data, '-ShareDir', share];
  const env = Object.assign({}, process.env);
  if(WHICH === 'node') Object.assign(env, { FLOWTASK_PORT:String(port), FLOWTASK_DATA_DIR:data, FLOWTASK_SHARE_DIR:share });
  const k = spawn(WHICH === 'node' ? process.execPath : 'powershell', args, { env, stdio:'ignore' });
  return k;
}
async function session(port, uname){
  const tk = (await req(port,'GET','/api/token')).json;
  const T = { 'X-FlowTask-Token': tk.token, 'Content-Type':'application/json' };
  for(let i=0;i<40;i++){ const c = await req(port,'GET','/api/auth-challenge?username='+uname, T); if(c.status===200){
    const ver = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(c.json.salt), 100000, 32, 'sha256').toString('hex');
    const se = await req(port,'POST','/api/session', T, JSON.stringify({ uid:c.json.uid, verifier:ver }));
    if(se.status === 200) return { tk: tk.token, sess: se.json.session };
  } await sleep(400); }
  return null;
}
const kids = [];
(async () => {
  const share = mkd('share'), dA = mkd('A'), dB = mkd('B');
  try{
    console.log(`\n== 双向「各改各的」合并 · ${WHICH === 'node' ? 'Node 版' : 'PowerShell 版'} ==`);
    kids.push(start(PORT_A, dA, share), start(PORT_B, dB, share));
    ok(await up(PORT_A), 'A 机服务已启动'); ok(await up(PORT_B), 'B 机服务已启动');

    /* 建两个账户（A 建表并推上去；B 从共享盘拉回账户表） */
    const tkA = (await req(PORT_A,'GET','/api/token')).json;
    const TA = { 'X-FlowTask-Token': tkA.token, 'Content-Type':'application/json' };
    await req(PORT_A,'POST','/api/db?file=flowtask_auth.json', TA, JSON.stringify({ meta:{rev:1,lastSaved:Date.now()}, users:[
      { id:'u_alice', username:'alice', name:'爱丽丝', role:'admin', salt:SALT, passHash:HASH_A, active:true, createdAt:Date.now() },
      { id:'u_bob', username:'bob', name:'鲍勃', role:'member', salt:SALT, passHash:HASH_A, active:true, createdAt:Date.now() } ]}));
    const sA = await session(PORT_A,'alice'), sB = await session(PORT_B,'bob');
    ok(!!sA && !!sB, '两端都拿到会话（B 的账户表来自共享盘同步）');
    const HA = { 'X-FlowTask-Token': sA.tk, 'X-FlowTask-Session': sA.sess, 'Content-Type':'application/json' };
    const HB = { 'X-FlowTask-Token': sB.tk, 'X-FlowTask-Session': sB.sess, 'Content-Type':'application/json' };

    /* 基线建立：先放一个双方都见过的共享库，之后各自在上面加分歧内容 */
    const seed = { meta:{ rev:1, lastSaved: Date.now() }, projects:[{ id:'p1', name:'共同项目', scope:'shared', memberIds:['u_alice','u_bob'] }],
      tasks:[{ id:'t0', projectId:'p1', title:'共有任务' }], notifications:[] };
    await req(PORT_A,'POST','/api/db?file=flowtask_shared.json', HA, JSON.stringify(seed));
    /* 合并要成立必须有「共同祖先」：让 B 通过定期拉取拿到初始共享库并落下基线。
       触发方式是打一次 /api/sync（服务端借请求做巡检），不是靠睡固定秒数赌时机 */
    async function refresh(port, H){
      await req(port, 'POST', '/api/sync', H, JSON.stringify({ mode: 'auto' }));
      await sleep(4500);
    }
    await refresh(PORT_A, HA); await refresh(PORT_B, HB); await refresh(PORT_A, HA);
    ok(fs.existsSync(path.join(dB,'flowtask_shared.json')), 'B 机已从共享盘拿到初始共享库');

    /* 分歧：A 加 ta + 改 t0 的负责人；B 加 tb + 改 t0 的标题 —— 都是同一份文件 */
    const mineA = JSON.parse(JSON.stringify(seed));
    mineA.meta.rev = 2; mineA.meta.lastSaved = Date.now();
    mineA.tasks.push({ id:'ta', projectId:'p1', title:'爱丽丝建的任务' });
    mineA.tasks[0].assigneeId = 'u_alice';
    const mineB = JSON.parse(JSON.stringify(seed));
    mineB.meta.rev = 2; mineB.meta.lastSaved = Date.now() + 1000;
    mineB.tasks.push({ id:'tb', projectId:'p1', title:'鲍勃建的任务' });
    mineB.tasks[0].title = '被鲍勃改过的标题';
    ok((await req(PORT_A,'POST','/api/db?file=flowtask_shared.json', HA, JSON.stringify(mineA))).status === 200, 'A 机保存成功（本机优先）');
    ok((await req(PORT_B,'POST','/api/db?file=flowtask_shared.json', HB, JSON.stringify(mineB))).status === 200, 'B 机保存成功（本机优先）');

    /* 等两轮同步：先各自推上去产生冲突，再合并 */
    await sleep(9000);
    const onShare = (() => { try{ return JSON.parse(fs.readFileSync(path.join(share,'team','flowtask_shared.json'),'utf8')); }catch(e){ return null; } })();
    ok(!!onShare, '共享盘上能看到合并后的团队共享库');
    const shareFile = path.join(share, 'team', 'flowtask_shared.json');
    const rawShare = fs.existsSync(shareFile) ? fs.readFileSync(shareFile, 'utf8') : '(无)';
    const ids = (onShare && Array.isArray(onShare.tasks)) ? onShare.tasks.map(t => t.id).sort().join(',') : 'NOT_ARRAY';
    if (ids === 'NOT_ARRAY') console.log('      盘上原文 = ' + rawShare.slice(0, 520));   // 形状异常时给出可诊断的原文
    ok(ids === 't0,ta,tb', '两个人各建的任务在共享盘上都保留（旧行为只会留一个），实际 = ' + ids);
    const t0 = onShare && onShare.tasks.find(t => t.id === 't0');
    ok(t0 && t0.title === '被鲍勃改过的标题', 'B 改的标题被保留');
    ok(t0 && t0.assigneeId === 'u_alice', 'A 改的负责人也被保留（字段级合并，不是整条二选一）');
    const mergedShare = JSON.stringify(onShare);
    ok(mergedShare.indexOf('爱丽丝建的任务') >= 0 && mergedShare.indexOf('鲍勃建的任务') >= 0, '两条新任务内容都完整在盘上');

    /* 本机收敛是最终一致：A 要等自己下一次拉取才看到合并结果，所以先触发一次同步再看。
       （本地优先 = 允许短暂落后，但必须自己收敛，否则下一次写入又造新冲突） */
    await refresh(PORT_A, HA);
    const localA = (() => { try{ return JSON.parse(fs.readFileSync(path.join(dA,'flowtask_shared.json'),'utf8')); }catch(e){ return null; } })();
    const la = localA ? localA.tasks.map(t=>t.id).sort().join(',') : '';
    ok(la === 't0,ta,tb', 'A 机本机已收敛到合并结果，实际 = ' + la);
    await refresh(PORT_B, HB);
    const localB2 = (() => { try{ return JSON.parse(fs.readFileSync(path.join(dB,'flowtask_shared.json'),'utf8')); }catch(e){ return null; } })();
    ok(localB2 && localB2.tasks.map(t=>t.id).sort().join(',') === 't0,ta,tb', 'B 机也收敛到同一份（双方一致才不会反复冲突）');
    /* 收敛后两边内容必须一致（版本号除外），否则下一次推送又会判成分歧 */
    const sameNow = (() => {
      try{
        const norm = f => { const j = JSON.parse(fs.readFileSync(f,'utf8')); delete j.meta; return JSON.stringify(j); };
        return norm(path.join(dA,'flowtask_shared.json')) === norm(path.join(dB,'flowtask_shared.json'));
      }catch(e){ return false; }
    })();
    ok(sameNow, '两台机器的数据内容已完全一致（版本号除外）');

    /* 合并状态要能被界面读到 */
    const st = await req(PORT_A,'GET','/api/sync', HA);
    ok(st.status === 200 && st.json.status.reachable === true, '同步状态可读且共享盘可达');
    /* 合并过的文件会留下 merged/push/pull 之一的痕迹；关键是绝不能停在 locked/hold/error ——
       那意味着改动被静默放弃在本地（这正是之前「拿不到锁就不推」的真 bug） */
    const ledger = (st.json.status.files || []).map(f => f.name + ':' + f.lastResult);
    ok(!ledger.some(x => /:(locked|hold|error)$/.test(x)), '账本里不该有被放弃的同步：' + JSON.stringify(ledger));
    const stB = await req(PORT_B,'GET','/api/sync', HB);
    const ledgerB = (stB.json.status.files || []).map(f => f.name + ':' + f.lastResult);
    ok(ledgerB.some(x => /flowtask_shared.json:(merged|push|pull)$/.test(x)),
       'B 侧账本能看到共享库确实同步过：' + JSON.stringify(ledgerB));
    ok(fs.readdirSync(path.join(share, 'team')).length > 0, '共享盘 team 目录下确有文件')

  }catch(e){
    failed++; console.log('  FAIL 场景异常：' + ((e && e.stack) || e));
  }finally{
    for(const k of kids){ try{ k.kill(); }catch(e){} }
    await sleep(600);
    for(const d of [share, dA, dB]) try{ fs.rmSync(d, { recursive:true, force:true }); }catch(e){}
    console.log(`\n== 双向合并端到端：${passed} 通过，${failed} 失败 ==`);
    process.exit(failed ? 1 : 0);
  }
})();
