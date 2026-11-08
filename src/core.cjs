const { EventEmitter } = require('node:events');
const path = require('node:path');

const TOOLS = ['codex', 'claude', 'cursor', 'orca'];
const ACTIVE = new Set(['starting', 'running', 'waiting']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const text = (v, limit = 180) => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, limit) : '';

function normalizeHook(input) {
  if (!input || !TOOLS.includes(input.tool) || !text(input.sessionId)) return null;
  const mapping = {
    SessionStart: 'idle', sessionStart: 'idle', workspaceOpen: 'idle',
    UserPromptSubmit: 'starting', beforeSubmitPrompt: 'starting',
    PreToolUse: 'running', PostToolUse: 'running', preToolUse: 'running', postToolUse: 'running',
    PermissionRequest: 'waiting', Stop: 'completed', stop: 'completed',
    StopFailure: 'failed', Interrupt: 'interrupted', SessionEnd: 'offline', sessionEnd: 'offline'
  };
  let status = mapping[input.event];
  if (input.event === 'Notification') {
    if (!['permission_prompt', 'elicitation_dialog'].includes(input.notificationType)) return null;
    status = 'waiting';
  }
  if (!status) return null;
  if (input.event === 'stop') {
    status = ({ completed: 'completed', error: 'failed', aborted: 'interrupted' })[input.result] || 'unknown';
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < Date.now() - 24 * 3600_000 || timestamp > Date.now() + 60_000) return null;
  const viaOrca = text(input.orcaPaneKey);
  return {
    id: viaOrca ? `orca:${text(input.orcaWorktreeId, 500)}:${viaOrca}` : `${input.tool}:${text(input.sessionId)}`,
    tool: viaOrca ? 'orca' : input.tool, agentTool: viaOrca ? input.tool : undefined, sessionId: text(input.sessionId), turnId: text(input.turnId), status,
    title: text(input.title), cwd: text(input.cwd, 1000), model: text(input.model, 80),
    source: viaOrca ? 'orca-hook' : 'hook', eventId: text(input.id), updatedAt: timestamp,
    detail: text(input.toolName, 80)
  };
}

function orcaTasks(payload, now = Date.now()) {
  if (!payload?.ok || !Array.isArray(payload.result?.worktrees)) throw new Error('Orca 返回格式无法识别');
  const tasks = [];
  for (const workspace of payload.result.worktrees) {
    if (workspace.hostId !== 'local' || workspace.isArchived) continue;
    for (const agent of workspace.agents || []) {
      if (!agent.paneKey) continue;
      const live = agent.hasLivePty === true || (workspace.hasAttachedPty === true && agent.hasLivePty !== false);
      const state = agent.state || agent.mainAgent?.state;
      const finished = ['done', 'completed', 'error', 'failed'].includes(state);
      if (!live && !(finished && Number(agent.updatedAt) >= now - 86400_000)) continue;
      const map = { working: 'running', running: 'running', thinking: 'running', starting: 'starting',
        waiting: 'waiting', 'needs-input': 'waiting', needs_input: 'waiting', permission: 'waiting',
        done: 'completed', completed: 'completed', idle: 'idle', error: 'failed', failed: 'failed' };
      let status = map[state] || 'unknown';
      if (agent.interrupted && !ACTIVE.has(status)) status = 'interrupted';
      tasks.push({
        id: `orca:${workspace.worktreeId}:${agent.paneKey}`, tool: 'orca', agentTool: text(agent.agentType, 40),
        sessionId: agent.paneKey, status, source: 'orca',
        title: text(agent.taskTitle || agent.conversationName || agent.displayName || agent.prompt) || `${workspace.displayName || workspace.repo} 任务`,
        cwd: text(workspace.path, 1000), detail: text(agent.toolName, 80),
        observedAt: now, updatedAt: Number(agent.updatedAt) || now,
        stateStartedAt: Number(agent.stateStartedAt || agent.mainAgent?.stateStartedAt) || now
      });
    }
  }
  return { tasks, truncated: Boolean(payload.result.truncated), omittedHosts: payload.result.hostScope?.omittedHostIds || [] };
}

