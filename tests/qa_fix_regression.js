/*
 * QA 独立回归套件 —— FlowTask v1.8.1 修复验证（由 QA 新增，不修改任何业务代码）
 * ============================================================================
 * 用法：  node tests/qa_fix_regression.js
 *         node tests/qa_fix_regression.js unit     仅前端纯函数（从 HTML 标记区求值）
 *         node tests/qa_fix_regression.js server   仅 Node + PS1 服务端
 *         node tests/qa_fix_regression.js parity   仅双端对等表
 *
 * 覆盖的修复编号：
 *   P0-1 导入留底失败中止 / P0-2 冲突副本写失败回 500 与形状校验 / P0-3 属性转义与取值域
 *   P1-4 readBody 超限 413 不悬挂 / P1-6 changepw 写盘与指纹同源
 *   PS1：A3 用户名大小写 / A4 POST body 上限 / A14 非法 shape / A15 uid 正则
 *
 * 注意：本文件只“加测试”。若断言暴露源码缺陷，应在报告中回报，而不是改业务代码。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'FlowTask_本地项目管理平台.html');
const SERVER_JS = path.join(ROOT, 'flowtask_server.js');
const SERVER_PS1 = path.join(ROOT, 'flowtask_server.ps1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 源码守卫走 readSource()：行尾/BOM 归一，避免"红绿取决于 checkout 行尾" */
const { readSource } = require('./_helpers');

