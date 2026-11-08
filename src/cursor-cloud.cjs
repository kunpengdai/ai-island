const { ACTIVE } = require('./core.cjs');
const STATUS = { CREATING: 'starting', RUNNING: 'running', WAITING_FOR_BACKGROUND_WORK: 'running', FINISHED: 'completed', ERROR: 'failed', CANCELLED: 'interrupted', EXPIRED: 'unknown' };
const clean = (value, max = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max) : '';
function cursorCloudTask(agent, run) {
  if (!agent?.id || !run?.id || typeof run.status !== 'string') throw new Error('Cursor 云端任务数据格式无法识别');
  const updatedAt = Date.parse(run.updatedAt || run.createdAt);
  const startedAt = Date.parse(run.createdAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(startedAt)) throw new Error('Cursor 云端任务时间格式无法识别');
  const status = STATUS[run.status] || 'unknown';
  return {
    id: `cursor-cloud:${clean(agent.id, 180)}`, sessionId: clean(agent.id, 180), turnId: clean(run.id, 180),
    tool: 'cursor', source: 'cursor-cloud', title: clean(agent.name) || 'Cursor 云端任务',
    status, updatedAt, observedAt: updatedAt, stateStartedAt: startedAt,
    cwd: clean(run.git?.branches?.[0]?.repoUrl, 1000) || 'Cursor Cloud',
    detail: ({ CREATING: '云端环境启动中', RUNNING: '云端任务运行中', WAITING_FOR_BACKGROUND_WORK: '后台工作运行中', FINISHED: '云端任务已完成', ERROR: '云端任务失败', CANCELLED: '云端任务已取消', EXPIRED: '云端任务已过期' })[run.status] || '未知的云端状态'
  };
}
class CursorCloudMonitor {
  constructor({ fetchImpl = globalThis.fetch, key = '' } = {}) { this.fetchImpl = fetchImpl; this.key = key; this.cache = new Map(); }
  async get(route) {
    let response;
    try {
      response = await this.fetchImpl(`https://api.cursor.com${route}`, {
        method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${this.key}:`).toString('base64')}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000), redirect: 'error'
      });
    } catch { throw new Error('无法连接 Cursor 云端 API，请检查网络'); }
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? 'Cursor API Key 无效或没有云端任务读取权限' : response.status === 429 ? 'Cursor API 请求过于频繁，将稍后重试' : `Cursor 云端 API 暂不可用（${response.status}）`);
      error.status = response.status; throw error;
    }
    try { return await response.json(); } catch { throw new Error('Cursor 云端 API 返回格式无法识别'); }
  }
  async poll(now = Date.now()) {
    if (!this.key) return { tasks: [], truncated: false };
    const agents = []; let cursor, truncated = false;
    for (let page = 0; page < 5; page++) {
      const data = await this.get(`/v1/agents?limit=100&includeArchived=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(data.items)) throw new Error('Cursor 云端列表格式无法识别');
      agents.push(...data.items);
      cursor = data.nextCursor;
      if (!cursor) break;
      if (page === 4) truncated = true;
    }
    const recent = agents.filter(a => a.latestRunId && a.status !== 'ARCHIVED' && (a.status === 'ACTIVE' || Date.parse(a.updatedAt) >= now - 86400_000 || this.cache.has(a.latestRunId)));
    const tasks = []; let next = 0;
    const worker = async () => {
      while (next < recent.length) {
        const agent = recent[next++];
        let task = this.cache.get(agent.latestRunId);
        if (!task || ACTIVE.has(task.status) || task.status === 'unknown') {
          const data = await this.get(`/v1/agents/${encodeURIComponent(agent.id)}/runs/${encodeURIComponent(agent.latestRunId)}`);
          const run = data.run || data;
          if (run.id !== agent.latestRunId) throw new Error('Cursor 云端运行标识不匹配');
          task = cursorCloudTask(agent, run); this.cache.set(agent.latestRunId, task);
        }
        tasks.push({ ...task, title: clean(agent.name) || task.title });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, recent.length) }, worker));
    return { tasks, truncated };
  }
}
module.exports = { CursorCloudMonitor, cursorCloudTask };
