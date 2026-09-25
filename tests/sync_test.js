/*
 * 共享盘同步引擎单测（零依赖）
 * 用法： node tests/sync_test.js
 * 做法： 用两个临时目录假扮「本机数据目录」与「共享盘」，把同步引擎的每条规则跑实。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../flowtask_sync.js');

let passed = 0, failed = 0;
function ok(cond, label){ if(cond){ passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label); } }
function eq(a, b, label){ ok(String(a) === String(b), label + '  (实际=' + a + ' 期望=' + b + ')'); }
function tmp(tag){ return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sync-' + tag + '-')); }
function writeLocal(dir, name, obj){ fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2), 'utf8'); }
function readJson(f){ try{ return JSON.parse(fs.readFileSync(f, 'utf8')); }catch(e){ return null; } }
function makeEngine(shareDir, dataDir, changed){
  return S.create({ shareDir, dataDir, onLocalChanged: changed || (() => {}), log: () => {} });
}

/* ---------- A. 纯决策函数：不动文件系统 ---------- */
const A = S.decideAction;
const L = (rev, lastSaved, hash) => ({ rev, lastSaved, hash: hash || ('h' + rev + (lastSaved || 0)) });
const Sg = L;
const ABSENT = { absent: true }, BAD = { bad: true };
console.log('\n== A. decideAction 版本胜负表 ==');
eq(A(ABSENT, ABSENT), 'noop', '两边都没有 → 什么都不做');
eq(A(ABSENT, L(3, 10)), 'pull', '本机没有、共享盘有 → 拉（换电脑首次登录）');
eq(A(L(3, 10), ABSENT), 'push', '本机有、共享盘没有 → 推（建立基线）');
eq(A(L(5, 10), L(3, 20)), 'push', '本机版本更高 → 推（即使对方时间戳更新）');
eq(A(L(3, 20), L(5, 10)), 'pull', '共享盘版本更高 → 拉');
eq(A({ rev: 3, lastSaved: 9, hash: 'same' }, { rev: 3, lastSaved: 9, hash: 'same' }), 'noop', '同版本同内容 → 不动');
eq(A({ rev: 3, lastSaved: 99, hash: 'x' }, { rev: 3, lastSaved: 11, hash: 'y' }), 'conflict-push', '同版本不同内容 + 本机写得晚 → 冲突后本机胜');
eq(A({ rev: 3, lastSaved: 5, hash: 'x' }, { rev: 3, lastSaved: 88, hash: 'y' }), 'conflict-pull', '同版本不同内容 + 对方写得晚 → 冲突后对方胜');
eq(A(BAD, ABSENT), 'invalid-local', '本机这份坏了 → 不推不拉，报 invalid-local');
eq(A(L(1, 1), BAD), 'invalid-remote', '共享盘那份坏了 → 不覆盖也不拉回，报 invalid-remote');

/* ---------- B. metaOf ---------- */
console.log('\n== B. metaOf ==');
eq(S.metaOf(null).absent, 'true', 'null → absent');
eq(S.metaOf('{ not json').bad, 'true', '坏 JSON → bad');
eq(S.metaOf('{"meta":{"rev":7,"lastSaved":8}}').rev, 7, '正常取到 rev');
eq(S.metaOf('{"meta":{}}').rev, 0, '缺 rev → 0');

/* ---------- C. 路径映射 ---------- */
console.log('\n== C. 共享盘路径映射 ==');
eq(S.sharePathOf('/s', 'flowtask_auth.json'), path.join('/s', 'team', 'flowtask_auth.json'), '账户表 → team/');
eq(S.sharePathOf('/s', 'flowtask_shared.json'), path.join('/s', 'team', 'flowtask_shared.json'), '共享库 → team/');
eq(S.sharePathOf('/s', 'flowtask_data_u_abc.json'), path.join('/s', 'users', 'u_abc', 'flowtask_data_u_abc.json'), '个人库 → users/<uid>/');
eq(S.sharePathOf('/s', 'flowtask_data.json'), 'null', '旧版单文件不参与同步');
eq(S.sharePathOf('', 'flowtask_auth.json'), 'null', '没配共享盘 → 不同步');
/* 回归：留底文件与个人库同目录，绝不能被误认成 uid（共享盘幽灵目录） */
eq(S.sharePathOf('/s', 'flowtask_data_u_abc_conflict_20260925_120000.json'), 'null', '个人库冲突副本不被当成个人库');
eq(S.sharePathOf('/s', 'flowtask_data_u_abc_corrupt_20260925_120000.json'), 'null', '损坏隔离件不被当成个人库');
eq(S.sharePathOf('/s', 'flowtask_data_conflict_20260925_120000.json'), 'null', '旧版单文件冲突副本不被当成个人库');
eq(S.sharePathOf('/s', 'flowtask_data_corrupt_20260925_120000.json'), 'null', '旧版单文件损坏隔离件不被当成个人库');
eq(S.sharePathOf('/s', 'flowtask_data_u_abc.json.base.json'), 'null', '基线快照绝不上共享盘');
ok(!S.PERSONAL_RE.test('flowtask_data_u_abc_conflict_1.json') && !S.PERSONAL_RE.test('flowtask_data_u_abc_corrupt_1.json'), 'PERSONAL_RE 本体同样排除冲突/隔离件');

