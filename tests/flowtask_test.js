/*
 * FlowTask 测试套件（Node 直跑，零依赖）
 * ------------------------------------------------
 * 用法：
 *   node tests/flowtask_test.js          → 单元测试 + Node 服务端集成测试
 *   node tests/flowtask_test.js ps1      → 仅 PowerShell 服务端冒烟测试
 *
 * 覆盖：
 *  - 单元测试：本地日期函数（时区修复）、重复任务推期、esc 转义、
 *    导入校验、旧通知 HTML 净化
 *  - 集成测试（独立端口 5199 + 独立数据目录）：令牌鉴权、来源门控、
 *    版本冲突 409、备份轮转、冲突副本、损坏文件隔离、页面令牌注入、
 *    nosniff 响应头
 *  - PS1 冒烟（端口 5299）：令牌、写入鉴权、版本冲突、损坏隔离
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'FlowTask_本地项目管理平台.html');
const NODE_EXE = process.execPath;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, extra){
  if(cond){ passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function req(base, method, p, { body, headers, origin } = {}){
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    if(origin !== undefined) h['Origin'] = origin;
    if(body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request(base + p, { method, headers: h }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }));
    });
    r.on('error', reject);
    if(body) r.write(body);
    r.end();
  });
}
/* 端口占用检测与清理：Windows 下只 kill 子进程偶尔留活口，会让下一轮偶发失败 */
function portListening(port){
  return new Promise(resolve => {
    const so = require('net').connect(port, '127.0.0.1');
    so.on('connect', () => { so.destroy(); resolve(true); });
    so.on('error', () => resolve(false));
    setTimeout(() => { so.destroy(); resolve(false); }, 400);
  });
}
function pidsOnPort(port){
  const r = require('child_process').spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  const out = String((r && r.stdout) || '');
  const pids = new Set();
  for(const line of out.split(/\r?\n/)){
    if(line.indexOf(':' + port) === -1 || line.indexOf('LISTENING') === -1) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if(m && Number(m[1]) > 0) pids.add(m[1]);
  }
  return [...pids];
}
async function freePort(port, tries = 40){
  for(const pid of pidsOnPort(port)){
    require('child_process').spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
  }
  for(let i = 0; i < tries && await portListening(port); i++) await sleep(250);
  return !(await portListening(port));
}
async function waitUp(base, tries = 60, gap = 500){
  for(let i = 0; i < tries; i++){
    try{ await req(base, 'GET', '/api/version'); return true; }catch(e){ await sleep(gap); }
  }
  return false;
}
const sample = (rev, extra) => JSON.stringify(Object.assign({
  users: [{ id: 'u1', username: 't', name: 'T', role: 'admin', salt: 's', passHash: 'p1$x', color: '#000', active: true }],
  projects: [], tasks: [], notifications: [], meta: { rev }
}, extra || {}));

