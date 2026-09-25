/*
 * FlowTask sidecar 构建：把 flowtask_server.js(+sync+merge) 打成单文件 Node SEA exe。
 * ---------------------------------------------------------
 * 产物：src-tauri/binaries/flowtask-server-<target-triple>.exe
 * 步骤：esbuild 捆绑 → node --experimental-sea-config 生成 blob →
 *       拷贝本机 node.exe → postject 注入 blob → 完成
 * 用法：node scripts/build-sidecar.mjs
 * 说明：服务端代码保持单一来源——桌面版跑的就是仓库里这份 flowtask_server.js，
 *       不维护第二实现；HTML 与数据目录由 Tauri 壳通过环境变量注入。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');          // FlowTask 仓库根
const DESKTOP = path.join(__dirname, '..');             // desktop/
const SEA = path.join(DESKTOP, 'sea');
const TRIPLE = process.env.FLOWTASK_TRIPLE || 'x86_64-pc-windows-msvc';
const OUT = path.join(DESKTOP, 'src-tauri', 'binaries', `flowtask-server-${TRIPLE}.exe`);

fs.rmSync(SEA, { recursive: true, force: true });
fs.mkdirSync(SEA, { recursive: true });

// 1) esbuild 捆绑（server 是入口，sync/merge 会被打进去）
require('esbuild').buildSync({
  entryPoints: [path.join(ROOT, 'flowtask_server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(SEA, 'bundle.cjs'),
  minify: true,
  legalComments: 'none',
});

// 2) SEA 配置 + blob
fs.writeFileSync(path.join(SEA, 'sea-config.json'), JSON.stringify({
  main: path.join(SEA, 'bundle.cjs'),
  output: path.join(SEA, 'flowtask.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(SEA, 'sea-config.json')], { stdio: 'inherit' });

// 3) 拷贝 node.exe 并注入 blob（Windows 需要先去掉签名 Authenticentic 才能 postject）
fs.copyFileSync(process.execPath, OUT);
execFileSync(process.execPath, [
  require.resolve('postject/dist/cli.js'),
  OUT, 'NODE_SEA_BLOB', path.join(SEA, 'flowtask.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

/* 4) 抹掉被 postject 破坏的 OpenJS 原签名目录（IMAGE_DIRECTORY_ENTRY_SECURITY 清零）。
      损坏签名会让 signtool 报 0x800700C1（bad exe format），也是杀软启发式误报的头号诱因；
      只清数据目录项、不截断文件尾——SEA blob 也在尾部，动不得，孤儿证书字节无人引用即无害。 */
{
  const fd = fs.openSync(OUT, 'r+');
  const buf = Buffer.alloc(1024);
  fs.readSync(fd, buf, 0, 1024, 0);
  const pe = buf.readUInt32LE(0x3c);
  const optStart = pe + 24;
  const magic = buf.readUInt16LE(optStart);
  // PE32+ 的 DataDirectory 起始于可选头 +112，PE32 是 +96；第 4 项 = 安全目录
  const ddSec = optStart + (magic === 0x20b ? 112 : 96) + 8 * 4;
  console.log('安全目录原值: VA=0x' + buf.readUInt32LE(ddSec).toString(16) + ' Size=' + buf.readUInt32LE(ddSec + 4));
  fs.writeSync(fd, Buffer.alloc(8), 0, 8, ddSec);
  const chk = Buffer.alloc(8);
  fs.readSync(fd, chk, 0, 8, ddSec);
  fs.closeSync(fd);
  if(chk.some(b => b !== 0)) throw new Error('安全目录清零失败');
  console.log('已清除残缺签名目录，signtool 可直接覆盖签名');
}

console.log('\nsidecar 已生成：' + OUT + '（' + Math.round(fs.statSync(OUT).size / 1048576) + ' MB）');
