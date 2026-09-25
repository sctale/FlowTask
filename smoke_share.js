/*
 * 共享盘同步 · 真机冒烟工具（手动运行，不进自动化测试链）
 * ----------------------------------------------------------------
 * 干嘛用：部署到新环境时，验证「本机存储 + 共享盘同步」这条链路在真实
 *         SMB 上是否成立——目录契约、跨机锁、抢占、冲突双方留底、以及真实延迟。
 *
 * 用法：  node smoke_share.js "\\\\fileserver\\share\\FlowTask"
 *         或用环境变量： set FLOWTASK_SHARE_DIR=<共享盘路径> 后直接 node smoke_share.js
 *         共享盘里已有真实数据时，额外加 --allow-nonempty 才肯跑（防止误碰生产数据）
 *
 * 安全：  所有测试数据写在自己申请的临时本机目录，只往共享盘「新建」目录与文件；
 *         清理阶段只删「本次登记过、且开跑前不存在」的路径，开跑前就存在的一律不碰。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const ALLOW_NONEMPTY = argv.indexOf('--allow-nonempty') >= 0;
const SHARE = String(argv.find(a => a && a[0] !== '-') || process.env.FLOWTASK_SHARE_DIR || '').trim();
const SERVER = path.join(__dirname, 'flowtask_server.js');
const PORT = Number(process.env.SMOKE_PORT) || 5311;
const PW = 'Smoke#2026', SALT = 's_smoke_1';
const UID = 'u_smoke_probe';
const HASH = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(SALT), 100000, 32, 'sha256').toString('hex');

if(!SHARE){
  console.log('用法： node smoke_share.js "\\\\server\\share\\FlowTask"   （或设 FLOWTASK_SHARE_DIR）');
  process.exit(2);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-smoke-data-'));
const created = [];                      // 只记录本探针在共享盘上造的东西
function track(p){ created.push(p); }
function req(method, p, headers, body){
  return new Promise((resolve, reject) => {
    const r = http.request({ host:'127.0.0.1', port:PORT, path:p, method,
      headers: Object.assign({ Origin:'http://127.0.0.1:'+PORT }, headers || {}) }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ let j=null; try{ j=JSON.parse(d);}catch(e){} resolve({status:res.statusCode,text:d,json:j}); });
    });
    r.on('error', reject); r.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(c, l){ if(c){ pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

(async () => {
  console.log('本机数据目录 =', dataDir);
  console.log('共享盘       =', SHARE);
  if(!fs.existsSync(SHARE)){
    console.log('FAIL  共享盘路径不存在或不可达：' + SHARE);
    console.log('      先确认已用当前账号连上该共享（explorer 能打开），再跑本工具。');
    try{ fs.rmSync(dataDir, { recursive:true, force:true }); }catch(e){}
    process.exit(2);
  }
  const before = fs.readdirSync(SHARE);
  console.log('共享盘初始内容 =', before.length ? before.join(' | ') : '(空)');
  if(before.length && !ALLOW_NONEMPTY){
    console.log('FAIL  这个共享盘里已经有东西了，冒烟工具会在同一层建目录，拒绝在可能是生产数据的地方试写。');
    console.log('      确认这些内容可以被旁观（工具不会删它们、但会往同一层建新目录）后，加 --allow-nonempty 再跑。');
    try{ fs.rmSync(dataDir, { recursive:true, force:true }); }catch(e){}
    process.exit(2);
  }

  const srv = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      FLOWTASK_PORT: String(PORT), FLOWTASK_HOST: '127.0.0.1',
      FLOWTASK_DATA_DIR: dataDir, FLOWTASK_SHARE_DIR: SHARE
    }), stdio: ['ignore','pipe','pipe']
  });
  srv.stdout.on('data', d => String(d).split('\n').filter(x => /共享盘|同步|启动/.test(x)).forEach(x => console.log('[srv]' + x)));
  srv.stderr.on('data', d => console.log('[srv-err] ' + d));

  try{
    let up = null;
    for(let i=0;i<80;i++){ try{ const r = await req('GET','/api/ping'); if(r.status===200){ up=r.json; break; } }catch(e){} await sleep(250); }
    ok(!!up, '服务已启动（数据目录在临时目录、共享盘指向真实 UNC）');

    const tk = (await req('GET','/api/token')).json;
    const H = { 'X-FlowTask-Token': tk.token, 'Content-Type':'application/json' };

    /* 1) 建账户 → 应同步到 team/ */
    const t0 = Date.now();
    await req('POST','/api/db?file=flowtask_auth.json', H, JSON.stringify({ meta:{rev:1,lastSaved:Date.now()}, users:[
      { id:UID, username:'smoke_probe', name:'冒烟', role:'admin', salt:SALT, passHash:HASH, active:true, createdAt:Date.now() } ]}));
    let teamAuth = null;
    for(let i=0;i<40;i++){ const f = path.join(SHARE,'team','flowtask_auth.json'); if(fs.existsSync(f)){ track(path.join(SHARE,'team','flowtask_auth.json')); teamAuth = f; break; } await sleep(250); }
    ok(!!teamAuth, '账户表已镜像到 team\\flowtask_auth.json');
    console.log('  ⓘ 写入到出现在共享盘 ≈ ' + (Date.now()-t0) + 'ms（含 3s 去抖）');
    ok(fs.existsSync(path.join(SHARE,'team')), 'track team 目录'); track(path.join(SHARE,'team'));

    /* 2) 登录 → 个人库推拉 */
    const ch = await req('GET','/api/auth-challenge?username=smoke_probe', H);
    const ver = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(ch.json.salt), 100000, 32, 'sha256').toString('hex');
    const se = await req('POST','/api/session', H, JSON.stringify({ uid: ch.json.uid, verifier: ver }));
    ok(se.status === 200, '冒烟账号登录成功（登录时会做一次定向拉取）');
    const HS = { 'X-FlowTask-Token': tk.token, 'X-FlowTask-Session': se.json.session, 'Content-Type':'application/json' };

    const rows = []; for(let i=0;i<400;i++) rows.push({ id:'t_'+i, title:'冒烟任务 '+i, projectId:'p_smoke', notes:'内容样本'.repeat(10) });
    const t1 = Date.now();
    const w = await req('POST','/api/db?file=flowtask_data_'+UID+'.json', HS,
      JSON.stringify({ meta:{rev:2,lastSaved:Date.now()}, projects:[{id:'p_smoke',name:'冒烟项目',memberIds:[UID],scope:'personal'}], tasks: rows }));
    ok(w.status === 200, '保存个人库（约 ' + Math.round(JSON.stringify(rows).length/1024) + 'KB 任务数据）');
    const mirror = path.join(SHARE,'users',UID,'flowtask_data_'+UID+'.json');
    let got = null;
    for(let i=0;i<40;i++){ if(fs.existsSync(mirror)){ got = JSON.parse(fs.readFileSync(mirror,'utf8')); break; } await sleep(250); }
    track(mirror); track(path.join(SHARE,'users',UID)); track(path.join(SHARE,'users'));
    ok(!!got && got.tasks.length === 400, '个人库已镜像到 users\\' + UID + '\\ 且 400 条任务完整');
    console.log('  ⓘ 本机保存到共享盘可见 ≈ ' + (Date.now()-t1) + 'ms');

    /* 3) 状态端点 */
    const st = await req('GET','/api/sync', HS);
    ok(st.json && st.json.enabled === true, '/api/sync 报告同步已开启');
    ok(st.json.status.reachable === true, '真共享盘视角：可达');
    console.log('  ⓘ 每文件同步记录 =', JSON.stringify(st.json.status.files.map(f => f.name + ':' + f.lastResult)));

    /* 4) 手动立即同步（无变化 → 全 noop） */
    const m = await req('POST','/api/sync', HS, JSON.stringify({ mode:'auto' }));
    ok(m.status === 200, '手动「立即同步」可用');
    ok((m.json.results||[]).every(r => r.action === 'noop' || r.action === 'ignored' || r.action === 'pull'), '无新改动时不产生多余写入：' + m.json.results.map(r=>r.name+'='+r.action).join(','));

    /* 5) 跨机锁：手工放一把新鲜锁，看 team 写入是否被挡住 */
    const lockDir = path.join(SHARE,'locks'); const lockF = path.join(lockDir,'flowtask_shared.json.lock');
    fs.mkdirSync(lockDir, { recursive: true }); track(lockF); track(lockDir);
    fs.writeFileSync(lockF, JSON.stringify({ owner:'u_other_pc', host:'OTHER', pid:1234, ts: Date.now() }));
    await req('POST','/api/db?file=flowtask_shared.json', HS, JSON.stringify({ meta:{rev:1,lastSaved:Date.now()}, projects:[{id:'p_s',name:'共享项目',scope:'shared',memberIds:[UID]}], tasks:[] }));
    let pushed = false;
    for(let i=0;i<24;i++){ if(fs.existsSync(path.join(SHARE,'team','flowtask_shared.json'))){ pushed = true; break; } await sleep(250); }
    ok(!pushed, '别的机器正持锁时，本机不写 team\\flowtask_shared.json（实测 6s 内未出现）');
    /* 换成过期锁 → 应能抢占 */
    fs.writeFileSync(lockF, JSON.stringify({ owner:'u_dead', host:'OLD', pid:1, ts: Date.now() - 120000 }));
    await req('POST','/api/db?file=flowtask_shared.json', HS, JSON.stringify({ meta:{rev:2,lastSaved:Date.now()+1}, projects:[{id:'p_s',name:'共享项目',scope:'shared',memberIds:[UID]}], tasks:[] }));
    let gotShared = null;
    for(let i=0;i<40;i++){ const f = path.join(SHARE,'team','flowtask_shared.json'); if(fs.existsSync(f)){ gotShared = f; break; } await sleep(250); }
    track(path.join(SHARE,'team','flowtask_shared.json'));
    ok(!!gotShared, '持锁进程超时后本机抢占成功并写入');
    ok(!fs.existsSync(lockF), '写入完成后锁已释放');

    /* 6) 真冲突 → 双方留底 */
    const cfDir = path.join(SHARE,'conflict'); track(cfDir);
    fs.mkdirSync(cfDir, { recursive: true });
    const cfBefore = new Set(fs.existsSync(cfDir) ? fs.readdirSync(cfDir) : []);
    fs.writeFileSync(path.join(SHARE,'users',UID,'flowtask_data_'+UID+'.json'),
      JSON.stringify({ meta:{rev:2,lastSaved:Date.now()+999999}, projects:[{id:'p_x',name:'别人那台机器的版本'}], tasks:[] }), 'utf8');
    const r2 = await req('POST','/api/sync', HS, JSON.stringify({ mode:'auto' }));
    const conflictFiles = fs.existsSync(cfDir) ? fs.readdirSync(cfDir) : [];
    /* 引擎自己写进 conflict\ 的留底也要登记，否则收尾时目录非空删不掉，会在共享盘上留下垃圾 */
    for(const f of conflictFiles) if(!cfBefore.has(f)) track(path.join(cfDir, f));
    ok(conflictFiles.length >= 2, '同版本不同内容 → conflict\\ 下双方各留一份底（' + conflictFiles.join(' , ') + '）');
    const localNow = JSON.parse(fs.readFileSync(path.join(dataDir,'flowtask_data_'+UID+'.json'),'utf8'));
    ok(localNow.projects[0].name === '别人那台机器的版本', '冲突后本机采用时间戳更新的一方，本机版本已在留底里');
    ok((r2.json.changedLocal||[]).length > 0, '响应告知页面哪些文件被换过：' + JSON.stringify(r2.json.changedLocal));

    console.log('\n== 真共享盘冒烟：' + pass + ' 通过，' + fail + ' 失败 ==');
  }catch(e){
    fail++; console.log('  FAIL  冒烟异常：' + ((e && e.stack) || e));
  }finally{
    try{ srv.kill(); }catch(e){}
    await sleep(400);
    /* 精确清理：只碰本探针登记过、且开跑前不存在的路径。
       文件直接删；目录只在「空」的时候删——万一共享盘上本来就有别人的数据
       （--allow-nonempty 场景），绝不递归删掉不属于本次的东西。 */
    const preexisting = new Set(before.map(x => path.join(SHARE, x)));
    const removed = [], kept = [];
    for(const p of created.slice().sort((a,b) => b.length - a.length)){
      if(preexisting.has(p)){ kept.push(path.basename(p) + '(开跑前就有)'); continue; }
      if(!fs.existsSync(p)) continue;
      try{
        if(fs.statSync(p).isDirectory()){
          fs.rmdirSync(p);                              // 非空会抛 ENOTEMPTY，正是我们要的保守行为
          removed.push(path.basename(p) + '\\');
        }else{
          fs.rmSync(p, { force: true });
          removed.push(path.basename(p));
        }
      }catch(e){
        if(e && e.code === 'ENOTEMPTY'){ kept.push(path.basename(p) + '\\(非空保留)'); }
        else { console.log('  ⚠ 清理失败 ' + p + ' → ' + (e && e.code)); fail++; }
      }
    }
    console.log('清理：', removed.join(' , ') || '(无)');
    if(kept.length) console.log('保留：', kept.join(' , '));
    const after = fs.readdirSync(SHARE);
    console.log('共享盘收尾内容 =', after.length ? after.join(' | ') : '(空)');
    try{ fs.rmSync(dataDir, { recursive:true, force:true }); }catch(e){}
    process.exit(fail ? 1 : 0);
  }
})();
