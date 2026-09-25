/*
 * 共享盘同步集成测试：起两个真实服务端实例，用两个独立数据目录 + 同一个共享盘目录，
 * 验证「A 机建的账号和数据，B 机登录后能拉回来」（本地优先 · 资料跟着账户走）。
 * 用法： node tests/sync_integration.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'flowtask_server.js');
const PORT_A = 5301, PORT_B = 5302;
const PW = 'Integrate#2026', SALT = 's_it_1';
const HASH = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(SALT), 100000, 32, 'sha256').toString('hex');

let passed = 0, failed = 0;
function ok(c, label){ if(c){ passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label); } }
function eq(a, b, label){ ok(String(a) === String(b), label + '  (实际=' + a + ' 期望=' + b + ')'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function mkd(tag){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-it-' + tag + '-')); }
function req(port, method, p, headers, body){
  return new Promise((resolve, reject) => {
    const r = http.request({ host:'127.0.0.1', port, path:p, method,
      headers: Object.assign({ Origin: 'http://127.0.0.1:' + port }, headers || {}) }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let j = null; try{ j = JSON.parse(d); }catch(e){}
        resolve({ status: res.statusCode, text: d, json: j, headers: res.headers });
      });
    });
    r.on('error', reject); r.end(body);
  });
}
async function waitUp(port, label){
  for(let i = 0; i < 80; i++){
    try{ const r = await req(port, 'GET', '/api/ping'); if(r.status === 200) return r.json; }catch(e){}
    await sleep(250);
  }
  throw new Error(label + ' 起不来');
}
function start(port, dataDir, shareDir){
  const c = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      FLOWTASK_PORT: String(port), FLOWTASK_HOST: '127.0.0.1',
      FLOWTASK_DATA_DIR: dataDir, FLOWTASK_SHARE_DIR: shareDir
    }), stdio: ['ignore', 'pipe', 'pipe']
  });
  c.stdout.on('data', () => {}); c.stderr.on('data', d => console.log('[srv' + port + '-err] ' + d));
  return c;
}
const kids = [];
function cleanup(kids_, dirs){
  for(const k of kids_) { try{ k.kill(); }catch(e){} }
  for(const d of dirs) try{ fs.rmSync(d, { recursive: true, force: true }); }catch(e){}
}

(async () => {
  const share = mkd('share'), dataA = mkd('dataA'), dataB = mkd('dataB');
  try{
    console.log('== 场景：两台机器 + 同一个共享盘 ==');
    const A = start(PORT_A, dataA, share); kids.push(A);
    const upA = await waitUp(PORT_A, 'A 机服务');
    eq(upA.ok, 'true', 'A 机服务已启动');

    const tkA = (await req(PORT_A, 'GET', '/api/token')).json;
    const HA = { 'X-FlowTask-Token': tkA.token, 'Content-Type': 'application/json' };

    /* 1) A 机注册唯一账户（A 档：账户表由管理员建，这里先建第一个 admin） */
    const uid = 'u_it_001';
    const authBody = JSON.stringify({ meta: { rev: 1, lastSaved: Date.now() }, users: [
      { id: uid, username: 'alice', name: '爱丽丝', role: 'admin', salt: SALT, passHash: HASH, active: true, createdAt: Date.now() }
    ]});
    const wAuth = await req(PORT_A, 'POST', '/api/db?file=flowtask_auth.json', HA, authBody);
    eq(wAuth.status, 200, 'A 机写入账户表');

    /* 2) A 机登录（挑战 → 证明 → 会话） */
    const ch = await req(PORT_A, 'GET', '/api/auth-challenge?username=alice', HA);
    eq(ch.status, 200, 'A 机登录挑战成功');
    const ver = 'p1$' + crypto.pbkdf2Sync(Buffer.from(PW), Buffer.from(ch.json.salt), 100000, 32, 'sha256').toString('hex');
    const se = await req(PORT_A, 'POST', '/api/session', HA, JSON.stringify({ uid: ch.json.uid, verifier: ver }));
    eq(se.status, 200, 'A 机会话签发成功');
    const sesA = { 'X-FlowTask-Token': tkA.token, 'X-FlowTask-Session': se.json.session, 'Content-Type': 'application/json' };

    /* 3) A 机保存个人库（带一个项目），等去抖推送落到共享盘 */
    const personal = JSON.stringify({ meta: { rev: 2, lastSaved: Date.now() },
      projects: [{ id: 'p_alice', name: 'A 机建的项目', memberIds: [uid], scope: 'personal' }],
      tasks: [{ id: 't_alice', projectId: 'p_alice', title: 'A 机建的任务' }] });
    const wP = await req(PORT_A, 'POST', '/api/db?file=flowtask_data_' + uid + '.json', sesA, personal);
    eq(wP.status, 200, 'A 机保存个人库');
    ok(fs.existsSync(path.join(dataA, 'flowtask_data_' + uid + '.json')), '本地优先：数据先落在 A 机自己的数据目录');

    let mirrored = null;
    for(let i = 0; i < 40; i++){
      const f = path.join(share, 'users', uid, 'flowtask_data_' + uid + '.json');
      if(fs.existsSync(f)){ mirrored = JSON.parse(fs.readFileSync(f, 'utf8')); break; }
      await sleep(250);
    }
    ok(!!mirrored, '去抖推送后，共享盘出现 users/<uid>/ 镜像');
    eq(mirrored && mirrored.projects[0].name, 'A 机建的项目', '镜像内容就是本机那份');
    const teamAuth = path.join(share, 'team', 'flowtask_auth.json');
    let hasTeamAuth = false;
    for(let i = 0; i < 40; i++){ if(fs.existsSync(teamAuth)){ hasTeamAuth = true; break; } await sleep(250); }
    ok(hasTeamAuth, '账户表同步到 team/flowtask_auth.json');

    /* 4) A 机状态查询 */
    const st = await req(PORT_A, 'GET', '/api/sync', sesA);
    eq(st.json.enabled, 'true', 'A 机 /api/sync 报告同步已开启');
    eq(st.json.status.reachable, 'true', 'A 机视角：共享盘可达');
    const noAuth = await req(PORT_A, 'GET', '/api/sync', { 'X-FlowTask-Token': tkA.token });
    eq(noAuth.status, 401, '未登录不能查询同步状态');

    /* 5) B 机（换电脑）启动 → 登录同一账户 → 数据应被拉回 */
    const B = start(PORT_B, dataB, share); kids.push(B);
    await waitUp(PORT_B, 'B 机服务');
    ok(!fs.existsSync(path.join(dataB, 'flowtask_data_' + uid + '.json')), 'B 机一开始确实没有这份个人库（模拟新电脑）');
    const tkB = (await req(PORT_B, 'GET', '/api/token')).json;
    const HB = { 'X-FlowTask-Token': tkB.token, 'Content-Type': 'application/json' };
    const chB = await req(PORT_B, 'GET', '/api/auth-challenge?username=alice', HB);
    eq(chB.status, 200, 'B 机靠共享盘同步过来的账户表认出了这个账户');
    const seB = await req(PORT_B, 'POST', '/api/session', HB, JSON.stringify({ uid: chB.json.uid, verifier: ver }));
    eq(seB.status, 200, 'B 机登录成功');
    const sesB = { 'X-FlowTask-Token': tkB.token, 'X-FlowTask-Session': seB.json.session, 'Content-Type': 'application/json' };
    ok(fs.existsSync(path.join(dataB, 'flowtask_data_' + uid + '.json')), '登录时已把个人库从共享盘拉回 B 机本地');
    const readB = await req(PORT_B, 'GET', '/api/db?file=flowtask_data_' + uid + '.json', sesB);
    eq(readB.status, 200, 'B 机能读到自己的库');
    eq(readB.json.projects[0].name, 'A 机建的项目', 'B 机读到的就是 A 机建的那个项目（资料跟着账户走）');
    eq(String(readB.json.meta.rev), '2', '拉回的版本号与共享盘一致');

    /* 6) B 机改一版并推送 → 共享盘版本前进 */
    const personalB = JSON.stringify({ meta: { rev: 3, lastSaved: Date.now() + 1000 },
      projects: [{ id: 'p_alice', name: 'B 机改了项目名', memberIds: [uid], scope: 'personal' }], tasks: [] });
    const wB = await req(PORT_B, 'POST', '/api/db?file=flowtask_data_' + uid + '.json', sesB, personalB);
    eq(wB.status, 200, 'B 机保存改动');
    let advanced = false;
    for(let i = 0; i < 40; i++){
      const m = JSON.parse(fs.readFileSync(path.join(share, 'users', uid, 'flowtask_data_' + uid + '.json'), 'utf8'));
      if(m.meta.rev === 3){ advanced = true; break; }
      await sleep(250);
    }
    ok(advanced, '共享盘镜像跟到第 3 版（B 机的改动推上去了）');

    /* 7) 真冲突：让共享盘停在同版本不同内容上，看是否双方留底且不静默覆盖 */
    const conflictShare = path.join(share, 'users', uid, 'flowtask_data_' + uid + '.json');
    fs.writeFileSync(conflictShare, JSON.stringify({ meta: { rev: 3, lastSaved: Date.now() + 99999 },
      projects: [{ id: 'p_other', name: '第三方版本' }], tasks: [] }), 'utf8');
    const manual = await req(PORT_B, 'POST', '/api/sync', sesB, JSON.stringify({ mode: 'pull' }));
    eq(manual.status, 200, '手动立即同步可用');
    const cf = fs.existsSync(path.join(share, 'conflict')) ? fs.readdirSync(path.join(share, 'conflict')) : [];
    ok(cf.length >= 2, '同版本不同内容 → 本机与对方各留一份底（找到 ' + cf.length + ' 个留底文件）');
    const afterB = JSON.parse(fs.readFileSync(path.join(dataB, 'flowtask_data_' + uid + '.json'), 'utf8'));
    eq(afterB.projects[0].name, '第三方版本', '冲突时按时间戳晚的一方（对方）为准，本机那份已留底');
    ok((manual.json.changedLocal || []).indexOf('flowtask_data_' + uid + '.json') >= 0,
       '响应告诉页面「本机这份被换了」，页面据此重读');

    /* 8) 关掉共享盘开关 → 行为回到纯本机，且不影响读写 */
    const offDir = mkd('off');
    const C = start(5303, offDir, ''); kids.push(C);
    await waitUp(5303, '纯本机服务');
    const stC = await req(5303, 'GET', '/api/sync', { 'X-FlowTask-Token': (await req(5303, 'GET', '/api/token')).json.token });
    eq(stC.status, 401, '纯本机模式下同步状态接口同样要登录');
    eq(fs.existsSync(path.join(share, 'users', uid)), 'true', '共享盘内容不受纯本机实例影响');
  }catch(e){
    failed++;
    console.log('  FAIL  集成测试异常：' + ((e && e.stack) || e));
  }finally{
    cleanup(kids, [share, dataA, dataB]);
  }
  console.log('\n== 共享盘集成测试结果：' + passed + ' 通过，' + failed + ' 失败 ==');
  process.exit(failed ? 1 : 0);
})();
