/*
 * 共享盘同步 · 双服务端对等测试
 * 同一套同步场景分别跑在 Node 版与 PowerShell 版上，断言两者行为逐条一致。
 * 用法：node tests/sync_parity.js          （两个实现都跑）
 *       node tests/sync_parity.js node|ps1  （只跑一个）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name, cond, extra){
  if(cond){ passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function req(base, method, p, headers, body){
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const h = Object.assign({ Origin: base }, headers || {});
    if(body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ hostname:u.hostname, port:u.port, path:u.pathname + u.search, method, headers:h }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status:res.statusCode, text:d, json:(() => { try{ return JSON.parse(d); }catch(e){ return null; } })() }));
    });
    r.on('error', reject); if(body) r.write(body); r.end();
  });
}
async function waitUp(base){
  for(let i = 0; i < 120; i++){ try{ const r = await req(base, 'GET', '/api/ping'); if(r.status === 200) return true; }catch(e){} await sleep(250); }
  return false;
}
async function waitFor(fn, ms){
  const t0 = Date.now();
  while(Date.now() - t0 < (ms || 12000)){ if(fn()) return true; await sleep(250); }
  return false;
}
function start(which, port, dataDir, shareDir){
  if(which === 'node'){
    const env = Object.assign({}, process.env, { FLOWTASK_PORT:String(port), FLOWTASK_HOST:'127.0.0.1',
      FLOWTASK_DATA_DIR:dataDir });
    /* 不传 shareDir 时必须把环境变量清掉，否则测试会继承调用者的真实配置 */
    if(shareDir) env.FLOWTASK_SHARE_DIR = shareDir; else delete env.FLOWTASK_SHARE_DIR;
    return spawn(process.execPath, [path.join(ROOT, 'flowtask_server.js')], { env, stdio:'ignore', windowsHide:true });
  }
  const psArgs = ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'flowtask_server.ps1'),
    '-Port', String(port), '-HostIP', '127.0.0.1', '-DataDir', dataDir];
  const psEnv = Object.assign({}, process.env);
  if(shareDir){ psArgs.push('-ShareDir', shareDir); } else { delete psEnv.FLOWTASK_SHARE_DIR; }
  return spawn('powershell', psArgs, { stdio:'ignore', windowsHide:true, env: psEnv });
}
function killAll(kids){ for(const k of kids){ try{ k.kill(); }catch(e){} } }
function mkd(t){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sp-' + t + '-')); }
/* Windows 上同一个目录可能有 8.3 短名与长名两种写法（os.tmpdir() 给短名，PS 版服务
   用 Get-Item .FullName 会规范化成长名），所以目录等价必须交给系统去解。
   注意：fs.realpathSync 是 libuv 自己算的、不展开 8.3；只有 .native 走 GetFinalPathNameByHandle */
function sameDir(a, b){
  if(!a || !b) return false;
  const real = p => {
    const s = String(p).replace(/[\\/]+$/, '');
    try{ return (fs.realpathSync.native ? fs.realpathSync.native(s) : fs.realpathSync(s)); }
    catch(e){ try{ return fs.realpathSync(s); }catch(_e){ return path.resolve(s); } }
  };
  return real(a).toLowerCase() === real(b).toLowerCase();
}
function readJ(f){ try{ return JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ return null; } }
function writeF(f, obj){ fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj), 'utf8'); }

const PW = 'Parity#2026', SALT = 's_pp_1', UID = 'u_pp';
const HASH = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(SALT), 100000, 32, 'sha256').toString('hex');

