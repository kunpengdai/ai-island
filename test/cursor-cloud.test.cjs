const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CursorCloudMonitor, cursorCloudTask } = require('../src/cursor-cloud.cjs');
const now = new Date().toISOString();
const agent = { id: 'bc-one', name: '云端测试任务', status: 'ACTIVE', latestRunId: 'run-one', updatedAt: now };
const run = status => ({ id: 'run-one', status, createdAt: now, updatedAt: now, result: 'private result is not retained' });

test('Cursor v1 uses run status, and background work is running rather than user interaction', () => {
  assert.equal(cursorCloudTask({ ...agent, status: 'IDLE' }, run('ERROR')).status, 'failed');
  assert.equal(cursorCloudTask(agent, run('FINISHED')).status, 'completed');
  assert.equal(cursorCloudTask(agent, run('WAITING_FOR_BACKGROUND_WORK')).status, 'running');
  assert.equal(cursorCloudTask(agent, run('CANCELLED')).status, 'interrupted');
  assert.equal(cursorCloudTask(agent, run('EXPIRED')).status, 'unknown');
  assert.equal(cursorCloudTask(agent, run('future-status')).status, 'unknown');
  assert.equal(JSON.stringify(cursorCloudTask(agent, run('FINISHED'))).includes('private result'), false);
});
test('Cursor cloud adapter only GETs official endpoints, follows pages and rechecks active runs', async () => {
  const requests = []; let status = 'RUNNING';
  const monitor = new CursorCloudMonitor({ key: 'test-key-not-real', fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, auth: options.headers.Authorization });
    const parsed = new URL(url);
    let data;
    if (parsed.pathname === '/v1/agents') data = parsed.searchParams.has('cursor') ? { items: [] } : { items: [agent], nextCursor: 'page two' };
    else data = run(status);
    return { ok: true, json: async () => data };
  } });
  assert.equal((await monitor.poll()).tasks[0].status, 'running');
  status = 'FINISHED';
  assert.equal((await monitor.poll()).tasks[0].status, 'completed');
  assert.ok(requests.every(r => new URL(r.url).origin === 'https://api.cursor.com' && r.method === 'GET'));
  assert.ok(requests.some(r => r.url.includes('cursor=page%20two')));
  assert.ok(requests.every(r => r.auth === `Basic ${Buffer.from('test-key-not-real:').toString('base64')}`));
  const before = requests.filter(r => r.url.includes('/runs/')).length;
  await monitor.poll();
  assert.equal(requests.filter(r => r.url.includes('/runs/')).length, before, 'finished run details are cached');
});
test('cloud auth/network failures do not echo credentials or mark a task completed', async () => {
  const monitor = new CursorCloudMonitor({ key: 'test-key-not-real', fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(() => monitor.poll(), error => error.status === 401 && !error.message.includes('test-key'));
  const offline = new CursorCloudMonitor({ key: 'test-key-not-real', fetchImpl: async () => { throw new Error('private request detail'); } });
  await assert.rejects(() => offline.poll(), error => !error.message.includes('private request'));
  assert.deepEqual(await new CursorCloudMonitor().poll(), { tasks: [], truncated: false });
});
