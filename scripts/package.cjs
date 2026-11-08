const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('./zip.cjs');
const root = path.resolve(__dirname, '..');
const meta = require('../package.json');
const electronExe = require('electron');
const folderName = `AI-Island-${meta.version}-win-x64`;
const out = path.join(root, 'release', folderName);
const application = path.join(out, 'resources', 'app');
if (process.platform !== 'win32') throw new Error('请在 Windows 构建 Windows 应用');
// Only this workspace's known release folder may be replaced.
if (path.dirname(out) !== path.resolve(root, 'release')) throw new Error('Invalid build output');
if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.dirname(electronExe), out, { recursive: true, filter: source => path.basename(source) !== 'default_app.asar' });
fs.renameSync(path.join(out, 'electron.exe'), path.join(out, 'AI Island.exe'));
fs.mkdirSync(application, { recursive: true });
for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(application, dir), { recursive: true });
const { devDependencies, scripts, ...production } = meta;
fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify(production, null, 2));
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, '使用说明.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'AI-Island-LICENSE.txt'));
if (fs.existsSync(path.join(root, 'docs'))) fs.cpSync(path.join(root, 'docs'), path.join(out, 'docs'), { recursive: true });
console.log(`Built: ${path.join(out, 'AI Island.exe')}`);
if (process.argv.includes('--zip')) {
  const zip = path.join(root, 'release', `AI-Island-${meta.version}-win-x64.zip`);
  createZip(out, zip);
  console.log(`Portable ZIP: ${zip}`);
}
