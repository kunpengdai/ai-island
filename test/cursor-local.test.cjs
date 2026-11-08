const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CursorLocalMonitor } = require('../src/cursor-local.cjs');
test('Cursor local diagnostics separate loaded Windows hooks, Cloud windows and SSH/WSL windows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-cursor-local-'));
  try {
    const dir = path.join(root, '20261108T155019');
    for (const [name, config, renderer] of [['window1', 'c:\\Users\\Test\\.cursor\\hooks.json', 'local'], ['window2', '\\home\\ubuntu\\.cursor\\hooks.json', 'Invoking resolveAuthority(background-composer)...'], ['window3', '\\home\\test\\.cursor\\hooks.json', 'Invoking resolveAuthority(ssh-remote)...']]) {
      fs.mkdirSync(path.join(dir, name, 'output'), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'output', 'cursor.hooks.workspace.log'), `User config path: ${config}\nLoaded 7 user hook(s) for steps: workspaceOpen\n`);
      fs.writeFileSync(path.join(dir, name, 'renderer.log'), renderer);
    }
    const result = await new CursorLocalMonitor({ root }).poll();
    assert.equal(result.localReady, true); assert.equal(result.remoteWindows, 2); assert.equal(result.cloudWindows, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
