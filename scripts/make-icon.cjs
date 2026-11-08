const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const b of buffer) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const body = Buffer.concat([type, data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]);
}
const size = 256, stride = size * 4 + 1, raw = Buffer.alloc(stride * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const offset = y * stride + 1 + x * 4;
  const dx = Math.max(44 - x, 0, x - (size - 45)), dy = Math.max(44 - y, 0, y - (size - 45));
  if (dx * dx + dy * dy > 44 * 44) continue;
  let color = [27, 28, 33, 255];
  const leanX = x + (y - 128) * .28;
  const bars = [[65, 91, 114, 164], [111, 137, 84, 164], [157, 183, 54, 164]];
  if (bars.some(([l, r, t, b]) => leanX >= l && leanX <= r && y >= t && y <= b)) color = [238, 162, 138, 255];
  color.forEach((v, i) => raw[offset + i] = v);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
fs.mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), Buffer.concat([header, png]));
console.log('Application icons generated.');
