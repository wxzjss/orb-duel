// 生成 PNG 图标（黑底 + 中心白色辉光圆球），仅用 Node 内置模块，无 npm 依赖
const fs = require('fs');
const zlib = require('zlib');

// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  // raw: 每行前加 filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // 辉光半径层（近似 radial 渐变）：外层暗蓝光晕 → 核心白球
  const glowR = size * 0.42;   // 光晕外沿
  const midR = size * 0.28;    // 中间过渡
  const coreR = size * 0.18;   // 白核
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let r = 0, g = 0, b = 0, a = 255;
      if (d <= coreR) {
        // 纯白核，中心略亮
        const t = 1 - d / coreR;
        r = g = 255; b = 255;
        a = Math.round(235 + 20 * t);
      } else if (d <= midR) {
        // 白 → 淡蓝过渡
        const t = (d - coreR) / (midR - coreR);
        r = Math.round(255 - 60 * t);
        g = Math.round(255 - 80 * t);
        b = 255;
        a = Math.round(255 - 90 * t);
      } else if (d <= glowR) {
        // 淡蓝 → 黑 光晕
        const t = (d - midR) / (glowR - midR);
        r = Math.round(195 - 195 * t);
        g = Math.round(175 - 175 * t);
        b = Math.round(255 - 255 * t);
        a = Math.round(165 - 165 * t);
      }
      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return encodePNG(size, size, px);
}

fs.writeFileSync(__dirname + '/icon-512.png', renderIcon(512));
fs.writeFileSync(__dirname + '/icon-192.png', renderIcon(192));
console.log('icons generated');
