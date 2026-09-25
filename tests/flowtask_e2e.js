/*
 * FlowTask E2E 测试骨架（零依赖：仅 Node 内置模块 + 内建 fetch/WebSocket）
 * ------------------------------------------------
 * 用法：
 *   node tests/flowtask_e2e.js            运行全部场景
 *   node tests/flowtask_e2e.js --headed   非无头模式（调试可视化）
 *   node tests/flowtask_e2e.js --keep     结束后保留浏览器/服务并打印调试 URL
 *   node tests/flowtask_e2e.js --selftest 仅检查环境（Edge/Node/端口/服务/浏览器可启动）
 *   node tests/flowtask_e2e.js --dump-console 结束后打印全部 console/异常记录
 *   node tests/flowtask_e2e.js --grep M22     只跑名字命中的场景（调试定位用，门禁跑全量）
 *
 * 实现要点：
 *  - Edge 无头 + CDP（内置 WebSocket，无 puppeteer）
 *  - 存储服务用 FLOWTASK_DATA_DIR 重定向到系统临时目录，真实 flowtask_data.json
 *    只读不写；结束后用 size+mtime 复核并报告
 *  - 端口：应用前端硬编码 http://127.0.0.1:5178（见 HTML 中 STORE_SVC），
 *    因此服务必须跑在 5178；若被占用且确认是 FlowTask 服务则先停掉（结束后会提示重启）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'flowtask_server.js');
const REAL_DATA = path.join(ROOT, 'flowtask_data.json');
const SHOTS_DIR = path.join(ROOT, 'e2e-shots');

const APP_HOST = '127.0.0.1';
const APP_PORT = 5178;                     // 前端硬编码，必须用这个端口
const APP_BASE = `http://${APP_HOST}:${APP_PORT}`;

const ARGV = process.argv.slice(2);
const FLAGS = {
  headed: ARGV.includes('--headed'),
  keep: ARGV.includes('--keep'),
  selftest: ARGV.includes('--selftest'),
  dumpConsole: ARGV.includes('--dump-console'),
  grep: (ARGV.find((a, i) => ARGV[i - 1] === '--grep') || '') || process.env.FLOWTASK_E2E_GREP || '',
};

const EDGE_CANDIDATES = [
  process.env.FLOWTASK_EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findEdge(){
  for(const p of EDGE_CANDIDATES){ try{ if(fs.existsSync(p)) return p; }catch(e){} }
  return null;
}

/* ================= 小工具 ================= */
function httpReq(base, method, p, { body, headers } = {}){
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    if(body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request(base + p, { method, headers: h }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }));
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    if(body) r.write(body);
    r.end();
  });
}
async function httpJson(base, p, tries = 40, gap = 250){
  for(let i = 0; i < tries; i++){
    try{
      const r = await httpReq(base, 'GET', p);
      if(r.status === 200){ try{ return JSON.parse(r.text); }catch(e){} }
    }catch(e){}
    await sleep(gap);
  }
  return null;
}
function freePort(){
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function portListening(port, host = '127.0.0.1'){
  return new Promise(resolve => {
    const s = net.connect(port, host);
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(800);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}
/* 谁占用了端口（Windows netstat）；仅用于识别/停止本项目的旧服务实例 */
function pidsOnPort(port){
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  if(r.status !== 0) return [];
  const pids = new Set();
  for(const line of String(r.stdout || '').split(/\r?\n/)){
    if(!/LISTENING/i.test(line)) continue;
    const m = line.match(/(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}:([0-9]+)\b.*?\s(\d+)\s*$/);
    if(m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}
function killPid(pid){
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  return r.status === 0;
}

/* ================= 断言工具（与 flowtask_test.js 同风格） ================= */
const SUITE = [];
function t(name, fn){ SUITE.push({ name, fn }); }
class AssertError extends Error{}
function assertTruthy(cond, msg){
  if(!cond) throw new AssertError((msg || '应为真值') + `  [实际=${JSON.stringify(cond)}]`);
}
function assertEq(actual, expected, msg){
  if(actual !== expected){
    throw new AssertError(`${msg || '值不相等'}  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
  }
}
function assertMatch(actual, re, msg){
  if(typeof actual !== 'string' || !re.test(actual)){
    throw new AssertError(`${msg || '不匹配正则'}  正则=${re} 实际=${JSON.stringify(String(actual).slice(0, 300))}`);
  }
}

/* 登录的稳定封装（场景文件共用，别各自抄一份）：
   先真实鼠标点击（贴近用户行为），12 秒没进去就取证"按钮落点上是谁"再用 requestSubmit 兜底
   ——仍然走应用自己的 submit 处理器。跑到大场景末尾时确实出现过"点击无声失效"，
   落点信息会打成 INFO，真是有元素盖住按钮就能当场看出来。 */
function makeLoginAs(getPage){
  return async function loginAs(u, pw, label){
    const page = getPage();
    const appOn = `(() => document.getElementById('app').classList.contains('on'))()`;
    await page.evaluate(`(() => { try{ logout(); }catch(e){} return true; })()`);
    await page.waitFor(`(() => getComputedStyle(document.getElementById('auth-page')).display !== 'none')()`,
      { timeout: 20000, name: (label || u) + '：回到登录页' });
    await page.fill('#li-username', u);
    await page.fill('#li-password', pw);
    await page.evaluate(`(() => {
      const b = document.querySelector('#login-form button[type=submit]');
      if(b) b.scrollIntoView({ block:'center' });
      return true;
    })()`);
    await page.click('#login-form button[type=submit]');
    try{
      await page.waitFor(appOn, { timeout: 12000, name: (label || u) + ' 登录（真实点击）' });
      return { path: 'click' };
    }catch(e1){
      const hit = await page.evaluate(`(() => {
        const b = document.querySelector('#login-form button[type=submit]');
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return { hit: el ? (el.tagName + '#' + el.id + '.' + String(el.className)) : '(空)',
                 errText: (document.getElementById('login-err') || {}).textContent,
                 userVal: (document.getElementById('li-username') || {}).value };
      })()`);
      await page.evaluate(`(() => { document.getElementById('login-form').requestSubmit(); return true; })()`);
      try{
        await page.waitFor(appOn, { timeout: 25000, name: (label || u) + ' 登录（表单提交兜底）' });
        console.log(`        INFO  ${label || u} 真实点击没进（落点=${hit.hit}），已用 requestSubmit 走通`);
        return { path: 'requestSubmit' };
      }catch(e2){
        const d = await page.evaluate(`(async () => {
          let probe;
          try{ const r = await login(${JSON.stringify(u)}, ${JSON.stringify(pw)});
            probe = (typeof r === 'string') ? ('返回原因：' + r) : ('登录本身成功：' + (r && r.username));
          }catch(er){ probe = '抛异常：' + ((er && er.message) || er); }
          return { probe: probe,
                   errText: (document.getElementById('login-err') || {}).textContent,
                   toasts: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '),
                   modals: [...document.querySelectorAll('.modal-mask .modal-head h3')].map(x => x.textContent),
                   users: (AUTH && AUTH.users || []).map(x => x.username + ':' + (x.active === false ? 'off' : 'on')).join(',') };
        })()`);
        throw new Error(`${label || u} 两种方式都没登进去，点击落点 = ${JSON.stringify(hit)}，现场 = ${JSON.stringify(d)}`);
      }
    }
  };
}

let PASSED = 0, FAILED = 0;
const LAST_CONSOLE = [];   // 失败时打印最近日志
let ACTIVE_PAGE = null;

function tailConsole(){
  const lines = [];
  const p = ACTIVE_PAGE;
  if(p){
    for(const c of p.logs.slice(-5)) lines.push('        console> ' + c);
    for(const c of p.errors.slice(-3)) lines.push('        error> ' + c);
  }
  return lines.join('\n');
}

/* ================= CDP 客户端（内置 WebSocket） ================= */
class CDPConnection{
  constructor(wsUrl){
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];   // (msg) => void
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    });
    this.ws.addEventListener('message', ev => {
      let msg; try{ msg = JSON.parse(String(ev.data)); }catch(e){ return; }
      if(msg.id !== undefined){
        const ent = this.pending.get(msg.id);
        if(ent){
          this.pending.delete(msg.id);
          if(msg.error) ent.reject(new Error('CDP ' + ent.method + ' 失败: ' + (msg.error.message || JSON.stringify(msg.error))));
          else ent.resolve(msg.result);
        }
      }else if(msg.method){
        for(const fn of this.listeners){ try{ fn(msg); }catch(e){} }
      }
    });
    this.closed = false;
    this.ws.addEventListener('close', () => { this.closed = true; for(const [, e] of this.pending){ e.reject(new Error('CDP 连接已关闭')); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId = undefined){
    if(this.closed) return Promise.reject(new Error('CDP 已关闭'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if(sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close(){ try{ this.ws.close(); }catch(e){} }
}

/* ================= Page（一个标签页会话） ================= */
class Page{
  constructor(browser, targetId, sessionId){
    this.browser = browser;
    this.cdp = browser.cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.logs = [];     // console 文本
    this.errors = [];   // 未捕获异常文本
    this.url = '';
  }
  _on(msg){
    const p = msg.params || {};
    if(msg.method === 'Runtime.consoleAPICalled'){
      const txt = (p.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type || '')).join(' ');
      this.logs.push(`[${p.type}] ${txt}`);
      if(this.logs.length > 500) this.logs.shift();
    }else if(msg.method === 'Runtime.exceptionThrown'){
      const d = p.exceptionDetails || {};
      const txt = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
      this.errors.push(String(txt).split('\n')[0] + (this._stack(d) ? ' | ' + this._stack(d).split('\n')[0] : ''));
      if(this.errors.length > 100) this.errors.shift();
    }
  }
  _stack(d){
    const frames = (d.stackTrace && d.stackTrace.callFrames) || (d.exception && d.exception.stackTrace && String(d.exception.stackTrace).split('\n'));
    return Array.isArray(frames) ? frames.slice(0, 6).map(f => `${f.functionName || '(anon)'} @ ${f.url}:${(f.lineNumber ?? -1) + 1}:${(f.columnNumber ?? -1) + 1}`).join('\n') : (frames || '');
  }
  send(method, params = {}){ return this.cdp.send(method, params, this.sessionId); }

  /**
   * evl(page, x)：Runtime.evaluate 包装。
   *  - x 为函数或字符串形式的函数（function/箭头/带括号）→ 自动 IIFE 调用
   *  - 其它字符串按表达式求值；awaitPromise+returnByValue → 返回 JSON 可序列化值
   *  - 抛 JS 异常时 Error 中带浏览器堆栈
   */
  async evaluate(x, opts = {}){
    let src;
    if(typeof x === 'function'){
      src = '(' + x.toString() + ')()';
    }else{
      const t = String(x).trim();
      const isFnLiteral = /^function\b/.test(t) || /^async\b/.test(t)
        || (t.startsWith('(') && /=>|function\b/.test(t) && !t.endsWith(')()'));
      src = (!opts.raw && isFnLiteral) ? '(' + t + ')()' : t;
    }
    const r = await this.send('Runtime.evaluate', {
      expression: src, returnByValue: true, awaitPromise: true, userGesture: !!opts.userGesture,
    });
    const d = r.exceptionDetails;
    if(d){
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate 抛异常';
      const st = this._stack(d);
      throw new Error('页内 JS 异常: ' + desc + (st ? '\n浏览器堆栈:\n' + st : '') + '\n求值源码: ' + src.slice(0, 400));
    }
    return r.result ? r.result.value : undefined;
  }

  async goto(url, { timeout = 20000 } = {}){
    this.url = url;
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', { timeout, name: '页面加载 ' + url });
    await sleep(120);
  }
  async setViewport(width, height, mobile = false){
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  }
  async clearDeviceMetrics(){ try{ await this.send('Emulation.clearDeviceMetricsOverride'); }catch(e){} }
  async screenshot(name){
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async waitFor(expr, { timeout = 8000, interval = 120, name = '' } = {}){
    const end = Date.now() + timeout;
    let last;
    while(Date.now() < end){
      try{ last = await this.evaluate(expr); if(last) return last; }
      catch(e){ last = e.message; }
      await sleep(interval);
    }
    throw new Error('waitFor 超时(' + timeout + 'ms): ' + (name || String(expr).slice(0, 120)) + (last !== undefined && last !== false ? '  最后值=' + JSON.stringify(last) : ''));
  }
  async waitForSelector(sel, opts = {}){ return this.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, { name: '等待元素 ' + sel, ...opts }); }

  async _center(sel){
    const box = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if(!el) return { err: '找不到元素 ' + ${JSON.stringify(sel)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if(!box || box.err) throw new Error(box ? box.err : '元素无坐标 ' + sel);
    if(box.w === 0 || box.h === 0) throw new Error('元素不可见(0x0): ' + sel);
    return box;
  }
  async mouse(x, y, type, extra = {}){
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }
  async click(sel){
    const b = await this._center(sel);
    await this.mouse(b.x, b.y, 'mouseMoved');
    await this.mouse(b.x, b.y, 'mousePressed', { buttons: 1 });
    await sleep(30);
    await this.mouse(b.x, b.y, 'mouseReleased', { buttons: 0 });
  }
  async hover(sel){ const b = await this._center(sel); await this.mouse(b.x, b.y, 'mouseMoved'); }
  async type(sel, text){
    const found = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.focus(); return true; })()`);
    if(!found) throw new Error('找不到输入框 ' + sel);
    await this.send('Input.insertText', { text: String(text) });
  }
  async fill(sel, text){
    await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.value = ''; el.focus(); return true; })()`);
    await this.type(sel, text);
  }
  async key(k){
    const map = {
      Enter: { code: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', vk: 27 },
      Tab: { code: 'Tab', vk: 9, text: '\t' }, Backspace: { code: 'Backspace', vk: 8 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
      ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
      ' ': { code: 'Space', vk: 32, text: ' ' },
    };
    const info = map[k] || { code: 'Key' + k.toUpperCase(), vk: k.toUpperCase().charCodeAt(0), text: k };
    const common = { key: k, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(info.text ? { text: info.text } : {}) });
    if(info.text) await this.send('Input.dispatchKeyEvent', { type: 'char', ...common, text: info.text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }
  async close(){ await this.browser.closePage(this); }
}

/* ================= Browser（Edge 进程 + CDP 多路复用） ================= */
class Browser{
  constructor(exe, profileDir, cdpPort, headed){
    this.exe = exe; this.profileDir = profileDir; this.cdpPort = cdpPort;
    this.headed = headed; this.proc = null; this.cdp = null;
    this.pages = []; this.version = null;
  }
  async launch(){
    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--allow-file-access-from-files', '--disable-background-timer-throttling',
      '--disable-gpu', '--window-size=1440,900',
    ];
    if(!this.headed) args.unshift('--headless=new');
    args.push('about:blank');
    this.proc = spawn(this.exe, args, { stdio: 'ignore', detached: false, windowsHide: false });
    this.proc.on('exit', (code) => { this.procExited = { code }; });
    const base = `http://127.0.0.1:${this.cdpPort}`;
    const v = await httpJson(base + '', '/json/version', 60, 300);   // 最长约 18s
    if(!v || !v.webSocketDebuggerUrl) throw new Error('Edge CDP 未就绪（/json/version 无响应）。' + (this.procExited ? '进程已退出 code=' + this.procExited.code : '进程仍在'));
    this.version = v;
    this.cdp = new CDPConnection(v.webSocketDebuggerUrl);
    await this.cdp.ready;
    this.cdp.listeners.push(msg => {
      const sid = msg.sessionId;
      const page = this.pages.find(p => p.sessionId === sid);
      if(page) page._on(msg);
    });
    return this;
  }
  async newPage(url = 'about:blank'){
    const { targetId } = await this.cdp.send('Target.createTarget', { url, background: false });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    page.url = url;
    this.pages.push(page);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    if(url && url !== 'about:blank') await page.goto(url);
    return page;
  }
  async closePage(page){
    const i = this.pages.indexOf(page); if(i >= 0) this.pages.splice(i, 1);
    try{ await this.cdp.send('Target.closeTarget', { targetId: page.targetId }); }catch(e){}
  }
  async shutdown(){
    if(this.cdp){ try{ await this.cdp.send('Browser.close').catch(() => {}); this.cdp.close(); }catch(e){ this.cdp.close(); } }
    if(this.proc && this.proc.exitCode === null){
      killPid(this.proc.pid);   // taskkill /T /F 兜底清掉 msedge 子进程树
      for(let i = 0; i < 20 && this.proc.exitCode === null; i++) await sleep(100);
    }
    this._rmProfile();
  }
  _rmProfile(){
    if(this._profileRemoved) return;
    for(let i = 0; i < 5; i++){
      try{ fs.rmSync(this.profileDir, { recursive: true, force: true }); this._profileRemoved = true; return; }
      catch(e){ }
    }
    console.log('  WARN  无法删除临时浏览器目录（Edge 可能仍持有句柄）: ' + this.profileDir);
  }
}

/* ================= 存储服务生命周期 ================= */
async function ensureAppPortFree(){
  // 应用前端硬编码 5178：必须独占。只停“确认是 FlowTask 服务”的占用者，绝不误杀第三方进程。
  if(!(await portListening(APP_PORT))) return { killed: 0 };
  let isFlow = false;
  try{
    const r = await httpReq(APP_BASE, 'GET', '/api/version');
    const j = JSON.parse(r.text);
    isFlow = r.status === 200 && j && j.ok === true && typeof j.rev === 'number';
  }catch(e){}
  if(!isFlow){
    const who = (pidsOnPort(APP_PORT) || []).join(',') || '未知';
    throw new Error(`端口 ${APP_PORT} 被非 FlowTask 进程占用 (PID ${who})。E2E 不会误杀它——请先释放端口再运行。`);
  }
  let killed = 0;
  for(const pid of pidsOnPort(APP_PORT)){ if(pid > 0 && killPid(pid)) killed++; }
  for(let i = 0; i < 40 && (await portListening(APP_PORT)); i++) await sleep(250);
  if(await portListening(APP_PORT)) throw new Error(`无法停止 ${APP_PORT} 上已有的 FlowTask 存储服务`);
  return { killed: Math.max(killed, 1) };
}

class ServerHandle{
  constructor(proc, dataDir){ this.proc = proc; this.dataDir = dataDir; this.exited = null; proc.on('exit', c => this.exited = c); }
  static async start(dataDir){
    const env = Object.assign({}, process.env, {
      FLOWTASK_HOST: APP_HOST,
      FLOWTASK_PORT: String(APP_PORT),
      FLOWTASK_DATA_DIR: dataDir,     // 数据/备份/冲突副本全部重定向到临时目录
    });
    const proc = spawn(process.execPath, [SERVER_JS], { env, stdio: 'ignore', detached: false, windowsHide: true });
    const h = new ServerHandle(proc, dataDir);
    const v = await httpJson(APP_BASE, '/api/version', 40, 250);
    if(!v) throw new Error('flowtask_server.js 未能在 /api/version 响应' + (h.exited !== null ? '，进程退出 code=' + h.exited : ''));
    return h;
  }
  async stop(){
    if(this.proc && this.proc.exitCode === null){ killPid(this.proc.pid); for(let i = 0; i < 20 && this.proc.exitCode === null; i++) await sleep(100); }
    try{ fs.rmSync(this.dataDir, { recursive: true, force: true }); }catch(e){}
  }
}

/* ================= 真实数据文件保护与取证 ================= */
function statDataFile(){
  try{ const s = fs.statSync(REAL_DATA); return { exists: true, size: s.size, mtimeMs: s.mtimeMs }; }
  catch(e){ return { exists: false }; }
}
function reportDataFile(before){
  const after = statDataFile();
  const untouched = before.exists === after.exists && (!before.exists || (before.size === after.size && before.mtimeMs === after.mtimeMs));
  const tag = untouched ? 'UNCHANGED' : 'MODIFIED!';
  console.log(`  INFO  flowtask_data.json 保护策略: FLOWTASK_DATA_DIR 重定向至临时目录（本次运行不读写真实文件）`);
  console.log(`  INFO  校验 [${tag}] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  if(!untouched) console.log('  WARN  真实数据文件发生了变化！请检查 backups/ 与运行日志。');
  return untouched;
}

/* ================= 运行器 ================= */
async function runSuite(){
  console.log('\n== E2E（Edge + CDP · FlowTask） ==');
  /* --grep 只跑名字命中的场景（调试定位用；全量门禁不加此参数）。逗号分隔可命中多个 */
  const greps = FLAGS.grep ? FLAGS.grep.split(',').map(s => s.trim()).filter(Boolean) : [];
  const runList = greps.length ? SUITE.filter(item => greps.some(g => item.name.indexOf(g) >= 0)) : SUITE;
  if(greps.length) console.log(`  INFO  --grep "${FLAGS.grep}" 命中 ${runList.length}/${SUITE.length} 个场景`);
  for(const item of runList){
    ACTIVE_PAGE = item.page || ACTIVE_PAGE;
    try{
      await item.fn();
      PASSED++; console.log('  PASS  ' + item.name);
    }catch(e){
      FAILED++;
      console.log('  FAIL  ' + item.name);
      console.log('        ' + String(e && e.message || e).split('\n').join('\n        '));
      const tail = tailConsole();
      if(tail) console.log(tail);
    }
  }
  console.log(`\n== 结果：${PASSED} 通过，${FAILED} 失败 ==`);
  if(FAILED) process.exitCode = 1;
}

async function printAllConsole(browser){
  if(!FLAGS.dumpConsole) return;
  console.log('\n== console / 异常全量 ==');
  for(const p of browser.pages){
    console.log(`-- ${p.url || '(blank)'} target=${p.targetId.slice(0, 8)}`);
    for(const l of p.logs) console.log('   ' + l);
    for(const l of p.errors) console.log('   ERR ' + l);
  }
}

/* ================= selftest ================= */
async function selftest(){
  console.log('== 环境自检 ==');
  let bad = 0;
  const chk = async (name, fn) => {
    try{ const note = await fn(); console.log('  PASS  ' + name + (note ? '  [' + note + ']' : '')); }
    catch(e){ bad++; console.log('  FAIL  ' + name + '  [' + (e && e.message) + ']'); }
  };
  await chk('Node 版本 >= 22（内建 fetch/WebSocket）', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if(major < 22) throw new Error('当前 ' + process.version);
    return process.version + ' @ ' + process.execPath;
  });
  const edge = findEdge();
  await chk('Edge 可执行文件存在', () => { if(!edge) throw new Error('未找到: ' + EDGE_CANDIDATES.join(' | ')); return edge; });
  await chk('flowtask_server.js 存在', () => { if(!fs.existsSync(SERVER_JS)) throw new Error(SERVER_JS); return 'ok'; });
  await chk('真实数据文件状态', () => JSON.stringify(statDataFile()));
  let browser = null, profileDir = null;
  try{
    await chk('空闲端口分配', () => freePort().then(p => { if(!(p > 0)) throw new Error('无端口'); return String(p); }));
    const cdp = await freePort();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtask-selftest-edge-'));
    browser = new Browser(edge, profileDir, cdp, false);
    await chk('Edge 无头启动 + /json/version 就绪', async () => {
      await browser.launch();
      return (browser.version && (browser.version.Browser || browser.version.product)) + '';
    });
    await chk('CDP Target/Runtime 往返', async () => {
      const p = await browser.newPage('about:blank');
      const v = await p.evaluate('1+2');
      if(v !== 3) throw new Error('evaluate 返回 ' + v);
      await p.close();
      return 'evaluate=3';
    });
    await chk('5178 端口可用性判定（必要时停止旧 FlowTask 服务实例）', async () => {
      const r = await ensureAppPortFree();
      if(r.killed) return `已停止 ${r.killed} 个旧实例——测完请重新双击「启动存储服务.bat」`;
      return '空闲';
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtask-selftest-data-'));
    let srv = null;
    await chk('存储服务可在 5178 启动（数据目录=临时）', async () => { srv = await ServerHandle.start(dataDir); return APP_BASE + '/api/version'; });
    await chk('页面托管可访问', async () => {
      const r = await httpReq(APP_BASE, 'GET', '/');
      if(r.status !== 200 || !r.text.includes('<html')) throw new Error('status=' + r.status);
      return r.text.length + ' bytes';
    });
    if(srv) await srv.stop();
  }finally{
    if(browser) await browser.shutdown();
    else if(profileDir) try{ fs.rmSync(profileDir, { recursive: true, force: true }); }catch(e){}
  }
  console.log(`\n== 自检结果：${bad === 0 ? '全部通过' : bad + ' 项失败'} ==`);
  if(bad) process.exitCode = 1;
}

/* ================= 冒烟场景（针对当前应用，须全部真实通过） ================= */
/* UX 场景集（独立文件，避免本文件继续膨胀） */
const defineUxScenarios = require('./flowtask_e2e_ux.js');
function defineSmokeScenarios(getPage){
  t('E2E-1 页面加载：#auth-page 可见且登录表单存在', async () => {
    const page = getPage();
    assertTruthy(await page.evaluate(`(() => {
      const ap = document.getElementById('auth-page');
      const form = document.getElementById('login-form');
      return !!ap && getComputedStyle(ap).display !== 'none' && !!form
        && !!document.getElementById('li-username') && !!document.getElementById('li-password')
        && !!form.querySelector('button[type=submit]');
    })()`), '登录页应可见且含用户名/密码/提交按钮');
    assertMatch(String(await page.evaluate('document.title')), /./, 'title 非空');
  });

  t('E2E-2 登录 admin/admin123 进入应用壳（#sidebar 且有导航项）', async () => {
    const page = getPage();
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.click('#login-form button[type=submit]');
    // PBKDF2 十万次迭代：给足 30s
    await page.waitFor(`document.getElementById('app').classList.contains('on') && getComputedStyle(document.getElementById('auth-page')).display === 'none'`,
      { timeout: 30000, name: '登录进入主界面' });
    assertTruthy(await page.evaluate(`!!document.querySelector('#sidebar')`), '#sidebar 应存在');
    const navCount = await page.evaluate(`document.querySelectorAll('#sidebar [data-nav]').length`);
    assertTruthy(Number(navCount) >= 1, '侧栏导航项 >= 1，实际 ' + navCount);
  });

  t('E2E-3 存储指示条报告文件存储模式（SVC_MODE / 文件存储）', async () => {
    const page = getPage();
    await page.waitFor(`(() => { const el = document.getElementById('store-status');
      return (typeof SVC_MODE !== 'undefined' && SVC_MODE === true) || (!!el && el.textContent.includes('文件存储')); })()`,
      { timeout: 15000, name: '等待文件存储模式生效' });
    const info = await page.evaluate(`(() => ({ svc: typeof SVC_MODE !== 'undefined' ? SVC_MODE : null, text: document.getElementById('store-status').textContent.trim() }))()`);
    assertTruthy(info.svc === true || info.text.includes('文件存储'), `SVC_MODE=${info.svc} #store-status="${info.text}"`);
  });

  t('E2E-4 哈希路由 #/project/<pid>/list 渲染列表视图', async () => {
    const page = getPage();
    const pid = await page.evaluate(`(() => { const p = (DB.projects || []).find(x => !x.archived) || (DB.projects || [])[0]; return p ? p.id : null; })()`);
    assertTruthy(pid, '应能取到首个可见项目 id（当前用户可见项目数：' + await page.evaluate(`(DB.projects || []).length`) + '）');
    await page.evaluate(`nav('#/project/' + ${JSON.stringify(String(pid))} + '/list')`);
    await page.waitFor(`(() => { const h = location.hash, tab = document.querySelector('.view-tab.active'), body = document.getElementById('proj-body');
      return h.indexOf('/list') !== -1 && !!tab && tab.textContent.includes('列表') && !!body && body.querySelectorAll('.task-row').length > 0; })()`,
      { timeout: 10000, name: '列表视图渲染' });
    const rows = await page.evaluate(`document.querySelectorAll('#proj-body .task-row').length`);
    assertTruthy(Number(rows) >= 1, '列表视图应有任务行，实际 ' + rows);
  });

  t('E2E-5 登录后首页截图写入 e2e-shots/', async () => {
    const page = getPage();
    await page.setViewport(1440, 900);
    await page.evaluate(`nav('#/')`);
    await page.waitFor(`!!document.querySelector('#sidebar [data-nav]')`, { timeout: 8000, name: '首页渲染' });
    await sleep(300);
    const file = await page.screenshot('home-logged-in');
    const st = fs.statSync(file);
    assertTruthy(st.size > 20000, '截图应为有效 PNG（>20KB），实际 ' + st.size + 'B: ' + file);
  });
}

/* ================= 主流程 ================= */
(async () => {
  if(FLAGS.selftest){ await selftest(); return; }

  const edge = findEdge();
  if(!edge){ console.error('未找到 Edge，可设置 FLOWTASK_EDGE 指定 msedge.exe 路径。候选: ' + EDGE_CANDIDATES.join(' | ')); process.exit(2); }

  const dataBefore = statDataFile();
  let browser = null, srv = null, page = null;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtask-e2e-edge-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtask-e2e-data-'));
  let portMsg = '';

  const cleanup = async () => {
    if(FLAGS.keep){
      console.log('\n  --keep 模式：保留浏览器与服务。');
      console.log('  CDP 调试页: http://127.0.0.1:' + (browser && browser.cdpPort) + '/json/list');
      console.log('  应用地址  : ' + APP_BASE);
      console.log('  浏览器临时配置目录: ' + profileDir);
      console.log('  数据临时目录      : ' + dataDir);
      return;
    }
    if(browser){ try{ await browser.shutdown(); }catch(e){} }
    if(srv){ try{ await srv.stop(); }catch(e){} }
    else { try{ fs.rmSync(dataDir, { recursive: true, force: true }); }catch(e){} }
  };
  let cleaning = false;
  const onceCleanup = async () => { if(cleaning) return; cleaning = true; await cleanup(); };

  process.on('SIGINT', async () => { await onceCleanup(); process.exit(130); });
  process.on('uncaughtException', async e => { console.error('未捕获异常:', e); await onceCleanup(); process.exit(1); });
  process.on('exit', () => { if(!FLAGS.keep && !cleaning && browser && browser.proc && browser.proc.exitCode === null){ killPid(browser.proc.pid); } if(!FLAGS.keep && !cleaning){ try{ fs.rmSync(profileDir, { recursive: true, force: true }); }catch(e){} } });

  try{
    const portInfo = await ensureAppPortFree();
    if(portInfo.killed) portMsg = `（已停止 ${portInfo.killed} 个原有 FlowTask 服务实例，测完请重新启动「启动存储服务.bat」）`;
    srv = await ServerHandle.start(dataDir);

    const cdpPort = await freePort();
    browser = new Browser(edge, profileDir, cdpPort, FLAGS.headed);
    await browser.launch();
    console.log('  环境: Edge ' + (browser.version.Browser || browser.version.product) + ' · Node ' + process.version + ' · CDP 端口 ' + cdpPort + (FLAGS.headed ? ' · 有头模式' : ''));

    page = await browser.newPage(APP_BASE + '/');
    ACTIVE_PAGE = page;
    await page.waitFor(`!!document.getElementById('auth-page') && document.readyState === 'complete'`, { timeout: 20000, name: '初始页面加载' });

    defineSmokeScenarios(() => page);
    /* loginAs：多账户场景共用的稳定登录封装（真实点击 + 落点取证 + requestSubmit 兜底） */
    const ctx = { t, assertTruthy, assertEq, assertMatch, getPage: () => page,
      getBrowser: () => browser, getBase: () => APP_BASE, loginAs: makeLoginAs(() => page) };
    defineUxScenarios(ctx);
    /* 第二批 UX 场景（独立文件，避免单文件过长）：活动折叠 / 滚动位置 / 默认项目 */
    require('./flowtask_e2e_ux2.js')(ctx);
    await runSuite();
    await printAllConsole(browser);
  }catch(e){
    FAILED++;
    console.log('  FAIL  骨架启动异常');
    console.log('        ' + (e && e.stack || e));
    process.exitCode = 1;
  }finally{
    await onceCleanup();
    if(portMsg) console.log('  INFO  ' + portMsg);
    reportDataFile(dataBefore);
    if(FLAGS.keep) process.exit(FAILED ? 1 : (process.exitCode || 0));   // keep 模式：故意泄漏事件循环句柄，强制退出让子进程存活
  }
})();
