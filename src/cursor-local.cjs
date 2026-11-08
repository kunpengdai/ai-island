const fs = require('node:fs/promises');
const path = require('node:path');

class CursorLocalMonitor {
  constructor({ root = path.join(process.env.APPDATA || '', 'Cursor', 'logs') } = {}) { this.root = root; }
  async poll() {
    let dirs;
    try { dirs = await fs.readdir(this.root); } catch (error) { if (error.code === 'ENOENT') return { localReady: false, remoteWindows: 0 }; throw error; }
    const latest = dirs.filter(n => /^\d{8}T\d{6}$/.test(n)).sort().pop();
    if (!latest) return { localReady: false, remoteWindows: 0 };
    const folder = path.join(this.root, latest);
    const files = (await fs.readdir(folder, { recursive: true })).filter(n => /cursor\.hooks\.[^\\/]+\.log$/.test(n));
    let localReady = false, remoteWindows = 0, cloudWindows = 0, lastLogAt = 0;
    for (const file of files) {
      const full = path.join(folder, file), handle = await fs.open(full, 'r');
      try {
        const stat = await handle.stat(); const size = Math.min(stat.size, 65536), bytes = Buffer.alloc(size);
        await handle.read(bytes, 0, size, stat.size - size);
        const text = bytes.toString('utf8');
        const configs = [...text.matchAll(/User config path:\s*([^\r\n]+)/g)];
        const config = configs.at(-1)?.[1] || '';
        if (/^[a-z]:[\\/]/i.test(config)) {
          if ([...text.matchAll(/Loaded (\d+) user hook\(s\)/g)].some(match => Number(match[1]) > 0)) localReady = true;
        } else if (config) {
          remoteWindows++;
          const windowFolder = file.split(/[\\/]/)[0];
          const renderer = await fs.open(path.join(folder, windowFolder, 'renderer.log'), 'r').catch(() => null);
          if (renderer) try {
            const size = Math.min((await renderer.stat()).size, 65536), bytes = Buffer.alloc(size);
            await renderer.read(bytes, 0, size, 0);
            if (/resolveAuthority\(background-composer|background-composer\)/.test(bytes.toString('utf8'))) cloudWindows++;
          } finally { await renderer.close(); }
        }
        lastLogAt = Math.max(lastLogAt, stat.mtimeMs);
      } finally { await handle.close(); }
    }
    return { localReady, remoteWindows, cloudWindows, lastLogAt };
  }
}
module.exports = { CursorLocalMonitor };
