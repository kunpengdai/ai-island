const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mergeHooks, withoutOwned, install, uninstall, installed, configPath } = require('../src/integrations.cjs');

test('install is idempotent and uninstall preserves every foreign hook and setting', () => {
  for (const tool of ['codex', 'claude', 'cursor']) {
    const original = { env: { CUSTOM: 'keep' }, hooks: { Stop: [{ matcher: 'foreign', hooks: [{ type: 'command', command: 'existing-tool notify' }] }], stop: [{ command: 'other-hook.ps1' }] } };
    const merged = mergeHooks(tool, original, 'C:\\Runtime\\island-hook.ps1');
    assert.deepEqual(mergeHooks(tool, merged, 'C:\\Runtime\\island-hook.ps1'), merged);
    const removed = withoutOwned(merged); if (tool === 'cursor') delete removed.version;
    assert.deepEqual(removed, original);
    assert.deepEqual(original.env, { CUSTOM: 'keep' });
  }
});
test('filesystem install backs up original bytes and leaves concurrent foreign changes on uninstall', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-config-'));
  try {
    const file = configPath('claude', root); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = '{ "model": "my-model", "hooks": {} }\r\n'; fs.writeFileSync(file, bytes);
    const result = install('claude', { home: root, runtime: path.join(root, 'runtime'), asset: path.join(__dirname, '..', 'assets', 'island-hook.ps1') });
    assert.equal(fs.readFileSync(result.backup, 'utf8'), bytes); assert.equal(installed('claude', root), true);
    const current = JSON.parse(fs.readFileSync(file)); current.newPreference = true; fs.writeFileSync(file, JSON.stringify(current));
    uninstall('claude', root); const cleaned = JSON.parse(fs.readFileSync(file));
    assert.equal(cleaned.newPreference, true); assert.equal(cleaned.model, 'my-model'); assert.equal(installed('claude', root), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('invalid config is never overwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-invalid-'));
  try {
    const file = configPath('codex', root); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'broken');
    assert.throws(() => install('codex', { home: root, runtime: path.join(root, 'runtime'), asset: '' }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('real Windows hook accepts Unicode stdin and only persists explicit event fields', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hook-'));
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'assets', 'island-hook.ps1'), '-Tool', 'claude', '-Event', 'UserPromptSubmit'], {
      input: JSON.stringify({ session_id: 'test-session', prompt: '实现中文任务面板', cwd: 'C:/项目', tool_input: { secret: 'do-not-store' } }),
      env: { ...process.env, AGENT_ISLAND_EVENT_DIR: root, ORCA_PANE_KEY: '', ORCA_WORKTREE_ID: '' }, encoding: 'utf8', timeout: 6000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
    const files = fs.readdirSync(root); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{32}\.json$/);
    const content = fs.readFileSync(path.join(root, files[0]), 'utf8'); const event = JSON.parse(content);
    assert.equal(event.title, '实现中文任务面板'); assert.equal(event.cwd, 'C:/项目'); assert.equal(event.event, 'UserPromptSubmit'); assert.equal(content.includes('do-not-store'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Cursor importing Claude hooks retains Cursor identity and stop errors', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-cursor-hook-'));
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'assets', 'island-hook.ps1'), '-Tool', 'claude', '-Event', 'Stop'], {
      input: JSON.stringify({ conversation_id: 'cursor-conversation', generation_id: 'cursor-turn', cursor_version: 'current', status: 'error', workspace_roots: ['C:/Cursor Project'] }),
      env: { ...process.env, AGENT_ISLAND_EVENT_DIR: root, ORCA_PANE_KEY: '', ORCA_WORKTREE_ID: '' }, encoding: 'utf8', timeout: 6000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const raw = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), 'utf8'));
    assert.equal(raw.tool, 'cursor'); assert.equal(raw.event, 'stop'); assert.equal(raw.sessionId, 'cursor-conversation');
    assert.equal(require('../src/core.cjs').normalizeHook(raw).status, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