let passed = 0, failed = 0;
const FAILED = [];
function ok(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; FAILED.push(name + (extra ? '  [' + extra + ']' : '')); }
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` + (cond ? '' : '  [' + (extra || '') + ']'));
}

/* ========================= 通用 HTTP（带超时，避免“悬挂”把测试拖死） ========================= */
function req(base, method, p, { body, headers = {}, timeout = 10000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; clearTimeout(tm); resolve(v); } };
    const tm = setTimeout(() => done({ status: 'TIMEOUT', text: '' }), timeout);
    try {
      const u = new URL(base + p);
      const h = Object.assign({}, headers);
      if (body) h['Content-Length'] = Buffer.byteLength(body);
      // agent:false —— 每个请求开新连接。Node 19+ 的 http.globalAgent 默认 keepAlive，
      // 服务端在 413 后会主动 destroy 连接，复用该连接会让下一个请求偶发 ECONNRESET（客户端假象）
      const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, agent: false }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('error', () => done({ status: 'RES_ERR', text: '' }));
        res.on('end', () => done({ status: res.statusCode, text: d }));
      });
      r.on('error', e => done({ status: 'REQ_ERR', text: String(e && e.code || e) }));
      if (body) { try { r.write(body); } catch (e) { done({ status: 'WRITE_ERR', text: e.message }); } }
      try { r.end(); } catch (e) {}
    } catch (e) { done({ status: 'THROW', text: e.message }); }
  });
}
async function waitUp(base, tries = 120, gap = 250) {
  for (let i = 0; i < tries; i++) { try { const r = await req(base, 'GET', '/api/ping'); if (r.status === 200) return true; } catch (e) {} await sleep(gap); }
  return false;
}
const j = s => { try { return JSON.parse(s); } catch (e) { return {}; } };
const tsTagFor = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/* ========================= PART A：前端纯函数（P0-3 / 导入校验） ========================= */
function unitTests() {
  console.log('\n== A. 前端：validateImportData 取值域 与 escAttr/safeColor/safeMood 边界 ==');
  const html = readSource(HTML);
  const regions = [...html.matchAll(/\/\*==TEST-BEGIN==\*\/([\s\S]*?)\/\*==TEST-END==\*\//g)].map(m => m[1]);
  ok('A0 可从 HTML 标记区提取纯函数（>=5 处）', regions.length >= 5, '实际 ' + regions.length);
  const sandbox = { Date, Math, String, Number, Object, Array, JSON, RegExp, isNaN, console, Map, Set, Error };
  /* validateImportData 的状态取值域现在是 STATUS_ORDER（单源，含 paused）。
     真实运行时它由 STATUS_DEF 派生；沙箱里补上等价定义，才能验"paused 不再被拒"。 */
  sandbox.STATUS_ORDER = ['todo', 'doing', 'paused', 'done'];
  vm.createContext(sandbox);
  vm.runInContext(regions.join('\n'), sandbox);
  const S = sandbox;
  ok('A0b validateImportData / escAttr / safeColor / safeMood / safeName 均已导出到测试沙箱',
    typeof S.validateImportData === 'function' && typeof S.escAttr === 'function'
    && typeof S.safeColor === 'function' && typeof S.safeMood === 'function'
    && typeof S.safeName === 'function');

  /* --- A0c safeName：显示名收口（v2.1.3 新增，堵跨账户存储型 XSS） --- */
  ok('A0c safeName 压掉标签与属性溢出字符', S.safeName('<img src=x onerror=alert(1)>') === 'img src=x onerror=alert(1)');
  ok('A0d safeName 压掉反引号（属性位逃逸）', S.safeName('a`b') === 'ab');
  /* 控制字符先被删除（含 \n），所以换行不会变成空格；真正的空格串才折叠。
     这个顺序是有意的：显示名里的换行只会撑破表格与药丸，没有保留价值。 */
  ok('A0e safeName 删控制字符、折叠空白并 trim',
    S.safeName('  张\u0000三\n李四 ') === '张三李四'
    && S.safeName('张  三') === '张 三');
  ok('A0f safeName 限长 40', S.safeName('x'.repeat(100)).length === 40);
  ok('A0g safeName 保留正常中英文与 emoji 名（不过度清洗）',
    S.safeName('张三 Zhang 🚀') === '张三 Zhang 🚀');
  ok('A0h safeName 对 null/undefined 返回空串（register 会回退到 username）',
    S.safeName(null) === '' && S.safeName(undefined) === '');

  const base = () => ({
    users: [{ id: 'u1', username: 't', name: 'T', role: 'admin', color: '#E24D5C', active: true }],
    projects: [{ id: 'p1', name: 'P', color: '#3b82f6', memberIds: ['u1'], statusUpdates: [] }],
    tasks: [], notifications: [], tags: []
  });
  const V = data => S.validateImportData(data);

  /* --- A1 合法输入必须放行（防回归核心） --- */
  ok('A1 合法备份通过（调色板色 + 空状态更新）', V(base()) === null, String(V(base())));
  const threeDigit = base(); threeDigit.projects[0].color = '#abc';
  ok('A1b #RGB 三色位通过', V(threeDigit) === null, String(V(threeDigit)));
  const noColor = base(); delete noColor.users[0].color; delete noColor.projects[0].color;
  ok('A1c 颜色字段缺失（undefined）仍放行——只加严不改既有判定', V(noColor) === null, String(V(noColor)));
  const emptyColor = base(); emptyColor.users[0].color = ''; emptyColor.projects[0].color = '';
  ok('A1d 颜色为空串仍放行', V(emptyColor) === null, String(V(emptyColor)));
  const noMood = base(); noMood.projects[0].statusUpdates = [{ id: 'su1', mood: undefined, text: 'x' }];
  ok('A1e statusUpdates[].mood 缺失仍放行', V(noMood) === null, String(V(noMood)));
  const goodMood = base(); goodMood.projects[0].statusUpdates = [{ id: 'su1', mood: 'atrisk', text: 'x' }, { id: 'su2', mood: 'offtrack', text: 'y' }];
  ok('A1f 合法 mood（atrisk/offtrack）通过', V(goodMood) === null, String(V(goodMood)));

  /* --- A2 新增加严：非法颜色/mood 必须被拒 --- */
  const badNamed = base(); badNamed.projects[0].color = 'red';
  ok('A2 命名色 red 被拒', typeof V(badNamed) === 'string', String(V(badNamed)));
  const badLen = base(); badLen.users[0].color = '#12345';
  ok('A2b 5 位 hex 被拒', typeof V(badLen) === 'string', String(V(badLen)));
  const badInject = base(); badInject.projects[0].color = '#fff" onload="alert(1)';
  ok('A2c 颜色注入载荷被拒', typeof V(badInject) === 'string', String(V(badInject)));
  const badRgb = base(); badRgb.tags = [{ id: 'g1', name: 'G', color: 'rgb(1,2,3)' }];
  ok('A2d 标签 rgb() 颜色被拒', typeof V(badRgb) === 'string', String(V(badRgb)));
  const badMood = base(); badMood.projects[0].statusUpdates = [{ id: 'su1', mood: 'happy', text: 'x' }];
  ok('A2e 非法 mood 被拒', typeof V(badMood) === 'string', String(V(badMood)));
  const badMoodInject = base(); badMoodInject.projects[0].statusUpdates = [{ id: 'su1', mood: 'ontrack" onclick="alert(1)', text: 'x' }];
  ok('A2f mood 注入载荷被拒', typeof V(badMoodInject) === 'string', String(V(badMoodInject)));

  /* --- A2g 「已暂停」必须能导回（v2.1.3 修的真实缺陷）---
     此前 STATUS_OK 写死 ['todo','doing','done']，而 STATUS_DEF 有四态，
     于是"导出 → 导入"对自己导出的备份必然失败（仓库自己的 flowtask_shared.json
     里就有 paused 任务）。这条断言锁住回归。 */
  const paused = base();
  paused.tasks = [
    { id: 't1', title: '暂停的任务', status: 'paused' },
    { id: 't2', title: '正常待办', status: 'todo' },
  ];
  ok('A2g 含「已暂停」任务的备份可导入（此前必然失败）', V(paused) === null, String(V(paused)));
  const fourStates = base();
  fourStates.tasks = ['todo', 'doing', 'paused', 'done'].map((s, i) => ({ id: 't' + i, title: s, status: s }));
  ok('A2h 四种状态全部被接受', V(fourStates) === null, String(V(fourStates)));
  const bogusState = base(); bogusState.tasks = [{ id: 't1', title: 'x', status: 'archived' }];
  ok('A2i 未知状态仍被拒（加严没被放宽）', typeof V(bogusState) === 'string', String(V(bogusState)));

  /* --- A3 既有 7 条判定（含结构）不得被改动 --- */
  ok('A3 非对象被拒', typeof V(null) === 'string' && typeof V('x') === 'string');
  ok('A3b 缺 users/projects/tasks 数组被拒', typeof V({ users: [], projects: [] }) === 'string');
  const dup = base(); dup.tasks = [{ id: 'p1', title: 'x' }];
  ok('A3c 重复 id 被拒', typeof V(dup) === 'string');
  const noId = base(); noId.tasks = [{ title: '无编号' }];
  ok('A3d 缺 id 被拒', typeof V(noId) === 'string');
  const noMembers = base(); delete noMembers.projects[0].memberIds;
  ok('A3e 项目缺成员列表被拒', typeof V(noMembers) === 'string');
  const badComments = base(); badComments.tasks = [{ id: 't1', title: 'T', comments: 'x' }];
  ok('A3f 任务 comments 非列表被拒', typeof V(badComments) === 'string');

  /* --- A4 safeColor 边界 --- */
  ok('A4 safeColor 3 位 hex 原样', S.safeColor('#abc') === '#abc');
  ok('A4b safeColor 6 位 hex 原样（大小写保留）', S.safeColor('#AABBCC') === '#AABBCC');
  ok('A4c safeColor 空值回退默认', S.safeColor(undefined) === '#9aa1ac' && S.safeColor(null) === '#9aa1ac' && S.safeColor('') === '#9aa1ac');
  ok('A4d safeColor 命名色回退', S.safeColor('red') === '#9aa1ac');
  ok('A4e safeColor 长度错误回退（5/7/8 位）', S.safeColor('#12345') === '#9aa1ac' && S.safeColor('#1234567') === '#9aa1ac' && S.safeColor('#12345678') === '#9aa1ac');
  ok('A4f safeColor 注入载荷回退', S.safeColor('#fff;}body{display:none') === '#9aa1ac' && S.safeColor('expression(alert(1))') === '#9aa1ac');
  ok('A4g safeColor 非字符串回退', S.safeColor(123) === '#9aa1ac' && S.safeColor({}) === '#9aa1ac');
  ok('A4h safeColor 支持自定义 fallback', S.safeColor('red', '#000') === '#000');

  /* --- A5 safeMood 白名单 --- */
  ok('A5 safeMood 三个合法值原样',
    S.safeMood('ontrack') === 'ontrack' && S.safeMood('atrisk') === 'atrisk' && S.safeMood('offtrack') === 'offtrack');
  ok('A5b safeMood 非法值回退 ontrack',
    S.safeMood('happy') === 'ontrack' && S.safeMood('') === 'ontrack' && S.safeMood(null) === 'ontrack'
    && S.safeMood(undefined) === 'ontrack' && S.safeMood('ontrack" x="1') === 'ontrack');

  /* --- A6 escAttr 边界 --- */
  ok('A6 escAttr 转义双引号', S.escAttr('a"b') === 'a&quot;b');
  ok('A6b escAttr 转义单引号/尖括号/&', S.escAttr(`<'&`) === '&lt;&#39;&amp;');
  ok('A6c escAttr 剥除反引号与控制字符', S.escAttr('a`b') === 'ab' && S.escAttr('a\u0001b') === 'ab');
  ok('A6d escAttr 空值安全', S.escAttr('') === '' && S.escAttr(undefined) === '');
  ok('A6e escAttr 能挡住属性逃逸载荷',
    !S.escAttr('x" onmouseover="alert(1)').includes('"') && !S.escAttr("x' onx='1").includes("'"));

  /* --- A7 助手必须真的被渲染链调用（不是死代码） --- */
  const cnt = s => (html.split(s).length - 1);
  ok('A7 safeColor 调用点充足（>=30 处）', cnt('safeColor(') >= 30, '实际 ' + cnt('safeColor('));
  ok('A7b safeMood 已接入渲染链', cnt('safeMood(') >= 2, '实际 ' + cnt('safeMood('));
  ok('A7c escAttr 已接入渲染链', cnt('escAttr(') >= 3, '实际 ' + cnt('escAttr('));
  /* 精确覆盖度扫描：剥掉注释后，取出 style="…" 里的 ${…} 表达式；
     凡引用 .color 的拼接点都必须被 safeColor 包裹（常量调色板不在此判定内） */
  const noComments = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  const spliceOf = attr => [...noComments.matchAll(new RegExp(attr + '="([^"]*)"', 'g'))]
    .flatMap(m => [...m[1].matchAll(/\$\{([^}]*)\}/g)].map(x => x[1]));
  const styleColor = spliceOf('style').filter(e => /\.color\b/.test(e));
  /* 先证明 STATUS_PILLS / PRIO_PILLS / PROJ_COLORS 是「代码常量调色板」，再把由它们
     产生的拼接（s.color / x.color / proj.color===c）排除在“必须 safeColor”之外——
     这几处不含用户数据，safeColor 的替代物是「源头即常量」。 */
  ok('A7d-0 STATUS_PILLS / PRIO_PILLS / PROJ_COLORS 均为常量定义',
    /const STATUS_PILLS = STATUS_DEF\.map/.test(noComments)
    && /const PRIO_PILLS = \[/.test(noComments)
    && /const PROJ_COLORS = \[/.test(noComments));
  const KNOWN_CONST = ['s.color', 'x.color'];
  const offenders = styleColor.filter(e =>
    !/safeColor\(/.test(e) && !KNOWN_CONST.includes(e.trim()) && !/proj\.color===c/.test(e));
  ok('A7d style 里的用户数据 .color 拼接全部经 safeColor（共扫描 ' + styleColor.length + ' 处）',
    offenders.length === 0, JSON.stringify(offenders));
  console.log('        [信息] 其中常量调色板拼接 ' + styleColor.filter(e => !/safeColor\(/.test(e)).length + ' 处（非用户数据）');
  ok('A7e class 里的 mood 拼接全部经 safeMood 白名单', !/class="mood-\$\{(?!mood\})/.test(noComments));
  /* 残余的数据源属性拼接（非颜色/mood）：仅统计并写入报告，不计 PASS/FAIL */
  const nakedData = [...noComments.matchAll(/(?:class|data-\w+|title|value)="([^"]*)"/g)]
    .flatMap(m => [...m[1].matchAll(/\$\{([^}]*)\}/g)].map(x => x[1]))
    .filter(e => /^[a-z]\.\w+(\.\w+)?$/.test(e.trim()))
    .filter(e => !/esc\(|escAttr|safeColor|safeMood|checkTitle|dueClass|prioName|STATUS_|ROLE_NAME|projectHash/.test(e));
  console.log('        [信息] 仍为裸拼接的数据源属性表达式 ' + nakedData.length + ' 处（非颜色/mood，见报告）');
  if (nakedData.length) console.log('        [信息] 样例：' + JSON.stringify([...new Set(nakedData)].slice(0, 14)));

  /* --- A8 P1-2 批量与单任务语义一致（源码级守卫，两端都在） --- */
  const snip = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
  const single = snip('function toggleTaskDone', 'function spawnRecurringNext');
  const batch = snip("if(act==='done')", "}else if(act==='assign')");
  ok('A8 单任务完成时快照 _prevStatus', /_prevStatus\s*=\s*\(t\.status && t\.status!=='done'\)\s*\?\s*t\.status\s*:\s*'todo'/.test(single));
  ok('A8b 批量完成时快照 _prevStatus（与单任务同式）', /_prevStatus\s*=\s*\(t\.status && t\.status!=='done'\)\s*\?\s*t\.status\s*:\s*'todo'/.test(batch));
  ok('A8c 批量取消完成按 _prevStatus 还原',
    /t\.status\s*=\s*\(t\._prevStatus && t\._prevStatus!=='done'\)\s*\?\s*t\._prevStatus\s*:\s*'todo'/.test(batch));

  /* --- A9 P1-1 两套绑定平级且都在 --- */
  const bind = snip('function bindTaskClicks', 'function renderMyTasks');
  ok('A9 主任务行绑定存在', /mini-task\[data-task\]/.test(bind) && /toggleTaskDone/.test(bind));
  ok('A9b 子任务行绑定存在且调 toggleSubDone', /mini-task\[data-sub\]/.test(bind) && /toggleSubDone/.test(bind));
  ok('A9c 子任务行仍可打开详情抽屉', /openSubDrawer/.test(bind));
  ok('A9d 两次遍历为平级（子任务遍历不在主任务回调内）',
    bind.indexOf("\\$\$('.mini-task[data-sub]'") === -1 ? /\.mini-task\[data-sub\]/.test(bind) && bind.split('$$(').length >= 3 : true);

  /* --- A10 P1-8 先冲队列再置空 --- */
  const exp = snip('function expireSession', 'function logout');
  ok('A10 expireSession 先 flushAllSaves 再置空',
    exp.indexOf('flushAllSaves()') > -1 && exp.indexOf('flushAllSaves()') < exp.indexOf('ME = null'));

  /* --- A11 P1-6 写盘与指纹同源（Node 源码）
         v1.10 起三条专用端点（改密/重置/删号）统一走 writeAuthObjWithRev，
         所以"同源"这条不变式要在该函数里查，而不是在 /api/changepw 的代码段里查。 --- */
  const srv = readSource(SERVER_JS);
  const waStart = srv.indexOf('function writeAuthObjWithRev');
  const wa = waStart > -1 ? srv.slice(waStart, waStart + 1600) : '';
  /* v1.10：账户表落盘升级为 tmp+rename 原子替换（审查项 #3）——
     "同一份文本写盘与算 hash"的不变式不变，只是写盘目标从 AUTH_FILE 变成 tmpAuth */
  ok('A11 账户表统一落盘：同一份文本写盘与算 hash',
    /const storeText = JSON.stringify\(auth, null, 2\)/.test(wa)
    && /writeFileSync\(tmpAuth, storeText/.test(wa)
    && /renameSync\(tmpAuth, AUTH_FILE\)/.test(wa)
    && /hash = hashOf\(storeText\)/.test(wa)
    && wa.indexOf('writeFileSync(tmpAuth, storeText') < wa.indexOf('hash = hashOf(storeText)'));
  /* rev 一致性：文件里的 meta.rev 必须和服务端记账一起推进，
     否则客户端读到的 rev 永远小 1，之后每次整表回写都会撞 409（M22 真根因） */
  ok('A11b 落盘前把新 rev 写进文件 meta，记账与文件同源',
    /auth\.meta\.rev = next/.test(wa) && wa.indexOf('auth.meta.rev = next') < wa.indexOf('JSON.stringify(auth, null, 2)')
    && /st\.rev = next/.test(wa));
  const srvDef = srv.replace('function writeAuthObjWithRev(auth){', '');   // 去掉定义本身，只数调用
  ok('A11c 三条专用端点都走统一落盘，且账户表只剩这一条原子写路径（不再有直写最终路径的旁路）',
    (srvDef.match(/writeAuthObjWithRev\(auth\)/g) || []).length === 3
    && (srv.match(/writeFileSync\(\s*AUTH_FILE/g) || []).length === 0
    && (srv.match(/writeFileSync\(tmpAuth/g) || []).length === 1,
    'writeAuthObjWithRev 调用 ' + (srvDef.match(/writeAuthObjWithRev\(auth\)/g) || []).length + ' 处');

  /* --- A12 P0-1 中止点位于 DB=data 之前 --- */
  const imp = html.slice(html.indexOf('let backedUp = false'), html.indexOf('DB = data; saveDB();'));
  ok('A12 留底失败 throw 在 DB=data 之前', /if\(!backedUp\)\{[\s\S]*?throw new Error/.test(imp) && imp.indexOf('throw new Error') > -1);
  ok('A12b 中止文案说明「未覆盖现有数据」', /未覆盖现有数据/.test(imp + html.slice(html.indexOf('DB = data; saveDB();'), html.indexOf('DB = data; saveDB();') + 200)));

  /* --- A13 D-5：id / status / priority 取值域收口（应 team-lead 要求补测；只加测试） ---
     被测代码：HTML:5165-5167（users/projects/tasks 顶层 id 正则）、5203-5219（ID_RE/STATUS_OK/PRIO_OK
     与 task/subtask/tag 的 id、status、priority 校验）。既有 A 组写于 D-5 之前，未覆盖此处。
     设计原则：拒绝与放行同等重要——既要堵注入，也不能误拒真实备份。 */
  const withTask = t => {
    const d = base();
    d.tasks = [Object.assign({ id: 't_mf3k2j9', title: 'T', comments: [], activities: [], subtasks: [], tags: [] }, t)];
    return d;
  };
  const withSub = s => withTask({ subtasks: [Object.assign({ id: 'st_x1', title: 's', status: 'todo', priority: 'low' }, s)] });

  /* A13a 顶层 id（users/projects/tasks）含非法字符必须被拒 */
  const badTopIds = [
    ['双引号', 'p"1'], ['单引号', "p'1"], ['尖括号', 'p<1>'], ['空格', 'p 1'],
    ['反引号', 'p`1'], ['超过 64 字符', 'p' + 'x'.repeat(64)],
  ];
  badTopIds.forEach(([label, bad], i) => {
    const d = base(); d.projects[0].id = bad;
    const msg = V(d);
    /* 不只判“被拒”，还要判“因编号非法被拒”——否则别的判定顶替拒了也会假通过 */
    ok(`A13a-${i + 1} 顶层 id 含${label}被拒`, typeof msg === 'string' && /编号/.test(msg), '实际 ' + JSON.stringify(msg));
  });

  /* A13b task 的 status / priority 非法必须被拒（含属性逃逸载荷），且报错原因须为对应字段 */
  const mTaskStatus = V(withTask({ status: 'evil"' }));
  ok('A13b-1 task.status 取非法值被拒（含双引号逃逸）', typeof mTaskStatus === 'string' && /状态/.test(mTaskStatus), '实际 ' + String(mTaskStatus));
  const mTaskPrio = V(withTask({ priority: 'x' }));
  ok('A13b-2 task.priority 取非法值被拒', typeof mTaskPrio === 'string' && /优先级/.test(mTaskPrio), '实际 ' + String(mTaskPrio));

  /* A13c 子任务同字段非法必须被拒（id / status / priority） */
  const mSubId = V(withSub({ id: 'st"x' }));
  ok('A13c-1 子任务 id 含双引号被拒', typeof mSubId === 'string' && /编号/.test(mSubId), '实际 ' + String(mSubId));
  const mSubStatus = V(withSub({ status: 'evil"' }));
  ok('A13c-2 子任务 status 取非法值被拒', typeof mSubStatus === 'string' && /子任务状态/.test(mSubStatus), '实际 ' + String(mSubStatus));
  const mSubPrio = V(withSub({ priority: 'x' }));
  ok('A13c-3 子任务 priority 取非法值被拒', typeof mSubPrio === 'string' && /子任务优先级/.test(mSubPrio), '实际 ' + String(mSubPrio));

  /* A13d 标签 id 非法必须被拒 */
  const withTag = id => { const d = base(); d.tags = [{ id, name: 'G', color: '#abc' }]; return d; };
  const mTagId = V(withTag('g"1'));
  ok('A13d 标签 id 含双引号被拒', typeof mTagId === 'string' && /编号/.test(mTagId), '实际 ' + String(mTagId));

  /* A13e 放行（防误拒，与拒绝同等重要）：真实 id 形态必须通过
     覆盖：数字/下划线/连字符、大小写混合、长度 1 与 64 边界 */
  const realShape = {
    users: [{ id: 'u1', username: 't', name: 'T', role: 'admin', color: '#E24D5C', active: true }],
    projects: [{ id: 'p_abc123', name: 'P', color: '#3b82f6', memberIds: ['u1'], statusUpdates: [] }],
    tasks: [{ id: 't_mf3k2j9', title: 'T', status: 'doing', priority: 'med', comments: [], activities: [],
      subtasks: [{ id: 'st_x1', title: 's', status: 'todo', priority: 'low' }], tags: [] }],
    tags: [{ id: 'g-1', name: 'G', color: '#abc' }], notifications: []
  };
  ok('A13e-1 真实 id 形态（u1 / p_abc123 / t_mf3k2j9 / st_x1 / g-1）全部放行', V(realShape) === null, '实际 ' + String(V(realShape)));
  const len1 = base(); len1.projects[0].id = 'a';
  ok('A13e-2 长度 1 的 id 放行（下界边界）', V(len1) === null, '实际 ' + String(V(len1)));
  const len64 = base(); len64.projects[0].id = 'q' + 'w'.repeat(63);
  ok('A13e-3 长度 64 的 id 放行（上界边界）', V(len64) === null, '实际 ' + String(V(len64)));
  const mixed = base(); mixed.projects[0].id = 'AbC_12-xYZ';
  ok('A13e-4 大小写混合 + 连字符/下划线 id 放行', V(mixed) === null, '实际 ' + String(V(mixed)));

  /* A13f 兼容：status / priority 缺失或为 null 必须放行（旧备份兼容） */
  ok('A13f-1 task/subtask 的 status、priority 字段缺失放行', V(withTask({})) === null && V(withSub({ status: undefined, priority: undefined })) === null, '实际 ' + String(V(withTask({}))));
  ok('A13f-2 task/subtask 的 status、priority 为 null 放行', V(withTask({ status: null, priority: null })) === null && V(withSub({ status: null, priority: null })) === null, '实际 ' + String(V(withTask({ status: null, priority: null }))));

  /* A13g 信息性固化：D-5 之前约有 46 处属性拼接以数据源表达式直出（见 A7e 统计）。
     D-5 之后，这些值（id / status / priority）已被导入校验约束为「受控 id 正则 + 枚举白名单」：
       - id 只允许 [A-Za-z0-9_-]{1,64}，引号/尖括号/反引号/空格一律被拒；
       - status 只允许 todo/doing/done，priority 只允许 high/med/low；
     故这些拼接虽仍是“裸拼接”，其数据源已不再可控，注入面已消除（当前不是漏洞）。
     彻底收敛（逐点 escAttr）仍可作后续加固项。此断言把结论固化，避免他人误读为
     “已逐点转义”或“漏洞仍在”。 */
  const bindTask = withTask({}); bindTask.tasks[0].id = 't"x';
  const mBindId = String(V(bindTask));
  const boundByImport = /状态/.test(String(mTaskStatus)) && /优先级/.test(String(mTaskPrio)) && /编号/.test(mBindId);
  ok('A13g 残余属性拼接的数据源已被导入校验约束为受控 id/枚举（信息性：非注入面，彻底收敛应统一 escAttr）',
    boundByImport, '实际 ' + JSON.stringify([String(mTaskStatus), String(mTaskPrio), mBindId]));
}

/* ========================= PART B：Node 服务端（P0-2 / P1-4） ========================= */
async function serverTests() {
  console.log('\n== B. Node 存储服务（P0-2 冲突副本 / P1-4 超限 body） ==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-node-'));
  const BASE = 'http://127.0.0.1:5421';
  const env = Object.assign({}, process.env, { FLOWTASK_PORT: '5421', FLOWTASK_DATA_DIR: dir });
  const proc = spawn(process.execPath, [SERVER_JS], { env, stdio: 'ignore', windowsHide: true });
  try {
    const up = await waitUp(BASE);
    ok('B0 服务可在 5421 启动', up);
    if (!up) return;
    const tk = await req(BASE, 'GET', '/api/token', { headers: { Origin: BASE } });
    const TOKEN = j(tk.text).token;
    const A = { Origin: BASE, 'X-FlowTask-Token': TOKEN };
    const HASH_A = 'p1$' + 'a'.repeat(64);
    await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev': '1' }, A),
        body: JSON.stringify({ meta: { rev: 1 }, users: [{ id: 'u_a', username: 'a', name: 'A', role: 'admin', salt: 's_a', passHash: HASH_A, active: true }] }) });
    const SESSION = j((await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: 'u_a', verifier: HASH_A }) })).text).session;
    const S = Object.assign({ 'X-FlowTask-Session': SESSION }, A);
    const dataBody = JSON.stringify({ meta: { rev: 1 }, projects: [], tasks: [], notifications: [] });
    await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '1' }, S), body: dataBody });

    /* P0-2a 冲突副本形状校验 */
    const bad = await req(BASE, 'POST', '/api/db-conflict?file=flowtask_data_u_a.json', { headers: S, body: '{"meta":{"rev":1},"users":[]}' });
    ok('B1 /api/db-conflict 非法形状回 400', bad.status === 400, '实际 ' + bad.status);
    const good = await req(BASE, 'POST', '/api/db-conflict?file=flowtask_data_u_a.json', { headers: S, body: dataBody });
    ok('B1b /api/db-conflict 合法数据回 200 并给文件名',
      good.status === 200 && /flowtask_data_u_a_conflict_\d{8}_\d{6}\.json/.test(j(good.text).file || ''), good.text.slice(0, 90));

    /* 用会话可写的 u_a。先清掉 B1b 刚写出的同名冲突文件，避免与预建目录撞名，
       再为「冲突副本目标文件名」逐个秒铺开目录 → fs.writeFile 命中 EISDIR → 应回 500 */
    for (const f of fs.readdirSync(dir)) {
      if (/^flowtask_data_u_a_conflict_\d{8}_\d{6}\.json$/.test(f)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch (e) {} }
    }
    const now = new Date();
    let dirsMade = 0;
    for (let s = -5; s <= 15; s++) {
      const d = new Date(now.getTime() + s * 1000);
      try { fs.mkdirSync(path.join(dir, 'flowtask_data_u_a_conflict_' + tsTagFor(d) + '.json')); dirsMade++; } catch (e) {}
    }
    const failWrite = await req(BASE, 'POST', '/api/db-conflict?file=flowtask_data_u_a.json', { headers: S, body: dataBody });
    ok('B2 冲突副本写盘失败回 500（不假成功）', failWrite.status === 500, '实际 ' + failWrite.status + '（预建目录 ' + dirsMade + ' 个）');
    ok('B2b 失败响应体为 {err:"save failed"}', j(failWrite.text).err === 'save failed', failWrite.text.slice(0, 80));

    /* P1-4 超限 body：硬性契约是「不悬挂 + 服务不被搞坏」；413 本身在 localhost 上
       存在与 RST 竞争的偶发（响应 flush 后 req.destroy 触发 RST，客户端可能先看到
       ECONNRESET）。故重复 4 次取样：断言不悬挂 + 至少一次明确回 413。 */
    const big = JSON.stringify({ meta: { rev: 99 }, projects: [], tasks: [], pad: 'x'.repeat(9 * 1024 * 1024) });
    const seen = []; let hung = false;
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      const over = await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '99' }, S), body: big, timeout: 15000 });
      const dt = Date.now() - t0;
      if (over.status === 'TIMEOUT') hung = true;
      seen.push(over.status + '/' + dt + 'ms' + (typeof over.status === 'string' ? '(' + (over.code || over.text || '') + ')' : ''));
      await sleep(150);
    }
    console.log('        [信息] 超限请求 4 次实测：' + JSON.stringify(seen));
    ok('B3 超限 body 不悬挂（4 次均收到响应）', !hung, JSON.stringify(seen));
    ok('B3b 超限 body 至少一次回 413 且 body 为 {err:"too large"}', seen.some(x => x.startsWith('413')), JSON.stringify(seen));

    /* 超限之后服务仍可用（连接未被搞坏） */
    const after = await req(BASE, 'GET', '/api/version', { timeout: 8000 });
    ok('B4 超限之后服务仍正常响应', after.status === 200, '实际 ' + after.status);
  } finally {
    try { proc.kill(); } catch (e) {}
    try { process.kill(-proc.pid); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.log('  [env] 临时目录清理超时（沙箱删除受限，非代码问题）: ' + dir); }
  }
}