class TaskStore extends EventEmitter {
  constructor() { super(); this.tasks = new Map(); this.seen = new Set(); this.cleared = new Map(); this.nextOrder = 0; }
  ingest(event, { silent = false } = {}) {
    if (!event) return false;
    const cleared = this.cleared.get(event.id);
    if (cleared) {
      if ((ACTIVE.has(event.status) && event.updatedAt > cleared.updatedAt) || (event.turnId && event.turnId !== cleared.turnId)) this.cleared.delete(event.id);
      else return false;
    }
    if (event.eventId && this.seen.has(event.eventId)) return false;
    if (event.eventId) { this.seen.add(event.eventId); if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value); }
    const prev = this.tasks.get(event.id);
    if (prev && event.updatedAt < prev.updatedAt) return false;
    // An Orca poll can lag a hook. Never let an older poll regress that event.
    const sameTurn = !event.turnId || !prev?.turnId || event.turnId === prev.turnId;
    if (prev && !sameTurn && ACTIVE.has(prev.status) && TERMINAL.has(event.status)) return false;
    if (prev && TERMINAL.has(prev.status) && ACTIVE.has(event.status) && event.source === 'orca' && event.stateStartedAt <= prev.endedAt) return false;
    if (prev && sameTurn && TERMINAL.has(prev.status) && ['running', 'waiting'].includes(event.status) && event.source !== 'orca' && event.updatedAt - prev.updatedAt < 1500) return false;
    let status = event.status;
    if (status === 'offline' && prev && ACTIVE.has(prev.status)) status = 'unknown';
    // A fresh idle event is just an open session, not a task.
    if (!prev && status === 'idle') return false;
    const starts = ACTIVE.has(status) && (!prev || !ACTIVE.has(prev.status) || !sameTurn);
    const current = {
      ...prev, ...event, status,
      displayOrder: prev?.displayOrder ?? this.nextOrder++,
      turnId: starts ? (event.turnId || '') : (event.turnId || prev?.turnId || ''),
      title: event.title || prev?.title || `${event.tool} · ${path.basename(event.cwd || '') || '新任务'}`,
      cwd: event.cwd || prev?.cwd || '', model: event.model || prev?.model || '',
      startedAt: starts ? (event.stateStartedAt || event.updatedAt) : (prev?.startedAt || event.stateStartedAt || event.updatedAt),
      endedAt: TERMINAL.has(status) ? (prev?.status === status ? prev.endedAt : event.updatedAt) : null,
      observedAt: event.observedAt || event.updatedAt,
      revision: (prev?.revision || 0) + (prev?.status !== status ? 1 : 0)
    };
    this.tasks.set(event.id, current);
    this.prune();
    this.emit('change', current);
    if (!silent && prev && ACTIVE.has(prev.status) && status === 'completed') this.emit('complete', current);
    return true;
  }
  markSourceUnknown(source, detail) {
    for (const task of this.tasks.values()) {
      if (task.source === source && ACTIVE.has(task.status)) {
        this.tasks.set(task.id, { ...task, status: 'unknown', detail, observedAt: Date.now() });
      }
    }
    this.emit('change');
  }
  reconcileOrca(tasks, { complete = true, silent = false } = {}) {
    const present = new Set(tasks.map(t => t.id));
    for (const task of tasks) this.ingest(task, { silent });
    if (complete) for (const task of this.tasks.values()) {
      if (['orca', 'orca-hook'].includes(task.source) && !present.has(task.id) && ACTIVE.has(task.status)) {
        this.tasks.set(task.id, { ...task, status: 'unknown', detail: '会话已离线', observedAt: Date.now() });
      }
    }
    this.emit('change');
  }
  expire(now = Date.now()) {
    for (const task of this.tasks.values()) {
      if (task.source === 'hook' && ACTIVE.has(task.status) && now - task.observedAt > 30 * 60_000) {
        this.tasks.set(task.id, { ...task, status: 'unknown', detail: '30 分钟未收到事件', observedAt: now });
      }
    }
  }
  clearHistory() {
    for (const [id, t] of this.tasks) if (!ACTIVE.has(t.status)) {
      this.cleared.set(id, { updatedAt: t.updatedAt, turnId: t.turnId || '' }); this.tasks.delete(id);
    }
    while (this.cleared.size > 500) this.cleared.delete(this.cleared.keys().next().value);
    this.emit('change');
  }
  prune() {
    const history = [...this.tasks.values()].filter(t => !ACTIVE.has(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of history.slice(80)) this.tasks.delete(t.id);
  }
  snapshot() {
    const group = task => ACTIVE.has(task.status) ? 0 : task.status === 'unknown' ? 2 : 1;
    return [...this.tasks.values()].sort((a, b) => group(a) - group(b) || a.displayOrder - b.displayOrder);
  }
  serialize() { return { tasks: this.snapshot().filter(t => !t.isDemo).slice(0, 100), cleared: [...this.cleared] }; }
  restore(tasks) {
    if (tasks && !Array.isArray(tasks)) {
      this.cleared = new Map(Array.isArray(tasks.cleared) ? tasks.cleared.slice(-500) : []);
      tasks = tasks.tasks;
    }
    for (const task of Array.isArray(tasks) ? tasks.slice(0, 100) : []) {
      if (TOOLS.includes(task.tool) && typeof task.id === 'string') {
        const displayOrder = Number.isFinite(task.displayOrder) ? task.displayOrder : this.nextOrder;
        this.nextOrder = Math.max(this.nextOrder, displayOrder + 1);
        const viaOrca = task.source === 'orca' || task.source === 'orca-hook';
        this.tasks.set(task.id, { ...task, displayOrder, tool: viaOrca ? 'orca' : task.tool, agentTool: task.agentTool || (viaOrca && task.tool !== 'orca' ? task.tool : undefined), status: ACTIVE.has(task.status) ? 'unknown' : task.status });
      }
    }
  }
}
module.exports = { TOOLS, ACTIVE, TERMINAL, normalizeHook, orcaTasks, TaskStore };
