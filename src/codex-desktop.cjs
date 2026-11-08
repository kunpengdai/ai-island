const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ACTIVE } = require('./core.cjs');

const MAX_READ = 4 * 1024 * 1024;
const clean = (value, max = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max) : '';

// The desktop app's rollout records are a local compatibility adapter. Only
// explicit lifecycle events determine completion; assistant text never does.
class DesktopSession {
  constructor(meta) {
    this.meta = meta;
    this.task = null;
    this.pendingInput = null;
    this.expectTitle = false;
  }
  accept(record) {
    const payload = record?.payload;
    const at = Date.parse(record?.timestamp);
    if (!payload || !Number.isFinite(at)) return;
    const turnId = clean(payload.turn_id || payload.turn?.id, 180);
    const current = this.task;
    const begin = () => {
      this.task = {
        id: `codex:${this.meta.id}`, sessionId: this.meta.id, tool: 'codex', source: 'codex-desktop',
        status: 'running', title: current?.title || `Codex · ${path.basename(this.meta.cwd || '') || '桌面任务'}`,
        cwd: this.meta.cwd || '', model: current?.model || '', turnId,
        stateStartedAt: at, updatedAt: at, observedAt: at, detail: '桌面任务运行中'
      };
      this.pendingInput = null;
      this.expectTitle = true;
    };
    if (record.type === 'event_msg') {
      const type = payload.type;
      if (['task_started', 'turn_started'].includes(type)) { begin(); return; }
      if (type === 'user_message') {
        if (!current || !ACTIVE.has(current.status)) begin();
        if (this.expectTitle) { this.task.title = clean(payload.message) || this.task.title; this.expectTitle = false; }
        this.task.updatedAt = this.task.observedAt = at;
        return;
      }
      if (!current) return;
      if (turnId && current.turnId && turnId !== current.turnId) return;
      const status = ({
        task_complete: 'completed', turn_completed: 'completed',
        turn_aborted: 'interrupted', task_aborted: 'interrupted',
        task_failed: 'failed', turn_failed: 'failed'
      })[type];
      if (status) {
        current.status = payload.turn?.status === 'failed' ? 'failed' : payload.turn?.status === 'interrupted' ? 'interrupted' : status;
        current.updatedAt = current.observedAt = at;
        current.detail = current.status === 'completed' ? '桌面任务已完成' : current.status === 'failed' ? '桌面任务失败' : '桌面任务已中断';
        this.pendingInput = null;
        return;
      }
      if (ACTIVE.has(current.status) && ['agent_message', 'agent_reasoning', 'token_count'].includes(type)) current.updatedAt = current.observedAt = at;
    } else if (record.type === 'turn_context' && current) {
      if (turnId) current.turnId = turnId;
      if (payload.model) current.model = clean(payload.model, 80);
    } else if (record.type === 'response_item' && current && ACTIVE.has(current.status)) {
      if (payload.type === 'function_call' && /(^|[._])request_user_input$/.test(payload.name || '')) {
        this.pendingInput = payload.call_id;
        current.status = 'waiting'; current.detail = '等待你回答问题';
      } else if (payload.type === 'function_call_output' && this.pendingInput && payload.call_id === this.pendingInput) {
        this.pendingInput = null; current.status = 'running'; current.detail = '桌面任务运行中';
      } else if (['function_call', 'custom_tool_call'].includes(payload.type) && !this.pendingInput) {
        current.detail = clean(payload.name, 80) || '正在使用工具';
      }
      current.updatedAt = current.observedAt = at;
    }
  }
  snapshot(now = Date.now()) {
    if (!this.task) return null;
    if (ACTIVE.has(this.task.status) && now - this.task.observedAt > 30 * 60_000) return { ...this.task, status: 'unknown', detail: '桌面会话 30 分钟未更新' };
    return { ...this.task };
  }
}

function desktopMetadata(record) {
  const meta = record?.type === 'session_meta' && record.payload;
  if (!meta || typeof meta.source === 'object' || meta.thread_source === 'subagent') return null;
  if (!/codex desktop/i.test(meta.originator || '') && meta.source !== 'vscode') return null;
  const id = clean(meta.id || meta.session_id, 180);
  if (!id) return null;
  return { id, cwd: clean(meta.cwd, 1000) };
}

