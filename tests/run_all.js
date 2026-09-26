/*
 * 验证链单一入口（Node 直跑，零依赖）
 * ============================================================================
 * 用法：
 *   node tests/run_all.js            跑全部（含 PS1 与 E2E，约 3-5 分钟）
 *   node tests/run_all.js --fast     跳过 E2E（约 1 分钟）
 *   node tests/run_all.js --no-ps1   跳过所有 PowerShell 相关项（无 PowerShell 的环境）
 *
 * 为什么要这个文件：此前验证链是"README 里的一串命令"，靠人记得逐条跑。
 * 后果是真实存在的——tests/_ps1_parse_check.ps1 只在 README 单列一行、不在
 * AGENTS.md 的验证链里，于是没人跑它，而它恰好是当时唯一能发现
 * "flowtask_server.ps1 因重复 BOM 无法解析"的检查。
 * 入口只有一个，缺项就会被看见。
 *
 * 退出码：任一项失败即非零，可直接作为 pre-push hook / CI 的判据。
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const FAST = argv.includes('--fast');
const NO_PS1 = argv.includes('--no-ps1');

/* 每项：名称 + 命令 + 参数。ps1 项在 --no-ps1 下跳过。 */
const STEPS = [
  { name: '语法闸门（内联脚本 + 全部 js）', cmd: 'node', args: ['tests/syntax_check.js'] },
  { name: 'PS1 解析 + 编码闸门（BOM/重复 BOM/UTF-16）', cmd: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/_ps1_parse_check.ps1'], ps1: true },
  { name: '版本一致性（9 处真相源）', cmd: 'node', args: ['tests/version_check.js', '--allow-lock-drift'] },
  { name: '单测 + 源码守卫 + Node 服务端集成', cmd: 'node', args: ['tests/flowtask_test.js'] },
  { name: 'PowerShell 服务端冒烟', cmd: 'node', args: ['tests/flowtask_test.js', 'ps1'], ps1: true },
  { name: 'QA 静默失败回归', cmd: 'node', args: ['tests/qa_fix_regression.js'] },
  { name: '共享盘同步引擎单测', cmd: 'node', args: ['tests/sync_test.js'] },
  { name: '三路合并内核单测', cmd: 'node', args: ['tests/merge_test.js'] },
  { name: '两机 + 共享盘端到端同步', cmd: 'node', args: ['tests/sync_integration.js'] },
  { name: '两机对撞：实体级合并端到端', cmd: 'node', args: ['tests/sync_merge_e2e.js'], ps1: true },
  { name: 'JS/PS 双服务端对等', cmd: 'node', args: ['tests/server_parity.js'], ps1: true },
  { name: 'JS/PS 同步引擎对等', cmd: 'node', args: ['tests/sync_parity.js'], ps1: true },
  { name: '真浏览器 E2E（Edge headless + CDP）', cmd: 'node', args: ['tests/flowtask_e2e.js'], e2e: true },
];

const results = [];
console.log('== FlowTask 验证链 ==' + (FAST ? '（--fast：跳过 E2E）' : '') + (NO_PS1 ? '（--no-ps1）' : '') + '\n');

for(const s of STEPS){
  if(s.ps1 && NO_PS1){ results.push({ name: s.name, status: 'SKIP' }); console.log(`-- 跳过  ${s.name}\n`); continue; }
  if(s.e2e && FAST){ results.push({ name: s.name, status: 'SKIP' }); console.log(`-- 跳过  ${s.name}\n`); continue; }
  console.log(`>> ${s.name}`);
  const r = spawnSync(s.cmd, s.args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  const code = r.status === null ? 1 : r.status;
  const status = code === 0 ? 'PASS' : 'FAIL';
  results.push({ name: s.name, status, code });
  console.log(`<< ${status}  ${s.name}（退出码 ${code}）\n`);
}

const failed = results.filter(r => r.status === 'FAIL');
const skipped = results.filter(r => r.status === 'SKIP');
console.log('==================== 汇总 ====================');
for(const r of results){
  const mark = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`  ${mark}  ${r.name}`);
}
console.log(`\n通过 ${results.length - failed.length - skipped.length} / 失败 ${failed.length} / 跳过 ${skipped.length}`);
if(failed.length){
  console.log('\n失败项：');
  for(const f of failed) console.log('  - ' + f.name);
  process.exitCode = 1;
} else {
  console.log('\n验证链全绿。');
}
