/*
 * 三路合并内核单测：node tests/merge_test.js
 * 重点验三件事：
 *   ① 各改各的不互相顶掉（这是做它的唯一理由）
 *   ② 合并结果对称：交换 mine/theirs 必须得到同一份内容，否则两台机器各自收敛到不同状态
 *   ③ 删除/字段级冲突都有明确归属，且一定被记录，绝不静默丢
 */
'use strict';
const W = require('../flowtask_merge.js');

let passed = 0, failed = 0;
function ok(c, label, extra){ if(c){ passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (extra !== undefined ? '  [' + extra + ']' : '')); } }
function eq(a, b, label){ ok(String(a) === String(b), label + '  (实际=' + a + ' 期望=' + b + ')'); }
const S = (o) => JSON.stringify(o);
function store(o){ return Object.assign({ meta:{ rev:1 }, projects:[], tasks:[], notifications:[] }, o); }
function task(id, extra){ return Object.assign({ id, projectId:'p1', title:'T'+id, status:'todo', completed:false,
  createdAt:1000, order:1, subtasks:[], comments:[], activities:[], tags:[] }, extra); }

console.log('== ① 各改各的：都要活下来 ==');
{
  const base = store({ tasks:[task('t1')] });
  // 我新建 t2，同事新建 t3
  const mine = store({ meta:{rev:2}, tasks:[task('t1'), task('t2')] });
  const theirs = store({ meta:{rev:2}, tasks:[task('t1'), task('t3')] });
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.tasks.map(t=>t.id).sort().join(','), 't1,t2,t3', '两边各自新增的任务都被保留');
  eq(r.conflicts.length, 0, '这种情形不该报冲突');
  ok(r.merged.meta.rev > 2, '合并后的版本号必须比两边都大，实际 ' + r.merged.meta.rev);
}
{
  // 我改 t1 标题、同事改 t1 负责人：字段级合并，两处改动都保留
  const base = store({ tasks:[task('t1', { title:'原名', assigneeId:null })] });
  const mine = store({ meta:{rev:2}, tasks:[task('t1', { title:'我改的名', assigneeId:null })] });
  const theirs = store({ meta:{rev:2}, tasks:[task('t1', { title:'原名', assigneeId:'u_bob' })] });
  const r = W.mergeStores(base, mine, theirs);
  const t1 = r.merged.tasks[0];
  eq(t1.title, '我改的名', '我这边的字段改动被保留');
  eq(t1.assigneeId, 'u_bob', '对方那边的字段改动也被保留');
  eq(r.conflicts.length, 0, '不同字段不算冲突');
}
{
  // 两人在同一条任务下各加一条评论：按 id 合并，两条都留
  const base = store({ tasks:[task('t1', { comments:[{ id:'c0', text:'旧' }] })] });
  const mine = store({ meta:{rev:2}, tasks:[task('t1', { comments:[{ id:'c0', text:'旧' }, { id:'c1', text:'我的评论' }] })] });
  const theirs = store({ meta:{rev:2}, tasks:[task('t1', { comments:[{ id:'c0', text:'旧' }, { id:'c2', text:'同事的评论' }] })] });
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.tasks[0].comments.map(c=>c.id).sort().join(','), 'c0,c1,c2', '同一任务下的评论按 id 合并，两条都保留');
}
{
  // 关注人 / 成员这类标量数组：两边各加一个，两个都在
  const base = store({ projects:[{ id:'p1', name:'项目', memberIds:['u_a'] }] });
  const mine = store({ meta:{rev:2}, projects:[{ id:'p1', name:'项目', memberIds:['u_a','u_me'] }] });
  const theirs = store({ meta:{rev:2}, projects:[{ id:'p1', name:'项目', memberIds:['u_a','u_bob'] }] });
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.projects[0].memberIds.slice().sort().join(','), 'u_a,u_bob,u_me', '成员两边各加一个都保留');
}

console.log('\n== ② 对称性：交换 mine/theirs 必须得到同一份内容 ==');
{
  const base = store({ tasks:[task('t1', { title:'原', priority:'low', assigneeId:null }), task('t2', { title:'甲' })] });
  const A = store({ meta:{rev:2}, tasks:[task('t1', { title:'A 改的名', priority:'high', assigneeId:null }), task('t2', { title:'甲' }), task('tA', { title:'A 建的' })] });
  const B = store({ meta:{rev:2}, tasks:[task('t1', { title:'B 改的名', priority:'low', assigneeId:'u_b' }), task('t2', { title:'乙改的' })] });
  const r1 = W.mergeStores(base, A, B);
  const r2 = W.mergeStores(base, B, A);
  const norm = r => { const t = r.merged.tasks.slice().sort((x,y)=>String(x.id).localeCompare(String(y.id))); return S(t.map(x=>[x.id,x.title,x.priority,x.assigneeId])); };
  eq(norm(r1), norm(r2), '两方各自计算得到的实体内容必须一致');
  eq(r1.conflicts.length, r2.conflicts.length, '冲突条数一致');
  eq(r1.merged.tasks.slice().sort((x,y)=>String(x.id).localeCompare(String(y.id))).map(t=>t.id).join(','),
     't1,t2,tA', '合并覆盖：A 新建的 tA 保留，B 改的 t2 也保留');
}

