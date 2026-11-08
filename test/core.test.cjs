const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TaskStore, normalizeHook, orcaTasks } = require('../src/core.cjs');
const time = Date.now();
const evt = (status, extra = {}) => ({ id: 'codex:a', tool: 'codex', source: 'hook', status, updatedAt: time, ...extra });

test('only an observed active → completed transition chimes, once per turn', () => {
  const store = new TaskStore(); const chimes = []; store.on('complete', t => chimes.push(t.id));
  store.ingest(evt('completed'));
  assert.equal(chimes.length, 0);
  store.ingest(evt('starting', { updatedAt: time + 1, turnId: 'new' }));
  store.ingest(evt('running', { updatedAt: time + 2 }));
  store.ingest(evt('waiting', { updatedAt: time + 3 }));
  store.ingest(evt('completed', { updatedAt: time + 4, eventId: 'stop-1' }));
  store.ingest(evt('completed', { updatedAt: time + 5, eventId: 'stop-1' }));
  store.ingest(evt('completed', { updatedAt: time + 6, eventId: 'stop-2' }));
  assert.deepEqual(chimes, ['codex:a']);
});
test('startup replay never chimes, next real completion does', () => {
  const store = new TaskStore(); let count = 0; store.on('complete', () => count++);
  store.ingest(evt('running'), { silent: true }); store.ingest(evt('completed', { updatedAt: time + 1 }), { silent: true });
  assert.equal(count, 0);
  store.ingest(evt('starting', { updatedAt: time + 10000 })); store.ingest(evt('completed', { updatedAt: time + 20000 }));
  assert.equal(count, 1);
});
test('late polls, late previous-turn stops and delayed post-tool hooks cannot regress a task', () => {
  const store = new TaskStore();
  store.ingest(evt('starting', { turnId: 'b' }));
  assert.equal(store.ingest(evt('completed', { turnId: 'a', updatedAt: time + 1 })), false);
  store.ingest(evt('completed', { turnId: 'b', updatedAt: time + 2 }));
  assert.equal(store.ingest(evt('running', { updatedAt: time + 3 })), false);
  assert.equal(store.ingest(evt('running', { source: 'orca', updatedAt: time - 100 })), false);
  assert.equal(store.snapshot()[0].status, 'completed');
  store.ingest(evt('starting', { turnId: 'c', updatedAt: time + 10000 }));
  assert.equal(store.snapshot()[0].startedAt, time + 10000);
});
test('offline, failure, interruption and stale hooks never report a success', () => {
  for (const status of ['offline', 'failed', 'interrupted']) {
    const store = new TaskStore(); let count = 0; store.on('complete', () => count++);
    store.ingest(evt('running')); store.ingest(evt(status, { updatedAt: time + 1 }));
    assert.equal(count, 0); assert.equal(store.snapshot()[0].status, status === 'offline' ? 'unknown' : status);
  }
  const store = new TaskStore(); store.ingest(evt('running')); store.expire(time + 31 * 60_000);
  assert.equal(store.snapshot()[0].status, 'unknown');
});
test('multiple sessions stay distinct, restoring active tasks marks them unknown', () => {
  const store = new TaskStore(); store.ingest(evt('running')); store.ingest(evt('waiting', { id: 'codex:b' }));
  store.clearHistory(); assert.equal(store.snapshot().length, 2);
  const next = new TaskStore(); next.restore(store.snapshot());
  assert.ok(next.snapshot().every(t => t.status === 'unknown'));
});
test('hook normalization is strict, Cursor failures are failures and notifications are selective', () => {
  const hook = { tool: 'cursor', sessionId: 'one', event: 'stop', result: 'error', timestamp: time, title: '<script>example</script>' };
  assert.equal(normalizeHook(hook).status, 'failed');
  assert.equal(normalizeHook({ ...hook, result: 'aborted' }).status, 'interrupted');
  assert.equal(normalizeHook({ ...hook, result: 'new-state' }).status, 'unknown');
  assert.equal(normalizeHook({ ...hook, tool: 'unknown' }), null);
  assert.equal(normalizeHook({ ...hook, timestamp: time - 2 * 86400000 }), null);
  assert.equal(normalizeHook({ ...hook, event: 'Notification', notificationType: 'idle_prompt' }), null);
  assert.equal(normalizeHook({ ...hook, event: 'Notification', notificationType: 'permission_prompt' }).status, 'waiting');
  assert.equal(normalizeHook({ ...hook, orcaPaneKey: 'pane', orcaWorktreeId: 'work' }).id, 'orca:work:pane');
});
test('Orca adapter ignores remote and dead sessions, trusts agent state rather than workspace labels', () => {
  const ws = { hostId: 'local', worktreeId: 'work', path: 'C:/test', hasAttachedPty: true, workspaceStatus: 'completed', agents: [
    { paneKey: 'a', agentType: 'codex', state: 'working', updatedAt: time },
    { paneKey: 'b', agentType: 'claude', state: 'future-state', updatedAt: time },
    { paneKey: 'c', agentType: 'claude', state: 'done', hasLivePty: false }
  ] };
  const parsed = orcaTasks({ ok: true, result: { worktrees: [ws, { ...ws, hostId: 'ssh:test' }], truncated: true } });
  assert.equal(parsed.tasks.length, 2); assert.equal(parsed.tasks[0].status, 'running'); assert.equal(parsed.tasks[1].status, 'unknown'); assert.equal(parsed.truncated, true);
  assert.throws(() => orcaTasks({ ok: false }));
});
test('disappearing Orca sessions become unknown only with a complete snapshot', () => {
  const store = new TaskStore(); store.ingest(evt('running', { source: 'orca' }));
  store.reconcileOrca([], { complete: false }); assert.equal(store.snapshot()[0].status, 'running');
  store.reconcileOrca([]); assert.equal(store.snapshot()[0].status, 'unknown');
});
test('a lagging Orca working observation cannot rearm an already completed hook turn', () => {
  const store = new TaskStore(); let count = 0; store.on('complete', () => count++);
  store.ingest(evt('running', { source: 'orca-hook', turnId: 'one' }));
  store.ingest(evt('completed', { source: 'orca-hook', turnId: 'one', updatedAt: time + 10 }));
  store.ingest(evt('running', { source: 'orca', stateStartedAt: time, updatedAt: time + 20 }));
  store.ingest(evt('completed', { source: 'orca', updatedAt: time + 30 }));
  assert.equal(count, 1);
  store.ingest(evt('running', { source: 'orca', stateStartedAt: time + 100, updatedAt: time + 100 }));
  assert.equal(store.snapshot()[0].turnId, '');
  store.ingest(evt('completed', { source: 'orca-hook', turnId: 'two', updatedAt: time + 200 }));
  assert.equal(count, 2);
});
test('running cards keep their order across alternating tool events, waits, and app restarts', () => {
  const store = new TaskStore();
  for (const id of ['one', 'two', 'three']) store.ingest(evt('running', { id, updatedAt: time }));
  for (let step = 1; step < 8; step++) {
    const id = ['three', 'one', 'two'][step % 3];
    store.ingest(evt(step === 4 ? 'waiting' : 'running', { id, updatedAt: time + step * 100 }));
    assert.deepEqual(store.snapshot().map(t => t.id), ['one', 'two', 'three']);
  }
  const restored = new TaskStore(); restored.restore(store.serialize());
  for (const id of ['three', 'two', 'one']) restored.ingest(evt('running', { id, updatedAt: time + 2000 }));
  assert.deepEqual(restored.snapshot().map(t => t.id), ['one', 'two', 'three']);
});
test('Orca owns its Codex tasks, respects aggregate waiting, and observes completion after PTY exit', () => {
  const payload = { ok: true, result: { worktrees: [{ hostId: 'local', worktreeId: 'work', hasAttachedPty: true, agents: [{ paneKey: 'pane', agentType: 'codex', state: 'waiting', mainAgent: { state: 'working' }, updatedAt: time, hasLivePty: true }] }] } };
  const task = orcaTasks(payload).tasks[0];
  assert.equal(task.tool, 'orca'); assert.equal(task.agentTool, 'codex'); assert.equal(task.status, 'waiting');
  const store = new TaskStore(); let chimes = 0; store.on('complete', () => chimes++);
  store.ingest(task);
  payload.result.worktrees[0].hasAttachedPty = false;
  Object.assign(payload.result.worktrees[0].agents[0], { state: 'done', hasLivePty: false, updatedAt: time + 1 });
  const completed = orcaTasks(payload).tasks;
  assert.equal(completed.length, 1); store.reconcileOrca(completed);
  assert.equal(store.snapshot()[0].status, 'completed'); assert.equal(chimes, 1);
  const hook = normalizeHook({ tool: 'codex', sessionId: 'thread', event: 'PreToolUse', timestamp: time, orcaPaneKey: 'pane', orcaWorktreeId: 'work' });
  assert.equal(hook.tool, 'orca'); assert.equal(hook.agentTool, 'codex');
});
test('unknown tasks form a separate trailing group and return to active only on a fresh running event', () => {
  const store = new TaskStore(); let chimes = 0; store.on('complete', () => chimes++);
  store.ingest(evt('unknown', { id: 'uncertain' }));
  store.ingest(evt('running', { id: 'working' }));
  store.ingest(evt('completed', { id: 'finished' }));
  assert.deepEqual(store.snapshot().map(t => t.id), ['working', 'finished', 'uncertain']);
  store.ingest(evt('running', { id: 'working', updatedAt: time + 1000 }));
  assert.deepEqual(store.snapshot().map(t => t.id), ['working', 'finished', 'uncertain']);
  store.ingest(evt('running', { id: 'uncertain', updatedAt: time + 1001 }));
  assert.deepEqual(store.snapshot().map(t => t.id), ['uncertain', 'working', 'finished']);
  assert.equal(store.snapshot().find(t => t.id === 'uncertain').status, 'running');
  assert.equal(chimes, 0);
});