async function suite(which, port){
  const base = 'http://127.0.0.1:' + port;
  const L = `[${which}]`;
  const dataDir = mkd('data'), shareDir = mkd('share');
  const kids = [];
  try{
    let kid = start(which, port, dataDir, shareDir); kids.push(kid);
    ok(`${L} 服务启动（已配置共享盘）`, await waitUp(base));

    const tk = (await req(base, 'GET', '/api/token')).json;
    const T = { 'X-FlowTask-Token': tk.token, 'Content-Type': 'application/json' };

    /* 1. 同步状态接口也要鉴权 */
    ok(`${L} 无令牌查同步状态 → 403`, (await req(base, 'GET', '/api/sync', {})).status === 403);
    ok(`${L} 有令牌无会话 → 401`, (await req(base, 'GET', '/api/sync', { 'X-FlowTask-Token': tk.token })).status === 401);
    ok(`${L} 无令牌手动同步 → 403`, (await req(base, 'POST', '/api/sync', {}, '{}')).status === 403);

    /* 2. 账户表写入 → 镜像到 team\ */
    const authV1 = { meta:{ rev:1, lastSaved:Date.now() }, users:[
      { id:UID, username:'ppuser', name:'对等', role:'admin', salt:SALT, passHash:HASH, active:true, createdAt:Date.now() }] };
    ok(`${L} 写账户表 200`, (await req(base, 'POST', '/api/db?file=flowtask_auth.json', T, JSON.stringify(authV1))).status === 200);
    const teamAuth = path.join(shareDir, 'team', 'flowtask_auth.json');
    ok(`${L} 账户表镜像到 team\\`, await waitFor(() => fs.existsSync(teamAuth)));
    ok(`${L} 镜像里就是那一个用户`, readJ(teamAuth) && readJ(teamAuth).users.length === 1 && readJ(teamAuth).users[0].username === 'ppuser',
       JSON.stringify(readJ(teamAuth) || {}).slice(0,90));

    /* 3. 登录 → 拿会话 */
    const ch = await req(base, 'GET', '/api/auth-challenge?username=ppuser', T);
    ok(`${L} 登录挑战 200`, ch.status === 200 && ch.json && ch.json.uid === UID);
    const ver = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(ch.json.salt), 100000, 32, 'sha256').toString('hex');
    const se = await req(base, 'POST', '/api/session', T, JSON.stringify({ uid:UID, verifier:ver }));
    ok(`${L} 会话签发 200`, se.status === 200 && !!se.json.session);
    const S = { 'X-FlowTask-Token': tk.token, 'X-FlowTask-Session': se.json.session, 'Content-Type': 'application/json' };

    /* 4. 个人库 → 镜像到 users\<uid>\ */
    const pf = 'flowtask_data_' + UID + '.json';
    const mirror = path.join(shareDir, 'users', UID, pf);
    ok(`${L} 写个人库 200`, (await req(base, 'POST', '/api/db?file=' + pf, S,
      JSON.stringify({ meta:{ rev:2, lastSaved:Date.now() }, projects:[{ id:'p1', name:'对等项目', memberIds:[UID] }], tasks:[] }))).status === 200);
    ok(`${L} 个人库镜像到 users\\<uid>\\`, await waitFor(() => fs.existsSync(mirror)));
    ok(`${L} 镜像版本号 = 2`, readJ(mirror) && readJ(mirror).meta.rev === 2);
    ok(`${L} 本机数据目录里也有这份（本地优先）`, fs.existsSync(path.join(dataDir, pf)));

    /* 5. 状态可查 */
    const st = await req(base, 'GET', '/api/sync', S);
    ok(`${L} /api/sync enabled=true`, st.status === 200 && st.json.enabled === true);
    ok(`${L} /api/sync reachable=true`, st.json.status && st.json.status.reachable === true, JSON.stringify(st.json.status || {}).slice(0,120));
    ok(`${L} status.files 是数组且含两份文件`, Array.isArray(st.json.status.files)
       && st.json.status.files.some(f => f.name === 'flowtask_auth.json')
       && st.json.status.files.some(f => f.name === pf), JSON.stringify(st.json.status.files || []).slice(0,160));

    /* 6. 别的机器正持锁 → team 不写 */
    const lockDir = path.join(shareDir, 'locks'); fs.mkdirSync(lockDir, { recursive: true });
    const lockF = path.join(lockDir, 'flowtask_shared.json.lock');
    fs.writeFileSync(lockF, JSON.stringify({ owner:'u_other', host:'OTHERPC', pid:999, ts:Date.now() }), 'utf8');
    const teamShared = path.join(shareDir, 'team', 'flowtask_shared.json');
    await req(base, 'POST', '/api/db?file=flowtask_shared.json', S,
      JSON.stringify({ meta:{ rev:1, lastSaved:Date.now() }, projects:[{ id:'s1', name:'被锁挡住的共享项目', scope:'shared', memberIds:[UID] }], tasks:[] }));
    const appearedWhileLocked = await waitFor(() => fs.existsSync(teamShared), 6000);
    ok(`${L} 新鲜锁未超时 → 本轮不写 team\\`, !appearedWhileLocked);
    fs.rmSync(lockF, { force: true });

    /* 7. 陈旧锁 → 抢占后写入 */
    fs.writeFileSync(lockF, JSON.stringify({ owner:'u_dead', host:'OLDPC', pid:1, ts:Date.now() - 120000 }), 'utf8');
    await req(base, 'POST', '/api/db?file=flowtask_shared.json', S,
      JSON.stringify({ meta:{ rev:2, lastSaved:Date.now() + 1 }, projects:[{ id:'s1', name:'抢到锁后写入', scope:'shared', memberIds:[UID] }], tasks:[] }));
    ok(`${L} 锁超时 → 抢占成功并写入 team\\`, await waitFor(() => fs.existsSync(teamShared)));
    ok(`${L} 写完释放锁`, await waitFor(() => !fs.existsSync(lockF)));
    ok(`${L} 共享库镜像版本号 = 2`, readJ(teamShared) && readJ(teamShared).meta.rev === 2, JSON.stringify(readJ(teamShared) || {}).slice(0,90));

    /* 8. 手动立即同步：无新改动 → 不产生多余写入 */
    const man = await req(base, 'POST', '/api/sync', S, JSON.stringify({ mode:'auto' }));
    ok(`${L} POST /api/sync 200`, man.status === 200 && man.json.ok === true);
    ok(`${L} 内容未变时全是 noop`, Array.isArray(man.json.results)
       && man.json.results.every(r => r.action === 'noop' || r.action === 'ignored'),
       JSON.stringify(man.json.results || []).slice(0,200));
    ok(`${L} changedLocal 是数组`, Array.isArray(man.json.changedLocal), typeof man.json.changedLocal);

    /* 9. 真冲突：同版本不同内容 → 双方留底 + 晚者胜 + 通知页面重读 */
    writeF(mirror, { meta:{ rev:2, lastSaved:Date.now() + 900000 }, projects:[{ id:'p_other', name:'另一台机器的版本' }], tasks:[] });
    const cf = await req(base, 'POST', '/api/sync', S, JSON.stringify({ mode:'auto' }));
    ok(`${L} 冲突被判为拉取方向`, cf.status === 200 && (cf.json.results || []).some(r => r.name === pf && r.action === 'pull'),
       JSON.stringify(cf.json.results || []).slice(0,220));
    const conflictDir = path.join(shareDir, 'conflict');
    ok(`${L} conflict\\ 下双方各留一份底`, fs.existsSync(conflictDir) && fs.readdirSync(conflictDir).length >= 2,
       fs.existsSync(conflictDir) ? fs.readdirSync(conflictDir).join(' , ') : '(目录不存在)');
    ok(`${L} 本机采用晚的一方`, readJ(path.join(dataDir, pf)) && readJ(path.join(dataDir, pf)).projects[0].name === '另一台机器的版本');
    ok(`${L} changedLocal 报告被换掉的文件`, (cf.json.changedLocal || []).indexOf(pf) >= 0, JSON.stringify(cf.json.changedLocal));

    /* 10. 对方那份是坏的 → 不覆盖、不拉回、本机不动 */
    fs.writeFileSync(mirror, '{ 这不是合法 JSON', 'utf8');
    const beforeLocal = fs.readFileSync(path.join(dataDir, pf), 'utf8');
    const bad = await req(base, 'POST', '/api/sync', S, JSON.stringify({ mode:'auto' }));
    ok(`${L} 坏远端 → invalid-remote`, (bad.json.results || []).some(r => r.name === pf && r.action === 'invalid-remote'),
       JSON.stringify(bad.json.results || []).slice(0,220));
    ok(`${L} 坏远端原样保留`, fs.readFileSync(mirror, 'utf8').indexOf('这不是合法') >= 0);
    ok(`${L} 本机文件未被改动`, fs.readFileSync(path.join(dataDir, pf), 'utf8') === beforeLocal);

    /* 11. 共享盘「读不到」≠「不存在」：目标位置是个目录 → hold 且标记不可达 */
    fs.rmSync(mirror, { force: true });
    fs.mkdirSync(mirror, { recursive: true });
    const hold = await req(base, 'POST', '/api/sync', S, JSON.stringify({ mode:'auto' }));
    ok(`${L} 读失败 → hold（不当作「没有」乱推）`, (hold.json.results || []).some(r => r.name === pf && r.action === 'hold'),
       JSON.stringify(hold.json.results || []).slice(0,220));
    ok(`${L} 读失败后状态标记不可达`, hold.json.status.reachable === false, JSON.stringify(hold.json.status).slice(0,140));
    ok(`${L} 状态里留下错误线索`, /share-read/.test(String(hold.json.status.lastError)), String(hold.json.status.lastError).slice(0,90));
    fs.rmSync(mirror, { recursive: true, force: true });

    /* 12. 开机续传的边界：只替「本机服务过的人」续传，绝不把同事的个人库拉过来；
           个人库的真正恢复时机是登录（见 sync_integration 的新电脑场景） */
    killAll(kids); kids.length = 0; await sleep(900);
    writeF(mirror, { meta:{ rev:7, lastSaved:Date.now() + 5000 }, projects:[{ id:'p_boot', name:'等待登录续传的项目' }], tasks:[] });
    const foreign = path.join(shareDir, 'users', 'u_other_person', 'flowtask_data_u_other_person.json');
    writeF(foreign, { meta:{ rev:9, lastSaved:Date.now() }, projects:[{ id:'p_secret', name:'别人的个人库' }], tasks:[] });
    fs.rmSync(path.join(dataDir, pf), { force: true });
    kid = start(which, port + 100, dataDir, shareDir); kids.push(kid);
    const b2 = 'http://127.0.0.1:' + (port + 100);
    ok(`${L} 重启后服务就绪`, await waitUp(b2));
    await sleep(1200);
    ok(`${L} 开机不会把同事的个人库拉到本机（隐私边界）`,
       !fs.existsSync(path.join(dataDir, 'flowtask_data_u_other_person.json')), fs.readdirSync(dataDir).join(' | '));
    const tkB = (await req(b2, 'GET', '/api/token')).json;
    const HB = { 'X-FlowTask-Token': tkB.token, 'Content-Type': 'application/json' };
    const chB = await req(b2, 'GET', '/api/auth-challenge?username=ppuser', HB);
    const seB = await req(b2, 'POST', '/api/session', HB, JSON.stringify({ uid:UID, verifier:ver }));
    ok(`${L} 重启后可再次登录`, seB.status === 200 && !!seB.json.session);
    ok(`${L} 登录把个人库从共享盘拉回本机`, fs.existsSync(path.join(dataDir, pf))
       && readJ(path.join(dataDir, pf)).projects[0].name === '等待登录续传的项目');
    ok(`${L} 拉回的版本号 = 7`, readJ(path.join(dataDir, pf)).meta.rev === 7);
    ok(`${L} 登录后也只拉自己那份`, !fs.existsSync(path.join(dataDir, 'flowtask_data_u_other_person.json')));

    /* 13. 关掉共享盘开关 → enabled=false，读写照常（行为回退到纯本机） */
    killAll(kids); kids.length = 0; await sleep(700);
    const offDir = mkd('off');
    kid = start(which, port + 200, offDir, ''); kids.push(kid);
    const offBase = 'http://127.0.0.1:' + (port + 200);
    ok(`${L} 纯本机实例启动`, await waitUp(offBase));
    const tk2 = (await req(offBase, 'GET', '/api/token')).json;
    const ch2 = await req(offBase, 'GET', '/api/auth-challenge?username=x', { 'X-FlowTask-Token': tk2.token, 'Content-Type':'application/json' });
    ok(`${L} 未配置共享盘时 /api/sync 仍要登录`, (await req(offBase, 'GET', '/api/sync', { 'X-FlowTask-Token': tk2.token })).status === 401);
    ok(`${L} 账户表读写不受影响`, (await req(offBase, 'POST', '/api/db?file=flowtask_auth.json',
      { 'X-FlowTask-Token': tk2.token, 'Content-Type':'application/json' }, JSON.stringify({ meta:{ rev:1, lastSaved:Date.now() }, users:[] }))).status === 200);
    ok(`${L} 纯本机模式下不产生同步状态文件`, !fs.existsSync(path.join(offDir, 'flowtask_sync.json')),
       fs.readdirSync(offDir).join(' | '));
    /* 14. 路径打错时绝不能"自己造个目录假装已同步"（Node 会 mkdir、PS 会 New-Item，两边都得挡住） */
    const ghost = path.join(os.tmpdir(), 'ft-ghost-' + which + '-' + Date.now());
    const ghostDir = mkd('ghostdata');
    const kid4 = start(which, port + 300, ghostDir, ghost); kids.push(kid4);
    const gBase = 'http://127.0.0.1:' + (port + 300);
    ok(`${L} 配了个不存在的路径也能起服务（本地优先）`, await waitUp(gBase));
    const tkG = (await req(gBase, 'GET', '/api/token')).json;
    const HG = { 'X-FlowTask-Token': tkG.token, 'Content-Type': 'application/json' };
    await req(gBase, 'POST', '/api/db?file=flowtask_auth.json', HG, JSON.stringify({
      meta:{ rev:1, lastSaved:Date.now() }, users:[{ id:UID, username:'ppuser', name:'对等', role:'admin', salt:SALT, passHash:HASH, active:true, createdAt:Date.now() }] }));
    await sleep(1500);                       // 给去抖推送足够时间（挡不住就会把目录造出来）
    ok(`${L} 打错的路径没有被凭空创建`, !fs.existsSync(ghost), '共享盘根目录被静默建出来了：' + ghost);
    const chG = await req(gBase, 'GET', '/api/auth-challenge?username=ppuser', HG);
    const verG = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(chG.json.salt), 100000, 32, 'sha256').toString('hex');
    const seG = await req(gBase, 'POST', '/api/session', HG, JSON.stringify({ uid:UID, verifier:verG }));
    const SG = { 'X-FlowTask-Token': tkG.token, 'X-FlowTask-Session': seG.json.session, 'Content-Type': 'application/json' };
    await req(gBase, 'POST', '/api/db?file=' + pf, SG, JSON.stringify({ meta:{ rev:2, lastSaved:Date.now() }, projects:[], tasks:[] }));
    await sleep(1500);
    const gst = await req(gBase, 'GET', '/api/sync', SG);
    ok(`${L} 状态里给出可读的失败原因`, gst.status === 200 && !!gst.json.status.blockReason,
      JSON.stringify(gst.json.status || {}).slice(0, 180));
    ok(`${L} 打错路径时标记为不可达`, gst.json.status.reachable === false);
    ok(`${L} 本机数据完好（本地优先）`, fs.existsSync(path.join(ghostDir, pf)));
    ok(`${L} 仍然没有凭空造出目录`, !fs.existsSync(ghost));
    /* 15. 配置文件这条路：把 flowtask_config.json 放进数据目录，不传任何参数/环境变量也应开启同步。
           同时验证隔离性——配置读的是数据目录，所以测试重定向 DATA_DIR 时不会看到真机的配置，
           跑回归就不可能把测试数据写进生产共享盘。 */
    const cfDir = mkd('cfdata'), cfShare = mkd('cfshare');
    fs.writeFileSync(path.join(cfDir, 'flowtask_config.json'),
      JSON.stringify({ shareDir: cfShare, syncEnabled: true }), 'utf8');
    const kidCf = start(which, port + 400, cfDir, null); kids.push(kidCf);
    const cfBase = 'http://127.0.0.1:' + (port + 400);
    ok(`${L} 仅凭配置文件即可启动`, await waitUp(cfBase));
    const tkCf = (await req(cfBase, 'GET', '/api/token')).json;
    ok(`${L} 服务本身正常`, (await req(cfBase, 'GET', '/api/ping')).status === 200);
    /* 用一个真实写入闭环来证明它确实按配置启用了：账户表会出现在配置文件指定的共享目录里 */
    await req(cfBase, 'POST', '/api/db?file=flowtask_auth.json', { 'X-FlowTask-Token': tkCf.token, 'Content-Type':'application/json' },
      JSON.stringify({ meta:{ rev:1, lastSaved:Date.now() }, users:[] }));
    const cfMirror = path.join(cfShare, 'team', 'flowtask_auth.json');
    ok(`${L} 账户表镜像到了「配置文件里写的」共享目录`, await waitFor(() => fs.existsSync(cfMirror)),
      fs.readdirSync(cfShare).join(' | ') || '(共享目录为空 → 配置没生效)');
    /* 配置的隔离性由「读的是数据目录」这一实现事实保证：上面镜像成功即证明
       配置来自 cfDir（临时数据目录），而不是程序目录 —— 所以测试重定向
       -DataDir 后就不可能读到真机的 flowtask_config.json，回归也不会写进生产共享盘 */
    killAll([kidCf]); await sleep(600);
    /* 关掉开关：syncEnabled=false 时即使写了 shareDir 也不启用 */
    const cfOffDir = mkd('cfoff'), cfOffShare = mkd('cfoff-share');
    fs.writeFileSync(path.join(cfOffDir, 'flowtask_config.json'),
      JSON.stringify({ shareDir: cfOffShare, syncEnabled: false }), 'utf8');
    const kidOff = start(which, port + 450, cfOffDir, null); kids.push(kidOff);
    const offBase2 = 'http://127.0.0.1:' + (port + 450);
    ok(`${L} syncEnabled=false 时服务仍能正常启动`, await waitUp(offBase2));
    const tkOff = (await req(offBase2, 'GET', '/api/token')).json;
    await req(offBase2, 'POST', '/api/db?file=flowtask_auth.json', { 'X-FlowTask-Token': tkOff.token, 'Content-Type':'application/json' },
      JSON.stringify({ meta:{ rev:1, lastSaved:Date.now() }, users:[] }));
    await sleep(1500);
    ok(`${L} syncEnabled=false → 不产生任何同步产物`, !fs.existsSync(path.join(cfOffDir, 'flowtask_sync.json')),
      fs.readdirSync(cfOffDir).join(' | '));
    killAll([kidOff]);
    for(const d of [cfDir, cfShare, cfOffDir, cfOffShare]) { try{ fs.rmSync(d, { recursive:true, force:true }); }catch(e){} }
    /* 16. 界面里改同步文件夹：管理员专属、校验不过退回原路径、改完立刻镜像到新位置。
           自带一套实例/目录/登录 —— 前面的场景会停掉主实例，复用 base 只会连到死端口 */
    const d16 = mkd('cfg16-data'), s16a = mkd('cfg16-shareA'), s16b = mkd('cfg16-shareB');
    const ghost2 = path.join(os.tmpdir(), 'ft-ghost2-' + which + '-' + Date.now());
    const port16 = port + 500, base16 = 'http://127.0.0.1:' + port16;
    const kid16 = start(which, port16, d16, s16a); kids.push(kid16);
    ok(`${L} 改路径场景的实例已启动`, await waitUp(base16));
    const tk16 = (await req(base16, 'GET', '/api/token')).json;
    const H16 = { 'X-FlowTask-Token': tk16.token, 'Content-Type': 'application/json' };
    await req(base16, 'POST', '/api/db?file=flowtask_auth.json', H16, JSON.stringify({ meta:{ rev:1, lastSaved:Date.now() }, users:[
      { id:UID, username:'ppuser', name:'对等', role:'admin', salt:SALT, passHash:HASH, active:true, createdAt:Date.now() }] }));
    const ch16 = await req(base16, 'GET', '/api/auth-challenge?username=ppuser', H16);
    const ver16 = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(ch16.json.salt), 100000, 32, 'sha256').toString('hex');
    const se16 = await req(base16, 'POST', '/api/session', H16, JSON.stringify({ uid:UID, verifier:ver16 }));
    const S16 = { 'X-FlowTask-Token': tk16.token, 'X-FlowTask-Session': se16.json.session, 'Content-Type': 'application/json' };
    await req(base16, 'POST', '/api/db?file=' + pf, S16,
      JSON.stringify({ meta:{ rev:3, lastSaved:Date.now() }, projects:[{ id:'p1', name:'换路径前的项目', memberIds:[UID] }], tasks:[] }));
    ok(`${L} 未登录不能读同步配置`, (await req(base16, 'GET', '/api/sync/config', { 'X-FlowTask-Token': tk16.token })).status === 401);
    ok(`${L} 无令牌不能改同步配置`, (await req(base16, 'POST', '/api/sync/config', { 'Content-Type': 'application/json' }, '{"shareDir":"x"}')).status === 403);
    const cfgGet = await req(base16, 'GET', '/api/sync/config', S16);
    ok(`${L} 管理员可读当前配置`, cfgGet.status === 200, String(cfgGet.status));
    ok(`${L} 当前配置含 shareDir/syncEnabled/openRegistration/envOverride`,
      cfgGet.json && cfgGet.json.config && ['shareDir','syncEnabled','openRegistration','envOverride'].every(k => k in cfgGet.json.config),
      JSON.stringify((cfgGet.json||{}).config || {}));
    /* 改到一个打不开的路径：必须 400 + 说明原因 + 退回原值（既不改运行时也不落盘） */
    const cfgBad = await req(base16, 'POST', '/api/sync/config', S16, JSON.stringify({ shareDir: ghost2 }));
    ok(`${L} 坏路径被拒绝`, cfgBad.status === 400 && cfgBad.json && cfgBad.json.err === 'share unusable', cfgBad.status + ' ' + String(cfgBad.text).slice(0,120));
    ok(`${L} 拒绝时给出人话原因`, cfgBad.json && /不存在|不可达|写不进/.test(String(cfgBad.json.reason)), JSON.stringify((cfgBad.json||{}).reason||''));
    ok(`${L} 拒绝后运行时退回原路径`, sameDir((cfgBad.json.config||{}).shareDir || '', s16a),
      (cfgBad.json.config||{}).shareDir);
    ok(`${L} 拒绝时不凭空创建目录`, !fs.existsSync(ghost2));
    ok(`${L} 拒绝时不落盘（配置里仍是原路径）`, (() => {
      const f = path.join(d16, 'flowtask_config.json');
      return !fs.existsSync(f) || sameDir(String(JSON.parse(fs.readFileSync(f,'utf8')).shareDir||''), s16a);
    })());
    /* 先探后确认：validateOnly 探一个可用目录 → 200，但运行时与配置都必须一点没动 */
    const pre = await req(base16, 'POST', '/api/sync/config', S16, JSON.stringify({ shareDir: s16b, validateOnly:true }));
    ok(`${L} validateOnly 探测可用目录返回有效`, pre.status === 200 && pre.json.valid === true, String(pre.text).slice(0,140));
    const pre2 = await req(base16, 'GET', '/api/sync/config', S16);
    ok(`${L} 探测后运行时仍是原路径（没有被悄悄切走）`,
      sameDir(pre2.json.config.shareDir, s16a), String((pre2.json.config||{}).shareDir));
    ok(`${L} 探测不落盘`, (() => {
      const f = path.join(d16, 'flowtask_config.json');
      return !fs.existsSync(f) || sameDir(String(JSON.parse(fs.readFileSync(f,'utf8')).shareDir||''), s16a);
    })());
    const preBad = await req(base16, 'POST', '/api/sync/config', S16, JSON.stringify({ shareDir: ghost2, validateOnly:true }));
    ok(`${L} validateOnly 探测坏路径给出原因且不改设置`,
      preBad.status === 400 && /不存在|不可达|写不进/.test(String(preBad.json.reason)), String(preBad.text).slice(0,140));
    /* 改到新的可用目录 */
    const okc = await req(base16, 'POST', '/api/sync/config', S16, JSON.stringify({ shareDir: s16b }));
    ok(`${L} 换到新共享盘成功`, okc.status === 200 && sameDir(okc.json.config.shareDir, s16b),
      okc.status + ' ' + String(okc.text).slice(0,140));
    ok(`${L} 新位置已可写`, okc.json.status.reachable === true && !okc.json.status.blockReason, JSON.stringify(okc.json.status||{}).slice(0,140));
    const cfgFile = path.join(d16, 'flowtask_config.json');
    ok(`${L} 配置已落盘到数据目录`, fs.existsSync(cfgFile));
    const savedCfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
    ok(`${L} 落盘内容就是新路径`, sameDir(String(savedCfg.shareDir || ''), s16b), JSON.stringify(savedCfg));
    /* 换路径后写入 → 镜像要出现在新位置 */
    await req(base16, 'POST', '/api/db?file=' + pf, S16,
      JSON.stringify({ meta:{ rev:4, lastSaved:Date.now()+2000 }, projects:[{ id:'p1', name:'换路径后的项目', memberIds:[UID] }], tasks:[] }));
    const mirror2 = path.join(s16b, 'users', UID, pf);
    ok(`${L} 换路径后镜像写入新位置`, await waitFor(() => fs.existsSync(mirror2) && JSON.parse(fs.readFileSync(mirror2,'utf8')).meta.rev === 4),
      '新位置内容 = ' + (fs.existsSync(mirror2) ? String(JSON.parse(fs.readFileSync(mirror2,'utf8')).meta.rev) : '(不存在)'));
    /* 停用同步：运行时立刻关，配置文件保留路径以便再开 */
    const cfgOff = await req(base16, 'POST', '/api/sync/config', S16, JSON.stringify({ syncEnabled:false }));
    ok(`${L} 可一键停用同步`, cfgOff.status === 200 && cfgOff.json.config.syncEnabled === false, String(cfgOff.text).slice(0,140));
    ok(`${L} 停用后运行时不再有路径`, !cfgOff.json.config.activeShareDir, JSON.stringify(cfgOff.json.config));
    ok(`${L} 停用后「配置的意图」仍是原路径（界面输入框不会被抹掉）`,
      sameDir(cfgOff.json.config.shareDir, s16b), String(cfgOff.json.config.shareDir));
    const savedOff = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    ok(`${L} 停用只关开关，路径留在配置里便于再启用`,
      savedOff.syncEnabled === false && sameDir(String(savedOff.shareDir || ''), s16b),
      JSON.stringify(savedOff));
    /* 再开启：不需要重启动服务，也不用重敲路径 */
    const cfgOn = await req(base16, 'POST', '/api/sync/config', S16, JSON.stringify({ syncEnabled:true }));
    ok(`${L} 可再次启用且无需重启`, cfgOn.status === 200 && cfgOn.json.config.syncEnabled === true && cfgOn.json.status.reachable === true,
      String(cfgOn.text).slice(0,160));
    ok(`${L} 只传开关就能重开（路径从配置补回）`,
      cfgOn.status === 200 && sameDir(String(cfgOn.json.config.shareDir || ''), s16b),
      JSON.stringify((cfgOn.json||{}).config || {}));
    killAll([kid16]);
    for(const d of [d16, s16a, s16b]) { try{ fs.rmSync(d, { recursive:true, force:true }); }catch(e){} }
  }catch(e){
    failed++; console.log(`  FAIL  ${L} 场景异常：` + ((e && e.stack) || e));
  }finally{
    killAll(kids); await sleep(500);
    for(const d of [dataDir, shareDir]) { try{ fs.rmSync(d, { recursive:true, force:true }); }catch(e){} }
  }
}

(async () => {
  const which = (process.argv[2] || '').toLowerCase();
  const run = !which || which === 'both' ? ['node', 'ps1'] : [which];
  const ports = { node: 5401, ps1: 5451 };
  for(const w of run){
    console.log(`\n== 共享盘同步对等 · ${w === 'node' ? 'Node 版' : 'PowerShell 版'} ==`);
    await suite(w, ports[w] || 5491);
  }
  console.log(`\n== 双服务端同步对等结果：${passed} 通过，${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
})();