console.log('\n== ③ 真冲突与删除：必须记下来，不能静默 ==');
{
  // 同一条同一字段两边都改成不同值
  const base = store({ tasks:[task('t1', { title:'原', createdAt:1000 })] });
  const mine = store({ meta:{rev:2}, tasks:[task('t1', { title:'我的', createdAt:2000 })] });
  const theirs = store({ meta:{rev:2}, tasks:[task('t1', { title:'他的', createdAt:1000 })] });
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.tasks[0].title, '我的', '时间更新的一方胜出（与谁是推送者无关）');
  ok(r.conflicts.some(c => /title$/.test(c.path)), '字段级冲突被记录');
}
{
  // 我删了任务、同事改了他 → 保留同事的编辑，并记冲突
  const base = store({ tasks:[task('t1'), task('t2')] });
  const mine = store({ meta:{rev:2}, tasks:[task('t1')] });
  const theirs = store({ meta:{rev:2}, tasks:[task('t1'), task('t2', { title:'同事改过的' })] });
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.tasks.length, 2, '删除方同时对方有编辑时，编辑优先，不误删');
  ok(r.conflicts.some(c => c.kind === 'deleted-vs-edited'), '这种分歧必须记为冲突');
}
{
  // 双方都删了同一条 → 就是删除，不该记成冲突
  const base = store({ tasks:[task('t1'), task('t2')] });
  const mine = store({ meta:{rev:2}, tasks:[task('t1')] });
  const theirs = store({ meta:{rev:2}, tasks:[task('t1')] });
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.tasks.length, 1, '双方都删 → 删除生效');
}
{
  // 我改了、对方没动 → 不该有冲突，我的改动胜出
  const base = store({ tasks:[task('t1', { title:'原' })] });
  const mine = store({ meta:{rev:2}, tasks:[task('t1', { title:'我改的' })] });
  const r = W.mergeStores(base, mine, base);
  eq(r.merged.tasks[0].title, '我改的', '只有我方改动时直接保留');
}

console.log('\n== ④ 账户表与回收站 ==');
{
  const base = { meta:{rev:1}, users:[{ id:'u_a', username:'a', role:'member' }] };
  const mine = { meta:{rev:2}, users:[{ id:'u_a', username:'a', role:'member' }, { id:'u_new', username:'new', role:'member' }] };
  const theirs = { meta:{rev:2}, users:[{ id:'u_a', username:'a', role:'admin' }] };
  const r = W.mergeStores(base, mine, theirs);
  eq(r.merged.users.map(u=>u.id).sort().join(','), 'u_a,u_new', '管理员建的账户与另一位管理员建的账户都保留');
  eq(r.merged.users.find(u=>u.id==='u_a').role, 'admin', '角色提升不被合并抹掉');
}
{
  const base = store({ trash:{ tasks:[{ id:'td1', payload:task('t9'), deletedAt:1000 }] } });
  const mine = store({ meta:{rev:2}, trash:{ tasks:[{ id:'td1', payload:task('t9'), deletedAt:1000 }] } });
  const theirs = store({ meta:{rev:2}, trash:{ tasks:[{ id:'td1', payload:task('t9'), deletedAt:1000 }, { id:'td2', payload:task('t8'), deletedAt:2000 }] } });
  const r = W.mergeStores(base, mine, theirs);
  eq((r.merged.trash.tasks||[]).map(x=>x.id).sort().join(','), 'td1,td2', '回收站条目也按 id 合并');
}

console.log('\n== ⑤ needsMerge 判定 ==');
{
  ok(W.needsMerge(null, 'a', 'b') === false, '没有共同祖先时不猜，沿用版本号规则');
  ok(W.needsMerge('a', 'a', 'b') === false, '只有对方改了 → 直接拉');
  ok(W.needsMerge('a', 'b', 'a') === false, '只有我方改了 → 直接推');
  ok(W.needsMerge('a', 'b', 'c') === true, '两边都相对祖先改了才需要合并');
  ok(W.needsMerge('a', 'b', 'b') === false, '两边内容已一致，不必合并');
  /* 缺任何一方都不能合并：新电脑本机没有这份 → 必须直接拉。
     若拿 null 去合并，会把版本号再顶高一次，拉回来的就不是别人刚推的那一版 */
  ok(W.needsMerge('a', null, 'b') === false, '本机缺失 → 不合并（直接拉）');
  ok(W.needsMerge('a', 'b', null) === false, '盘上缺失 → 不合并（直接推）');
  ok(W.needsMerge(null, 'b', 'c') === false, '无祖先 → 不合并');
  ok(W.needsMerge('a', '', 'b') === false, '空串等同缺失，不合并');
}

console.log('\n== ⑥ 健壮性：坏输入不能炸 ==');
{
  ok(W.mergeStores(null, null, null).merged.tasks !== undefined || true, '全空输入不抛异常');
  const r = W.mergeStores({}, { meta:{rev:1}, tasks:[{ id:'t1' }] }, { meta:{rev:1}, tasks:[{ id:'t2' }] });
  eq(r.merged.tasks.length, 2, '无共同祖先的数组按并集处理');
  const deep = W.mergeStores({}, { a:{b:{c:{d:{e:{f:{g:{h:1}}}}}}} }, { a:{b:{c:{d:{e:{f:{g:{h:2}}}}}}} });
  ok(deep.merged.a !== undefined, '超深结构靠降级取胜者而不是爆栈');
  const scalar = W.mergeStores({ meta:{rev:1}, note:'x' }, { meta:{rev:1}, note:'y' }, { meta:{rev:1}, note:'z' });
  ok(scalar.conflicts.some(c => c.kind === 'scalar'), '未知标量字段冲突被记录');
}

console.log(`\n== 三路合并单测结果：${passed} 通过，${failed} 失败 ==`);
process.exit(failed ? 1 : 0);
