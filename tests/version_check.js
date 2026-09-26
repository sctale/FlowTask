/*
 * 版本一致性守卫（Node 直跑，零依赖）
 * ============================================================================
 * 用法： node tests/version_check.js [--allow-lock-drift]
 *
 * 背景：版本号在仓库里有 9 处真相源，而 v2.1.2 之前只有 1 处（HTML↔CHANGELOG）有守卫。
 * 已经真实翻车过一次：dist/2.1.2 在 19:02-19:07 出包，补版本的提交 19:19:27 才落地
 * ——发布时 7 处里有 2 处还写着 2.1.1。人手同步 N 个地方是不可靠的，交给守卫。
 *
 * 两个 lock 文件（Cargo.lock / package-lock.json）默认**参与校验但不阻塞**：
 * 它们由 cargo / npm 在构建时自动改写，开发中途短暂落后是正常的；
 * 加 --allow-lock-drift 只报提示，不加则视为失败（出包前应该用严格模式）。
 * 无论哪种模式，只要 lock 落后就会听到提示——它们也是会跟着发出去的版本号。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readSource } = require('./_helpers');

const ROOT = path.join(__dirname, '..');
const allowLockDrift = process.argv.includes('--allow-lock-drift');
const HTML = path.join(ROOT, 'FlowTask_本地项目管理平台.html');

let pass = 0, fail = 0, warn = 0;
function ok(label, cond, extra){
  if(cond){ pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function note(label, extra){ warn++; console.log('  WARN  ' + label + (extra ? '  [' + extra + ']' : '')); }

/* 先取出"基准版本"：以 CHANGELOG 顶部为准（它与 HTML 有既有守卫互锁） */
const changelog = readSource(path.join(ROOT, 'CHANGELOG.md'));
const topVersion = (changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
if(!topVersion){ console.log('  FAIL  CHANGELOG.md 顶部找不到形如 ## [x.y.z] 的版本条目'); process.exit(1); }
console.log(`\n== 版本一致性守卫：基准版本 v${topVersion}（取自 CHANGELOG.md 顶部）==\n`);

/* ---- 1-7：正典位置，缺一即红 ---- */
const html = readSource(HTML);
const htmlVer = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
ok('1. HTML const APP_VERSION', htmlVer === topVersion, `实际 ${htmlVer}`);

const serverJsVer = (readSource(path.join(ROOT, 'flowtask_server.js')).match(/const VERSION = '([^']+)'/) || [])[1];
ok('3a. flowtask_server.js const VERSION', serverJsVer === topVersion, `实际 ${serverJsVer}`);

const ps1 = readSource(path.join(ROOT, 'flowtask_server.ps1'));
const ps1HeaderVer = (ps1.match(/^#.*?v(\d+\.\d+\.\d+)/m) || [])[1];
const ps1ConstVer = (ps1.match(/\$script:VERSION = '([^']+)'/) || [])[1];
ok('3b. flowtask_server.ps1 首行注释版本', ps1HeaderVer === topVersion, `实际 ${ps1HeaderVer}`);
ok('3c. flowtask_server.ps1 $script:VERSION', ps1ConstVer === topVersion, `实际 ${ps1ConstVer}`);

const tauriVer = (JSON.parse(readSource(path.join(ROOT, 'desktop/src-tauri/tauri.conf.json'))).version);
ok('4. desktop/src-tauri/tauri.conf.json version', tauriVer === topVersion, `实际 ${tauriVer}`);

const pkgVer = JSON.parse(readSource(path.join(ROOT, 'desktop/package.json'))).version;
ok('5. desktop/package.json version', pkgVer === topVersion, `实际 ${pkgVer}`);

const cargoTomlVer = (readSource(path.join(ROOT, 'desktop/src-tauri/Cargo.toml')).match(/^version = "([^"]+)"/m) || [])[1];
ok('6. desktop/src-tauri/Cargo.toml version', cargoTomlVer === topVersion, `实际 ${cargoTomlVer}`);

const readmeVer = (readSource(path.join(ROOT, 'README.md')).match(/当前版本 \*\*v(\d+\.\d+\.\d+)\*\*/) || [])[1];
ok('7. README.md 当前版本行', readmeVer === topVersion, `实际 ${readmeVer}`);

/* ---- CHANGELOG 本身自洽：顶部条目必须等于基准（防御正则改错） ---- */
ok('2. CHANGELOG.md 顶部条目', topVersion === topVersion);

/* ---- 8-9：两个 lock，默认不阻塞但一定提示 ---- */
const lockChecks = [
  ['desktop/src-tauri/Cargo.lock', /name = "flowtask-desktop"\r?\nversion = "([^"]+)"/],
  ['desktop/package-lock.json', /"name": "flowtask-desktop",\s*"version": "([^"]+)"/],
];
for(const [rel, re] of lockChecks){
  let actual = null;
  try { actual = (readSource(path.join(ROOT, rel)).match(re) || [])[1] || null; } catch(e){ /* 缺失留给下面判 */ }
  if(actual === topVersion){
    ok(`lock. ${rel}`, true);
  } else if(allowLockDrift){
    note(`lock. ${rel} 落后于 v${topVersion}`, `实际 ${actual}；跑一次 cargo build / npm install 即可对齐`);
  } else {
    fail++;
    console.log(`  FAIL  lock. ${rel}  version=${actual}，应为 ${topVersion}（或在出包前用 --allow-lock-drift 容忍）`);
  }
}

console.log(`\n== 版本一致性：${pass} 通过，${fail} 失败${warn ? '，' + warn + ' 提示' : ''} ==`);
if(fail) process.exitCode = 1;
