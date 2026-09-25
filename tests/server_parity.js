/*
 * 双服务端对等测试：同一套场景分别跑在 Node 版与 PowerShell 版存储服务上，
 * 断言两者行为完全一致（v1.5 的账户表 / 个人库 / 共享库 / 会话鉴权 / 幂等）。
 * 用法：node tests/server_parity.js          （两个实现都跑）
 *       node tests/server_parity.js node     （只跑 Node 版）
 *       node tests/server_parity.js ps1      （只跑 PowerShell 版）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, extra){
  if(cond){ passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function req(base, method, p, { body, headers = {} } = {}){
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const h = Object.assign({}, headers);
    if(body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ hostname:u.hostname, port:u.port, path:u.pathname + u.search, method, headers:h }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }));
    });
    r.on('error', reject);
    if(body) r.write(body);
    r.end();
  });
}
async function waitUp(base, tries = 80, gap = 250){
  for(let i = 0; i < tries; i++){
    try{ const r = await req(base, 'GET', '/api/ping'); if(r.status === 200) return true; }catch(e){}
    await sleep(gap);
  }
  return false;
}
const j = s => { try{ return JSON.parse(s); }catch(e){ return {}; } };

/* ---------- 共享场景：对任一实现都适用（dir 传入时追加落盘文件断言，仅本地跑有） ---------- */
async function scenarios(BASE, label, dir){
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-parity-'));
  const data = JSON.stringify({ meta:{ rev:1 }, projects:[{ id:'p1', name:'项目A', memberIds:['u_a'] }], tasks:[], notifications:[] });

  // 令牌
  const tk = await req(BASE, 'GET', '/api/token', { headers:{ Origin: BASE } });
  ok(`[${label}] /api/token 可信来源发令牌`, tk.status === 200 && tk.text.includes('"token"'));
  const TOKEN = j(tk.text).token;
  const A = { Origin: BASE, 'X-FlowTask-Token': TOKEN };
  const badOrigin = { Origin: 'http://evil.example.com', 'X-FlowTask-Token': TOKEN };

  const tkBad = await req(BASE, 'GET', '/api/token', { headers:{ Origin:'http://evil.example.com' } });
  ok(`[${label}] 非可信来源拿不到令牌`, tkBad.status === 403);

  // 探活免鉴权
  const ping = await req(BASE, 'GET', '/api/ping');
  ok(`[${label}] /api/ping 免鉴权可探活`, ping.status === 200 && j(ping.text).ready === true, ping.text.slice(0,60));

  // 文件名白名单
  for(const bad of ['../../etc/passwd', 'flowtask_secret.json', 'flowtask_data.jsonx', 'flowtask_x.json', 'flowtask_data_.json']){
    const r = await req(BASE, 'GET', '/api/db?file=' + encodeURIComponent(bad), { headers: A });
    ok(`[${label}] 拒绝非法文件名 ${bad}`, r.status === 400 || r.status === 401, '实际 ' + r.status);
  }

  // 未登录不能碰个人库/共享库
  const noSess = await req(BASE, 'GET', '/api/db?file=flowtask_shared.json', { headers: A });
  ok(`[${label}] 无会话读共享库 401`, noSess.status === 401, '实际 ' + noSess.status);
  const noSessW = await req(BASE, 'POST', '/api/db?file=flowtask_shared.json', { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, A), body: data });
  ok(`[${label}] 无会话写共享库 401`, noSessW.status === 401, '实际 ' + noSessW.status);
  const noTok = await req(BASE, 'GET', '/api/db?file=flowtask_shared.json', { headers:{ Origin: BASE } });
  ok(`[${label}] 无令牌一律 403`, noTok.status === 403, '实际 ' + noTok.status);

  // 账户表：注册期无需会话即可读写（写入会带密码哈希；读取一律脱敏）
  const HASH_A = 'p1$' + 'a'.repeat(64);
  const HASH_B = 'p1$' + 'b'.repeat(64);
  const authBody = JSON.stringify({ meta:{ rev:1 }, users:[{ id:'u_a', username:'a', name:'A', role:'admin', salt:'s_a', passHash:HASH_A, active:true }] });
  const w1 = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json', { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, A), body: authBody });
  ok(`[${label}] 写账户表成功`, w1.status === 200 && j(w1.text).rev === 1, w1.text.slice(0,80));
  const r1 = await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: A });
  const r1j = j(r1.text);
  ok(`[${label}] 读回账户表`, r1.status === 200 && r1j.users[0].username === 'a');
  ok(`[${label}] 账户表读取脱敏：不下发 salt/passHash`, r1.status === 200 && r1j.users[0].passHash === undefined && r1j.users[0].salt === undefined, JSON.stringify(r1j.users[0] || {}).slice(0,80));

  // 假冲突修复：同版本 + 同内容 → 幂等 200
  const dup = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json', { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, A), body: authBody });
  ok(`[${label}] 同版本同内容 → 幂等 200（不再误报冲突）`, dup.status === 200 && j(dup.text).noop === true, dup.text.slice(0,80));
  const dupNoHeader = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json', { headers: A, body: authBody });
  ok(`[${label}] 版本号取自请求体时同样幂等`, dupNoHeader.status === 200 && j(dupNoHeader.text).noop === true, dupNoHeader.text.slice(0,80));

  // 真冲突：同版本 + 内容不同 → 409（只改显示名：不新增账户，避免撞上"账号由管理员开通"的守卫）
  const real = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, A), body: JSON.stringify({ meta:{ rev:1 }, users:[{ id:'u_a', username:'a', name:'改了名', active:true }] }) });
  ok(`[${label}] 同版本内容不同 → 真冲突 409`, real.status === 409 && j(real.text).rev === 1, real.text.slice(0,80));

  // 更高版本可写
  const bump = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'2' }, A), body: JSON.stringify({ meta:{ rev:2 }, users:[{ id:'u_a', username:'a', active:true }] }) });
  ok(`[${label}] 更高版本号写入成功`, bump.status === 200 && j(bump.text).rev === 2);

  // 账户表写入守卫（v1.6 / v1.10 改判：回写不做删除，所以空表推上来是「什么都没改」而不是失败）
  const shrink = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'3' }, A), body: JSON.stringify({ meta:{ rev:3 }, users:[] }) });
  ok(`[${label}] 空表回写被服务端补回存量（不清表）`, shrink.status === 200, '实际 ' + shrink.status + ' ' + shrink.text.slice(0,60));
  const afterShrink = await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: A });
  ok(`[${label}] 空表回写后原有账户一个没少`, ((j(afterShrink.text) || {}).users || []).some(u => u.id === 'u_a'),
    String(afterShrink.text).slice(0,80));
  const addAdmin = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'3' }, A), body: JSON.stringify({ meta:{ rev:3 }, users:[{ id:'u_a', username:'a', active:true }, { id:'u_evil', username:'evil', role:'admin', active:true }] }) });
  ok(`[${label}] 无会话自封管理员被拒 403`, addAdmin.status === 403, '实际 ' + addAdmin.status);
  const addMember = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'3' }, A), body: JSON.stringify({ meta:{ rev:3 }, users:[{ id:'u_a', username:'a', active:true }, { id:'u_b', username:'b', role:'member', salt:'s_b', passHash:HASH_B, active:true }] }) });
  /* v1.9：账号只由管理员开通。界面藏入口是体验，服务端拒才是约束——
     表里已有活跃账户时，匿名新增账户必须被拒（此前是放行自助注册） */
  ok(`[${label}] 无会话新增账户被拒（账号由管理员开通）`, addMember.status === 403, '实际 ' + addMember.status + ' ' + addMember.text.slice(0,80));
  const stealHash = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'4' }, A), body: JSON.stringify({ meta:{ rev:4 }, users:[{ id:'u_a', username:'a', active:true }, { id:'u_b', username:'b', role:'member', salt:'s_x', passHash:HASH_A, active:true }] }) });
  ok(`[${label}] 无会话改他人密码哈希被拒 403`, stealHash.status === 403, '实际 ' + stealHash.status);
  // 守卫补齐：带会话的管理员写回「脱敏表」（缺 passHash/salt）不得洗掉真实哈希
  const sessFirst = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_a', verifier: HASH_A }) });
  const SESS0 = j(sessFirst.text).session;
  const redactedWrite = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'5', 'X-FlowTask-Session': SESS0 }, A), body: JSON.stringify({ meta:{ rev:5 }, users:[{ id:'u_a', username:'a', role:'admin', active:true }, { id:'u_b', username:'b', role:'member', active:true }] }) });
  ok(`[${label}] 管理员写回脱敏表放行`, redactedWrite.status === 200, '实际 ' + redactedWrite.status + ' ' + redactedWrite.text.slice(0,60));
  const backRead = await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: Object.assign({ 'X-FlowTask-Session': SESS0 }, A) });
  ok(`[${label}] 脱敏回写后存量哈希仍在（服务端补齐）`, backRead.status === 200, '实际 ' + backRead.status);
  if(dir){
    const rawAuth = JSON.parse(fs.readFileSync(path.join(dir, 'flowtask_auth.json'), 'utf8'));
    const ua = (rawAuth.users || []).find(u=>u.id==='u_a');
    ok(`[${label}] 落盘文件里 u_a 的真实哈希未被洗掉`, !!(ua && ua.passHash === HASH_A), JSON.stringify(ua || {}).slice(0,80));
    /* u_b 的哈希补齐改到 v1.9 场景里验：此刻 u_b 只由脱敏回写带进来，还没有哈希 */
  }

  // 登录挑战（v1.6）：只回 uid/salt/算法；同源（无 Origin 头）也必须可用——
  // 浏览器对同源 GET 不携带 Origin，此前误拒会让登录在托管页面上必挂
  const chal = await req(BASE, 'GET', '/api/auth-challenge?username=a', { headers: { 'X-FlowTask-Token': TOKEN } });
  ok(`[${label}] 登录挑战：同源（无 Origin）可用且不含哈希`,
    chal.status === 200 && j(chal.text).uid === 'u_a' && j(chal.text).salt === 's_a' && j(chal.text).algo === 'p1'
    && !JSON.stringify(j(chal.text)).includes('passHash'), chal.text.slice(0,80));
  const chalBad = await req(BASE, 'GET', '/api/auth-challenge?username=nobody', { headers: { 'X-FlowTask-Token': TOKEN } });
  ok(`[${label}] 登录挑战：不存在用户 404`, chalBad.status === 404, '实际 ' + chalBad.status);
  const chalEvil = await req(BASE, 'GET', '/api/auth-challenge?username=a', { headers: { 'X-FlowTask-Token': TOKEN, Origin:'http://evil.example.com' } });
  ok(`[${label}] 登录挑战：不可信来源 403`, chalEvil.status === 403, '实际 ' + chalEvil.status);

  // 会话签发（v1.6：必须携带密码证明）
  const sNone = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_a' }) });
  ok(`[${label}] 缺密码证明不能换会话 400`, sNone.status === 400, '实际 ' + sNone.status);
  const sWrong = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_a', verifier:'p1$' + 'c'.repeat(64) }) });
  ok(`[${label}] 密码证明错误换不到会话 401`, sWrong.status === 401, '实际 ' + sWrong.status);
  const s1 = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_a', verifier: HASH_A }) });
  ok(`[${label}] 正确密码证明换到会话`, s1.status === 200 && String(j(s1.text).session || '').split('.').length === 3, s1.text.slice(0,80));
  const SESSION = j(s1.text).session;
  ok(`[${label}] 会话有效期为 7 天`, Number(j(s1.text).ttlDays) === 7, '实际 ' + j(s1.text).ttlDays);
  const sBad = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_nobody', verifier: HASH_A }) });
  ok(`[${label}] 不存在的 uid 换不到会话`, sBad.status === 404, '实际 ' + sBad.status);
  const sInj = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'../../x', verifier: HASH_A }) });
  ok(`[${label}] 非法 uid 被拒`, sInj.status === 400, '实际 ' + sInj.status);
  const chk = await req(BASE, 'GET', '/api/session', { headers: Object.assign({ 'X-FlowTask-Session': SESSION }, A) });
  ok(`[${label}] 会话可校验且回显 uid`, chk.status === 200 && j(chk.text).uid === 'u_a');
  const tamper = SESSION.slice(0, -4) + 'AAAA';
  const chkBad = await req(BASE, 'GET', '/api/session', { headers: Object.assign({ 'X-FlowTask-Session': tamper }, A) });
  ok(`[${label}] 篡改会话被拒`, chkBad.status === 401, '实际 ' + chkBad.status);

  const S = Object.assign({ 'X-FlowTask-Session': SESSION }, A);
  // 带会话后可读写共享库
  const sh = await req(BASE, 'POST', '/api/db?file=flowtask_shared.json', { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, S), body: data });
  ok(`[${label}] 带会话写共享库成功`, sh.status === 200 && j(sh.text).rev === 1, sh.text.slice(0,80));
  const shR = await req(BASE, 'GET', '/api/db?file=flowtask_shared.json', { headers: S });
  ok(`[${label}] 读回共享库`, shR.status === 200 && j(shR.text).projects[0].name === '项目A');
  // 个人库
  const own = 'flowtask_data_u_a.json';
  /* v1.6 写盘可信：把个人库路径变成目录，rename 必然失败 → 服务端必须回 500
     且不得推进版本（此前被吞掉错误照样回 200「已保存」并推进 rev+hash） */
  if(dir){
    fs.mkdirSync(path.join(dir, own), { recursive: true });
    const failWrite = await req(BASE, 'POST', '/api/db?file=' + own, { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, S), body: data });
    ok(`[${label}] 写盘失败必须回 500（不能假成功）`, failWrite.status === 500, '实际 ' + failWrite.status);
    const vFail = await req(BASE, 'GET', '/api/version?file=' + own, { headers: S });
    ok(`[${label}] 写盘失败后版本号不推进`, j(vFail.text).rev === 0, '实际 ' + j(vFail.text).rev);
    fs.rmdirSync(path.join(dir, own));
  }
  const pw = await req(BASE, 'POST', '/api/db?file=' + own, { headers: Object.assign({ 'X-FlowTask-Rev':'1' }, S), body: data });
  ok(`[${label}] 可写自己的个人库`, pw.status === 200, pw.text.slice(0,60));
  const other = await req(BASE, 'GET', '/api/db?file=flowtask_data_u_b.json', { headers: S });
  ok(`[${label}] 不能碰别人的个人库`, other.status === 403, '实际 ' + other.status);
  // 版本号按文件独立
  const v1 = await req(BASE, 'GET', '/api/version?file=flowtask_shared.json', { headers: S });
  const v2 = await req(BASE, 'GET', '/api/version?file=flowtask_auth.json', { headers: A });
  ok(`[${label}] 各文件版本号互相独立`, j(v1.text).rev === 1 && j(v2.text).rev === 5, JSON.stringify(j(v1.text)) + ' / ' + JSON.stringify(j(v2.text)));

  /* v1.9：管理员带会话新增账户应当放行（这就是"管理员开号"的服务端依据） */
  const adminAdd = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'6', 'X-FlowTask-Session': SESS0 }, A),
      body: JSON.stringify({ meta:{ rev:6 }, users:[
        { id:'u_a', username:'a', role:'admin', active:true },
        { id:'u_b', username:'b', role:'member', salt:'s_b', passHash:HASH_B, active:true }] }) });
  ok(`[${label}] 管理员会话新增账户放行`, adminAdd.status === 200, '实际 ' + adminAdd.status + ' ' + adminAdd.text.slice(0,80));
  if(dir){
    const rawB = JSON.parse(fs.readFileSync(path.join(dir, 'flowtask_auth.json'), 'utf8'));
    const ubOk = (rawB.users || []).find(u=>u.id==='u_b');
    ok(`[${label}] 哈希补齐对新成员同样生效`, !!(ubOk && ubOk.passHash === HASH_B), JSON.stringify(ubOk || {}).slice(0,90));
  }
  const anonAfterAdmin = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
    { headers: Object.assign({ 'X-FlowTask-Rev':'7' }, A), body: JSON.stringify({ meta:{ rev:7 }, users:[
        { id:'u_a', username:'a', role:'admin', active:true }, { id:'u_b', username:'b', role:'member', active:true },
        { id:'u_c', username:'c', role:'member', salt:'s_c', passHash:HASH_B, active:true }] }) });
  ok(`[${label}] 匿名再加账户仍被拒`, anonAfterAdmin.status === 403, '实际 ' + anonAfterAdmin.status);
  /* v1.9 /api/resetpw：管理员重置他人密码，重置后旧口令作废且对方被要求首登改密 */
  const rpNoTok = await req(BASE, 'POST', '/api/resetpw', { headers:{ Origin:BASE }, body:'{}' });
  ok(`[${label}] resetpw 无令牌 403`, rpNoTok.status === 403, '实际 ' + rpNoTok.status);
  const rpNoSess = await req(BASE, 'POST', '/api/resetpw', { headers: A, body:'{}' });
  ok(`[${label}] resetpw 无会话 401`, rpNoSess.status === 401, '实际 ' + rpNoSess.status);
  const rpBad = await req(BASE, 'POST', '/api/resetpw', { headers: Object.assign({ 'X-FlowTask-Session': SESS0 }, A),
    body: JSON.stringify({ uid:'u_b', newSalt:'s_z', newHash:'not-p1' }) });
  ok(`[${label}] resetpw 哈希格式不合法被拒`, rpBad.status === 400, '实际 ' + rpBad.status);
  const rpUnknown = await req(BASE, 'POST', '/api/resetpw', { headers: Object.assign({ 'X-FlowTask-Session': SESS0 }, A),
    body: JSON.stringify({ uid:'u_ghost', newSalt:'s_z', newHash: HASH_B }) });
  ok(`[${label}] resetpw 未知账户 404`, rpUnknown.status === 404, '实际 ' + rpUnknown.status);
  const rpOk = await req(BASE, 'POST', '/api/resetpw', { headers: Object.assign({ 'X-FlowTask-Session': SESS0 }, A),
    body: JSON.stringify({ uid:'u_b', newSalt:'s_new', newHash: HASH_B }) });
  ok(`[${label}] 管理员重置密码成功`, rpOk.status === 200 && j(rpOk.text).pwMustChange === true, '实际 ' + rpOk.status + ' ' + rpOk.text.slice(0,80));
  const oldLogin = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_b', verifier: HASH_A }) });
  ok(`[${label}] 重置后旧口令登录失败`, oldLogin.status === 401, '实际 ' + oldLogin.status);
  const newLogin = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_b', verifier: HASH_B }) });
  ok(`[${label}] 重置后新口令可登录`, newLogin.status === 200 && !!j(newLogin.text).session, '实际 ' + newLogin.status);
  const SESS_B = j(newLogin.text).session;
  const rpByMember = await req(BASE, 'POST', '/api/resetpw', { headers: Object.assign({ 'X-FlowTask-Session': SESS_B }, A),
    body: JSON.stringify({ uid:'u_a', newSalt:'s_x', newHash: HASH_A }) });
  ok(`[${label}] 非管理员不能重置他人密码`, rpByMember.status === 403, '实际 ' + rpByMember.status);
  if(dir){
    const raw2 = JSON.parse(fs.readFileSync(path.join(dir, 'flowtask_auth.json'), 'utf8'));
    const ub2 = (raw2.users || []).find(u=>u.id==='u_b');
    ok(`[${label}] 重置后落盘带上待改密标记`, !!(ub2 && ub2.pwMustChange === true), JSON.stringify(ub2 || {}).slice(0,90));
  }
  /* 本人改密：/api/changepw 成功后必须清掉待改密标记（否则提示永远挂着） */
  const cp = await req(BASE, 'POST', '/api/changepw', { headers: Object.assign({ 'X-FlowTask-Session': SESS_B }, A),
    body: JSON.stringify({ oldVerifier: HASH_B, newSalt:'s_b2', newHash: HASH_A }) });
  ok(`[${label}] 本人改密成功`, cp.status === 200, '实际 ' + cp.status + ' ' + cp.text.slice(0,80));
  if(dir){
    const raw3 = JSON.parse(fs.readFileSync(path.join(dir, 'flowtask_auth.json'), 'utf8'));
    const ub3 = (raw3.users || []).find(u=>u.id==='u_b');
    ok(`[${label}] 本人改密后待改密标记被清除`, !!(ub3 && ub3.pwMustChange === false), JSON.stringify(ub3 || {}).slice(0,90));
  }

  /* v1.10 删除账户：不可逆动作，鉴权、留底、tombstone 三件事两端必须一致 */
  {
    const loginB = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_b', verifier: HASH_A }) });
    const sessB = j(loginB.text).session;
    ok(`[${label}] 删除前能取到被删账户的会话（用于验 tombstone）`, !!sessB, loginB.status + ' ' + String(loginB.text).slice(0,80));
    const SB = sessB ? { 'X-FlowTask-Token': TOKEN, 'X-FlowTask-Session': sessB } : null;
    ok(`[${label}] 删除账户需登录`, (await req(BASE, 'POST', '/api/delete-user', { headers: A, body:'{}' })).status === 401);
    ok(`[${label}] 非管理员不能删除账户`,
      (await req(BASE, 'POST', '/api/delete-user', { headers: SB, body: JSON.stringify({ uid:'u_a' }) })).status === 403);
    ok(`[${label}] 非法 uid 被拒`,
      (await req(BASE, 'POST', '/api/delete-user', { headers: Object.assign({'X-FlowTask-Session':SESS0},A), body: JSON.stringify({ uid:'../x' }) })).status === 400);
    ok(`[${label}] 未知账户返回 404`,
      (await req(BASE, 'POST', '/api/delete-user', { headers: Object.assign({'X-FlowTask-Session':SESS0},A), body: JSON.stringify({ uid:'u_ghost' }) })).status === 404);
    ok(`[${label}] 不能删除自己`,
      (await req(BASE, 'POST', '/api/delete-user', { headers: Object.assign({'X-FlowTask-Session':SESS0},A), body: JSON.stringify({ uid:'u_a' }) })).status === 400);
    /* 先给 u_b 建一份个人库，才能验证「删除会留底而不是真删」 */
    await req(BASE, 'POST', '/api/db?file=flowtask_data_u_b.json', { headers: SB, body: JSON.stringify({ meta:{rev:1,lastSaved:Date.now()}, projects:[], tasks:[] }) });
    ok(`[${label}] 最后一个管理员不能被删（否则全组失去开号入口）`,
      (await req(BASE, 'POST', '/api/delete-user', { headers: Object.assign({'X-FlowTask-Session':SESS0},A), body: JSON.stringify({ uid:'u_a' }) })).status === 400);
    const del = await req(BASE, 'POST', '/api/delete-user', { headers: Object.assign({'X-FlowTask-Session':SESS0},A), body: JSON.stringify({ uid:'u_b' }) });
    ok(`[${label}] 管理员删除账户成功`, del.status === 200 && j(del.text).ok === true, del.status + ' ' + String(del.text).slice(0,90));
    /* rev 一致性回归（M22 真根因）：专用端点自己改账户表后，文件里的 meta.rev 必须和服务端记账一起推进。
       此前只动记账不动文件，客户端 GET 到的 rev 永远比记账小 1，之后任何一次整表回写必然 409、
       合并重试也永远追不上——表现出来就是「建号点了没反应，成员列表里始终没有他」。 */
    const verAuth = j((await req(BASE, 'GET', '/api/version?file=flowtask_auth.json', { headers: A })).text).rev;
    const fileAuthRev = (j((await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: A })).text).meta || {}).rev;
    ok(`[${label}] 专用端点改表后 记账 rev 与文件 meta.rev 一致`, Number(verAuth) === Number(fileAuthRev),
      '记账=' + verAuth + ' 文件=' + fileAuthRev);
    const afterDelTable = j((await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: A })).text);
    const pushAfter = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev': String(Number(fileAuthRev) + 1), 'X-FlowTask-Session': SESS0 }, A),
        body: JSON.stringify({ meta:{ rev: Number(fileAuthRev) + 1 }, users: afterDelTable.users }) });
    ok(`[${label}] 按读到的 rev 递增回写不再撞 409（删号后仍能建号）`, pushAfter.status === 200,
      '实际 ' + pushAfter.status + ' ' + String(pushAfter.text).slice(0,80));
    if(dir){
      const gone = !fs.existsSync(path.join(dir, 'flowtask_data_u_b.json'));
      const keptName = j(del.text).preserved || '';
      ok(`[${label}] 个人库被改名留底而非直接删除`, gone && keptName && fs.existsSync(path.join(dir, keptName)),
        'gone=' + gone + ' 留底=' + (keptName || '(无)'));
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'flowtask_auth.json'), 'utf8'));
      ok(`[${label}] 账户从 users 中移除且写入 tombstone`,
        !raw.users.some(u=>u.id==='u_b') && Array.isArray(raw.deleted) && raw.deleted.some(d=>String(d.uid)==='u_b'),
        JSON.stringify(raw.deleted || null).slice(0,90));
    }
    /* tombstone 必须立刻让被删者的旧会话失效——否则"删了人他还能继续写" */
    const after = await req(BASE, 'GET', '/api/db?file=flowtask_data_u_b.json', { headers: SB });
    ok(`[${label}] 被删账户的旧会话立刻失效`, after.status === 401, '实际 ' + after.status);
    const chalGone = await req(BASE, 'GET', '/api/auth-challenge?username=b', { headers: A });
    ok(`[${label}] 被删账户无法再换到新会话`, chalGone.status === 404, '实际 ' + chalGone.status);
    const loginGone = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid:'u_b', verifier: HASH_A }) });
    ok(`[${label}] 用被删账户的旧证明换不到会话`, loginGone.status === 404, '实际 ' + loginGone.status);
    /* v1.10 语义：整表回写既删不了人，也救不活人。
       「少一行」不再判 403——账户表读取是脱敏的，每张过期标签页都可能只是还没看到别人的新账户，
       判 403 会把正常的建号一起打死；改成服务端把存量补回去（回写不做删除）。
       已进 tombstone 的人则从请求里丢掉，过期快照一推就复活的洞同样堵上。 */
    const mkC = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev':'99', 'X-FlowTask-Session': SESS0 }, A),
        body: JSON.stringify({ meta:{ rev:99 }, users:[{ id:'u_a', username:'a', role:'admin', salt:'s_a', passHash:HASH_A, active:true },
                                                  { id:'u_c', username:'c', role:'member', salt:'s_c', passHash:HASH_B, active:true }] }) });
    ok(`[${label}] 管理员整表回写可以新增账户`, mkC.status === 200, '实际 ' + mkC.status + ' ' + String(mkC.text).slice(0,80));
    const shrinkDel = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev':'100', 'X-FlowTask-Session': SESS0 }, A),
        body: JSON.stringify({ meta:{ rev:100 }, users:[{ id:'u_a', username:'a', role:'admin', active:true }] }) });   // 少了 u_c
    ok(`[${label}] 整表回写少一行不被当作删除`, shrinkDel.status === 200, '实际 ' + shrinkDel.status + ' ' + String(shrinkDel.text).slice(0,80));
    const stillThere = await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: A });
    const stillIds = ((j(stillThere.text) || {}).users || []).map(u => u && u.id).join(',');
    ok(`[${label}] 少一行的那次回写把存量补了回来（u_c 仍在）`, stillIds.indexOf('u_c') >= 0, '实际 users=' + stillIds);
    const revive = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev':'101', 'X-FlowTask-Session': SESS0 }, A),
        body: JSON.stringify({ meta:{ rev:101 }, users:[{ id:'u_a', username:'a', role:'admin', salt:'s_a', passHash:HASH_A, active:true },
                                                        { id:'u_b', username:'b', role:'member', salt:'s_b', passHash:HASH_B, active:true }] }) });
    const afterRevive = await req(BASE, 'GET', '/api/db?file=flowtask_auth.json', { headers: A });
    const reviveIds = ((j(afterRevive.text) || {}).users || []).map(u => u && u.id).join(',');
    ok(`[${label}] 过期快照推回被删账户不会让其复活`, revive.status === 200 && reviveIds.indexOf('u_b') < 0,
      revive.status + ' 实际 users=' + reviveIds);
    const chalRevive = await req(BASE, 'GET', '/api/auth-challenge?username=b', { headers: A });
    ok(`[${label}] 复活动作没能让被删账户重新可登录`, chalRevive.status === 404, '实际 ' + chalRevive.status);
  }

  // 冲突副本按文件命名
  const cf = await req(BASE, 'POST', '/api/db-conflict?file=' + own, { headers: S, body: data });
  ok(`[${label}] 冲突副本留底并返回文件名`, cf.status === 200 && /flowtask_data_u_a_conflict_.*\.json/.test(j(cf.text).file || ''), cf.text.slice(0,80));
  // 结构校验
  const badShape = await req(BASE, 'POST', '/api/db?file=' + own, { headers: Object.assign({ 'X-FlowTask-Rev':'9' }, S), body: '{"meta":{"rev":9},"users":[]}' });
  ok(`[${label}] 数据文件缺 projects/tasks 被拒`, badShape.status === 400, '实际 ' + badShape.status);
  const authShape = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json', { headers: Object.assign({ 'X-FlowTask-Rev':'9' }, A), body: '{"meta":{"rev":9},"projects":[]}' });
  ok(`[${label}] 账户表缺 users 被拒`, authShape.status === 400, '实际 ' + authShape.status);
  // 页面托管注入令牌
  const page = await req(BASE, 'GET', '/', { headers:{ Origin: BASE } });
  ok(`[${label}] 页面托管并注入真实令牌`, page.status === 200 && page.text.includes(TOKEN) && !page.text.includes('__FLOWTASK_TOKEN__'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---------- 启动两种实现 ---------- */
function startNode(port, dir){
  const env = Object.assign({}, process.env, { FLOWTASK_PORT:String(port), FLOWTASK_DATA_DIR:dir });
  return spawn(process.execPath, [path.join(ROOT, 'flowtask_server.js')], { env, stdio:'ignore', windowsHide:true });
}
function startPs1(port, dir){
  return spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT, 'flowtask_server.ps1'),
    '-Port', String(port), '-DataDir', dir], { stdio:'ignore', windowsHide:true });
}
function kill(p){ try{ p.kill(); }catch(e){} try{ process.kill(-p.pid); }catch(e){} }