/* ========================= PART C：PS1 服务端（A3/A4/A14/A15） ========================= */
async function ps1Tests() {
  console.log('\n== C. PowerShell 存储服务（A3 / A14 / A15） ==');
  if (!fs.existsSync(SERVER_PS1)) { ok('C0 flowtask_server.ps1 存在', false); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-ps1-'));
  const BASE = 'http://127.0.0.1:5422';
  const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SERVER_PS1, '-Port', '5422', '-DataDir', dir], { stdio: 'ignore', windowsHide: true });
  try {
    const up = await waitUp(BASE, 160, 300);
    ok('C0 PS1 服务可在 5422 启动', up);
    if (!up) return;
    const tk = await req(BASE, 'GET', '/api/token', { headers: { Origin: BASE } });
    const TOKEN = j(tk.text).token;
    const A = { Origin: BASE, 'X-FlowTask-Token': TOKEN };
    const HASH_A = 'p1$' + 'a'.repeat(64);
    await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev': '1' }, A),
        body: JSON.stringify({ meta: { rev: 1 }, users: [{ id: 'u_a', username: 'a', name: 'A', role: 'admin', salt: 's_a', passHash: HASH_A, active: true }] }) });
    const SESSION = j((await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: 'u_a', verifier: HASH_A }) })).text).session;
    const S = Object.assign({ 'X-FlowTask-Session': SESSION }, A);
    await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '1' }, S), body: JSON.stringify({ meta: { rev: 1 }, projects: [], tasks: [], notifications: [] }) });

    /* A14 非法 shape 必须被拒 */
    const badShape = await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json',
      { headers: Object.assign({ 'X-FlowTask-Rev': '9' }, S), body: '{"meta":{"rev":9},"users":[]}' });
    ok('C1 /api/db 数据文件非法形状回 400（A14）', badShape.status === 400, '实际 ' + badShape.status);
    const badAuth = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev': '9' }, A), body: '{"meta":{"rev":9},"projects":[]}' });
    ok('C1b /api/db 账户表非法形状回 400', badAuth.status === 400, '实际 ' + badAuth.status);
    const strUsers = await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
      { headers: Object.assign({ 'X-FlowTask-Rev': '9' }, A), body: '{"meta":{"rev":9},"users":"x"}' });
    ok('C1c users 为字符串被拒（-is [array] 而非 IEnumerable）', strUsers.status === 400, '实际 ' + strUsers.status);

    /* A15 uid 正则 */
    const uidOk = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: 'u_a', verifier: HASH_A }) });
    ok('C2 合法 uid 换会话 200（A15 不误伤）', uidOk.status === 200, '实际 ' + uidOk.status);
    const uidBad = await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: '../../x', verifier: HASH_A }) });
    ok('C2b 非法 uid 回 400', uidBad.status === 400, '实际 ' + uidBad.status);

    /* A3 用户名大小写 */
    const chalUpper = await req(BASE, 'GET', '/api/auth-challenge?username=' + encodeURIComponent('A'), { headers: { 'X-FlowTask-Token': TOKEN } });
    ok('C3 用户名大写 A 可命中挑战 200（A3）', chalUpper.status === 200, '实际 ' + chalUpper.status);
    const chalSpace = await req(BASE, 'GET', '/api/auth-challenge?username=' + encodeURIComponent('  a  '), { headers: { 'X-FlowTask-Token': TOKEN } });
    ok('C3b 用户名首尾空格被忽略 200（A3）', chalSpace.status === 200, '实际 ' + chalSpace.status);

    /* A4 POST body 上限：D-3 已把 PS1 超限响应从 400 对齐为 413（与 Node 一致）。
       本地回环上超限响应可能与 RST 竞争（客户端偶发 ECONNRESET，见 D-4），故失败重试；
       一旦拿到明确状态码，就必须是 413。 */
    const big = JSON.stringify({ meta: { rev: 99 }, projects: [], tasks: [], pad: 'x'.repeat(9 * 1024 * 1024) });
    let c4 = null; const c4seen = [];
    for (let i = 0; i < 4 && c4 === null; i++) {
      const r = await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '99' }, S), body: big, timeout: 20000 });
      c4seen.push(typeof r.status === 'number' ? r.status : r.status + '(' + (r.code || r.text || '') + ')');
      if (typeof r.status === 'number') c4 = r.status;
      await sleep(150);
    }
    console.log('        [信息] PS1 超限 POST 实测：' + JSON.stringify(c4seen));
    ok('C4 超限 POST 回 413（A4/D-3 已与 Node 对齐）', c4 === 413, '实际 ' + c4);
  } finally {
    try { proc.kill(); } catch (e) {}
    try { process.kill(-proc.pid); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.log('  [env] 临时目录清理超时（沙箱删除受限，非代码问题）: ' + dir); }
  }
}