/* ---------- D. 真实文件系统的推拉 ---------- */
console.log('\n== D. 推拉落盘 ==');
{
  const data = tmp('data'), share = tmp('share');
  writeLocal(data, 'flowtask_data_u_a.json', { meta: { rev: 4, lastSaved: 100 }, projects: [{ id: 'p1', name: '我的项目' }], tasks: [] });
  const changed = [];
  const e1 = makeEngine(share, data, n => changed.push(n));
  const r = e1._internals.syncFile('flowtask_data_u_a.json', 'push');
  eq(r.action, 'push', '首次推送');
  const mirrored = path.join(share, 'users', 'u_a', 'flowtask_data_u_a.json');
  ok(fs.existsSync(mirrored), '共享盘出现个人库镜像');
  eq(readJson(mirrored).meta.rev, 4, '镜像版本号一致');
  eq(changed.length, 0, '纯推送不应回调本地变更');
  /* 再推一次：内容没变 → noop */
  eq(e1._internals.syncFile('flowtask_data_u_a.json', 'push').action, 'noop', '内容未变重复推送 → noop');
  /* 本机改一版再推 */
  writeLocal(data, 'flowtask_data_u_a.json', { meta: { rev: 5, lastSaved: 200 }, projects: [], tasks: [{ id: 't1' }] });
  eq(e1._internals.syncFile('flowtask_data_u_a.json', 'push').action, 'push', '本机更新 → 再推');
  eq(readJson(mirrored).meta.rev, 5, '镜像跟到第 5 版');
  /* 换电脑：新空目录 + 同一共享盘 → 登录拉回 */
  const data2 = tmp('data-newmachine');
  const changed2 = [];
  const e2 = makeEngine(share, data2, n => changed2.push(n));
  const lg = e2.loginSync('u_a');
  const pulled = lg.results.find(x => x.name === 'flowtask_data_u_a.json');
  eq(pulled.action, 'pull', '新电脑登录后拉回自己的库');
  eq(readJson(path.join(data2, 'flowtask_data_u_a.json')).meta.rev, 5, '拉回的版本号正确');
  eq(changed2.indexOf('flowtask_data_u_a.json') >= 0, 'true', '拉取后回调了 onLocalChanged（服务端要作废版本缓存）');
}

/* ---------- E. 真冲突：双方留底 + 谁晚谁赢 ---------- */
console.log('\n== E. 同版本不同内容 ==');
{
  const data = tmp('data'), share = tmp('share');
  const e = makeEngine(share, data);
  const target = path.join(share, 'team', 'flowtask_shared.json');
  /* 共享盘上先放一份 rev=9、时间戳更晚、内容不同的 */
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ meta: { rev: 9, lastSaved: 5000 }, projects: [{ id: 'other' }], tasks: [] }), 'utf8');
  writeLocal(data, 'flowtask_shared.json', { meta: { rev: 9, lastSaved: 1000 }, projects: [{ id: 'mine' }], tasks: [] });
  const r = e._internals.syncFile('flowtask_shared.json', 'push');
  eq(r.action, 'pull', '对方时间戳更晚 → 这次不覆盖，改为拉对方版本');
  eq(readJson(path.join(data, 'flowtask_shared.json')).projects[0].id, 'other', '本机被换成对方的版本');
  const cf = fs.readdirSync(path.join(share, 'conflict'));
  eq(cf.length, 2, '冲突时本机与对方各留一份底（共 2 个文件）');
  ok(cf.some(f => /_local_/.test(f)), '留底里有一份是 local');
  ok(cf.some(f => /_remote_/.test(f)), '留底里有一份是 remote');
}

