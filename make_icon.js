/*
 * FlowTask 图标生成器（Node 零依赖版，替代 make_icon.py）
 * ---------------------------------------------------------
 * 图形沿用 FlowTask 标识（v2.0.2 起）：深青圆角底板 + 半透明清单两行 + 实心大勾（清单→完成）。
 *
 * 为什么重写：旧 make_icon.py 生成的 .ico 是 24bpp BMP 条目，且 AND mask 约定写反
 *   （BMP/ICO 里 1=透明、0=不透明，它给不透明像素置了 1），
 *   结果整个 logo 变透明、四角留实心 —— 桌面快捷方式显示成一个方块，即"logo 不对"。
 *
 * 本实现输出：
 *   - 16/24/32/48/64/128：32bpp BGRA + 全零 AND mask（真 Alpha，边缘平滑）
 *   - 256：PNG 内嵌（现代 Windows 首选，体积也小）
 *   - flowtask.png：256 RGBA
 *
 * 用法：node make_icon.js [输出目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BRAND = [15, 118, 110];        // #0F766E
const WHITE = [255, 255, 255];

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/* 圆角矩形的符号距离：<0 在内部 */
function rrectSDF(x, y, w, h, r){
  const cx = w / 2, cy = h / 2;
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const circleSDF = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function segSDF(x, y, ax, ay, bx, by){
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const den = bax * bax + bay * bay;
  const t = den === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / den));
  return Math.hypot(pax - bax * t, pay - bay * t);
}

/* 渲染 size×size 的 RGBA（自上而下，一维数组）；ss 为亚像素采样倍率 */
function render(size, ss){
  const px = new Uint8Array(size * size * 4);
  const inset = size * 0.05, side = size - 2 * inset, rr = side * 0.24;
  const d = size;
  /* v2.0.2 标识「清单 → 完成」：两条半透明任务线 + 一道实心大勾（与内联 SVG logo 同几何） */
  const layers = [
    { alpha: 0.4,  hw: 0.054 * d, segs: [[[0.229 * d, 0.267 * d], [0.771 * d, 0.267 * d]]] },
    { alpha: 0.65, hw: 0.054 * d, segs: [[[0.229 * d, 0.467 * d], [0.538 * d, 0.467 * d]]] },
    { alpha: 1.0,  hw: 0.0625 * d, segs: [[[0.229 * d, 0.70 * d], [0.367 * d, 0.838 * d]], [[0.367 * d, 0.838 * d], [0.783 * d, 0.467 * d]]] },
  ];
  const inv = 1 / (ss * ss);
  for(let py = 0; py < size; py++){
    for(let pxi = 0; pxi < size; pxi++){
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for(let sy = 0; sy < ss; sy++){
        for(let sx = 0; sx < ss; sx++){
          const x = pxi + (sx + 0.5) / ss, y = py + (sy + 0.5) / ss;
          const bg = clamp01(0.5 - rrectSDF(x - inset, y - inset, side, side, rr));
          let white = 0;
          for(const L of layers){
            let cov = 0;
            for(const [[ax, ay], [bx, by]] of L.segs)
              cov = Math.max(cov, clamp01(0.5 - (segSDF(x, y, ax, ay, bx, by) - L.hw)));
            white += cov * bg * L.alpha;
          }
          ar += WHITE[0] * white + BRAND[0] * (bg - white);
          ag += WHITE[1] * white + BRAND[1] * (bg - white);
          ab += WHITE[2] * white + BRAND[2] * (bg - white);
          aa += bg * 255;
        }
      }
      const o = (py * size + pxi) * 4;
      px[o]     = Math.round(ar * inv);
      px[o + 1] = Math.round(ag * inv);
      px[o + 2] = Math.round(ab * inv);
      px[o + 3] = Math.round(aa * inv);
    }
  }
  return px;
}

/* 32bpp BGRA DIB（XOR 自下而上 + 全零 AND mask：0=不透明，Alpha 通道负责真正的透明） */
function encodeDIB32(size, px){
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);            // 高度 = 图像 + AND mask
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  const rowBytes = size * 4;
  const xor = Buffer.alloc(rowBytes * size);
  for(let y = 0; y < size; y++){
    const srcRow = size - 1 - y;            // BMP 自下而上
    for(let x = 0; x < size; x++){
      const o = (srcRow * size + x) * 4, d = y * rowBytes + x * 4;
      xor[d]     = px[o + 2];               // B
      xor[d + 1] = px[o + 1];               // G
      xor[d + 2] = px[o];                   // R
      xor[d + 3] = px[o + 3];               // A
    }
  }
  const andStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andStride * size);   // 全 0 = 不透明（旧版就是这里写反了）
  return Buffer.concat([hdr, xor, and]);
}

/* PNG（RGBA，colorType 6）——256 尺寸内嵌用，也用于导出 flowtask.png */
function encodePNG(size, px){
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for(let y = 0; y < size; y++){
    raw[p++] = 0;                                        // filter: None
    for(let x = 0; x < size; x++){
      const o = (y * size + x) * 4;
      raw[p++] = px[o]; raw[p++] = px[o + 1]; raw[p++] = px[o + 2]; raw[p++] = px[o + 3];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? (zlib.crc32(body) >>> 0) : crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
/* Node <18 没有 zlib.crc32 时的兜底实现 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = -1;
  for(let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

function makeICO(outPath, sizes){
  const entries = sizes.map(s => {
    const px = render(s, s >= 128 ? 3 : 2);
    return { size: s, data: s >= 256 ? encodePNG(s, px) : encodeDIB32(s, px) };
  });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = Buffer.alloc(16 * entries.length);
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o]     = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(e.size >= 256 ? 32 : 32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  fs.writeFileSync(outPath, Buffer.concat([head, dir, ...entries.map(e => e.data)]));
  return fs.statSync(outPath).size;
}

if(require.main === module){
  const dir = path.resolve(process.argv[2] || __dirname);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const icoSize = makeICO(path.join(dir, 'flowtask.ico'), sizes);
  fs.writeFileSync(path.join(dir, 'flowtask.png'), encodePNG(256, render(256, 3)));
  console.log(`flowtask.ico 已生成：${sizes.join('/')} 尺寸，32bpp 真 Alpha，${icoSize} 字节`);
  console.log('flowtask.png 已生成：256x256 RGBA');
}

module.exports = { render, encodeDIB32, encodePNG, makeICO };