async function readRange(file, start, length) {
  const fd = await fs.open(file, 'r');
  try { const data = Buffer.alloc(length); const { bytesRead } = await fd.read(data, 0, length, start); return data.subarray(0, bytesRead); }
  finally { await fd.close(); }
}

class CodexDesktopMonitor {
  constructor({ root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), discoverEvery = 5000 } = {}) {
    this.root = root; this.discoverEvery = discoverEvery; this.nextDiscovery = 0;
    this.startedAt = Date.now();
    this.files = new Set(); this.sessions = new Map(); this.ignored = new Map();
  }
  async discover(now) {
    if (now < this.nextDiscovery) return;
    this.nextDiscovery = now + this.discoverEvery;
    let entries;
    try { entries = await fs.readdir(this.root, { recursive: true, withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(entry.parentPath || entry.path, entry.name);
      if (this.sessions.has(file)) { this.files.add(file); continue; }
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= now - 86400_000 && this.ignored.get(file) !== stat.mtimeMs) candidates.push({ file, mtime: stat.mtimeMs });
      } catch { /* A concurrently removed rollout is retried on discovery. */ }
    }
    for (const item of candidates.sort((a, b) => b.mtime - a.mtime).slice(0, 200)) this.files.add(item.file);
  }
  async read(file) {
    const stat = await fs.stat(file);
    let tracked = this.sessions.get(file);
    if (!tracked) {
      const head = await readRange(file, 0, Math.min(stat.size, 1024 * 1024));
      const newline = head.indexOf(10);
      if (newline < 0) return; // Incomplete metadata: retry when the writer finishes.
      let meta;
      try { meta = desktopMetadata(JSON.parse(head.subarray(0, newline).toString('utf8'))); } catch { return; }
      if (!meta) { this.ignored.set(file, stat.mtimeMs); this.files.delete(file); return; }
      tracked = { parser: new DesktopSession(meta), offset: 0, partial: Buffer.alloc(0), skipFirst: false, mtime: 0, ready: false, pendingEvents: [] };
      this.sessions.set(file, tracked);
    }
    if (stat.size < tracked.offset) { this.sessions.delete(file); return this.read(file); }
    if (stat.size === tracked.offset && stat.mtimeMs === tracked.mtime) return;
    const chunk = await readRange(file, tracked.offset, Math.min(MAX_READ, stat.size - tracked.offset));
    tracked.offset += chunk.length; tracked.mtime = stat.mtimeMs;
    let bytes = Buffer.concat([tracked.partial, chunk]);
    if (tracked.skipFirst) {
      const next = bytes.indexOf(10);
      if (next < 0) { tracked.partial = Buffer.alloc(0); return; }
      bytes = bytes.subarray(next + 1); tracked.skipFirst = false;
    }
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      if (end - start <= 1024 * 1024) {
        try {
          const record = JSON.parse(bytes.subarray(start, end).toString('utf8'));
          const previous = tracked.parser.task;
          const oldStatus = previous?.status, oldTurn = previous?.turnId;
          tracked.parser.accept(record);
          const current = tracked.parser.task;
          if (current && (current.status !== oldStatus || current.turnId !== oldTurn)) {
            if (current.updatedAt >= this.startedAt) tracked.pendingEvents.push({ ...current });
          }
        } catch { /* Ignore malformed rows, keep following valid lifecycle events. */ }
      }
      start = end + 1;
    }
    tracked.partial = Buffer.from(bytes.subarray(start));
    if (tracked.partial.length > 1024 * 1024) { tracked.partial = Buffer.alloc(0); tracked.skipFirst = true; }
    tracked.ready = tracked.offset === stat.size;
  }
  async poll(now = Date.now()) {
    await this.discover(now);
    let errors = 0;
    for (const file of this.files) {
      try { await this.read(file); }
      catch (error) { errors++; if (error.code === 'ENOENT') { this.files.delete(file); this.sessions.delete(file); } }
    }
    const ready = [...this.sessions.values()].filter(s => s.ready);
    const tasks = ready.map(s => s.parser.snapshot(now)).filter(Boolean);
    const events = ready.flatMap(s => s.pendingEvents.splice(0)).sort((a, b) => a.updatedAt - b.updatedAt);
    return { tasks, events, errors, sessions: this.sessions.size };
  }
}
module.exports = { CodexDesktopMonitor, DesktopSession, desktopMetadata };