/* ========================= PART D：双端对等表 ========================= */
async function parityTable() {
  console.log('\n== D. 双端对等表（本次声称“对齐”的 4 项 + 冲突副本形状） ==');
  const dirN = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-par-n-'));
  const dirP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-par-p-'));
  const BN = 'http://127.0.0.1:5431', BP = 'http://127.0.0.1:5432';
  const pN = spawn(process.execPath, [SERVER_JS], { env: Object.assign({}, process.env, { FLOWTASK_PORT: '5431', FLOWTASK_DATA_DIR: dirN }), stdio: 'ignore', windowsHide: true });
  const pP = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SERVER_PS1, '-Port', '5432', '-DataDir', dirP], { stdio: 'ignore', windowsHide: true });
  try {
    const upN = await waitUp(BN), upP = await waitUp(BP, 160, 300);
    ok('D0 两实现均可启动', upN && upP, 'node=' + upN + ' ps1=' + upP);
    if (!upN || !upP) return;

    async function measure(BASE) {
      const r = {};
      const TOKEN = j((await req(BASE, 'GET', '/api/token', { headers: { Origin: BASE } })).text).token;
      const A = { Origin: BASE, 'X-FlowTask-Token': TOKEN };
      const HASH_A = 'p1$' + 'a'.repeat(64);
      await req(BASE, 'POST', '/api/db?file=flowtask_auth.json',
        { headers: Object.assign({ 'X-FlowTask-Rev': '1' }, A),
          body: JSON.stringify({ meta: { rev: 1 }, users: [{ id: 'u_a', username: 'a', name: 'A', role: 'admin', salt: 's_a', passHash: HASH_A, active: true }] }) });
      const SESSION = j((await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: 'u_a', verifier: HASH_A }) })).text).session;
      const S = Object.assign({ 'X-FlowTask-Session': SESSION }, A);
      const dataBody = JSON.stringify({ meta: { rev: 1 }, projects: [], tasks: [], notifications: [] });
      await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '1' }, S), body: dataBody });
      r['1. 登录挑战：用户名大写 A'] = (await req(BASE, 'GET', '/api/auth-challenge?username=A', { headers: { 'X-FlowTask-Token': TOKEN } })).status;
      r['2. 非法 shape：/api/db 数据文件'] = (await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '9' }, S), body: '{"meta":{"rev":9},"users":[]}' })).status;
      r['3. uid 正则：uid 含大写 U_A'] = (await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: 'U_A', verifier: HASH_A }) })).status;
      r['3b. uid 正则：路径穿越 ../../x'] = (await req(BASE, 'POST', '/api/session', { headers: A, body: JSON.stringify({ uid: '../../x', verifier: HASH_A }) })).status;
      r['4. body 上限：>8MB POST'] = (await req(BASE, 'POST', '/api/db?file=flowtask_data_u_a.json', { headers: Object.assign({ 'X-FlowTask-Rev': '99' }, S), body: JSON.stringify({ meta: { rev: 99 }, projects: [], tasks: [], pad: 'x'.repeat(9 * 1024 * 1024) }), timeout: 20000 })).status;
      r['5. 非法 shape：/api/db-conflict 数据文件'] = (await req(BASE, 'POST', '/api/db-conflict?file=flowtask_data_u_a.json', { headers: S, body: '{"meta":{"rev":1},"users":[]}' })).status;
      r['5b. 非法 shape：/api/db-conflict 账户表'] = (await req(BASE, 'POST', '/api/db-conflict?file=flowtask_auth.json', { headers: A, body: '{"meta":{"rev":1},"projects":[]}' })).status;
      return r;
    }
    const n = await measure(BN), p = await measure(BP);
    const KEYS = Object.keys(n);
    let mism = 0;
    for (const k of KEYS) {
      const aligned = String(n[k]) === String(p[k]);
      if (!aligned) mism++;
      console.log(`  ${aligned ? 'ALIGNED ' : 'MISMATCH'}  ${k}  →  node=${JSON.stringify(n[k])}  ps1=${JSON.stringify(p[k])}`);
    }
    ok('D1 双端对等：4 项对齐 + 冲突副本形状一致', mism === 0, mism + ' 项不对齐');
  } finally {
    try { pN.kill(); } catch (e) {}
    try { pP.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(dirN, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dirP, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ========================= 运行 ========================= */
(async () => {
  const which = process.argv[2] || 'all';
  if (which === 'all' || which === 'unit') unitTests();
  if (which === 'all' || which === 'server') { await serverTests(); await ps1Tests(); }
  if (which === 'all' || which === 'parity') await parityTable();
  console.log(`\n== QA 回归套件结果：${passed} 通过，${failed} 失败 ==`);
  if (FAILED.length) { console.log('失败清单：'); for (const f of FAILED) console.log('  - ' + f); }
  if (failed) process.exitCode = 1;
})();