(async () => {
  const which = process.argv[2] || 'both';
  // 外部实例模式：FT_PARITY_BASE=http://127.0.0.1:5399 node tests/server_parity.js external
  if(which === 'external'){
    const BASE = process.env.FT_PARITY_BASE;
    console.log(`\n== 对等测试：外部实例 ${BASE} ==`);
    if(!BASE){ console.error('需要设置 FT_PARITY_BASE'); process.exit(2); }
    if(!await waitUp(BASE, 20, 250)){ ok('[external] 服务未就绪', false); console.log('\n== 结果：0 通过，1 失败 =='); process.exit(1); }
    await scenarios(BASE, 'external');
    console.log(`\n== 结果：${passed} 通过，${failed} 失败 ==`);
    process.exit(failed ? 1 : 0);
  }
  const want = which === 'both' ? ['node', 'ps1'] : [which];
  let port = 5311;
  for(const kind of want){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-parity-dir-'));
    const BASE = `http://127.0.0.1:${port}`;
    console.log(`\n== 对等测试：${kind} 版存储服务（端口 ${port}，数据目录 ${dir}） ==`);
    const proc = kind === 'node' ? startNode(port, dir) : startPs1(port, dir);
    try{
      const up = await waitUp(BASE);
      if(!up){ ok(`[${kind}] 服务能启动并响应 /api/ping`, false, '超时未就绪'); continue; }
      ok(`[${kind}] 服务能启动并响应 /api/ping`, true);
      await scenarios(BASE, kind, dir);
    }finally{
      kill(proc);
      fs.rmSync(dir, { recursive: true, force: true });
      port++;
      await sleep(400);
    }
  }
  console.log(`\n== 结果：${passed} 通过，${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
})();