/* ---------- F. 跨机锁 ---------- */
console.log('\n== F. 跨机锁 ==');
{
  const data = tmp('data'), share = tmp('share');
  const e = makeEngine(share, data);
  writeLocal(data, 'flowtask_shared.json', { meta: { rev: 1, lastSaved: 10 }, projects: [], tasks: [] });
  fs.mkdirSync(path.join(share, 'locks'), { recursive: true });
  const lock = path.join(share, 'locks', 'flowtask_shared.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ owner: 'u_other', ts: Date.now() }), 'utf8');
  eq(e._internals.syncFile('flowtask_shared.json', 'push').action, 'locked', '别人正持锁 → 本轮放弃，不写 team');
  ok(!fs.existsSync(path.join(share, 'team', 'flowtask_shared.json')), '被锁挡住时共享盘没被写');
  /* 陈旧锁（超过 60s）可抢占 */
  fs.writeFileSync(lock, JSON.stringify({ owner: 'u_dead', ts: Date.now() - 120000 }), 'utf8');
  eq(e._internals.syncFile('flowtask_shared.json', 'push').action, 'push', '持锁进程已超时 → 抢占过期锁');
  ok(fs.existsSync(path.join(share, 'team', 'flowtask_shared.json')), '抢到锁后写成功');
  ok(!fs.existsSync(lock), '同步结束后锁已释放');
}

/* ---------- G. 「读不到」≠「不存在」：绝不能覆盖 ---------- */
console.log('\n== G. 共享盘读失败时的保守行为 ==');
{
  const data = tmp('data'), share = tmp('share');
  const e = makeEngine(share, data);
  writeLocal(data, 'flowtask_data_u_g.json', { meta: { rev: 3, lastSaved: 10 }, projects: [], tasks: [] });
  /* 用「目标位置是个目录」模拟非 ENOENT 的读失败（EISDIR） */
  fs.mkdirSync(path.join(share, 'users', 'u_g', 'flowtask_data_u_g.json'), { recursive: true });
  const r = e._internals.syncFile('flowtask_data_u_g.json', 'push');
  eq(r.action, 'hold', '读共享盘报错 → hold，不动任何数据');
  eq(e.status().reachable, 'false', '状态标记为不可达');
  eq(e.status().lastError.indexOf('share-read') >= 0, 'true', '状态里留下错误线索');
  const st = JSON.parse(fs.readFileSync(e._internals.stateFile, 'utf8'));
  ok(st.lastError, '状态文件持久化了最近一次错误');
}

/* ---------- H. 账户表同步到 team ---------- */
console.log('\n== H. 账户表 ==');
{
  const data = tmp('data'), share = tmp('share');
  const e = makeEngine(share, data);
  writeLocal(data, 'flowtask_auth.json', { meta: { rev: 2, lastSaved: 10 }, users: [{ id: 'u_a', username: 'a', role: 'admin', salt: 's', passHash: 'p1$' + 'a'.repeat(64), active: true }] });
  eq(e._internals.syncFile('flowtask_auth.json', 'push').action, 'push', '账户表可推送');
  const mirrored = readJson(path.join(share, 'team', 'flowtask_auth.json'));
  eq(mirrored.users.length, 1, '共享盘上的账户表有 1 个用户');
  eq(mirrored.users[0].username, 'a', '用户名同步过去了');
}

/* ---------- I. 未配置共享盘 = 完全惰性 ---------- */
console.log('\n== I. 开关关闭时的行为 ==');
{
  const data = tmp('data');
  const e = makeEngine('', data);
  eq(e.enabled, 'false', '没配 SHARE_DIR → enabled=false');
  eq(e.syncAll('pull').enabled, 'false', 'syncAll 直接空转');
  eq(e.loginSync('u_a').enabled, 'false', 'loginSync 直接空转');
  writeLocal(data, 'flowtask_data_u_a.json', { meta: { rev: 1, lastSaved: 1 }, projects: [], tasks: [] });
  e.schedulePush('flowtask_data_u_a.json', 10);
  eq(e.status().pending, 0, '关闭时不排任何同步任务');
  const files = fs.readdirSync(data);
  ok(!files.some(f => /sync/.test(f)), '关闭时不写同步状态文件（行为与今天完全一致）');
}

/* ---------- J. 去抖推送 ---------- */
console.log('\n== J. 去抖推送 ==');
{
  const data = tmp('data'), share = tmp('share');
  const e = makeEngine(share, data);
  writeLocal(data, 'flowtask_data_u_j.json', { meta: { rev: 1, lastSaved: 1 }, projects: [], tasks: [] });
  e.schedulePush('flowtask_data_u_j.json', 40);
  e.schedulePush('flowtask_data_u_j.json', 40);
  e.schedulePush('flowtask_data_u_j.json', 40);
  eq(e.status().pending, 1, '连点三次只排一个任务（去抖）');
  ok(!fs.existsSync(path.join(share, 'users', 'u_j')), '还没到时间，尚未推送');
  setTimeout(() => {
    eq(e.status().pending, 0, '到时间后队列清空');
    ok(fs.existsSync(path.join(share, 'users', 'u_j', 'flowtask_data_u_j.json')), '去抖后真的推送了');
    /* ---------- L. 路径打错时绝不能"自己造个目录假装已同步" ---------- */
console.log('\n== L. 共享盘路径校验 ==');
{
  const ghost = path.join(os.tmpdir(), 'ft-ghost-share-' + Date.now() + '-不存在');
  const chk = S.checkShare(ghost);
  eq(chk.ok, 'false', '指向不存在的路径 → 校验不通过');
  ok(/不存在|不可达/.test(chk.reason), '校验失败要给出人话原因：' + chk.reason);
  ok(!fs.existsSync(ghost), '光是校验不会把目录造出来');

  /* 配了个打错的路径：引擎必须 hold 住，且不能凭空建出共享盘根目录 */
  const data = tmp('data');
  writeLocal(data, 'flowtask_data_u_l.json', { meta: { rev: 1, lastSaved: 1 }, projects: [], tasks: [] });
  const e = makeEngine(ghost, data);
  ok(e.enabled, '路径暂不可达时仍保持"想同步"的意图（共享盘可能只是没连上）');
  eq(e.status().blockReason !== '', 'true', '启动校验没过 → 状态里带得上原因');
  const r = e._internals.syncFile('flowtask_data_u_l.json', 'push');
  eq(r.action, 'hold', '根目录不在时同步直接 hold，不写任何东西');
  ok(!fs.existsSync(ghost), '关键断言：数据没有被静默写进一个凭空造出来的错误目录');
  ok(/share-root-missing/.test(String(r.err)), 'hold 的原因可诊断：' + r.err);

  /* 真正存在且可写的空目录 → 校验通过，且不留探针文件 */
  const good = tmp('good-share');
  const chk2 = S.checkShare(good);
  eq(chk2.ok, 'true', '已存在且可写的目录 → 校验通过');
  eq(fs.readdirSync(good).length, 0, '校验跑完不留任何探针文件');
  /* 存在但是个文件 → 拒绝 */
  const asFile = path.join(tmp('f'), 'notadir');
  fs.writeFileSync(asFile, 'x');
  eq(S.checkShare(asFile).ok, 'false', '路径是个文件 → 校验不通过');
  /* 恢复可写后原因要自动清掉（不能一直挂着旧错） */
  const e2 = makeEngine(good, data);
  eq(e2.status().blockReason || '', '', '换到可用路径后没有残留原因');
  eq(e2._internals.syncFile('flowtask_data_u_l.json', 'push').action, 'push', '可用之后就正常推送');
}

/* ---------- M. 关掉开关 = 完全惰性 ---------- */
console.log('\n== M. 校验与开关的独立性 ==');
{
  const data = tmp('data');
  const e = makeEngine('', data);
  eq(e.checkNow(), '未配置共享盘目录', '没配置时 checkNow 给出明确说明');
  eq(e.status().enabled, 'false', '没配置时状态就是未启用');
  eq(e.status().shareDir, '', '没配置时不回报任何路径');
}

/* ---------- J2. 去抖之后的收尾断言（L / M / K 都在定时器回调里按序执行） ---------- */
    /* ---------- K. 坏文件不覆盖对方 ---------- */
    const data2 = tmp('data2'), share2 = tmp('share2');
    const e2 = makeEngine(share2, data2);
    writeLocal(data2, 'flowtask_shared.json', { meta: { rev: 1, lastSaved: 1 }, projects: [], tasks: [] });
    fs.mkdirSync(path.join(share2, 'team'), { recursive: true });
    fs.writeFileSync(path.join(share2, 'team', 'flowtask_shared.json'), '{ 坏掉的 json', 'utf8');
    const rk = e2._internals.syncFile('flowtask_shared.json', 'push');
    eq(rk.action, 'invalid-remote', '对方那份坏了 → 不覆盖');
    ok(String(fs.readFileSync(path.join(share2, 'team', 'flowtask_shared.json'), 'utf8')).indexOf('坏掉') >= 0, '坏文件原样保留，等人工/备份恢复');
    console.log('\n== 同步引擎单测结果：' + passed + ' 通过，' + failed + ' 失败 ==');
    process.exit(failed ? 1 : 0);
  }, 200);
}
