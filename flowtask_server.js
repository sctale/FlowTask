/*
 * FlowTask 本地文件存储服务（零依赖，仅用 Node 内置模块）
 * ------------------------------------------------
 * v1.5 数据分区与账户会话：
 *   - 三份物理数据文件，全部 .json（公司电脑只放行 json/md/html/db 类文件）
 *       flowtask_auth.json        账户表（注册表，全员共用一份）
 *       flowtask_data_<uid>.json  个人库（每个账户一份，彼此物理隔离）
 *       flowtask_shared.json      共享库（被设为「团队共享」的项目）
 *   - HMAC 会话令牌：登录/注册后由服务端签发，7 天有效；
 *     读写个人库/共享库必须携带有效会话，未登录返回 401
 *   - v1.6 会话可信：签发会话必须携带密码证明（客户端按 /api/auth-challenge
 *     返回的盐与算法算出 PBKDF2 结果），服务端常量时间比对 passHash；
 *     账户表读取脱敏（不再下发 salt/passHash），写入按字段级守卫防整表覆盖
 *   - v1.6 写盘可信：写失败回 500 且不推进版本；版本在排队前同步推进，
 *     并发写不再出现「都回 200、后写者覆盖」的窗口；读错误(ENOENT 之外)回 500
 *   - 假冲突修复：同版本号 + 内容一致 → 幂等 200（不再 409）；
 *     只有"同版本但内容确实不同"才是真冲突 → 409
 *   - /api/ping 探活端点（免鉴权），供启动脚本判断服务是否就绪
 *   - 兼容期：不带 file 参数时仍走旧版 flowtask_data.json（令牌即可），便于分阶段迁移
 *
 * 接口：
 *   GET    /api/ping                       -> { ok, version, ready }
 *   GET    /api/token                      -> 发放页面令牌（仅可信来源）
 *   GET    /api/version?file=              -> 该文件的当前版本号
 *   GET    /api/db?file=                   -> 读数据（无文件/已隔离返回 204）
 *   POST   /api/db?file=                   -> 写数据（鉴权 + 版本校验 + 幂等 + 原子替换 + 备份轮转）
 *   POST   /api/db-conflict?file=          -> 保存冲突副本，返回文件名
 *   GET    /api/auth-challenge?username=   -> 登录挑战（返回 uid/salt/算法，不含哈希）
 *   POST   /api/session                    -> 用 uid + 密码证明换会话令牌
 *   POST   /api/changepw                   -> 本人改密码（需会话 + 旧密码证明）
 *   GET    /api/session                    -> 校验当前会话是否仍有效
 *   GET    /api/sync                       -> 共享盘同步状态（未配置时 enabled:false）
 *   POST   /api/sync                       -> 手动「立即同步」（双向，按 rev 定胜负）
 *   GET    /                               -> 打开 FlowTask 页面（自动注入令牌）
 *
 * 启动：双击「启动 FlowTask.vbs」，或 node flowtask_server.js
 * 测试：环境变量 FLOWTASK_PORT / FLOWTASK_HOST / FLOWTASK_DATA_DIR 可覆盖
 * 共享盘：FLOWTASK_SHARE_DIR 指向 \\server\share\FlowTask 即开启「本地优先 + 后台同步」；
 *         不设置就是纯本机模式。同步规则见 flowtask_sync.js 顶部注释。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.FLOWTASK_PORT) || 5178;
const HOST = process.env.FLOWTASK_HOST || '127.0.0.1';
const DATA_DIR = process.env.FLOWTASK_DATA_DIR || __dirname;

/* 配置文件 flowtask_config.json（与数据目录同处，跟着文件夹一起拷走）：
   让不开命令行、不知道环境变量怎么设的人也能开启共享盘同步，界面里也能改。
   优先级：环境变量 > 配置文件 > 默认（纯本机）。
   形如 { "shareDir": "\\\\server\\share\\FlowTask", "syncEnabled": true, "openRegistration": false }
   读 DATA_DIR 而不是程序目录，是为了让测试把 DATA_DIR 重定向到临时目录时
   自动看不到真机的配置——否则跑一次回归就会往生产共享盘写测试数据。 */
