const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = table[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function createZip(folder, destination) {
  const temp = `${destination}.tmp`;
  const fd = fs.openSync(temp, 'w'); const central = []; let offset = 0;
  const write = data => { fs.writeFileSync(fd, data); offset += data.length; };
  try {
    const files = fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    if (files.length > 65535) throw new Error('ZIP file count exceeds supported limit');
    for (const file of files) {
      const full = path.join(file.parentPath, file.name);
      const name = Buffer.from(`${path.basename(folder)}/${path.relative(folder, full).replace(/\\/g, '/')}`, 'utf8');
      const data = fs.readFileSync(full); const compressed = zlib.deflateRawSync(data, { level: 6 }); const crc = crc32(data);
      const date = fs.statSync(full).mtime;
      const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
      const dosDate = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
      local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
      const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10);
      entry.writeUInt16LE(dosTime, 12); entry.writeUInt16LE(dosDate, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
      central.push(entry, name); write(local); write(name); write(compressed);
    }
    const centralOffset = offset;
    for (const part of central) write(part);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(offset - centralOffset, 12); end.writeUInt32LE(centralOffset, 16); write(end);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, destination);
}
module.exports = { createZip };