/* ================= 单元测试 ================= */
function unitTests(){
  console.log('\n== 单元测试（从 HTML 提取标记区求值） ==');
  const html = fs.readFileSync(HTML, 'utf8');
  const regions = [...html.matchAll(/\/\*==TEST-BEGIN==\*\/([\s\S]*?)\/\*==TEST-END==\*\//g)].map(m => m[1]);
  ok('找到测试标记区 >= 5 处', regions.length >= 5, '实际 ' + regions.length);
  const sandbox = { Date, Math, String, Number, Object, Array, JSON, RegExp, isNaN, console, Map, Set, Error };
  vm.createContext(sandbox);
  vm.runInContext(regions.join('\n'), sandbox);
  const S = sandbox;
  const pad = n => String(n).padStart(2, '0');
  S.ME = { id: 'me1', name: '测试员' };
  S.notify = function(){};

  // 时区修复核心：所有日期必须为本地日期串
  ok('localDateStr 补零且取本地日期', S.localDateStr(new Date(2026, 0, 5)) === '2026-01-05');
  const now = new Date();
  ok('todayStr = 本地今天', S.todayStr() === `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`);
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
  ok('dateOffset(+1) = 本地明天', S.dateOffset(1) === S.localDateStr(tmr));
  ok('dateAddStr 跨月', S.dateAddStr('2026-08-31', 1) === '2026-09-01');

  // 重复任务推期
  ok('nextDueDate daily', S.nextDueDate('2026-08-31', 'daily') === '2026-09-01');
  ok('nextDueDate weekly', S.nextDueDate('2026-08-31', 'weekly') === '2026-09-07');
  ok('nextDueDate monthly 结果合法', /^\d{4}-\d{2}-\d{2}$/.test(S.nextDueDate('2026-01-31', 'monthly')));
  ok('nextDueDate 空值安全', S.nextDueDate(null, 'daily') === null);

  // 转义
  ok('esc 转义 HTML 注入', S.esc('<img src=x onerror=alert(1)>').indexOf('<img') === -1);
  ok('esc 转义引号', S.esc('"\'&').includes('&quot;') && S.esc('"\'&').includes('&amp;'));

  /* ---- v1.7.3 时间显示：超过一天必须落到日期（评论/动态按日期追溯） ---- */
  const MIN = 60000, HR = 3600000, DAY = 86400000;
  ok('时间：<1 分钟 = 刚刚', S.fmtTime(Date.now() - 30000) === '刚刚');
  ok('时间：<1 小时 = 分钟前', /分钟前/.test(S.fmtTime(Date.now() - 10*MIN)));
  ok('时间：<24 小时 = 小时前', /小时前/.test(S.fmtTime(Date.now() - 3*HR)));
  ok('时间：2 天前显示日期而非「几天前」', /^\d+月\d+日 \d{2}:\d{2}$/.test(S.fmtTime(Date.now() - 2*DAY)));
  ok('时间：三周前不再输出「N天前」', !/\d+天前/.test(S.fmtTime(Date.now() - 21*DAY)));
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  ok('时间：昨天显示「昨天 HH:MM」', /^昨天 \d{2}:\d{2}$/.test(S.fmtDateShort(yest.getTime())));
  const ly = new Date(new Date().getFullYear() - 1, 5, 15, 9, 5);
  ok('时间：跨年显示完整年月日', S.fmtDateShort(ly.getTime()) === (ly.getFullYear() + '年6月15日'));
  ok('时间：timeTitle 输出完整时间戳', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(S.timeTitle(Date.now())));
  ok('时间：非法输入安全返回', S.fmtDateShort('abc') === '—' && S.timeTitle('abc') === '');

  /* ---- v1.7.5：活动记录折叠（只看创建 + 最近 3 条）与快速添加默认项目 ---- */
  const acts = n => Array.from({length:n}, (_,i)=>({ id:'a'+i, text:'动态'+i, ts: (i+1)*1000 }));
  {
    const f1 = S.foldActivity(acts(4), false);
    ok('折叠：4 条时不折叠（未超过 创建+3）', f1.foldable === false && f1.rows.length === 4);
    const f2 = S.foldActivity(acts(9), false);
    ok('折叠：9 条只显示 4 条（创建 + 最近 3）', f2.foldable === true && f2.rows.length === 4 && f2.hidden === 5);
    ok('折叠：最早一条被保留', f2.rows.some(a=>a.id==='a0') === true);
    ok('折叠：渲染顺序为新→旧、创建记录在最末',
      f2.rows[0].id === 'a8' && f2.rows[f2.rows.length-1].id === 'a0');
    const f3 = S.foldActivity(acts(9), true);
    ok('展开后显示全部（仍受 30 条上限约束）', f3.rows.length === 9 && f3.hidden === 0);
    ok('折叠：空活动安全', S.foldActivity(undefined, false).rows.length === 0 && S.foldActivity(null, true).total === 0);
    const f4 = S.foldActivity(acts(45), true);
    ok('折叠：超长活动只渲染最近 30 条', f4.rows.length === 30 && f4.rows[0].id === 'a44');
  }
  {
    const ps = [{ id:'p1' }, { id:'p2' }, { id:'p3' }];
    ok('默认项目：显式传入优先', S.quickAddDefaultProject('p2', ps, { page:'project', pid:'p3' }, 'p1') === 'p2');
    ok('默认项目：在项目里时用当前项目', S.quickAddDefaultProject(null, ps, { page:'project', pid:'p3' }, 'p1') === 'p3');
    ok('默认项目：不在项目里时用上次创建的', S.quickAddDefaultProject(null, ps, { page:'home' }, 'p2') === 'p2');
    ok('默认项目：都没有时退回第一个', S.quickAddDefaultProject(null, ps, { page:'home' }, '') === 'p1');
    ok('默认项目：失效的 pid（项目被删）会被忽略',
      S.quickAddDefaultProject(null, ps, { page:'project', pid:'gone' }, 'gone') === 'p1');
  }
  /* v1.9 顶栏同步指示：没配共享盘时这个按钮根本不该出现（默认模式界面零变化） */
  {
    ok('同步指示：未配置共享盘 → 不显示', S.syncStatusView(null) === null && S.syncStatusView({ enabled:false }) === null);
    ok('同步指示：服务端不支持同步 → 不显示', S.syncStatusView({ enabled:undefined }) === null);
    const okView = S.syncStatusView({ enabled:true, reachable:true, pending:0, lastSyncAt:0 });
    ok('同步指示：正常时是绿色「已同步」', !!okView && okView.cls === 'ok' && okView.txt.indexOf('已同步') >= 0,
      okView ? okView.txt + '/' + okView.cls : 'null');
    const pend = S.syncStatusView({ enabled:true, reachable:true, pending:2 });
    ok('同步指示：有排队时显示待同步项数', !!pend && pend.cls === 'saving' && pend.txt.indexOf('2') >= 0,
      pend ? pend.txt + '/' + pend.cls : 'null');
    const down = S.syncStatusView({ enabled:true, reachable:false, lastError:'flowtask_shared.json share-read:ECONNRESET' });
    ok('同步指示：共享盘断开时转红并说明本机仍安全', !!down && down.cls === 'err'
      && down.txt.indexOf('断开') >= 0 && down.tip.indexOf('本机数据仍在正常保存') >= 0,
      down ? down.txt + '/' + down.cls : 'null');
    ok('同步指示：断开提示里带上最近一次错误原因', !!down && down.tip.indexOf('ECONNRESET') >= 0);
    ok('同步指示：断线不会被误读成「已同步」',
      S.syncStatusView({ enabled:true, reachable:false }).txt !== okView.txt);
    /* 「配置本身有问题」与「共享盘临时掉线」必须分开说：前者重连不会好，得让人去改配置 */
    const cfg = S.syncStatusView({ enabled:true, reachable:false, blockReason:'目录不存在或共享盘不可达（ENOENT）' });
    ok('同步指示：路径打不开时文案区别于临时断开', !!cfg && cfg.txt === '共享盘打不开',
      cfg ? cfg.txt : 'null');
    ok('同步指示：配置问题要给出下一步（检查路径与权限、改完重启）',
      !!cfg && /资源管理器/.test(cfg.tip) && /写入权限/.test(cfg.tip) && /重启服务/.test(cfg.tip));
    ok('同步指示：配置问题同样不许显示成「已同步」', !!cfg && cfg.cls === 'err');
    const recovered = S.syncStatusView({ enabled:true, reachable:true, pending:0, blockReason:'' });
    ok('同步指示：原因清空后回到正常绿色态', !!recovered && recovered.cls === 'ok');
    /* 「同步中」的过渡态：服务端自动推送，但 PowerShell 版不回报排队数，
       只靠 info.pending 会让用户最多 30 秒看不到反应，误以为必须手点 */
    const awaitView = S.syncStatusView({ enabled:true, reachable:true, pending:0 }, true);
    ok('同步指示：本机刚保存过应显示同步中（即使服务端没回报排队数）',
      !!awaitView && awaitView.cls === 'saving' && /同步中/.test(awaitView.txt), JSON.stringify(awaitView));
    ok('同步指示：过渡态文案要说明不用点', !!awaitView && /不用点/.test(awaitView.tip), awaitView && awaitView.tip);
    ok('同步指示：awaiting=false 时同样的服务端状态显示为已同步',
      S.syncStatusView({ enabled:true, reachable:true, pending:0 }, false).cls === 'ok');
    ok('同步指示：配置问题优先于过渡态（打不开时不该显示同步中）',
      S.syncStatusView({ enabled:true, reachable:false, blockReason:'路径不存在' }, true).cls === 'err');
  }

  /* v1.9 数据导出：Excel 兼容性与注入防护都是真实会踩的坑，逐条钉住 */
  {
    ok('导出：CSV 必须以 UTF-8 BOM 开头（否则 Excel 打开中文乱码）',
      S.rowsToCSV(['任务'], [['降本']]).charCodeAt(0) === 0xFEFF,
      '实际首字符码 ' + S.rowsToCSV(['任务'], [['降本']]).charCodeAt(0));
    ok('导出：行尾用 CRLF', /\r\n$/.test(S.rowsToCSV(['a'], [['1']])));
    ok('导出：表头与每行都加引号并逗号分隔',
      S.rowsToCSV(['任务', '备注'], [['写"引号"', '有,逗号']]) === '﻿"任务","备注"\r\n"写""引号""","有,逗号"\r\n',
      JSON.stringify(S.rowsToCSV(['任务', '备注'], [['写"引号"', '有,逗号']])));

    /* 公式注入：标题/描述是同事可写的自由文本，以 = + - @ 开头会被 Excel 当公式执行 */
    for(const bad of ['=1+1', '+AA', '-2+3', '@SUM(A1)', '\t=cmd']){
      ok(`导出：危险单元格「${bad.slice(0,6)}」被加前导单引号`, S.csvCell(bad).indexOf("'" + bad) === 1, S.csvCell(bad));
    }
    ok('导出：纯数字不受保护（评论数 5 不该变成文本）', S.csvCell(5) === '"5"' && S.csvCell(0) === '"0"');
    ok('导出：单元格内换行统一成 LF 且被引号包住', S.csvCell('a\r\nb').indexOf('\n') > 0 && S.csvCell('a\r\nb').startsWith('"'));
    ok('导出：null/undefined 都是空串而不是字面量', S.csvCell(null) === '""' && S.csvCell(undefined) === '""');

    /* 描述其实是纯 textarea 存的纯文本，剥标签属防御（导入/历史数据可能带 HTML）：
       块级边界各算一次换行，连续换行最多留一个空行 */
    ok('导出：富文本描述抽成纯文本', S.plainText('<p>供应商<b>回签</b>延迟</p><br>需电话跟进') === '供应商回签延迟\n\n需电话跟进',
      JSON.stringify(S.plainText('<p>供应商<b>回签</b>延迟</p><br>需电话跟进')));
    ok('导出：HTML 实体要还原', S.plainText('A &amp; B &quot;C&quot; &lt;D&gt;') === 'A & B "C" <D>',
      JSON.stringify(S.plainText('A &amp; B &quot;C&quot; &lt;D&gt;')));
    ok('导出：双重编码不被二次解码（&amp;lt; 保持可见的 &lt;）', S.plainText('&amp;lt;x&amp;gt;') === '&lt;x&gt;',
      JSON.stringify(S.plainText('&amp;lt;x&amp;gt;')));
    ok('导出：连续空行折叠', S.plainText('a\n\n\n\n\nb') === 'a\n\nb');
    ok('导出：空描述给空串', S.plainText('') === '' && S.plainText(null) === '');
    ok('导出：时间戳格式化', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(S.fmtStamp(1700000000000)), S.fmtStamp(1700000000000));
    ok('导出：没有时间戳不给 1970', S.fmtStamp(null) === '' && S.fmtStamp(0) === '');

    /* 逾期口径：已完成的任务不算逾期（界面上多处内联判断，导出口径必须明确） */
    ok('导出：过期未完成算逾期', S.isTaskOverdue({ dueDate:'2026-01-01', completed:false }, '2026-09-22') === true);
    ok('导出：已完成不算逾期', S.isTaskOverdue({ dueDate:'2026-01-01', completed:true }, '2026-09-22') === false);
    ok('导出：无截止日期不算逾期', S.isTaskOverdue({ dueDate:null, completed:false }, '2026-09-22') === false);
    ok('导出：子任务进度形如 1/3', S.subProgress({ subtasks:[{done:true},{done:false},{done:false}] }) === '1/3');
    ok('导出：没有子任务时进度留空', S.subProgress({ subtasks:[] }) === '');
    ok('导出：已完成任务的列显示「已完成」而非「待办」',
      S.statusOf({ completed:true, status:'doing' }) === '已完成' && S.statusOf({ completed:false, status:'doing' }) === '进行中');

    const keys = S.exportColumnDefs().map(c => c.key);
    ok('导出：列 key 不重复', new Set(keys).size === keys.length);
    ok('导出：列标签不重复（界面按标签勾选，重名会误伤）',
      new Set(S.exportColumnDefs().map(c => c.label)).size === S.exportColumnDefs().length);
    ok('导出：默认勾选的列是常用列', JSON.stringify(S.exportColumnDefs().filter(c => c.on).map(c => c.key))
      === JSON.stringify(['title','project','status','priority','assignee','startDate','dueDate','overdue','subtasks','tags']),
      JSON.stringify(S.exportColumnDefs().filter(c => c.on).map(c => c.key)));
    ok('导出：按 key 取列保持顺序',
      S.exportColumnsOf(['dueDate','title']).map(c => c.key).join(',') === 'title,dueDate');
    ok('导出：未知 key 被忽略而不是报错', S.exportColumnsOf(['title','nope']).length === 1);
  }
  {
    const ctx = { today:'2026-09-22', projName:id => id === 'p1' ? 'G1降本10%' : '其他', userName:id => id === 'u1' ? '沈' : '' };
    const tasks = [{ id:'t1', projectId:'p1', title:'锁定供应商', assigneeId:'u1', dueDate:'2026-09-20',
      priority:'high', status:'doing', completed:false, startDate:'2026-09-01', tags:['采购','风险'],
      subtasks:[{ id:'s1', title:'比价', done:true }, { id:'s2', title:'回签', done:false, dueDate:'2026-09-19', assigneeId:'u1' }],
      comments:[{},{},{}] }];
    const cols = S.exportColumnsOf(['parent','assignee','dueDate','kind','title','comments','project','status','overdue','subtasks']);
    const only = S.buildExportRows(cols, S.flattenWithSubtasks([]), ctx);
    ok('导出：空列表只剩表头', only.rows.length === 0 && only.head.length === 10);
    const flat = S.flattenWithSubtasks(tasks);
    ok('导出：勾选含子任务时 1 主任务 + 2 子任务 = 3 行', flat.length === 3);
    const built = S.buildExportRows(cols, flat, ctx);
    /* 列顺序由列定义决定（与勾选先后无关），所以按表头名取值，别写死下标 */
    const at = (row, label) => row[built.head.indexOf(label)];
    ok('导出：列顺序跟随列定义而非勾选顺序（勾选顺序我故意打乱了）',
      built.head.join(',') === '任务,所属项目,状态,负责人,截止日期,是否逾期,子任务进度,类型,父任务,评论数',
      built.head.join(','));
    ok('导出：第一行是任务本体，类型为「任务」', at(built.rows[0], '类型') === '任务', JSON.stringify(built.rows[0]));
    /* 行号靠猜容易反（展开顺序 = 子任务数组顺序），一律按任务标题定位 */
    const rowOf = title => built.rows.find(r => at(r, '任务') === title);
    ok('导出：子任务行带父任务标题与「子任务」类型',
      at(rowOf('比价'), '父任务') === '锁定供应商' && at(rowOf('比价'), '类型') === '子任务');
    ok('导出：子任务继承项目名', at(rowOf('比价'), '所属项目') === 'G1降本10%');
    ok('导出：逾期未完成的子任务标逾期', at(rowOf('回签'), '是否逾期') === '是', JSON.stringify(rowOf('回签')));
    ok('导出：已完成的子任务不算逾期', at(rowOf('比价'), '是否逾期') === '');
    ok('导出：子任务状态只看自身 done，不继承父任务状态',
      at(rowOf('回签'), '状态') === '待办' && at(rowOf('比价'), '状态') === '已完成',
      at(rowOf('回签'), '状态') + ' / ' + at(rowOf('比价'), '状态'));
    ok('导出：未单独指派的子任务沿用父任务负责人', at(rowOf('比价'), '负责人') === '沈',
      JSON.stringify(rowOf('比价')));
    ok('导出：主任务评论数带出来', at(built.rows[0], '评论数') === 3);
    ok('导出：主任务自身逾期也标注', at(built.rows[0], '是否逾期') === '是');   // t1 截止 09-20 < 今天
    ok('导出：未超量时不截断', built.truncated === false);
    const md = S.buildExportMarkdown([{ name:'G1降本10%', count:1, overdue:1,
      rows:[S.mdTaskLine(tasks[0], ctx)] }], { title:'任务清单', scopeLabel:'全部可见项目', by:'沈', at:'2026-09-22 15:00', total:1 });
    ok('导出：Markdown 含项目名与逾期数', md.includes('G1降本10%') && md.includes('逾期 1 项'), md.slice(0, 160));
    ok('导出：Markdown 任务行含负责人、优先级与逾期标记',
      md.includes('沈') && md.includes('高') && md.includes('已逾期') && md.includes('子任务 1/2'), md);
    ok('导出：Markdown 未完成任务用 [ ]', md.includes('- [ ] 锁定供应商'));
    ok('导出：Markdown 完成任务用 [x]',
      S.mdTaskLine({ completed:true, title:'已办', priority:'low' }, ctx).includes('[x]'));
  }

  /* v1.9 共享盘设置面板的取态文案 + 管理员初始口令 */
  {
    ok('同步设置：没配置就是「未启用」，不吓人', S.shareConfigView({ syncEnabled:false }, {}).txt === '未启用');
    ok('同步设置：未启用时提示怎么开始', /共享目录|有权/.test(S.shareConfigView({ syncEnabled:false }, {}).tip));
    const blocked = S.shareConfigView({ syncEnabled:true }, { blockReason:'目录不存在或共享盘不可达（ENOENT）' });
    ok('同步设置：配置有问题要报「打不开」并附原因', blocked.txt === '打不开' && /ENOENT/.test(blocked.tip), blocked.txt);
    ok('同步设置：「未启用」与「打不开」不能混为一谈', blocked.txt !== S.shareConfigView({ syncEnabled:false }, {}).txt);
    const down = S.shareConfigView({ syncEnabled:true }, { reachable:false });
    ok('同步设置：临时掉线说「暂时连不上」而不是配置错误', /暂时连不上/.test(down.txt) && down.txt !== blocked.txt);
    const env = S.shareConfigView({ syncEnabled:true, envOverride:true }, { reachable:true });
    ok('同步设置：环境变量覆盖时必须提醒重启会被顶回', /环境变量/.test(env.txt) && /重启/.test(env.tip), env.txt + ' | ' + env.tip);
    const good = S.shareConfigView({ syncEnabled:true }, { reachable:true, lastSyncAt: Date.now() });
    ok('同步设置：正常态为已连通绿色', good.cls === 'ok' && /已连通/.test(good.txt), good.txt);
    ok('同步设置：三种异常态都不显示成已连通',
      blocked.cls !== 'ok' && down.cls !== 'ok' && S.shareConfigView(null, {}).cls === '');

    const p1 = S.genInitialPassword(), p2 = S.genInitialPassword();
    ok('初始口令：长度足够且不共用默认弱口令', p1.length >= 10 && p1 !== '123456', p1);
    ok('初始口令：四类字符齐备（大写/小写/数字/符号）',
      /[A-Z]/.test(p1) && /[a-z]/.test(p1) && /[0-9]/.test(p1) && /[!@#$%\-_=+]/.test(p1), p1);
    ok('初始口令：排除易混字符 0O1lI', !/[0O1lI]/.test(p1), p1);
    ok('初始口令：两次生成不同（不再全组同一个）', p1 !== p2, p1 + ' / ' + p2);
    const pool = new Set(); for(let i=0;i<60;i++) pool.add(S.genInitialPassword());
    ok('初始口令：60 次生成至少 55 种，随机性够用', pool.size >= 55, '实际 ' + pool.size + ' 种');
    ok('初始口令：通过账户表的哈希格式（可被 PBKDF2 处理）', typeof p1 === 'string' && p1.length >= 6);
  }
  /* v1.9 新建任务的落位：order 撞值会让键盘排序看起来完全没反应 */
  {
    const T = [{ projectId:'p1', status:'todo', order:100 }, { projectId:'p1', status:'todo', order:100 }];
    ok('落位：同组已有任务时排在末尾且不与既有值相同',
      S.nextTaskOrder(T, 'p1', 'todo', 7) === 101, String(S.nextTaskOrder(T, 'p1', 'todo', 7)));
    ok('落位：同项目不同状态互不影响', S.nextTaskOrder(T, 'p1', 'doing', 7) === 7);
    ok('落位：新项目用 fallback（不打乱既有时间序）', S.nextTaskOrder(T, 'p2', 'todo', 555) === 555);
    ok('落位：空任务表不报错', S.nextTaskOrder([], 'p1', 'todo', 9) === 9 && S.nextTaskOrder(undefined, 'p1', 'todo', 9) === 9);
    ok('落位：坏 order 值当 0 处理而不是 NaN',
      S.nextTaskOrder([{ projectId:'p1', status:'todo', order:'abc' }], 'p1', 'todo', 5) === 6);
    const twice = [];
    let o = 1000;
    for(let i = 0; i < 5; i++){ o = S.nextTaskOrder(twice, 'p1', 'todo', o); twice.push({ projectId:'p1', status:'todo', order:o }); }
    ok('落位：连续建 5 条得到 5 个互不相同的 order', new Set(twice.map(t=>t.order)).size === 5,
      JSON.stringify(twice.map(t=>t.order)));
  }

  /* 守卫：$() 返回单个元素、$() 才返回列表 —— 源码里出现 `$(...).forEach(` 必然是 bug，
     且它在 render 链里抛错会让整页兜底成空白，肉眼只看到「页面打不开」。 */
  {
    const src = fs.readFileSync(HTML, 'utf8');
    const bad = [];
    src.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/(^|[^$])\$\(('[^']*'|"[^"]*")(\s*,\s*[^)]+)?\)\.forEach/);
      if (m) bad.push((i + 1) + ': ' + line.trim().slice(0, 80));
    });
    ok('守卫：不存在 $(...).forEach（应为 $(...)）', bad.length === 0, bad.slice(0, 3).join(' ; '));
  }

  // 导入校验
  ok('导入校验：缺数组拒绝', typeof S.validateImportData({ users: [] }) === 'string');
  ok('导入校验：非对象拒绝', typeof S.validateImportData([1, 2]) === 'string');
  ok('导入校验：重复 id 拒绝', typeof S.validateImportData({ users: [{ id: 'a' }, { id: 'a' }], projects: [], tasks: [] }) === 'string');
  ok('导入校验：缺 id 拒绝', typeof S.validateImportData({ users: [{ name: 'x' }], projects: [], tasks: [] }) === 'string');
  ok('导入校验：合法数据通过', S.validateImportData({ users: [{ id: 'a' }], projects: [{ id: 'p', memberIds: [] }], tasks: [{ id: 't' }] }) === null);
  /* v1.6 深校验：结构不完整的备份必须在导入前拦下（曾把渲染链搞白屏且先落了盘） */
  ok('导入校验：项目缺成员列表拒绝', typeof S.validateImportData({ users: [{ id: 'a' }], projects: [{ id: 'p' }], tasks: [] }) === 'string');
  ok('导入校验：任务评论不是列表拒绝', typeof S.validateImportData({ users: [{ id: 'a' }], projects: [{ id: 'p', memberIds: [] }], tasks: [{ id: 't', comments: 'x' }] }) === 'string');

  /* v1.6 拆库归属：回收站里的共享项目，其任务仍归共享库（曾整批搬进删除者个人库并从共享库消失） */
  {
    const savedDB = S.DB, savedScope = S.SCOPE_SHARED, savedRevs = S._revs;
    S.DB = {
      meta:{}, tags:[], savedFilters:[],
      projects:[], notifications:[],
      tasks:[{ id:'t1', projectId:'p_gone', title:'x' }, { id:'t2', projectId:'p_live', title:'y' }],
      trash:{ tasks:[], projects:[{ id:'p_gone', scope:'shared', ownerId:'me1' }] },
    };
    S.SCOPE_SHARED = 'shared';
    S._revs = { personal:0, shared:0 };
    try{
      const parts = S.splitStores();
      ok('拆库：回收站里的共享项目任务仍归共享库', parts.shared.tasks.some(t=>t.id==='t1') && !parts.personal.tasks.some(t=>t.id==='t1'));
      ok('拆库：正常个人任务仍归个人库', parts.personal.tasks.some(t=>t.id==='t2'));
    } finally { S.DB = savedDB; S.SCOPE_SHARED = savedScope; S._revs = savedRevs; }
  }

  // 旧通知净化（存储型 XSS 防线）
  ok('净化保留 <b>', S.sanitizeLegacyHTML('<b>张三</b> 指派给你').includes('<b>'));
  ok('净化剥除 <script>', S.sanitizeLegacyHTML('<script>alert(1)</scr' + 'ipt><b>x</b>').indexOf('<script') === -1);
  ok('净化剥除 <img onerror>', S.sanitizeLegacyHTML('<img src=x onerror=alert(1)>').indexOf('<img') === -1);
  ok('净化剥除带属性的 <b>', S.sanitizeLegacyHTML('<b onclick=alert(1)>x</b>').indexOf('<b ') === -1);
  ok('净化保留 <br>', S.sanitizeLegacyHTML('a<br/>b').includes('<br/>'));

  // 子任务状态同步（done 与 status 单一真相源）
  const mkT = (sub) => ({ subtasks: [sub] });
  let s1 = { id: 'st1', title: 'A', done: false, status: 'todo', comments: [], recurring: null };
  S.setSubStatus(mkT(s1), s1, 'doing');
  ok('setSubStatus 同步 done=false', s1.status === 'doing' && s1.done === false);
  S.setSubStatus(mkT(s1), s1, 'done');
  ok('setSubStatus 同步 done=true', s1.status === 'done' && s1.done === true);
  S.toggleSubDone(mkT(s1), s1);
  ok('取消完成恢复原状态', s1.status === 'doing' && s1.done === false);
  // 重复子任务：完成时自动在下一位生成新一期
  const s2 = { id: 'st2', title: '周报', done: false, status: 'todo', comments: [{ x: 1 }], recurring: 'weekly', dueDate: '2026-08-31', assigneeId: null, tags: [], followers: [] };
  const t2 = mkT(s2);
  S.setSubStatus(t2, s2, 'done');
  ok('重复子任务生成下一期', t2.subtasks.length === 2);
  const next = t2.subtasks[1];
  ok('下一期日期正确推 7 天', next.dueDate === '2026-09-07', '实际 ' + next.dueDate);
  ok('下一期评论清空且未完成', next.done === false && next.status === 'todo' && next.comments.length === 0);
}

/* ================= UX 阶段新增纯函数 + 防回退守卫 ================= */
function uxTests(){
  console.log('\n== UX 优化回归（阶段 A-G 纯函数与守卫） ==');
  const html = fs.readFileSync(HTML, 'utf8');
  const regions = [...html.matchAll(/\/\*==TEST-BEGIN==\*\/([\s\S]*?)\/\*==TEST-END==\*\//g)].map(m => m[1]);
  const sandbox = { Date, Math, String, Number, Object, Array, JSON, RegExp, isNaN, console, Map, Set, Error };
  vm.createContext(sandbox);
  vm.runInContext(regions.join('\n'), sandbox);
  const S = sandbox;

  /* ---- 时钟格式化 ---- */
  ok('fmtClock 空值返回空串', S.fmtClock(0) === '');
  ok('fmtClock 补零到 HH:MM:SS', S.fmtClock(new Date(2026, 8, 3, 9, 5, 7).getTime()) === '09:05:07');

  /* ---- 冲突差异摘要 ---- */
  const mk = (over) => Object.assign({ id:'t1', title:'写周报', status:'todo', assigneeId:null,
    dueDate:null, startDate:null, priority:'low', desc:'' }, over||{});
  ok('冲突摘要：完全一致时 0 处差异',
    S.summarizeDBDiff({ tasks:[mk()], projects:[] }, { tasks:[mk()], projects:[] }).changed === 0);
  const d1 = S.summarizeDBDiff({ tasks:[mk({ status:'doing' })], projects:[] }, { tasks:[mk()], projects:[] });
  ok('冲突摘要：状态不同算 1 处', d1.changed === 1 && d1.lines.join('').includes('status'), JSON.stringify(d1));
  const d2 = S.summarizeDBDiff({ tasks:[], projects:[{ id:'p1', name:'新项目' }] }, { tasks:[], projects:[] });
  ok('冲突摘要：本地新建项目算差异', d2.changed === 1 && d2.lines.join('').includes('新项目'));
  const d3 = S.summarizeDBDiff({ tasks:[], projects:[] }, { tasks:[mk({ id:'t9' })], projects:[] });
  ok('冲突摘要：对方新增任务只提示不计入我的改动', d3.changed === 0 && d3.lines.join('').includes('对方新增'));
  ok('冲突摘要：null 与空串视为相同',
    S.summarizeDBDiff({ tasks:[mk({ dueDate:null })], projects:[] }, { tasks:[mk({ dueDate:'' })], projects:[] }).changed === 0);

  /* ---- 起止日期配对 ---- */
  ok('日期配对：开始晚于截止 → 截止顺延',
    JSON.stringify(S.applyDatePair({ startDate:null, dueDate:'2026-09-01' }, 'start', '2026-09-05'))
    === JSON.stringify({ startDate:'2026-09-05', dueDate:'2026-09-05', moved:'dueDate' }));
  ok('日期配对：截止早于开始 → 开始回退',
    S.applyDatePair({ startDate:'2026-09-08', dueDate:'2026-09-02' }, 'due', '2026-09-02').moved === 'startDate');
  ok('日期配对：正常区间不动',
    S.applyDatePair({ startDate:'2026-09-01', dueDate:'2026-09-09' }, 'due', '2026-09-05').moved === null);
  ok('日期配对：清空一端不误报',
    S.applyDatePair({ startDate:'2026-09-01', dueDate:'2026-09-09' }, 'due', '').dueDate === null);

  /* ---- 重名检测 ---- */
  ok('重名检测：忽略首尾空格', !!S.findDupName([{ id:'a', name:'紧急' }], '  紧急 '));
  ok('重名检测：排除自身 id', !S.findDupName([{ id:'a', name:'紧急' }], '紧急', 'name', 'a'));
  ok('重名检测：空名不判重', S.findDupName([{ id:'a', name:'' }], '  ') === null);

  /* ---- 中文日期词 ---- */
  const T = '2026-09-03';   // 周四
  ok('日期词：今天/明天/后天/大后天',
    S.resolveDateToken('今天', T) === '2026-09-03' && S.resolveDateToken('明天', T) === '2026-09-04'
    && S.resolveDateToken('后天', T) === '2026-09-05' && S.resolveDateToken('大后天', T) === '2026-09-06');
  ok('日期词：N 天后', S.resolveDateToken('10天后', T) === '2026-09-13');
  ok('日期词：周五取本周剩余的周五', S.resolveDateToken('周五', T) === '2026-09-04');
  ok('日期词：今天已是周五则取下个周五', S.resolveDateToken('周一', '2026-09-07') === '2026-09-14');
  ok('日期词：下周二', S.resolveDateToken('下周二', T) === '2026-09-08');
  ok('日期词：ISO 原样通过', S.resolveDateToken('2026-12-31', T) === '2026-12-31');
  ok('日期词：9月5日落在今年', S.resolveDateToken('9月5日', T) === '2026-09-05');
  ok('日期词：已过日期滚到明年', S.resolveDateToken('1月2日', T) === '2027-01-02');
  ok('日期词：无法识别返回 null', S.resolveDateToken('彩虹', T) === null);

  /* ---- 快速添加一句话解析 ---- */
  const ctx = { users:[{ id:'u1', name:'王小米', username:'wang' }, { id:'u2', name:'李四', username:'lisi' }],
    tags:[{ id:'g1', name:'文档' }, { id:'g2', name:'设计' }], today:T };
  const p1 = S.parseQuickText('整理报价单 @王小米 明天 !高 #文档', ctx);
  ok('解析：标题剥离 token', p1.title === '整理报价单', p1.title);
  ok('解析：@负责人', p1.assigneeId === 'u1' && p1.matched.assignee === '王小米');
  ok('解析：日期词', p1.dueDate === '2026-09-04');
  ok('解析：!优先级映射数据值', p1.priority === 'high');
  ok('解析：#标签命中已有标签', p1.tagIds.length === 1 && p1.tagIds[0] === 'g1');
  const p2 = S.parseQuickText('查一下 @不存在的人 下周周二', ctx);
  ok('解析：未知 @ 保留在标题里', p2.title.includes('@不存在的人') && p2.assigneeId === null);
  const p3 = S.parseQuickText('做两件事 #文档 #设计 周五', ctx);
  ok('解析：多标签 + 周词', p3.tagIds.length === 2 && p3.dueDate === '2026-09-04' && p3.title === '做两件事');
  ok('解析：纯 token 输入标题为空（由调用方兜底原文）', S.parseQuickText('明天', ctx).title === '');
  ok('解析：空输入不抛错', S.parseQuickText('', ctx).title === '' && S.parseQuickText(null, ctx).title === '');

  /* ---- 渲染索引 ---- */
  S.DB = { meta:{ rev:7 },
    projects:[{ id:'p1', name:'A', memberIds:['me'] }, { id:'p2', name:'B', memberIds:['me'] }],
    tasks:[
      { id:'t1', projectId:'p1', status:'todo', title:'一', assigneeId:'me', completed:false },
      { id:'t2', projectId:'p1', status:'done', title:'二', assigneeId:'u1', completed:true },
      { id:'t3', projectId:'p2', status:'doing', title:'三', assigneeId:'me', completed:false },
      { id:'t4', projectId:'ghost', status:'todo', title:'孤儿', assigneeId:null, completed:false },
    ] };
  ok('索引：按项目分组正确', S.tasksOfProject('p1').length === 2 && S.tasksOfProject('p2').length === 1);
  ok('索引：未知项目返回空数组', Array.isArray(S.tasksOfProject('nope')) && S.tasksOfProject('nope').length === 0);
  ok('索引：projectOf 命中', S.projectOf({ projectId:'p2' }).name === 'B');
  ok('索引：孤儿任务的 projectOf 返回 null', S.projectOf({ projectId:'ghost' }) === null);
  const refA = S.tasksOfProject('p1'); refA.length = 0;
  ok('索引：返回副本，调用方 sort/修改不污染索引', S.tasksOfProject('p1').length === 2);
  S.DB.tasks.push({ id:'t5', projectId:'p2', status:'todo', title:'四', assigneeId:null, completed:false });
  S.bumpDataEpoch();      // v1.5：索引失效信号是数据纪元，不再是 meta.rev
  ok('索引：数据纪元变化后自动重建', S.tasksOfProject('p2').length === 2);

  /* ---- 状态唯一真相源 ---- */
  // 注意：脚本内的顶层 const 不挂到沙箱对象上，需用表达式在上下文里求值
  const ev = expr => vm.runInContext(expr, sandbox);
  ok('状态：状态名唯一来源（四态，含已暂停）',
    ev('STATUS_ORDER.join(",")') === 'todo,doing,paused,done'
    && ev('STATUS_NAME.doing') === '进行中' && ev('statusName("done")') === '已完成'
    && ev('STATUS_NAME.paused') === '已暂停' && ev('statusName("stalled")') === '待办');
  ok('状态：选择器与行内 pill 共用同一色板令牌',
    ev('STATUS_PILLS.every(p => p.color === "var(--st-" + p.st + "-dot)") && STATUS_PILLS.length === 4'));
  ok('状态：未知值回退为待办', ev('statusName("nope")') === '待办');
  ok('勾选圈提示回显当前状态',
    ev('checkTitle(false, "doing")') === '标记完成（当前：进行中）'
    && ev('checkTitle(true, "done")') === '取消完成（当前：已完成）');

  /* ---- v1.5 三文件模型：拆分 / 合并 round-trip ---- */
  S.ME = { id: 'u_a', name: 'A' };
  S.SCOPE_SHARED = 'shared';
  S.AUTH = { meta:{ rev:1 }, users:[{ id:'u_a', username:'a', active:true }] };
  S._revs = { personal:3, shared:7, auth:1 };
  S._wrote = { personal:'', shared:'', auth:'' };
  const P0 = { meta:{ rev:3 }, projects:[{ id:'p1', name:'个人项目', scope:'personal', memberIds:['u_a'] }],
    tasks:[{ id:'t1', projectId:'p1', title:'私密任务', status:'todo', completed:false, comments:[], subtasks:[], activities:[] }],
    notifications:[{ id:'n1', userId:'u_a', text:'x' }], trash:{ tasks:[], projects:[] }, tags:[{ id:'g1', name:'紧急' }], savedFilters:[{ id:'sf1' }] };
  const S0 = { meta:{ rev:7 }, projects:[{ id:'p2', name:'共享项目', scope:'shared', memberIds:['u_a','u_b'] }],
    tasks:[{ id:'t2', projectId:'p2', title:'团队任务', status:'doing', completed:false, comments:[], subtasks:[], activities:[] }],
    notifications:[{ id:'n2', userId:'u_b', projectId:'p2', text:'y' }], trash:{ tasks:[], projects:[] } };
  ev('mergeStores(' + JSON.stringify(P0) + ',' + JSON.stringify(S0) + ')');
  ok('合并视图含两个库的项目', ev('DB.projects.map(p=>p.id).join(",")') === 'p1,p2');
  ok('合并视图 users 来自账户表', ev('DB.users.length') === 1);
  ok('合并后各自记录版本号', ev('_revs.personal') === 3 && ev('_revs.shared') === 7);
  const rt = JSON.parse(ev('JSON.stringify(splitStores())'));
  ok('拆分回写：个人库只含个人项目', rt.personal.projects.length === 1 && rt.personal.projects[0].id === 'p1');
  ok('拆分回写：共享库只含共享项目', rt.shared.projects.length === 1 && rt.shared.projects[0].id === 'p2');
  ok('任务按所属项目归属分流', rt.personal.tasks.map(t=>t.id).join() === 't1' && rt.shared.tasks.map(t=>t.id).join() === 't2');
  ok('通知按 projectId 分流，无 projectId 归个人库',
    rt.personal.notifications.map(n=>n.id).join() === 'n1' && rt.shared.notifications.map(n=>n.id).join() === 'n2');
  ok('标签与筛选视图留在个人库', rt.personal.tags.length === 1 && rt.personal.savedFilters.length === 1);
  ok('拆分保留各自版本号', rt.personal.meta.rev === 3 && rt.shared.meta.rev === 7);
  ev('DB.trash.projects.push({ id:"p2b", scope:"shared", deletedAt:Date.now() }); DB.trash.tasks.push({ id:"t9", projectId:"p2", deletedAt:Date.now() })');
  const tr = JSON.parse(ev('JSON.stringify(splitStores())'));
  ok('回收站里的共享项目也进共享库', tr.shared.trash.projects.length === 1 && tr.shared.trash.tasks.length === 1);
  ok('personalFileOf 按 uid 定位文件', ev('personalFileOf("u_x")') === 'flowtask_data_u_x.json');
  ok('projectScopeOf 只认 shared', ev('projectScopeOf({scope:"shared"})') === 'shared' && ev('projectScopeOf({})') === 'personal');

  /* ---- v1.9 协作可见性：加同事 = 自动共享；邀请通知要落在对方读得到的库
         真实事故：管理员把同事加进个人项目的 memberIds，数据仍在他自己的个人库文件里，
         服务端只把那份文件发给他本人 → 同事登录后什么都看不到，而且界面上毫无提示。
         判定是纯函数（decideAutoShare），"真的搬库"由浏览器 E2E M23 端到端证明。 ---- */
  const mkProj = (scope, ids, extra) => Object.assign({ id:'p1', name:'P', ownerId:'u_a',
    memberIds: ids, archived:false, scope, statusUpdates:[] }, extra || {});
  const decide = p => ev('decideAutoShare(' + JSON.stringify(p) + ',"u_a",false)');
  ok('自动共享判定：名单里只有创建人 → 保持个人项目',
    decide(mkProj('personal', ['u_a'])) === 'solo');
  ok('自动共享判定：名单里出现同事 → 应搬进团队共享库',
    decide(mkProj('personal', ['u_a', 'u_b'])) === 'share');
  ok('自动共享判定：scope 缺失的老项目同样按个人库处理（迁移前也不能漏）',
    decide(mkProj(undefined, ['u_a', 'u_b'])) === 'share');
  ok('自动共享判定：归档项目不许偷偷搬库',
    decide(mkProj('personal', ['u_a', 'u_b'], { archived:true })) === 'archived');
  ok('自动共享判定：已在共享库的不重复动作',
    decide(mkProj('shared', ['u_a', 'u_b'])) === 'already');
  ok('自动共享判定：非创建人且非管理员 → 无权把别人的项目搬库',
    ev('decideAutoShare(' + JSON.stringify(mkProj('personal', ['u_a', 'u_c'])) + ',"u_c",false)') === 'noperm');
  ok('自动共享判定：管理员可以代创建人共享',
    ev('decideAutoShare(' + JSON.stringify(mkProj('personal', ['u_a', 'u_c'])) + ',"u_c",true)') === 'share');
  ok('自动共享判定：owner 缺失时不会把创建人自己误判成同事',
    decide(mkProj('personal', ['u_a'], { ownerId: undefined })) !== 'solo');

  ok('搬库时把创建人与操作者都留在名单里',
    /* P 现在是真正的权限对象（进了测试标记区），isAdmin 由 ME.role 决定，不再打桩 */
    (S.ME = { id:'u_a', name:'管理员', role:'admin' }, S.UI = { prefs:{} },
      S.DB = { meta:{ rev:1, lastSaved:Date.now() },
      projects:[mkProj('personal', ['u_b'])], tasks:[], notifications:[],
      trash:{ tasks:[], projects:[] }, users:[{ id:'u_a' }, { id:'u_b' }], tags:[], savedFilters:[] },
      S.saveDB = function(){}, S.renderApp = function(){}, S.toast = function(){},
      ev('shareProjectIfCollaborating(DB.projects[0])') === 'shared'
      && ev('DB.projects[0].memberIds.slice().sort().join(",")') === 'u_a,u_b'
      && ev('projectScopeOf(DB.projects[0])') === 'shared'));

  ok('通知：邀请带 projectId，才会随项目落到对方读得到的库',
    (S.DB = { meta:{ rev:1 }, projects:[], tasks:[{ id:'t1', projectId:'p1' }], notifications:[],
       trash:{ tasks:[], projects:[] }, users:[{ id:'u_a' }, { id:'u_b' }], tags:[], savedFilters:[] },
      S.ME = { id:'u_a' },
      ev('notify("u_b","invite",null,{projName:"P",projId:"p1"}); notify("u_b","comment","t1",{})'),
      ev('DB.notifications.map(n=>n.projectId).join("|")') === 'p1|p1'));
  ok('通知：不给任何项目线索时仍归个人库（不凭空造 projectId）',
    (S.DB.notifications = [], ev('notify("u_b","status_update",null,{})'), S.DB.notifications[0].projectId === null));
  ok('守卫：两个改成员的入口都走同一条自动共享规则',
    (html.match(/shareProjectIfCollaborating\(proj\)/g) || []).length === 3,
    '实际 ' + (html.match(/shareProjectIfCollaborating\(proj\)/g) || []).length + ' 处（应为 定义+两个入口）');
  ok('守卫：个人项目的成员弹窗与项目设置都当场说清"加了同事会自动共享"',
    /自动共享/.test(html) && /登录看不到|同事还看不到|别人登录看不到/.test(html));
  S.DB = null;

  /* 迁移：scope 缺失（单文件时代的项目基本都是）要显式补成 personal，
     否则成员弹窗/侧栏标记读不到归属，界面上说不清"这项目共没共享"。
     migrateData 本体太大不进测试标记区，这里按本文件既有惯例用文本级锁住这一行。 */
  ok('迁移：缺 scope 的项目被显式补成 personal',
    html.includes(`p.scope = 'personal'; changed = true;`) && html.includes("if(p.scope !== SCOPE_SHARED && p.scope !== 'personal')"),
    'migrateData 里没有 scope 补齐这一行');

  /* ---- v1.9 可见性单源：成员名单决定谁能看到项目，管理员也不例外
         真实反馈：sid 把 hao 从一个项目里移出，hao（role=admin）登录仍然看得见——
         因为旧判定是 isAdmin() || memberIds.includes(ME.id)，管理员直接绕过名单。 ---- */
  const visProj = { id:'p_v', name:'可见性', ownerId:'u_a', memberIds:['u_a','u_b'], archived:false, scope:'shared' };
  S.DB = { meta:{ rev:1 }, projects:[visProj], tasks:[], notifications:[],
    trash:{ tasks:[], projects:[] }, users:[{ id:'u_a' },{ id:'u_b' },{ id:'u_c' }], tags:[], savedFilters:[] };
  S.UI = { prefs:{} };
  S.ME = { id:'u_b', name:'在名单里', role:'member' };
  ok('可见性：名单里的成员看得到', ev('P.canSeeProject(DB.projects[0])') === true);
  S.ME = { id:'u_c', name:'路人', role:'member' };
  ok('可见性：名单外的人看不到', ev('P.canSeeProject(DB.projects[0])') === false);
  ok('可见性：管理员默认也只能看到自己参与的项目（移出即不可见）',
    (S.ME = { id:'u_c', name:'管理员', role:'admin' }, ev('P.canSeeProject(DB.projects[0])') === false));
  ok('可见性：管理员打开「显示全部项目」后才纵览',
    (S.UI = { prefs:{ seeAllProjects:true } }, ev('P.canSeeProject(DB.projects[0])') === true));
  ok('可见性：偏好里的非法值不能顺手打开管理员纵览',
    (S.UI = { prefs:{ seeAllProjects:'true' } }, ev('PREF().seeAllProjects') === false));
  ok('可见性：visibleProjects 与列表数字同口径（不再有第二份判定）',
    (S.UI = { prefs:{} }, S.ME = { id:'u_c', name:'管理员', role:'admin' },
      ev('P.visibleProjects().length') === 0 && ev('DB.projects.length') === 1));

  ok('守卫：可见性判定只剩 canSeeProject 一处，散落写法已清零',
    !/isAdmin\(\) \|\| p\.memberIds\.includes\(ME\.id\)/.test(html)
    && (html.match(/P\.canSeeProject\(/g) || []).length >= 7,
    'canSeeProject ' + (html.match(/P\.canSeeProject\(/g) || []).length + ' 处');
  ok('守卫：管理员「显示全部项目」开关存在且明示是管理员纵览',
    html.includes('sb-see-all') && /显示全部项目/.test(html));

  /* ---- 防回退守卫（文本级锁住本轮修掉的问题） ---- */
  const banned = [
    ['dataset.secAdd（＋按钮取值 bug）', 'dataset.secAdd'],
    ['永久删除任务（文案与行为相反）', '永久删除任务'],
    ['高优先（优先级叫法不统一）', '高优先'],
    ['添加卡片（同一动作两种叫法）', '添加卡片'],
    ['协作者（应为关注人）', '协作者'],
    ['数据完全存储于本机浏览器（与侧栏矛盾）', '数据完全存储于本机浏览器'],
    ['conflict 文件（术语泄漏）', 'conflict 文件'],
    ['users 应为数组（校验术语泄漏）', '应为数组'],
    ['Asana（品牌定位不得再出现在源码）', 'Asana'],
    ['收件箱（v2.0 起叫「通知」）', '收件箱'],
    ['状态更新（v2.0 起叫「项目播报」）', '状态更新'],
    ['Tab+Q（v2.0 起换 Ctrl+K 命令面板）', 'Tab+Q'],
    ['旧品牌色 #E24D5C', 'E24D5C'],
    ['珊瑚红（定位语不得残留）', '珊瑚红'],
    ['emoji 图标·软盘', '\uD83D\uDCBE'],
    ['emoji 图标·眼睛', '\uD83D\uDC41'],
    ['emoji 图标·锁', '\uD83D\uDD12'],
    ['emoji 图标·地球', '\uD83C\uDF10'],
    ['emoji 图标·垃圾桶', '\uD83D\uDDD1'],
    ['emoji 图标·对话气泡', '\uD83D\uDCAC'],
  ];
  banned.forEach(([label, needle]) => ok('守卫：不再出现 ' + label, !html.includes(needle), '仍能在源码中找到'));
  ok('守卫：Ctrl+K 命令面板已就位（openCmdk + KEYMAP 单一来源）',
    html.includes('function openCmdk') && html.includes('const KEYMAP') && html.includes("e.key==='k'||e.key==='K'"));
  ok('守卫：项目标识用首字母色块（proj-ic）', html.includes('.proj-ic{') && html.includes('class="proj-ic"'));
  ok('守卫：状态色板只在 :root 定义并被引用',
    /--st-doing-dot:/.test(html) && /\.status-pill\.s-doing\{[^}]*var\(--st-doing-fg\)/.test(html)
    && !/\.status-pill\.s-doing\{[^}]*#2563eb/.test(html));
  ok('守卫：优先级徽章不再用实心背景', !/\.prio-pill\.prio-high\{background:/.test(html));
  ok('守卫：弹窗主按钮动词已显式化',
    ['创建项目','添加','添加子任务','创建账户','保存设置','保存成员','创建标签','设置日期']
      .every(v => html.includes("'" + v + "'")));
  ok('守卫：可达性基础设施已就位',
    html.includes('function enhanceA11y') && html.includes("setAttribute('tabindex'") && html.includes('role="dialog"'));
  ok('守卫：窄屏断点已补', /@media \(max-width:900px\)/.test(html) && /@media \(max-width:640px\)/.test(html));
  ok('守卫：本地写盘防抖 + 关页前同时冲本地与待推送',
    html.includes('function scheduleLocalSave') && html.includes('function flushAllSaves')
    && html.includes("addEventListener('pagehide', flushAllSaves)") && html.includes('_svcSaveTimer = null; pushStoreSvc();'));
  ok('守卫：冲突副本有 UI 入口', html.includes('冲突副本') && html.includes('data-cp-dl'));
  ok('守卫：帮助层与首次引导存在', html.includes('function openHelpModal') && html.includes('function maybeShowWelcome'));
  ok('守卫：筛选视图与按视图记住筛选', html.includes('DB.savedFilters') && html.includes('function restoreFilter'));
  ok('守卫：三文件模型与账户表已落地',
    html.includes('flowtask_auth.json') && html.includes('flowtask_shared.json') && html.includes('personalFileOf')
    && html.includes('function establishSession') && html.includes('function verifySessionWithServer'));
  ok('守卫：启动不再无条件推送（假冲突源头已移除）', !/flushLocalDB\(\);\s*\n\s*pushStoreSvc\(\);/.test(html));
  ok('守卫：项目归属切换有确认与说明', html.includes('function setProjectScope') && html.includes('共享给团队'));
  /* ---- v1.6 走查修复守卫（账户可信 / 权限单源 / XSS / 会话证明） ---- */
  const serverJs = fs.readFileSync(path.join(ROOT, 'flowtask_server.js'), 'utf8');
  const serverPs1 = fs.readFileSync(path.join(ROOT, 'flowtask_server.ps1'), 'utf8');
  ok('v1.6 守卫：登录改走挑战+证明流程', html.includes('/api/auth-challenge') && html.includes('verifier'));
  ok('v1.6 守卫：服务端会话签发必须验证密码证明（Node）', serverJs.includes("err:'verifier required'") && serverJs.includes('timingSafeEqual'));
  ok('v1.6 守卫：PS 版同样验证密码证明', serverPs1.includes("err = 'verifier required'") && serverPs1.includes('Test-SafeEqualStr'));
  ok('v1.6 守卫：账户表读取脱敏（Node）', serverJs.includes('redactAuth'));
  ok('v1.6 守卫：账户表读取脱敏（PS）', serverPs1.includes("p.Name -ne 'passHash' -and $p.Name -ne 'salt'"));
  ok('v1.6 守卫：账户表字段级写守卫（Node）', serverJs.includes('function guardAuthWrite') && serverJs.includes('只有管理员可以修改账户角色'));
  ok('v1.6 守卫：账户表字段级写守卫（PS）', serverPs1.includes('function Protect-AuthWrite') && serverPs1.includes('只有管理员可以修改账户角色'));
  ok('v1.6 守卫：Node 写盘失败回 500 且回滚版本', serverJs.includes('save failed') && serverJs.includes('prevRev'));
  ok('v1.6 守卫：PS Move-Item 目录陷阱显式拦截', serverPs1.includes('destination is a directory'));
  ok('v1.6 守卫：备份轮转按完整时间戳匹配', serverJs.includes('d{8}_') && serverPs1.includes('d{8}_'));
  ok('v1.6 守卫：共享/收回确认弹窗项目名已转义', html.includes("html: '「' + esc(proj.name)"));
  ok('v1.6 守卫：成员管理与项目设置权限单源 canManageProject', html.includes('function canManageProject') && html.includes('canManageProject(proj) ? `<button') && html.includes('if(!canManageProject(proj)) return toast'));
  ok('v1.6 守卫：项目设置改名/改描述仅管理权可保存', html.includes('if(canAdmin){\n      proj.name = $(\'#ps-name\')'));
  ok('v1.6 守卫：越权归因区分访客与非成员', html.includes('function denyWriteTaskMsg') && !html.includes("'只读访客不能改变任务状态，卡片已放回原位'"));
  ok('v1.6 守卫：用户菜单改为原生按钮（键盘可登出）', html.includes('<button type="button" class="user-chip"'));
  ok('v1.6 守卫：toast 与保存状态带 aria-live', html.includes('id="toast-wrap" role="status" aria-live="polite"') && html.includes('id="store-status" onclick="retryStoreSvc()" role="status"'));
  ok('v1.6 守卫：批量条不再使用 emoji 图标', !html.includes('🗑 删除</button>') && !html.includes('👤 指派…</button>'));
  ok('v1.6 守卫：看板卡不再重复状态 pill', !html.includes("card-foot\">\n      <span class=\"status-pill"));
  ok('v1.6 守卫：批量条先清选中再执行（计数不残留）', /bar\.onclick = \(e\)=>\{[\s\S]{0,400}MULTI\.ids\.clear\(\);[\s\S]{0,200}if\(act==='done'\)/.test(html));
  ok('v1.6 守卫：离开项目页退出多选并撤批量条', /renderContent\(\)\{\s*\n\s*const c = \$\('#content'\);[\s\S]{0,400}removeBatchBar\(\);/.test(html));
  ok('v1.6 守卫：抽屉键盘增强在重绘之后', (html.match(/enhanceA11y\(\$\('#drawer-body'\)\);\s*\n\}/g) || []).length === 2);
  ok('v1.6 守卫：快速添加连续录入', html.includes('可继续录入下一条'));
  ok('v1.6 守卫：读错误不再谎报空库（Node）', serverJs.includes("err.code === 'ENOENT'"));
  ok('v1.6 守卫：登出前冲掉待写盘队列', /function logout\(\)\{[\s\S]{0,200}flushAllSaves\(\)/.test(html));
  /* ---- v1.7：任务移动 / 键盘排序 / 确认框统一 / label 关联 ---- */
  ok('v1.7 守卫：任务移动到项目（按钮 + 可搜索切换器 + 批量条入口）',
    html.includes('function moveTaskToProject') && html.includes('id="dt-move-btn"')
    && html.includes('function openProjectPicker') && html.includes('data-ba="move"'));
  ok('v1.7 守卫：原生 confirm 已全部替换为自研确认框', !/(^|[^a-zA-Z])confirm\(/.test(html));
  ok('v1.7 守卫：键盘排序 Alt+↑/↓（任务行与侧栏项目）',
    html.includes('function keyboardMoveTask') && html.includes('function keyboardMoveProject')
    && html.includes("keyboardMoveTask(el.dataset.task, e.key==='ArrowUp' ? -1 : 1)"));
  ok('v1.7 守卫：表单 label 已关联 for（≥28 处）', (html.match(/<label for=/g) || []).length >= 28);
  ok('v1.7 守卫：复制项目可撤销', html.includes('已撤销项目复制'));
  /* ---- v1.7.2：默认指派自己 / 回收站范围清空 ---- */
  ok('v1.7.2 守卫：快速添加默认指派当前用户', html.includes('data-me="1"') && html.includes('sel.dataset.userPicked'));
  ok('v1.7.2 守卫：回收站清空按管理权分范围（不再仅管理员）',
    html.includes('clearableProjectIds') && html.includes('你有管理权的') && !html.includes('只有管理员可以清空回收站'));
  /* ---- v1.7.3：时间按日期追溯 ---- */
  ok('v1.7.3 守卫：评论/动态/通知/回收站时间带完整时间戳悬浮提示',
    html.includes('class="c-time" title=') && html.includes('class="a-time" title=')
    && html.includes('class="n-time" title=') && html.includes('删除于 ${timeTitle'));
  ok('v1.7.3 守卫：已编辑标记带编辑时刻', html.includes('（已编辑 \'+timeTitle(cm.editedAt)'));
  ok('v1.7.3 守卫：不再输出「N天前」相对表述',
    !/Math\.floor\(diff\/86400\)/.test(html));
  /* v1.7.3 当年靠"中途发现已登出就 break"避免 null.meta 崩溃，代价是把队列里剩下的
     那份团队共享库整个丢掉（编辑静默丢失）。现在改成进函数就快照两份待写内容与鉴权头，
     推完不依赖 DB 是否还在——所以这条守卫要钉的是"不许再有 break 收手"。 */
  ok('v1.7.3 守卫：推送中途登出不再抛 null.meta（改为快照）',
    html.includes('if(DB && DB.meta) DB.meta.rev') && html.includes('headers: snapHeaders')
    && !/if\(!DB\) break;/.test(html), '推送队列应先快照待写内容与鉴权头');
  ok('守卫：登出冲队列时两份库都要推出去（不允许中途丢弃共享库）',
    html.includes('const snapHeaders = storeHeaders();') && /r = await fetchStore\(job\.name, 'POST', body, rev, job\.headers\)/.test(html));
  /* ---- v1.7.4：弹窗「添加即关闭」，连续录入改成显式按钮 ---- */
  ok('v1.7.4 守卫：快速添加主按钮创建即关闭弹窗',
    html.includes("if(!keepOpen){ toast('任务已创建', 'ok'); return true; }"));
  ok('v1.7.4 守卫：添加子任务主按钮创建即关闭弹窗',
    html.includes("if(!keepOpen){ toast('子任务已添加', 'ok'); return true; }"));
  ok('v1.7.4 守卫：连续录入是显式第二条路径（按钮 + Shift+Enter）',
    html.includes('id="qa-again"') && html.includes('id="as-again"')
    && html.includes('if(e.shiftKey){ commitQuickAdd(true); return; }')
    && html.includes('if(e.shiftKey){ commitSub(true); return; }'));
  /* ---- v1.8.1：子任务拖拽排序 + 首页子任务完成圆圈 ---- */
  ok('v1.8.1 守卫：抽屉子任务可拖拽排序（指示线 + 重排落盘）',
    html.includes('.subtask-row[draggable]') && html.includes('_subDropAfter')
    && html.includes("t.subtasks.splice(_subDropAfter ? dstIdx+1 : dstIdx, 0, item)"));
  ok('v1.8.1 守卫：首页子任务行带完成圆圈并可切换',
    html.includes('checkTitle(!!s.done, s.status') && html.includes('toggleSubDone(host, sub)'));
  /* ---- v1.7.5 ---- */
  ok('v1.7.5 守卫：活动记录默认折叠且可展开（两个抽屉都绑）',
    html.includes('function activityListHTML')
    && (html.match(/#drawer-body \[data-act-fold\]/g) || []).length === 2);
  ok('v1.7.5 守卫：切换任务回到顶部',
    (html.match(/drawerBody.scrollTop = wasOpenForSame \? savedScroll : 0;/g) || []).length === 2);
  ok('v1.8.0 守卫：今天卡片外层条件须含今天到期/子任务（曾漏掉导致只剩子任务时渲染成空态）',
    html.includes('(needToday.length + subOverdue.length + subToday.length) ? [')
    && !html.includes('(overdue.length || subOverdue.length) ? ['));
  ok('v1.8.0 守卫：首页卡片纳入子任务（子任务行 + 点击进详情）',
    html.includes('const homeSubs = DB.tasks.filter') && html.includes('data-sub="${t.id}/${s.id}"')
    && html.includes("openSubDrawer(parts[0], parts[1])"));
  ok('v1.7.5 守卫：快速添加默认项目走当前/上次，而非固定第一个',
    html.includes('quickAddDefaultProject(defaultPid, projects, ROUTE, UI.lastAddPid)')
    && html.includes('UI.lastAddPid = proj.id; saveUI();')
    && !html.includes('const pid = defaultPid || projects[0].id;'));

  /* ---- 偏好设置：默认值与非法值兜底 ---- */
  S.UI = { prefs: {} };
  ok('偏好：无存储时用默认值', ev('PREF().projView') === 'overview' && ev('PREF().tagLimit') === 2);
  S.UI = { prefs: { projView:'board', tagLimit:0, startPage:'my-tasks', newTaskStatus:'doing' } };
  ok('偏好：读回已存的值', ev('PREF().projView') === 'board' && ev('PREF().tagLimit') === 0
    && ev('PREF().newTaskStatus') === 'doing');
  S.UI = { prefs: { projView:'hacked', startPage:'nope', newTaskStatus:'x', tagLimit:-5 } };
  ok('偏好：非法值一律回退默认', ev('PREF().projView') === 'overview' && ev('PREF().startPage') === 'last'
    && ev('PREF().newTaskStatus') === 'todo' && ev('PREF().tagLimit') === 2);
  S.UI = { prefs: { projView:'list' }, lastRoute:'#/project/p9/board' };
  ok('偏好：项目链接带上默认页面', ev('projectHash("p9")') === '#/project/p9/list');
  ok('偏好：未设启动页时沿用上次的具体位置', ev('startHash()') === '#/project/p9/board');
  S.UI = { prefs: { startPage:'home' }, lastRoute:'#/project/p9/list' };
  ok('偏好：启动页选首页', ev('startHash()') === '#/');
  S.UI = { prefs: { startPage:'my-tasks' } };
  ok('偏好：启动页选我的任务', ev('startHash()') === '#/my-tasks');
  S.UI = { prefs: { startPage:'last' }, lastRoute:'' };
  ok('偏好：没有历史记录时回首页', ev('startHash()') === '#/');

  /* ---- 启动脚本不得再起任何控制台进程（否则双击时会闪黑窗口） ---- */
  const vbs = fs.readFileSync(path.join(ROOT, '启动 FlowTask.vbs'), 'utf8');
  ok('守卫：启动脚本不用 sh.Exec 起 cmd（无黑窗口）', vbs.indexOf('.Exec(') < 0);
  ok('守卫：启动脚本以隐藏窗口方式起服务', /,\s*0,\s*False/.test(vbs));
  ok('守卫：PowerShell 走系统固定路径探测', vbs.includes('WindowsPowerShell') && vbs.includes('FileExists'));

  const ver = vm.runInContext('APP_VERSION', sandbox);
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const topVer = (cl.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
  ok('守卫：APP_VERSION 与 CHANGELOG 顶部版本一致', ver === topVer, `代码 ${ver} / CHANGELOG ${topVer}`);
}

/* ================= Node 服务端集成测试 ================= */
async function nodeIntegration(){
  console.log('\n== 集成测试：Node 存储服务（端口 5199） ==');
  const PORT = 5199, BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = path.join(__dirname, 'tmp', 'srv');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const env = Object.assign({}, process.env, { FLOWTASK_PORT: String(PORT), FLOWTASK_DATA_DIR: DATA_DIR });
  await freePort(PORT);
  const srv = spawn(NODE_EXE, [path.join(ROOT, 'flowtask_server.js')], { env, stdio: 'ignore' });
  const R = (m, p, o) => req(BASE, m, p, o);
  try{
    ok('服务启动', await waitUp(BASE));

    // 令牌与来源门控
    let r = await R('GET', '/api/token');
    ok('无 Origin 拒绝发放令牌', r.status === 403);
    r = await R('GET', '/api/token', { origin: 'http://evil.example.com' });
    ok('恶意来源拒绝发放令牌', r.status === 403 && !r.headers['access-control-allow-origin']);
    r = await R('GET', '/api/token', { origin: BASE });
    ok('同源发放令牌', r.status === 200 && !!JSON.parse(r.text).token);
    ok('同源回显 ACAO', r.headers['access-control-allow-origin'] === BASE);
    const token = JSON.parse(r.text).token;

    // 写入门禁
    r = await R('POST', '/api/db', { body: sample(1), headers: { 'Content-Type': 'application/json' } });
    ok('无令牌写入 403', r.status === 403);
    r = await R('POST', '/api/db', { body: sample(1), headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': 'wrong' } });
    ok('错误令牌写入 403', r.status === 403);

    // 形状校验
    r = await R('POST', '/api/db', { body: '{"foo":1}', headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': token } });
    ok('非法数据结构 400', r.status === 400);
    r = await R('POST', '/api/db', { body: 'not json', headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': token } });
    ok('非法 JSON 400', r.status === 400);

    // 正常写入与读取
    const H1 = { 'Content-Type': 'application/json', 'X-FlowTask-Token': token, 'X-FlowTask-Rev': '1' };
    r = await R('POST', '/api/db', { body: sample(1), headers: H1 });
    ok('rev=1 首次写入成功', r.status === 200);
    r = await R('GET', '/api/db');
    ok('读数据同样需要令牌（v1.5 收紧）', r.status === 403);
    r = await R('GET', '/api/db', { headers: { 'X-FlowTask-Token': token } });
    ok('带令牌读取返回已存数据', r.status === 200 && JSON.parse(r.text).meta.rev === 1);
    r = await R('GET', '/api/version');
    ok('版本接口返回 1', r.status === 200 && JSON.parse(r.text).rev === 1);

    // 版本冲突
    r = await R('POST', '/api/db', { body: sample(1), headers: H1 });
    ok('同版本号 + 内容一致 → 幂等 200（不再误报冲突）', r.status === 200 && JSON.parse(r.text).noop === true, r.text.slice(0, 60));
    r = await R('POST', '/api/db', { body: sample(1).replace('"T"', '"改了名字"'), headers: H1 });
    ok('同版本号 + 内容不同 → 真冲突 409', r.status === 409);
    r = await R('POST', '/api/db', { body: sample(0), headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': token } });
    ok('无版本号写入放行（旧客户端兼容）', r.status === 200);
    r = await R('POST', '/api/db', { body: sample(2), headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': token, 'X-FlowTask-Rev': '2' } });
    ok('更高版本号写入成功', r.status === 200);

    // 备份轮转（第二次写入时已有数据文件 → 触发备份）
    await sleep(400);
    const bdir = path.join(DATA_DIR, 'backups');
    const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => /\.json$/.test(f)) : [];
    ok('备份轮转已生成备份', backups.length >= 1, 'backups=' + backups.length);

    // 冲突副本
    r = await R('POST', '/api/db-conflict', { body: sample(99), headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': token } });
    ok('冲突副本保存成功', r.status === 200 && fs.readdirSync(DATA_DIR).some(f => f.startsWith('flowtask_data_conflict_')));
    r = await R('POST', '/api/db-conflict', { body: sample(99), headers: { 'Content-Type': 'application/json' } });
    ok('冲突副本无令牌 403', r.status === 403);

    // 损坏文件隔离
    fs.writeFileSync(path.join(DATA_DIR, 'flowtask_data.json'), '{ broken json !!!');
    r = await R('GET', '/api/db', { headers: { 'X-FlowTask-Token': token } });
    ok('损坏文件返回 204', r.status === 204);
    ok('损坏文件带隔离头', !!r.headers['x-flowtask-quarantined']);
    ok('损坏文件已改名隔离', fs.readdirSync(DATA_DIR).some(f => f.startsWith('flowtask_data_corrupt_')));
    ok('原数据文件已移除', !fs.existsSync(path.join(DATA_DIR, 'flowtask_data.json')));

    // 页面托管与令牌注入
    r = await R('GET', '/');
    ok('页面托管 200', r.status === 200);
    ok('页面注入真实令牌', r.text.includes(`window.__FT_TOKEN__ = "${token}"`));
    ok('页面不含占位符', !r.text.includes('__FLOWTASK_TOKEN__'));
    ok('响应带 nosniff', r.headers['x-content-type-options'] === 'nosniff');
  } finally {
    try{ srv.kill(); }catch(e){}
    await freePort(PORT);
  }
}

/* ================= PowerShell 服务端冒烟 ================= */
async function ps1Smoke(){
  console.log('\n== 冒烟测试：PowerShell 存储服务（端口 5299） ==');
  const PORT = 5299, BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = path.join(__dirname, 'tmp', 'ps1');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await freePort(PORT);
  const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'flowtask_server.ps1'), '-Port', String(PORT), '-DataDir', DATA_DIR], { stdio: 'ignore' });
  const R = (m, p, o) => req(BASE, m, p, o);
  try{
    ok('PS1 服务启动（首启较慢，最多等 30 秒）', await waitUp(BASE));
    let ping = await R('GET', '/api/ping');
    ok('PS1 /api/ping 免鉴权可探活', ping.status === 200 && JSON.parse(ping.text).ready === true);

    let r = await R('GET', '/api/token', { origin: BASE });
    ok('同源发放令牌', r.status === 200 && !!JSON.parse(r.text).token);
    const token = JSON.parse(r.text).token;
    r = await R('GET', '/api/token', { origin: 'http://evil.example.com' });
    ok('恶意来源拒绝', r.status === 403);

    r = await R('POST', '/api/db', { body: sample(1), headers: { 'Content-Type': 'application/json' } });
    ok('无令牌写入 403', r.status === 403);
    const H1 = { 'Content-Type': 'application/json', 'X-FlowTask-Token': token, 'X-FlowTask-Rev': '1' };
    r = await R('POST', '/api/db', { body: sample(1), headers: H1 });
    ok('rev=1 写入成功', r.status === 200);
    r = await R('GET', '/api/db');
    ok('PS1 读数据同样需要令牌', r.status === 403);
    r = await R('GET', '/api/db', { headers: { 'X-FlowTask-Token': token } });
    ok('带令牌读取返回数据', r.status === 200 && JSON.parse(r.text).meta.rev === 1);
    r = await R('POST', '/api/db', { body: sample(1), headers: H1 });
    ok('PS1 同版本号 + 内容一致 → 幂等 200', r.status === 200 && JSON.parse(r.text).noop === true, r.text.slice(0, 60));
    r = await R('POST', '/api/db', { body: sample(1).replace('"T"', '"改了名字"'), headers: H1 });
    ok('PS1 同版本号 + 内容不同 → 真冲突 409', r.status === 409);
    r = await R('GET', '/api/db?file=flowtask_shared.json', { headers: { 'X-FlowTask-Token': token } });
    ok('PS1 无会话读共享库 401', r.status === 401);
    r = await R('POST', '/api/db', { body: sample(2), headers: { 'Content-Type': 'application/json', 'X-FlowTask-Token': token, 'X-FlowTask-Rev': '2' } });
    ok('更高版本号写入成功', r.status === 200);

    fs.writeFileSync(path.join(DATA_DIR, 'flowtask_data.json'), '{ broken !!!');
    r = await R('GET', '/api/db', { headers: { 'X-FlowTask-Token': token } });
    ok('损坏文件 204 + 隔离头', r.status === 204 && !!r.headers['x-flowtask-quarantined']);

    r = await R('GET', '/');
    ok('页面托管 + 令牌注入', r.status === 200 && r.text.includes(`window.__FT_TOKEN__ = "${token}"`));
    ok('响应带 nosniff', r.headers['x-content-type-options'] === 'nosniff');
  } finally {
    try{ process.kill(-ps.pid); }catch(e){ try{ ps.kill(); }catch(e2){} }
    await freePort(PORT);
  }
}

(async () => {
  const mode = process.argv[2];
  try{
    if(mode === 'ps1'){
      await ps1Smoke();
    }else{
      unitTests();
      uxTests();
      await nodeIntegration();
    }
  }catch(e){
    failed++;
    console.log('  FAIL  测试执行异常：' + (e && e.message));
  }
  /* README 里写的条数会随新增测试漂移（已经飘过两次：写 226 实际 286）。
     文档不实比没文档更糟，所以让守卫来强制同步——改了测试就得改 README。 */
  if(mode !== 'ps1'){
    const total = passed + failed;
    let declared = null;
    try{
      const rm = fs.readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
      const m = rm.match(/node tests\/flowtask_test\.js\s+#.*?（(\d+)\s*条/);
      if(m) declared = Number(m[1]);
    }catch(e){}
    if(declared === null){
      failed++; console.log('  FAIL  README 里找不到 flowtask_test.js 的条数标注，无法核对');
    }else if(declared !== total){
      failed++; console.log(`  FAIL  README 声明 ${declared} 条，实跑 ${total} 条（不含本条一致性检查）→ 请把 README 里该行改成 ${total} 条`);
    }else{
      passed++; console.log(`  PASS  README 声明条数与实跑一致（${total} 条，不含本条检查）`);
    }
  }
  console.log(`\n== 结果：${passed} 通过，${failed} 失败 ==`);
  process.exit(failed ? 1 : 0);
})();
