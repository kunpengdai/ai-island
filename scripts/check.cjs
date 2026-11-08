const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const dir of ['src', 'scripts', 'test']) {
  for (const file of fs.readdirSync(dir, { recursive: true }).filter(f => /\.(cjs|js)$/.test(f))) {
    execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'inherit' });
  }
}
console.log('All JavaScript syntax checks passed.');