const CONFIG_FILE = path.join(DATA_DIR, 'flowtask_config.json');
function readConfigFile(){
  try{
    if(!fs.existsSync(CONFIG_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  }catch(e){
    console.log('⚠️ flowtask_config.json 读不懂，本次按纯本机模式启动：' + ((e && e.message) || e));
    return {};
  }
}
let CONFIG = readConfigFile();
/* 只覆盖白名单键，其它内容原样保留（用户可能手工加了备注字段） */
function writeConfigFile(patch){
  const merged = Object.assign({}, CONFIG, patch);
  const text = JSON.stringify(merged, null, 2) + '\n';
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);       // 与数据文件同一套原子替换
  CONFIG = merged;
  return merged;
}
/* 共享盘同步（本地优先）：不配置就是完全关闭，服务端行为与没有这套机制时一致 */
const SHARE_DIR = String(process.env.FLOWTASK_SHARE_DIR ||
  (CONFIG.syncEnabled === false ? '' : (CONFIG.shareDir || ''))).trim();
/* v2.1：桌面版（Tauri sidecar）把 HTML 打进安装包资源目录，用 FLOWTASK_HTML 指过来；
   直接 node 跑时仍按老行为从脚本同目录取——两条路径共用同一份服务端代码 */
const HTML_FILE = process.env.FLOWTASK_HTML || path.join(__dirname, 'FlowTask_本地项目管理平台.html');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SECRET_FILE = path.join(DATA_DIR, 'flowtask_secret.json');
const AUTH_FILE = path.join(DATA_DIR, 'flowtask_auth.json');

const VERSION = '2.1.3';
const TOKEN = crypto.randomBytes(16).toString('hex');
const ALLOWED_ORIGINS = new Set(['http://' + HOST + ':' + PORT, 'null']);
const BODY_LIMIT = 8 * 1024 * 1024;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const BACKUP_KEEP = 40;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;      // 记住 7 天

/* 文件名白名单：只允许这三类，杜绝路径穿越 */
const FILE_RE = /^flowtask_(auth|shared|data_[a-z0-9_\-]{1,64})\.json$/;
const LEGACY_NAME = 'flowtask_data.json';

function fileOf(name){ return path.join(DATA_DIR, name); }
function isAuthFile(name){ return name === 'flowtask_auth.json'; }
function shapeOk(name, obj){
  if(!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if(isAuthFile(name)) return Array.isArray(obj.users);
  return Array.isArray(obj.projects) && Array.isArray(obj.tasks);
}

/* ---------- 会话签名（服务端私有密钥，重启后旧会话仍然有效） ---------- */
let SECRET = null;
function secret(){
  if(SECRET) return SECRET;
  try{
    const j = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    if(j && typeof j.secret === 'string' && j.secret.length >= 32){ SECRET = j.secret; return SECRET; }
  }catch(e){}
  SECRET = crypto.randomBytes(24).toString('hex');
  try{ fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret: SECRET, createdAt: Date.now() }, null, 2), 'utf8'); }
  catch(e){ /* 写不进去就用内存密钥：重启后会话失效，功能不受影响 */ }
  return SECRET;
}
function sign(uidVal, exp){
  return crypto.createHmac('sha256', secret()).update(uidVal + '|' + exp).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function issueSession(uidVal){
  const exp = Date.now() + SESSION_TTL_MS;
  return { session: uidVal + '.' + exp + '.' + sign(uidVal, exp), exp };
}
/* 返回 uid 字符串；无效/过期返回 null */
function verifySession(tok){
  if(typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if(parts.length !== 3) return null;
  const uidVal = parts[0], exp = Number(parts[1]), sig = parts[2];
  /* 与 FILE_RE 同口径（不含大写）：旧版带 /i 会签出「会话合法但个人库文件名被 FILE_RE 拒绝」
     的死角；账户 id 一律小写（前端 toString(36) 生成），在写入侧校验格式后这里无需放宽 */
  if(!uidVal || !/^[a-z0-9_\-]{1,64}$/.test(uidVal)) return null;
  if(!exp || exp < Date.now()) return null;
  const want = sign(uidVal, exp);
  const a = Buffer.from(sig), b = Buffer.from(want);
  if(a.length !== b.length) return null;
  if(!crypto.timingSafeEqual(a, b)) return null;
  return uidVal;
}
/* 个人库文件名由会话里的 uid 决定，前端不能指定别人的文件 */
function personalFile(uidVal){ return 'flowtask_data_' + uidVal + '.json'; }

/* ---------- 登录失败限速（与 PowerShell 版对等） ----------
   key = uid + 来源 IP；连续失败 5 次起指数退避（1s/2s/4s…封顶 60s），成功即清零。 */
const loginFails = new Map();   // key -> { n, until }
function loginThrottled(key){
  const s = loginFails.get(key);
  return (s && s.until > Date.now()) ? (s.until - Date.now()) : 0;
}
function loginFailNote(key){
  const s = loginFails.get(key) || { n: 0, until: 0 };
  s.n++;
  if(s.n >= 5) s.until = Date.now() + Math.min(60000, 1000 * Math.pow(2, s.n - 5));
  if(loginFails.size > 4096) loginFails.clear();   // 防无界增长（撞库者轮换 key 时）
  loginFails.set(key, s);
}
function loginOkNote(key){ loginFails.delete(key); }

/* ---------- 通用工具 ---------- */
function tsTag(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function corsHeaders(req, extra){
  const h = Object.assign({}, extra || {});
  const o = req.headers['origin'] || '';
  if(ALLOWED_ORIGINS.has(o)){ h['Access-Control-Allow-Origin'] = o; h['Vary'] = 'Origin'; }
  h['X-Content-Type-Options'] = 'nosniff';
  return h;
}
function send(res, req, code, body, headers){ res.writeHead(code, corsHeaders(req, headers)); res.end(body); }
function sendJson(res, req, code, obj){
  send(res, req, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readBody(req, res, onBody){
  let chunks = [], size = 0, done = false;
  /* P1-4：保证 onBody / 超限响应 / 错误响应三者只有一个真正发生 */
  const once = fn => { if(done) return; done = true; fn(); };
  req.on('data', c => {
    if(done) return;
    size += c.length;
    if(size > BODY_LIMIT){
      /* P1-4：超限必须显式回 413，不能只 destroy 让客户端悬挂。
         D-4：回 413 后不要立刻 req.destroy()——RST 可能先于客户端读取 413 到达（表现为 ECONNRESET）。
         改为 resume() 排空并丢弃剩余请求体，待请求体读完(end)或连接关闭后再收尾，客户端可稳定读到 413 */
      once(() => {
        sendJson(res, req, 413, { ok:false, err:'too large' });
        const finish = () => { try{ req.destroy(); }catch(e){} };
        try{ req.resume(); }catch(e){}
        req.on('end', finish);
        req.on('close', finish);
        req.on('aborted', finish);
      });
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => once(() => onBody(Buffer.concat(chunks).toString('utf8'))));
  /* 请求体读取出错（连接中断等）也要收尾并给出响应，避免请求悬挂 */
  req.on('error', e => {
    console.log('⚠️ 读取请求体失败：' + ((e && e.message) || e));
    once(() => { try{ sendJson(res, req, 400, { ok:false, err:'bad request' }); }catch(_e){} req.destroy(); });
  });
}

/* ---------- 每个文件的版本与内容指纹 ---------- */
const state = new Map();     // name -> { rev, hash, lastBackupAt }
function hashOf(text){ return crypto.createHash('sha1').update(text).digest('hex'); }
function loadState(name){
  if(state.has(name)) return state.get(name);
  const st = { rev: 0, hash: '', lastBackupAt: 0 };
  try{
    const raw = fs.readFileSync(fileOf(name), 'utf8');
    st.hash = hashOf(raw);
    const j = JSON.parse(raw);
    st.rev = (j && j.meta && Number(j.meta.rev)) || 0;
  }catch(e){ /* 文件还不存在 */ }
  state.set(name, st);
  return st;
}
/* 共享盘同步：拉取会改写本地文件，必须让 loadState 缓存作废，
   否则服务端拿旧指纹比对，会产生假冲突或漏判真冲突 */
const SYNC = require('./flowtask_sync').create({
  shareDir: SHARE_DIR,
  dataDir: DATA_DIR,
  log: msg => console.log(msg),
  onLocalChanged: name => { state.delete(name); }
});
/* 界面看到的同步配置。envOverride 必须报出来：环境变量优先级高于配置文件，
   否则用户在界面里改了路径、重启后被环境变量顶回去，还以为自己配置丢了。
   shareDir = 用户配的是什么（意图，关同步也留着，便于再开）；
   activeShareDir = 此刻真正在用的（停用状态下为空）——两者混成一个值，
   界面就会在停用后把长路径从输入框里抹掉，逼人重敲。 */
function openRegistrationAllowed(){ return CONFIG.openRegistration === true; }
function publicConfig(){
  return {
    shareDir: String(CONFIG.shareDir || SYNC.shareDir || ''),
    activeShareDir: SYNC.shareDir,
    syncEnabled: SYNC.enabled,
    openRegistration: openRegistrationAllowed(),
    envOverride: !!String(process.env.FLOWTASK_SHARE_DIR || '').trim()
  };
}
function rotateBackup(name, st, cb){
  const f = fileOf(name);
  fs.stat(f, (err) => {
    if(err){ cb(); return; }
    const now = Date.now();
    if(now - st.lastBackupAt < BACKUP_INTERVAL_MS){ cb(); return; }
    st.lastBackupAt = now;
    fs.mkdir(BACKUP_DIR, { recursive: true }, (merr) => {
      /* P1-12：备份失败不再静默——至少留下日志线索（此前 mkdir/copyFile 回调完全忽略 err） */
      if(merr) console.log('⚠️ 备份目录创建失败：' + merr.message);
      fs.copyFile(f, path.join(BACKUP_DIR, name.replace(/\.json$/, '') + '_' + tsTag() + '.json'), (cerr) => {
        if(cerr) console.log('⚠️ 备份复制失败：' + cerr.message);
        fs.readdir(BACKUP_DIR, (e, files) => {
          if(!e){
            /* 轮转必须按「完整文件名 + 时间戳」匹配，不能用裸前缀：
               flowtask_data_ 也是每个个人库备份（flowtask_data_<uid>_时间戳.json）的前缀，
               裸 startsWith 会把别的账户的备份当成旧版单文件的备份删掉 */
            const stem = name.replace(/\.json$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tsRe = new RegExp('^' + stem + '_\\d{8}_\\d{6}\\.json$');
            const backs = files.filter(x => tsRe.test(x)).sort();
            while(backs.length > BACKUP_KEEP){ fs.unlink(path.join(BACKUP_DIR, backs.shift()), (uerr) => { if(uerr) console.log('⚠️ 备份清理失败：' + uerr.message); }); }
          }
          cb();
        });
      });
    });
  });
}
let saveQueue = Promise.resolve();
/* 原子写：失败必须把错误交回调用方（此前 err 被吞掉、照样回 200「已保存」，
   且版本/指纹照常推进，客户端从此永远不再真正重写这份文件） */
function atomicWrite(name, text, then){
  const f = fileOf(name), tmp = f + '.tmp';
  saveQueue = saveQueue.then(() => new Promise(resolve => {
    fs.writeFile(tmp, text, 'utf8', werr => {
      if(werr){ resolve({ ok:false, err:werr }); return; }
      fs.rename(tmp, f, rerr => resolve(rerr ? { ok:false, err:rerr } : { ok:true }));
    });
  })).then(r => then(r)).catch(e => then({ ok:false, err:e }));
}

/* 必须定义在模块级：authed() 也是模块级函数，放在请求处理器内部它作用域够不到，
   上次就是因此抛 ReferenceError 直接把进程打崩（前端只看到"连接被重置"）。 */
/* ---------- 账户删除的三道硬约束 ----------
   ① 个人库文件绝不 unlink：改名成 deleted_… 留底，误删还能捞回来；
   ② 写入 tombstone（auth.deleted）：只把账户从 users 里摘掉是不够的——
      已签发的会话是 HMAC 自证的，不查表，被删的人仍能继续读写自己的库；
   ③ 只走专用端点：删人的动作不放进「整表回写」里，否则一张过期标签页
      把少了某行的表推上来，就等于误删。 */
/* 账户表带缓存读：每个鉴权请求都要查一次 tombstone，旧版每次全表 readFileSync+parse。
   失效条件：mtime/大小变化（覆盖 sync 拉回与外部改动）+ 1 秒 TTL 兜底；
   写路径（writeAuthObjWithRev / /api/db 账户表回写）主动作废。
   语义与直读一致：只有 ENOENT 算空表，其它错误照抛（fail-closed）。 */
let _authCache = null;
function readAuthObj(){
  let st = null;
  try{ st = fs.statSync(AUTH_FILE); }
  catch(e){
    _authCache = null;
    if(e && e.code === 'ENOENT') return { users: [], deleted: [] };
    throw e;
  }
  const now = Date.now();
  if(_authCache && _authCache.mtimeMs === st.mtimeMs && _authCache.size === st.size && (now - _authCache.at) < 1000) return _authCache.obj;
  const obj = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));   // 损坏/瞬时读错 → 抛出，由调用方 fail-closed
  _authCache = { mtimeMs: st.mtimeMs, size: st.size, at: now, obj };
  return obj;
}
function isDeletedUid(uidVal){
  let a;
  try{ a = readAuthObj(); }
  catch(e){ return true; }   // fail-closed：读不了 tombstone 时不能放行（宁可 401 让客户端重试）
  return (Array.isArray(a.deleted) ? a.deleted : []).some(d => d && String(d.uid) === String(uidVal));
}
/* 专用端点（改密 / 重置密码 / 删号）自己改账户表的统一落盘。
   关键：文件里的 meta.rev 必须和服务端记账一起推进。此前只写 st.rev += 1 而文件里的 rev 原地不动，
   客户端 GET 到的 rev 就永远比记账小 1，整表回写必然 409，重试也永远追不上——
   「管理员建号后成员列表刷不出新账户」就是这么来的（v1.10 修）。
   写盘失败时直接抛出，记账不动，由调用方决定回滚（删号那条要把留底改回原名）。 */
function writeAuthObjWithRev(auth){
  const st = loadState('flowtask_auth.json');
  const next = (Number(st.rev) || 0) + 1;
  auth.meta = auth.meta || {};
  auth.meta.rev = next;
  const storeText = JSON.stringify(auth, null, 2);
  /* 账户表是全系统最不能坏的文件：与 /api/db 同一套 tmp+rename 原子替换。
     旧版直写最终路径，进程在写入中途被杀会截断账户表，而损坏的表在旧 readAuthObj
     里会被当成空表 → 两个缺陷叠加就是全员账户丢失 */
  const tmpAuth = AUTH_FILE + '.tmp';
  fs.writeFileSync(tmpAuth, storeText, 'utf8');
  fs.renameSync(tmpAuth, AUTH_FILE);
  _authCache = null;   // 刚写的表必须立刻可见（mtime 粒度可能撞在同一毫秒）
  st.rev = next; st.hash = hashOf(storeText);
  SYNC.schedulePush('flowtask_auth.json');   // 账户表变更同样要镜像到共享盘
  return { storeText, rev: next };
}

/* ---------- 鉴权判定 ---------- */
function authed(req, res, name, uidVal){
  // 返回 { ok, uid }；已发 401/403 时 ok=false
  if(req.headers['x-flowtask-token'] !== TOKEN){
    sendJson(res, req, 403, { ok:false, err:'forbidden' });
    return { ok:false };
  }
  if(name === LEGACY_NAME) return { ok:true, uid:null };      // 兼容期：旧单文件仍只需令牌
  if(isAuthFile(name)) return { ok:true, uid:null };          // 账户表：注册/登录需要能读写
  const sid = verifySession(req.headers['x-flowtask-session']);
  /* 被删除的账户即使手里还有未过期会话也必须立刻失效：
     会话是 HMAC 自证的、不查账户表，不挡这道就会让"删了人还能继续写他的库"。
     注意返回 ok:false 前一定要先把响应发出去，否则调用方会等一个永不存在的响应 */
  if(sid && isDeletedUid(sid)){
    sendJson(res, req, 401, { ok:false, err:'unauthorized' });
    return { ok:false };
  }
  if(!sid){ sendJson(res, req, 401, { ok:false, err:'unauthorized' }); return { ok:false }; }
  if(name !== personalFile(sid) && name !== 'flowtask_shared.json'){
    sendJson(res, req, 403, { ok:false, err:'forbidden_file' }); return { ok:false };
  }
  return { ok:true, uid:sid };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  /* 同源 GET 请求浏览器不携带 Origin 头：缺 Origin = 同源，放行；
     带了 Origin 但不在白名单（file:// 的 'null' 也在白名单）才拒绝 */
  const originOk = !req.headers['origin'] || ALLOWED_ORIGINS.has(req.headers['origin']);

  if(req.method === 'OPTIONS'){
    send(res, req, 204, '', {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-FlowTask-Token, X-FlowTask-Rev, X-FlowTask-Session',
      'Access-Control-Max-Age': '600',
    });
    return;
  }

  /* ---- 探活（免鉴权，供启动脚本判断服务就绪） ---- */
  if(req.method === 'GET' && url.pathname === '/api/ping'){
    /* openRegistration 走免鉴权的 ping 下发：登录页要在登录前就知道该不该显示注册入口。
       这里只是"界面少露一个必然失败的入口"，真正的约束在 guardAuthWrite，绕过界面也建不了号 */
    sendJson(res, req, 200, { ok:true, app:'FlowTask', version: VERSION, ready:true, ts:Date.now(),
      openRegistration: openRegistrationAllowed() });
    return;
  }

  if(req.method === 'GET' && url.pathname === '/api/token'){
    /* 令牌发放保持严格：托管页面的令牌是注入的，file:// 页面会带 Origin:null；
       无 Origin 的请求仍拒绝（对等测试有守卫）。挑战端点单独放宽同源无 Origin 的情况 */
    if(!req.headers['origin'] || !ALLOWED_ORIGINS.has(req.headers['origin'])){ send(res, req, 403, 'forbidden'); return; }
    sendJson(res, req, 200, { ok: true, token: TOKEN, version: VERSION });
    return;
  }

  /* ---- 会话签发与校验 ----
     v1.6：签发会话必须携带密码证明（客户端用账户盐算出的 PBKDF2 结果），
     服务端与账户表里的 passHash 做常量时间比对——只凭自报 uid 换会话的口子已封死。
     兼容期：旧格式（s2$/fb$）哈希同样按原文比对（客户端按 challenge 返回的算法算证明）。 */
  if(req.method === 'GET' && url.pathname === '/api/auth-challenge'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    if(!originOk){ sendJson(res, req, 403, { ok:false, err:'forbidden origin' }); return; }
    const uname = String(url.searchParams.get('username') || '').trim().toLowerCase();
    let user = null;
    for(const src of [AUTH_FILE, fileOf(LEGACY_NAME)]){
      try{
        const a = JSON.parse(fs.readFileSync(src, 'utf8'));
        user = (a.users || []).find(u => u && u.username === uname && u.active !== false) || null;
      }catch(e){}
      if(user) break;
    }
    if(!user && SYNC.enabled){
      /* 本机找不到这个账户：很可能是管理员刚在别处建的。先从共享盘补拉一次账户表再认一次，
         否则新机器 / 一直开着的机器都要重启才能登录（而 /api/sync 又需要会话，成了死循环） */
      try{ SYNC.pullAuth(); }catch(e){ console.log('⚠️ 登录前补拉账户表失败：' + ((e && e.message) || e)); }
      try{
        const a2 = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
        user = (a2.users || []).find(u => u && u.username === uname && u.active !== false) || null;
      }catch(e){}
    }
    if(!user){ sendJson(res, req, 404, { ok:false, err:'unknown user' }); return; }
    const algo = typeof user.passHash === 'string' && user.passHash.startsWith('p1$') ? 'p1' : 'legacy';
    sendJson(res, req, 200, { ok:true, uid: user.id, salt: user.salt || '', algo });
    return;
  }
  function safeEqualStr(a, b){
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    if(ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  }
  function findStoredUser(uidVal){
    for(const src of [AUTH_FILE, fileOf(LEGACY_NAME)]){
      try{
        const a = JSON.parse(fs.readFileSync(src, 'utf8'));
        const u = (a.users || []).find(x => x && x.id === uidVal && x.active !== false);
        if(u) return u;
      }catch(e){}
    }
    return null;
  }
  if(req.method === 'POST' && url.pathname === '/api/session'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    readBody(req, res, body => {
      let obj; try{ obj = JSON.parse(body); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      const uidVal = String((obj && obj.uid) || '');
      const verifier = String((obj && obj.verifier) || '');
      if(!/^[a-z0-9_\-]{1,64}$/.test(uidVal)){ sendJson(res, req, 400, { ok:false, err:'bad uid' }); return; }
      if(!verifier){ sendJson(res, req, 400, { ok:false, err:'verifier required' }); return; }
      /* 登录失败限速（v1.10）：按 uid+来源IP 计数，5 次起指数退避（封顶 60s），成功清零。
         局域网部署（FLOWTASK_HOST 非回环）时挡住无限撞库；本机部署几乎不会触发。 */
      const tKey = uidVal + '|' + (req.socket && req.socket.remoteAddress || '?');
      const waitMs = loginThrottled(tKey);
      if(waitMs > 0){ sendJson(res, req, 429, { ok:false, err:'too many failed attempts', retryAfterMs: waitMs }); return; }
      const u = findStoredUser(uidVal);
      if(!u){ loginFailNote(tKey); sendJson(res, req, 404, { ok:false, err:'unknown uid' }); return; }
      if(!safeEqualStr(u.passHash || '', verifier)){ loginFailNote(tKey); sendJson(res, req, 401, { ok:false, err:'bad credentials' }); return; }
      loginOkNote(tKey);
      const s = issueSession(uidVal);
      /* 本地优先：先把这个人的数据从共享盘拉回来（拉不到就照常放行，不卡登录）。
         SMB 一次往返约几十毫秒，只在登录这个低频动作里同步做。 */
      try{ SYNC.loginSync(uidVal); }
      catch(e){ console.log('⚠️ 登录同步异常（已忽略，不影响登录）：' + ((e && e.message) || e)); }
      sendJson(res, req, 200, { ok:true, session: s.session, exp: s.exp, ttlDays: SESSION_TTL_MS / 86400000 });
    });
    return;
  }
  /* 改密码：服务端校验旧密码证明后原地更新账户表（客户端拿到的是脱敏表，无法本地完成这件事） */
  if(req.method === 'POST' && url.pathname === '/api/changepw'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    const sid = verifySession(req.headers['x-flowtask-session']);
    if(!sid){ sendJson(res, req, 401, { ok:false, err:'unauthorized' }); return; }
    readBody(req, res, body => {
      let obj; try{ obj = JSON.parse(body); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      const oldVerifier = String((obj && obj.oldVerifier) || '');
      const newSalt = String((obj && obj.newSalt) || '');
      const newHash = String((obj && obj.newHash) || '');
      if(!oldVerifier || !newSalt || !/^p1\$[0-9a-f]{64}$/.test(newHash)){
        sendJson(res, req, 400, { ok:false, err:'invalid payload' }); return;
      }
      let auth; try{ auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
      catch(e){ sendJson(res, req, 500, { ok:false, err:'auth file unreadable' }); return; }
      const u = (auth.users || []).find(x => x && x.id === sid);
      if(!u){ sendJson(res, req, 404, { ok:false, err:'unknown uid' }); return; }
      if(!safeEqualStr(u.passHash || '', oldVerifier)){ sendJson(res, req, 401, { ok:false, err:'bad credentials' }); return; }
      u.salt = newSalt; u.passHash = newHash;
      u.pwMustChange = false;          // 本人改过密，首登改密提示就该消失
      /* P1-6：写盘与指纹基于同一份文本；rev 由 writeAuthObjWithRev 统一推进（记账与文件一致） */
      try{ writeAuthObjWithRev(auth); }
      catch(e){ sendJson(res, req, 500, { ok:false, err:'save failed' }); return; }
      sendJson(res, req, 200, { ok:true });
    });
    return;
  }

  /* ---- 删除账户（仅管理员；不可逆，故强制留底） ---- */
  if(req.method === 'POST' && url.pathname === '/api/delete-user'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    const sidD = verifySession(req.headers['x-flowtask-session']);
    if(!sidD){ sendJson(res, req, 401, { ok:false, err:'unauthorized' }); return; }
    const meD = findStoredUser(sidD);
    if(!meD || meD.role !== 'admin'){ sendJson(res, req, 403, { ok:false, err:'只有管理员可以删除账户' }); return; }
    readBody(req, res, body => {
      let obj; try{ obj = JSON.parse(body || '{}'); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      const target = String((obj && obj.uid) || '');
      if(!/^[a-z0-9_\-]{1,64}$/.test(target)){ sendJson(res, req, 400, { ok:false, err:'bad uid' }); return; }
      if(target === sidD){ sendJson(res, req, 400, { ok:false, err:'不能删除自己当前登录的账户，请改用退出登录' }); return; }
      let auth;
      try{ auth = readAuthObj(); }
      catch(e){ sendJson(res, req, 500, { ok:false, err:'auth file unreadable' }); return; }
      const users = Array.isArray(auth.users) ? auth.users : [];
      const victim = users.find(u => u && String(u.id) === target);
      if(!victim){ sendJson(res, req, 404, { ok:false, err:'unknown uid' }); return; }
      /* 删掉最后一个管理员 = 全组失去管理入口（开不了号也重置不了密码），必须挡住 */
      const otherAdmins = users.filter(u => u && String(u.id) !== target && u.role === 'admin' && u.active !== false).length;
      if(victim.role === 'admin' && otherAdmins === 0){
        sendJson(res, req, 400, { ok:false, err:'这是最后一个管理员：请先指定其他管理员再删除' }); return;
      }
      /* 留底：把该账户的个人库改名保存，绝不当场删除（磁盘被占用就让本次删除失败，别硬来） */
      let preserved = '';
      const personal = fileOf(personalFile(target));
      if(fs.existsSync(personal)){
        preserved = 'deleted_' + personalFile(target).replace(/\.json$/, '') + '_' + tsTag() + '.json';
        try{ fs.renameSync(personal, path.join(DATA_DIR, preserved)); }
        catch(e){ sendJson(res, req, 500, { ok:false, err:'backup failed', detail: (e && e.code) || 'rename error' }); return; }
      }
      auth.users = users.filter(u => u && String(u.id) !== target);
      auth.deleted = (Array.isArray(auth.deleted) ? auth.deleted : []).concat([{
        uid: target, username: String(victim.username || ''), name: String(victim.name || ''),
        at: Date.now(), by: sidD
      }]);
      const storeText = (() => { try{ return writeAuthObjWithRev(auth).storeText; }
        catch(e){ return null; } })();
      if(storeText === null){
        /* 账户表没写成：把留底改回原名，避免出现「人还在、数据不见了」 */
        if(preserved){ try{ fs.renameSync(path.join(DATA_DIR, preserved), personal); }catch(_e){} }
        sendJson(res, req, 500, { ok:false, err:'save failed' }); return;
      }
      /* AUTH_NAME 是同步模块里的常量，本文件没有这个名字——写死字面量，
         上次这里抛 ReferenceError 直接把进程打崩（连接被重置，前端只看到"服务没响应"） */
      console.log('ⓘ 管理员 ' + sidD + ' 删除了账户 ' + target +
        (preserved ? '（个人库已留底为 ' + preserved + '）' : ''));
      sendJson(res, req, 200, { ok:true, uid: target, preserved });
    });
    return;
  }

  /* ---- 管理员重置他人密码（仅管理员会话）----
     忘密、离职交接、初始口令没送出去都得有路可走；重置后强制对方首登改密 */
  if(req.method === 'POST' && url.pathname === '/api/resetpw'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    const sidR = verifySession(req.headers['x-flowtask-session']);
    if(!sidR){ sendJson(res, req, 401, { ok:false, err:'unauthorized' }); return; }
    const meR = findStoredUser(sidR);
    if(!meR || meR.role !== 'admin'){ sendJson(res, req, 403, { ok:false, err:'只有管理员可以重置他人密码' }); return; }
    readBody(req, res, body => {
      let obj; try{ obj = JSON.parse(body || '{}'); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      const uidVal = String((obj && obj.uid) || '');
      const newSalt = String((obj && obj.newSalt) || '');
      const newHash = String((obj && obj.newHash) || '');
      if(!/^[a-z0-9_\-]{1,64}$/.test(uidVal)){ sendJson(res, req, 400, { ok:false, err:'bad uid' }); return; }
      if(!newSalt || !/^p1\$[0-9a-f]{64}$/.test(newHash)){ sendJson(res, req, 400, { ok:false, err:'invalid payload' }); return; }
      let auth; try{ auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
      catch(e){ sendJson(res, req, 500, { ok:false, err:'auth file unreadable' }); return; }
      const u = (auth.users || []).find(x => x && x.id === uidVal);
      if(!u){ sendJson(res, req, 404, { ok:false, err:'unknown uid' }); return; }
      u.salt = newSalt; u.passHash = newHash; u.pwMustChange = true;
      try{ writeAuthObjWithRev(auth); }
      catch(e){ sendJson(res, req, 500, { ok:false, err:'save failed' }); return; }
      console.log('ⓘ 管理员 ' + sidR + ' 重置了 ' + uidVal + ' 的密码（下次登录须改密）');
      sendJson(res, req, 200, { ok:true, uid: uidVal, pwMustChange: true });
    });
    return;
  }
  if(req.method === 'GET' && url.pathname === '/api/session'){
    const sid = verifySession(req.headers['x-flowtask-session']);
    sendJson(res, req, sid ? 200 : 401, sid ? { ok:true, uid:sid } : { ok:false, err:'unauthorized' });
    return;
  }

  /* ---- 同步配置读写（仅管理员）：界面里就能改同步文件夹，不必再手改文件重启 ----
     校验不过就退回原路径：留下一个打不开的配置，等于把「已同步」变成假象 */
  if(url.pathname === '/api/sync/config'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    const sidC = verifySession(req.headers['x-flowtask-session']);
    if(!sidC){ sendJson(res, req, 401, { ok:false, err:'unauthorized' }); return; }
    const su = findStoredUser(sidC);
    if(!su || su.role !== 'admin'){ sendJson(res, req, 403, { ok:false, err:'只有管理员可以修改同步设置' }); return; }
    if(req.method === 'GET'){ sendJson(res, req, 200, { ok:true, config: publicConfig(), status: SYNC.status() }); return; }
    if(req.method !== 'POST'){ sendJson(res, req, 405, { ok:false, err:'method not allowed' }); return; }
    readBody(req, res, body => {
      let obj; try{ obj = JSON.parse(body || '{}'); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      if(!obj || typeof obj !== 'object' || Array.isArray(obj)){ sendJson(res, req, 400, { ok:false, err:'invalid payload' }); return; }
      const prevDir = SYNC.shareDir, prevOn = SYNC.enabled;
      const has = k => Object.prototype.hasOwnProperty.call(obj, k);
      /* 关同步时运行时会把路径清空，但配置文件里留着；只传 syncEnabled:true 要能从配置里补回来，
         否则「关掉再打开」会把长 UNC 路径丢掉，用户得重敲 */
      const savedDir = String(CONFIG.shareDir || '').trim();
      const nextDir = has('shareDir') ? String(obj.shareDir || '').trim() : (prevDir || savedDir);
      /* 传了路径就视为要用它；只有显式 syncEnabled:false 才关闭 */
      const nextOn = has('syncEnabled') ? (obj.syncEnabled !== false && !!nextDir) : (!!nextDir && obj.syncEnabled !== false);
      const applied = SYNC.reconfigure(nextDir, nextOn);
      /* validateOnly：只做一次无副作用探测（探针对，随后一律退回原设置、绝不落盘），
         让界面能「先告诉用户路径行不行，再让他确认切换」，而不是确认完才报错 */
      if(obj.validateOnly === true){
        const why = applied.enabled ? applied.blockReason : (nextDir ? '同步已关闭' : '');
        SYNC.reconfigure(prevDir, prevOn);
        sendJson(res, req, why ? 400 : 200, why
          ? { ok:false, err:'share unusable', reason: why }
          : { ok:true, valid:true, shareDir: nextDir });
        return;
      }
      if(applied.enabled && applied.blockReason && obj.force !== true){
        SYNC.reconfigure(prevDir, prevOn);                      // 退回原值，不落盘
        sendJson(res, req, 400, { ok:false, err:'share unusable', reason: applied.blockReason, config: publicConfig() });
        return;
      }
      try{ writeConfigFile({ shareDir: nextDir, syncEnabled: SYNC.enabled }); }
      catch(e){
        SYNC.reconfigure(prevDir, prevOn);
        console.log('⚠️ 同步配置写入失败：' + ((e && e.message) || e));
        sendJson(res, req, 500, { ok:false, err:'config write failed', detail: (e && e.code) || '' });
        return;
      }
      /* 立刻双向同步一次：新位置马上有本机数据，新位置已有的更新也拿回来 */
      let syncResults = null;
      try{ const s = SYNC.syncAll('auto', sidC); syncResults = s && s.results; }
      catch(e){ console.log('⚠️ 切换后的首次同步异常：' + ((e && e.message) || e)); }
      console.log('ⓘ 同步设置已更新：' + (SYNC.enabled ? SYNC.shareDir : '已停用') + '（操作者 ' + sidC + '）');
      sendJson(res, req, 200, { ok:true, config: publicConfig(), status: SYNC.status(), results: syncResults });
    });
    return;
  }

  /* ---- 共享盘同步：状态查询与手动「立即同步」（本地优先，未配置时返回 enabled:false） ---- */
  if(url.pathname === '/api/sync'){
    if(req.headers['x-flowtask-token'] !== TOKEN){ sendJson(res, req, 403, { ok:false, err:'forbidden' }); return; }
    const sid = verifySession(req.headers['x-flowtask-session']);
    if(!sid){ sendJson(res, req, 401, { ok:false, err:'unauthorized' }); return; }
    if(req.method === 'GET'){ sendJson(res, req, 200, { ok:true, enabled: SYNC.enabled, status: SYNC.status() }); return; }
    if(req.method === 'POST'){
      readBody(req, res, body => {
        let obj = {}; try{ obj = JSON.parse(body || '{}'); }catch(e){}
        const mode = obj && obj.mode === 'pull' ? 'pull' : (obj && obj.mode === 'push' ? 'push' : 'auto');
        const out = SYNC.syncAll(mode, sid);
        /* 拉取可能改写了本地文件 → 把「本机版本变了」告诉页面，页面据此重新读库 */
        const changedLocal = (out.results || []).filter(r => r.action === 'pull').map(r => r.name);
        sendJson(res, req, 200, { ok:true, enabled: SYNC.enabled, mode, changedLocal, results: out.results, status: SYNC.status() });
      });
      return;
    }
  }

  /* ---- 解析并校验目标文件名 ---- */
  let name = url.searchParams.get('file') || LEGACY_NAME;
  if(name !== LEGACY_NAME && !FILE_RE.test(name)){ sendJson(res, req, 400, { ok:false, err:'bad file' }); return; }

  if(req.method === 'GET' && url.pathname === '/api/version'){
    sendJson(res, req, 200, { ok: true, rev: loadState(name).rev, file: name });
    return;
  }

  /* 账户表读取脱敏：盐与密码哈希不再下发给任何页面（登录改走 /api/auth-challenge + 证明换会话） */
  function redactAuth(text){
    try{
      const j = JSON.parse(text);
      if(Array.isArray(j.users)) j.users = j.users.map(u => {
        if(!u || typeof u !== 'object') return u;
        const c = Object.assign({}, u); delete c.passHash; delete c.salt; return c;
      });
      return JSON.stringify(j);
    }catch(e){ return text; }
  }

  if(req.method === 'GET' && url.pathname === '/api/db'){
    const a = authed(req, res, name); if(!a.ok) return;
    fs.readFile(fileOf(name), 'utf8', (err, data) => {
      if(err){
        /* 只有「文件不存在」才等于空库；被占用 / 无权限必须报错，
           否则客户端会把「读不到」当成「没有数据」——界面凭空变空、甚至触发迁移/演示注入 */
        if(err.code === 'ENOENT'){ send(res, req, 204, ''); return; }
        console.log('⚠️ 读取失败：' + name + ' → ' + err.message);
        sendJson(res, req, 500, { ok:false, err:'read failed', detail: err.code || 'read error', file: name });
        return;
      }
      let ok = false; try{ ok = shapeOk(name, JSON.parse(data)); }catch(e){ ok = false; }
      if(ok){
        const body = isAuthFile(name) ? redactAuth(data) : data;
        send(res, req, 200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return;
      }
      const q = path.join(DATA_DIR, name.replace(/\.json$/, '') + '_corrupt_' + tsTag() + '.json');
      state.delete(name);
      // 等 rename 真正完成再回应：否则客户端拿到 204 时文件可能还没改名（偶发扑空）
      fs.rename(fileOf(name), q, (rerr) => {
        if(rerr){
          console.log('⚠️ 隔离损坏文件失败：' + rerr.message);
          /* 隔离失败时绝不能谎报「文件不存在」：那份损坏文件是唯一可人工抢救的副本 */
          sendJson(res, req, 500, { ok:false, err:'quarantine failed', detail: rerr.code || 'rename error', file: name });
          return;
        }
        console.log(`⚠️ ${name} 损坏，已自动隔离为 ${path.basename(q)}`);
        send(res, req, 204, '', { 'X-FlowTask-Quarantined': path.basename(q) });
      });
    });
    return;
  }

  if(req.method === 'POST' && url.pathname === '/api/db-conflict'){
    const a = authed(req, res, name); if(!a.ok) return;
    readBody(req, res, body => {
      let obj;
      try{ obj = JSON.parse(body); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      /* G4：冲突副本与 /api/db 同样做形状校验（体积上限已由 readBody 的 BODY_LIMIT 统一把关） */
      if(!shapeOk(name, obj)){ sendJson(res, req, 400, { ok:false, err:'invalid shape' }); return; }
      const f = path.join(DATA_DIR, name.replace(/\.json$/, '') + '_conflict_' + tsTag() + '.json');
      /* P0-2：写盘失败必须回 500，不能无视 err 照回 200「已留底」 */
      fs.writeFile(f, body, 'utf8', (err) => {
        if(err){ console.log('⚠️ 冲突副本写入失败：' + err.message); sendJson(res, req, 500, { ok:false, err:'save failed' }); return; }
        sendJson(res, req, 200, { ok:true, file: path.basename(f) });
      });
    });
    return;
  }

  /* 账户表写入守卫：页面拿到的是脱敏表，直接整片写回可能把别人的哈希/角色/停用状态抹掉，
     甚至用一张只剩自己的表顶掉整个账户表。这里按字段级差异放行/拒绝：
     - 新增用户：允许（自助注册/首启种子/管理员建号），但用户名不得与已有用户重复，角色 admin 仅限引导期或管理员会话
     - 既有用户：username/role/active 变更需管理员会话；salt/passHash 变更仅限「本人会话」或管理员会话
     - 缺失的 salt/passHash 自动用存量值补齐（脱敏表回写的透明兼容）
     - 删除用户 / 表缩水：一律不采纳（补回存量），删人只能走 /api/delete-user */
  function guardAuthWrite(obj, hasSession, sid, isAdminSess){
    let stored;
    try{ stored = readAuthObj(); }
    /* 「读不了」绝不能当成空表继续：那会让一张过期快照顶掉真实账户表（fail-closed 回 500） */
    catch(e){ return { code:500, err:'账户表暂时读不了，请稍后重试' }; }
    const old = Array.isArray(stored.users) ? stored.users : [];
    let inc = Array.isArray(obj.users) ? obj.users : [];
    const oldById = new Map(old.filter(u => u && u.id).map(u => [String(u.id), u]));
    /* 整表回写既不做删除，也不让已删的人复活（v1.10 的「少一行就 403」证伪：
       账户表读取是脱敏的、每个页面手里都可能是一张过期快照，「少一行」绝大多数时候
       只是别人的新账户还没进我的表，判它 403 会让正常的建号操作永远失败在客户端）。
       ① 存量有、请求里没有 → 把存量原样补回去。真要删人请走 /api/delete-user
          （它才会留底个人库、作废会话、写 tombstone）。
       ② 请求里有、但已在 tombstone 里 → 丢掉这一行，否则某张过期标签页一推就把人救回来。 */
    const delIds = new Set(((Array.isArray(stored.deleted) ? stored.deleted : []).filter(d => d && d.uid)).map(d => String(d.uid)));
    const incIds = new Set(inc.filter(u => u && u.id).map(u => String(u.id)));
    for(const u of old){ if(u && u.id && !incIds.has(String(u.id))) inc.push(u); }
    inc = inc.filter(u => u && u.id && !delIds.has(String(u.id)));
    obj.users = inc;
    /* tombstone 同样不能被整表回写洗掉：页面手里那份是脱敏表，多半连 deleted 都没有，
       照原样落盘等于把「谁被删过」全忘了，下一张过期快照就能把人救回来。只并集、不丢弃。 */
    const keptDel = (Array.isArray(stored.deleted) ? stored.deleted : []).filter(d => d && d.uid);
    const seenDel = new Set(keptDel.map(d => String(d.uid)));
    for(const d of (Array.isArray(obj.deleted) ? obj.deleted : [])){
      if(d && d.uid && !seenDel.has(String(d.uid))){ keptDel.push(d); seenDel.add(String(d.uid)); }
    }
    obj.deleted = keptDel;
    const seenName = new Map();
    for(const u of old){ if(u && u.username) seenName.set(String(u.username).toLowerCase(), u.id); }
    for(const u of inc){
      if(!u || typeof u !== 'object' || !u.id) continue;
      const prev = oldById.get(String(u.id));
      if(!prev){
        /* 新账户 id 必须匹配个人库文件名白名单（不含大写）：否则这张表能建出
           "会话合法但个人库读写被 FILE_RE 拒" 的死角账户（v1.10 统一口径） */
        if(!/^[a-z0-9_\-]{1,64}$/.test(String(u.id))){ return { code:400, err:'账户 id 格式不合法' }; }
        const nm = String(u.username || '').toLowerCase();
        if(nm && seenName.has(nm)){ return { code:400, err:'用户名已被使用：' + u.username }; }
        if(u.role === 'admin' && !isAdminSess && old.some(x => x && x.active !== false)){
          return { code:403, err:'只有管理员可以创建管理员账户' };
        }
        /* 账号由管理员开通：没有 admin 会话就不能往账户表里塞新人。
           两个豁免：① 表里还没有任何活跃账户（首启 bootstrap，否则没人能进来开第一个号）；
           ② 配置显式 openRegistration:true。界面藏掉注册入口只是体验，这里才是约束。 */
        const bootstrap = !old.some(x => x && x.active !== false);
        if(!isAdminSess && !openRegistrationAllowed() && !bootstrap){
          return { code:403, err:'账号需由管理员创建（如需开放自助注册，请在数据管理里改设置）' };
        }
        continue;
      }
      /* 脱敏合并语义：请求里缺的字段 = 保持原值，不算变更。
         只有真的带了不同的值、且没有对应权限时才拒绝 */
      const self = hasSession && sid === u.id;
      const eff = Object.assign({}, prev);
      for(const k of Object.keys(u)) if(u[k] !== undefined) eff[k] = u[k];
      if(String(eff.username) !== String(prev.username) && !isAdminSess){
        return { code:403, err:'只有管理员可以修改账户用户名' };
      }
      if(String(eff.role) !== String(prev.role) && !isAdminSess){
        return { code:403, err:'只有管理员可以修改账户角色' };
      }
      if((prev.active !== false) !== (eff.active !== false) && !isAdminSess && !self){
        return { code:403, err:'只有管理员可以停用/恢复账户' };
      }
      const hashChanged = (prev.passHash || '') !== (eff.passHash || '');
      const saltChanged = (prev.salt || '') !== (eff.salt || '');
      if((hashChanged || saltChanged) && !isAdminSess && !self){
        return { code:403, err:'只有本人或管理员可以修改密码' };
      }
      if(hashChanged && !/^p1\$[0-9a-f]{64}$/.test(String(eff.passHash)) && !isAdminSess){
        return { code:400, err:'密码哈希格式不合法' };
      }
      /* 把合并后的完整用户写回请求对象：落盘内容 = 补齐了 salt/passHash 的版本 */
      for(const k of Object.keys(eff)) u[k] = eff[k];
    }
    return { code:0 };
  }

  if(req.method === 'POST' && url.pathname === '/api/db'){
    const a = authed(req, res, name); if(!a.ok) return;
    readBody(req, res, body => {
      let obj;
      try{ obj = JSON.parse(body); }catch(e){ sendJson(res, req, 400, { ok:false, err:'invalid json' }); return; }
      if(!shapeOk(name, obj)){ sendJson(res, req, 400, { ok:false, err:'invalid shape' }); return; }
      let storeText = body;
      if(isAuthFile(name)){
        const sid = verifySession(req.headers['x-flowtask-session']);
        const g = guardAuthWrite(obj, !!sid, sid, !!sid && (() => {
          const u = findStoredUser(sid); return u && u.role === 'admin';
        })());
        if(g.code){ sendJson(res, req, g.code, { ok:false, err: g.err }); return; }
        /* 守卫给缺哈希的账户补回了存量 salt/passHash：落盘必须用补齐后的内容，
           否则脱敏页面的回写会把真实密码哈希整片洗掉 */
        storeText = JSON.stringify(obj);
        _authCache = null;   // 账户表即将被改写，缓存立刻作废
      }
      const st = loadState(name);
      const incRev = Number(req.headers['x-flowtask-rev']) || (obj.meta && Number(obj.meta.rev)) || 0;
      const incHash = hashOf(storeText);
      /* 同版本或更旧：内容一致就是重复提交（幂等成功），内容真的不同才算冲突 */
      if(incRev && st.rev && incRev <= st.rev){
        if(incHash === st.hash){ sendJson(res, req, 200, { ok:true, rev: st.rev, noop:true, file:name }); return; }
        sendJson(res, req, 409, { ok:false, err:'conflict', rev: st.rev, file: name });
        return;
      }
      /* 版本/指纹在排队前同步推进：并发写请求会立刻看到新版本而被判 409/幂等，
         不再出现「两个请求都读到旧版本、后写者静默覆盖」的窗口；写失败则回滚 */
      const prevRev = st.rev, prevHash = st.hash;
      st.rev = incRev || st.rev; st.hash = incHash;
      rotateBackup(name, st, () => {
        atomicWrite(name, storeText, wr => {
          if(!wr || !wr.ok){
            /* 只有记账仍停在「本次推进到的值」才回滚：排队期间若有更新的写入
               已推进 st.rev/st.hash，回滚会把别人的版本一起抹掉，之后携带该版本的
               客户端绕过冲突检测被静默覆盖（v1.10 修） */
            if(st.hash === incHash){ st.rev = prevRev; st.hash = prevHash; }
            console.log('⚠️ 写盘失败：' + name + ' → ' + (wr && wr.err ? wr.err.message : 'unknown'));
            sendJson(res, req, 500, { ok:false, err:'save failed', detail: (wr && wr.err && wr.err.code) || 'write error', file: name });
            return;
          }
          sendJson(res, req, 200, { ok:true, rev: st.rev, file: name });
          /* 本地先落定，再排队往共享盘推（去抖，不阻塞本次响应） */
          SYNC.schedulePush(name);
        });
      });
    });
    return;
  }

  /* ---- 页面托管（注入令牌） ---- */
  if(req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')){
    fs.readFile(HTML_FILE, 'utf8', (err, data) => {
      if(err){ send(res, req, 500, '未找到 FlowTask_本地项目管理平台.html，请与本文件放在同一目录'); return; }
      send(res, req, 200, data.replace(/__FLOWTASK_TOKEN__/g, TOKEN),
        { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    });
    return;
  }

  send(res, req, 404, 'not found');
});

if(require.main === module){
server.listen(PORT, HOST, () => {
  /* 定期拉取定时器由 SYNC 引擎自管（create 时按 enabled 建，reconfigure 热切换时启停），
     不拉的话长开的机器永远看不到同事推上来的改动 */
  /* 先拉后服务：把本机服务过的那些人的数据从共享盘续下来（拉不到就用本地，不阻塞启动） */
  if(SYNC.enabled){
    try{
      const r = SYNC.pullOnBoot();
      const pulled = (r.results || []).filter(x => x.action === 'pull');
      if(pulled.length) console.log('ⓘ 共享盘同步：开机拉回 ' + pulled.map(x => x.name).join('、'));
    }catch(e){ console.log('⚠️ 开机同步异常（已忽略，用本地数据继续）：' + ((e && e.message) || e)); }
  }
  console.log('');
  console.log(`  ✅ FlowTask 存储服务已启动 v${VERSION}（账户表 + 个人库 + 共享库 · 会话鉴权 · 假冲突已修）`);
  console.log('  ------------------------------------------------');
  console.log(`  数据目录 : ${DATA_DIR}`);
  console.log(`  账户表   : flowtask_auth.json${fs.existsSync(AUTH_FILE) ? '（已存在）' : '（首次注册时创建）'}`);
  console.log(`  共享库   : flowtask_shared.json`);
  console.log(`  个人库   : flowtask_data_<账户id>.json（每账户一份，互相隔离）`);
  console.log(`  备份目录 : ${BACKUP_DIR}（间隔≥10 分钟自动备份，每类保留最近 ${BACKUP_KEEP} 份）`);
  console.log(`  共享盘   : ${SYNC.enabled ? SHARE_DIR + (SYNC.status().blockReason ? ' ⚠ ' + SYNC.status().blockReason : '') : '未配置（仅本机存储，行为与旧版一致）'}`);
  console.log(`  请从浏览器打开 : http://${HOST}:${PORT}`);
  console.log('  停止服务 : 关闭本窗口或按 Ctrl+C');
  console.log('  ------------------------------------------------');
  console.log('');
});

}

server.on('error', (e) => {
  if(e.code === 'EADDRINUSE'){
    console.log(`⚠️ 端口 ${PORT} 已被占用——很可能存储服务已在运行，本窗口直接关闭即可。`);
  }else{
    console.log('启动失败：', e.message);
  }
});

/* 供测试直接引用内部函数 */
{
  module.exports = { FILE_RE, shapeOk, issueSession, verifySession, personalFile, hashOf, TOKEN, SESSION_TTL_MS };
}
