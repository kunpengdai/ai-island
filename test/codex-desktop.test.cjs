const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexDesktopMonitor, DesktopSession, desktopMetadata } = require('../src/codex-desktop.cjs');
const { TaskStore } = require('../src/core.cjs');
const at = Date.now();
const record = (type, payload, offset = 0) => ({ timestamp: new Date(at + offset).toISOString(), type, payload });
const event = (type, extra = {}, offset = 0) => record('event_msg', { type, ...extra }, offset);

test('desktop metadata matches the installed Codex Desktop format and excludes CLI and subagents', () => {
  const meta = payload => ({ type: 'session_meta', payload });
  assert.equal(desktopMetadata(meta({ id: 'desktop', source: 'vscode', originator: 'Codex Desktop', cwd: 'C:/Game' })).id, 'desktop');
  assert.equal(desktopMetadata(meta({ id: 'cli', source: 'cli', originator: 'codex-tui' })), null);
  assert.equal(desktopMetadata(meta({ id: 'child', source: { subagent: { other: 'guardian' } }, originator: 'Codex Desktop' })), null);
  assert.equal(desktopMetadata(meta({ id: 'child', source: 'vscode', thread_source: 'subagent' })), null);
});
test('only explicit desktop lifecycle records finish a task; final assistant text is not completion', () => {
  const session = new DesktopSession({ id: 'desktop', cwd: 'C:/Game' });
  session.accept(event('task_started', { turn_id: 'turn-1' }));
  session.accept(event('user_message', { message: '实现中文桌面任务' }, 1));
  session.accept(record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: 'done' }, 2));
  assert.equal(session.snapshot(at + 3).status, 'running');
  session.accept(event('task_complete', { turn_id: 'turn-1' }, 4));
  assert.equal(session.snapshot(at + 5).status, 'completed');
  assert.equal(session.snapshot(at + 5).title, '实现中文桌面任务');
  session.accept(event('task_started', { turn_id: 'turn-2' }, 6));
  session.accept(event('task_complete', { turn_id: 'turn-1' }, 7));
  assert.equal(session.snapshot(at + 8).status, 'running');
  session.accept(event('turn_aborted', { turn_id: 'turn-2' }, 9));
  assert.equal(session.snapshot(at + 10).status, 'interrupted');
});
test('a blocking question stays waiting until its matching response, while async questions do not pause the task', () => {
  const session = new DesktopSession({ id: 'desktop' }); session.accept(event('task_started', { turn_id: 'one' }));
  session.accept(record('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'optional' }, 1));
  assert.equal(session.snapshot(at + 2).status, 'running');
  session.accept(record('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'question' }, 3));
  assert.equal(session.snapshot(at + 4).status, 'waiting');
  session.accept(record('response_item', { type: 'function_call_output', call_id: 'other' }, 5));
  assert.equal(session.snapshot(at + 6).status, 'waiting');
  session.accept(record('response_item', { type: 'function_call_output', call_id: 'question' }, 7));
  assert.equal(session.snapshot(at + 8).status, 'running');
  assert.equal(session.snapshot(at + 31 * 60_000).status, 'unknown');
});
test('incremental desktop discovery handles new files, partial UTF-8 rows, repeated polls, and fast completed turns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-desktop-'));
  try {
    const monitor = new CodexDesktopMonitor({ root, discoverEvery: 0 });
    const base = Date.now() + 1; monitor.startedAt = base;
    const line = (type, payload, offset = 0) => JSON.stringify({ timestamp: new Date(base + offset).toISOString(), type, payload }) + '\n';
    const file = path.join(root, 'rollout-test.jsonl');
    await monitor.poll(base);
    fs.writeFileSync(file, line('session_meta', { id: 'native', source: 'vscode', originator: 'Codex Desktop', cwd: 'C:/中文' }) + line('event_msg', { type: 'task_started', turn_id: 'one' }, 1));
    let result = await monitor.poll(base + 2);
    assert.equal(result.tasks[0].status, 'running'); assert.equal(result.tasks[0].source, 'codex-desktop');
    const bytes = Buffer.from(line('event_msg', { type: 'user_message', message: '修复桌面任务采集' }, 3));
    fs.appendFileSync(file, bytes.subarray(0, bytes.length - 3)); await monitor.poll(base + 4);
    fs.appendFileSync(file, bytes.subarray(bytes.length - 3)); result = await monitor.poll(base + 5);
    assert.equal(result.tasks[0].title, '修复桌面任务采集');
    const store = new TaskStore(); let chimes = 0; store.on('complete', () => chimes++);
    store.ingest(result.tasks[0], { silent: true });
    fs.appendFileSync(file, line('event_msg', { type: 'task_complete', turn_id: 'one' }, 6));
    result = await monitor.poll(base + 7); result.events.forEach(t => store.ingest(t)); result.tasks.forEach(t => store.ingest(t));
    assert.equal(chimes, 1);
    result = await monitor.poll(base + 8); result.events.forEach(t => store.ingest(t)); result.tasks.forEach(t => store.ingest(t));
    assert.equal(chimes, 1);
    fs.appendFileSync(file, line('event_msg', { type: 'task_started', turn_id: 'two' }, 10) + line('event_msg', { type: 'task_complete', turn_id: 'two' }, 11));
    result = await monitor.poll(base + 12); result.events.forEach(t => store.ingest(t)); result.tasks.forEach(t => store.ingest(t));
    assert.equal(chimes, 2, 'a turn starting and finishing between polls still chimes once');
    store.clearHistory(); result.tasks.forEach(t => store.ingest(t)); assert.equal(store.snapshot().length, 0);
    const restored = new TaskStore(); restored.restore(store.serialize()); result.tasks.forEach(t => restored.ingest(t)); assert.equal(restored.snapshot().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
