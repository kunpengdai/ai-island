const $ = id => document.getElementById(id);
const api = window.island;
let state = { tasks: [], settings: {}, sources: {}, expanded: false };
let page = 'tasks', filter = 'all', selectedTool = 'all', audioContext, toastTimer, cloudConnectError = '', pending = new Set();
let lastStripMarkup = '', lastIntegrationMarkup = '';
const taskNodes = new Map();
const unknownGroupHeader = document.createElement('div');
unknownGroupHeader.className = 'task-group-heading';
unknownGroupHeader.dataset.group = 'unknown';
unknownGroupHeader.setAttribute('role', 'heading');
unknownGroupHeader.setAttribute('aria-level', '2');
const names = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', orca: 'Orca' };
const active = new Set(['starting', 'running', 'waiting']);
const statuses = { starting: '正在开始', running: '运行中', waiting: '待交互', completed: '已完成', failed: '运行失败', interrupted: '已中断', idle: '空闲', offline: '已离线', unknown: '状态未知' };
const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
  codex: svg('<path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 4l-4 16"/>'),
  claude: svg('<path d="m12 2 1 7 5-5-3 7 7-1-7 3 5 5-7-3 1 7-3-7-5 5 3-7-7 1 7-3-5-5 7 3z"/>'),
  cursor: svg('<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10M12 2v10M3 17l9-5 9 5"/>'),
  orca: svg('<path d="M3 14c4 0 4-9 10-9 4 0 7 4 8 9-2-1-4-1-5 1-3 5-9 5-13-1Z"/><path d="M10 16c1-2 3-3 6-1M14 5l1-3"/>'),
  volume: svg('<path d="m11 5-6 4H2v6h3l6 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>'),
  mute: svg('<path d="m11 5-6 4H2v6h3l6 4zM17 9l5 6M22 9l-5 6"/>'),
  expand: svg('<path d="m8 10 4 4 4-4"/>'), collapse: svg('<path d="m8 14 4-4 4 4"/>'),
  hide: svg('<path d="M5 12h14"/>'), quit: svg('<path d="M12 3v9M6 5a9 9 0 1 0 12 0"/>'),
  folder: svg('<path d="M3 7h7l2 3h9v10H3zM3 7V4h6l3 3h8v3"/>')
};
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
async function action(name, value) { try { return await api.action(name, value); } catch (e) { toast(e.message.replace(/^Error invoking remote method.*?: Error: /, '')); return null; } }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
function showPage(value) { page = value; renderPage(); }
function renderPage() {
  $('tasks-page').hidden = page !== 'tasks'; $('settings-page').hidden = page !== 'settings';
  document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('selected', el.dataset.page === page); el.setAttribute('aria-current', el.dataset.page === page ? 'page' : 'false'); });
}
function sourceLabel(tool) {
  const source = state.sources[tool] || {};
  if (tool === 'cursor' && ['connected', 'partial'].includes(source.cloudStatus)) return '云端已连接';
  if (tool === 'cursor' && source.running && source.cloudWindows && !source.cloudConfigured) return '云端待连接';
  if (tool === 'cursor' && source.installed && source.running && source.status !== 'connected') return '本机已就绪';
  return ({ connected: '已连接', checking: '检测中', partial: '部分连接', offline: '等待连接', unavailable: '未找到 CLI', listening: '等待事件', 'not-installed': source.running ? '待接入 · 已打开' : '待接入' })[source.status] || '待接入';
}
function duration(task) {
  const end = task.endedAt || (active.has(task.status) ? Date.now() : task.observedAt || task.updatedAt);
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderTasks() {
  let tasks = selectedTool === 'all' ? state.tasks : state.tasks.filter(t => t.tool === selectedTool);
  if (filter === 'active') tasks = tasks.filter(t => active.has(t.status));
  if (filter === 'waiting') tasks = tasks.filter(t => t.status === 'waiting');
  if (filter === 'completed') tasks = tasks.filter(t => t.status === 'completed');
  if (filter === 'unknown') tasks = tasks.filter(t => t.status === 'unknown');
  const list = $('task-list'), scrollTop = list.scrollTop;
  const setText = (el, value) => { const text = String(value ?? ''); if (el.textContent !== text) el.textContent = text; };
  const setClass = (el, value) => { if (el.className !== value) el.className = value; };
  const currentIds = new Set(state.tasks.map(t => t.id));
  for (const [id, entry] of taskNodes) if (!currentIds.has(id)) { entry.node.remove(); taskNodes.delete(id); }
  const desiredNodes = [];
  const unknownCount = tasks.filter(t => t.status === 'unknown').length;
  let unknownHeadingAdded = false;
  for (const task of tasks) {
    if (filter === 'all' && task.status === 'unknown' && !unknownHeadingAdded) {
      setText(unknownGroupHeader, `状态未知 · ${unknownCount}`);
      desiredNodes.push(unknownGroupHeader); unknownHeadingAdded = true;
    }
    let entry = taskNodes.get(task.id);
    if (!entry) {
      const node = document.createElement('article'); node.dataset.taskId = task.id;
      node.innerHTML = `<div class="task-top"><span class="tool-icon"></span><span class="task-tool"></span><span class="task-source"></span><span class="task-status"><i></i><span class="status-label"></span></span></div><div class="task-title"></div><div class="task-meta"><span class="task-project">${icons.folder}<span class="project-name"></span></span><span class="task-detail"></span><time class="task-time"></time></div>`;
      entry = { node, icon: node.querySelector('.tool-icon'), tool: node.querySelector('.task-tool'), source: node.querySelector('.task-source'), status: node.querySelector('.task-status'), label: node.querySelector('.status-label'), title: node.querySelector('.task-title'), project: node.querySelector('.task-project'), projectName: node.querySelector('.project-name'), detail: node.querySelector('.task-detail'), time: node.querySelector('.task-time') };
      entry.time.dataset.time = task.id; taskNodes.set(task.id, entry);
    }
    setClass(entry.node, `task-card ${task.status}`);
    if (entry.icon.dataset.iconTool !== task.tool) { entry.icon.innerHTML = icons[task.tool] || icons.orca; entry.icon.dataset.iconTool = task.tool; setClass(entry.icon, `tool-icon ${task.tool}`); }
    setText(entry.tool, names[task.tool]);
    setText(entry.source, task.isDemo ? '演示' : task.tool === 'orca' ? names[task.agentTool] || task.agentTool || 'Agent' : task.source === 'codex-desktop' ? 'Desktop' : task.source === 'cursor-cloud' ? 'Cloud' : 'Hooks');
    setClass(entry.status, `task-status ${task.status}`); setText(entry.label, statuses[task.status] || '状态未知');
    setText(entry.title, task.title); if (entry.title.title !== task.title) entry.title.title = task.title;
    const project = task.cwd?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '本机会话';
    setText(entry.projectName, project); if (entry.project.title !== task.cwd) entry.project.title = task.cwd || '';
    setText(entry.detail, task.detail); setText(entry.time, duration(task));
    desiredNodes.push(entry.node);
  }
  const visibleNodes = new Set(desiredNodes);
  for (const child of [...list.children]) if (!visibleNodes.has(child)) child.remove();
  let nextNode = list.firstElementChild;
  for (const node of desiredNodes) {
    if (node === nextNode) nextNode = nextNode.nextElementSibling;
    else list.insertBefore(node, nextNode);
  }
  if (list.scrollTop !== scrollTop) list.scrollTop = scrollTop;
  $('empty-state').hidden = tasks.length > 0;
  $('task-list').hidden = tasks.length === 0;
  if (!tasks.length && state.tasks.length) {
    $('empty-state').querySelector('h2').textContent = ({ all: '这个工具暂时没有任务', active: '暂时没有进行中的任务', waiting: '暂时没有待交互的任务', completed: '还没有完成的任务', unknown: '没有状态未知的任务' })[filter];
    $('empty-state').querySelector('p').textContent = '新的任务动态会自动显示在这里。';
    $('empty-state').querySelector('.empty-actions').hidden = true;
  } else {
    $('empty-state').querySelector('h2').textContent = '下一次灵感，从这里开始';
    $('empty-state').querySelector('p').textContent = '连接你的编程工具，任务状态会自动汇集到这里。';
    $('empty-state').querySelector('.empty-actions').hidden = false;
  }
}
function setSwitch(id, value) { $(id).classList.toggle('on', Boolean(value)); $(id).setAttribute('aria-checked', String(Boolean(value))); }
function render() {
  $('island').classList.toggle('open', state.expanded);
  $('expanded-content').hidden = !state.expanded;
  $('summary').setAttribute('aria-expanded', String(state.expanded));
  $('expand').innerHTML = state.expanded ? icons.collapse : icons.expand;
  $('expand').setAttribute('aria-label', state.expanded ? '收起' : '展开');
  $('mute').innerHTML = state.settings.sound ? icons.volume : icons.mute;
  $('mute').setAttribute('aria-label', state.settings.sound ? '关闭提示音' : '打开提示音');
  const running = state.tasks.filter(t => active.has(t.status));
  const waiting = running.filter(t => t.status === 'waiting');
  const done = state.tasks.filter(t => t.status === 'completed');
  const recentDone = done.some(t => Date.now() - t.endedAt < 12000);
  const workingCount = running.length - waiting.length;
  $('summary-running').textContent = workingCount;
  $('summary-waiting').textContent = waiting.length;
  $('summary-completed').textContent = done.length;
  for (const [key, count] of [['working', workingCount], ['waiting', waiting.length], ['completed', done.length]]) document.querySelector(`.summary-metric.${key}`).classList.toggle('has-tasks', count > 0);
  $('summary').setAttribute('aria-label', `运行中 ${workingCount}，待交互 ${waiting.length}，已完成 ${done.length}，${state.expanded ? '收起' : '展开'}任务面板`);
  $('activity').className = `mini-activity ${running.some(t => t.status !== 'waiting') ? 'busy' : recentDone ? 'done' : ''}`;
  $('greeting').textContent = waiting.length ? '有个任务，需要你。' : running.length ? '灵感正在变成现实。' : '让专注，不被打断。';
  $('overview-caption').textContent = running.length ? `${running.length} 个任务正在推进${waiting.length ? `，${waiting.length} 个等待确认` : '，完成时会提醒你'}。` : '任务交给 AI，进度留在这里。';
  const scopedTasks = selectedTool === 'all' ? state.tasks : state.tasks.filter(t => t.tool === selectedTool);
  $('task-count').textContent = scopedTasks.length;
  $('active-count').textContent = scopedTasks.filter(t => active.has(t.status)).length; $('completed-count').textContent = scopedTasks.filter(t => t.status === 'completed').length;
  $('waiting-count').textContent = scopedTasks.filter(t => t.status === 'waiting').length;
  $('unknown-count').textContent = scopedTasks.filter(t => t.status === 'unknown').length;
  const strip = Object.keys(names).map(t => `<button class="tool-chip ${selectedTool === t ? 'selected' : ''}" data-tool="${t}" aria-pressed="${selectedTool === t}" title="筛选 ${names[t]} 任务 · ${sourceLabel(t)}"><span class="tool-icon tool-mini ${t}">${icons[t]}</span><span class="tool-chip-name">${t === 'claude' ? 'Claude' : names[t]} <b class="tool-count">${state.tasks.filter(task => task.tool === t && active.has(task.status)).length}</b><span class="chip-state ${['connected', 'partial'].includes(state.sources[t]?.status) ? 'connected' : ''}">${sourceLabel(t)}</span></span></button>`).join('');
  if (lastStripMarkup !== strip) { lastStripMarkup = strip; $('tool-strip').innerHTML = strip; }
  for (const chip of $('tool-strip').querySelectorAll('[data-tool]')) {
    const source = state.sources[chip.dataset.tool];
    if (source?.lastEventAt) chip.title = `${names[chip.dataset.tool]} · ${sourceLabel(chip.dataset.tool)} · 最近同步 ${new Date(source.lastEventAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  }
  const integrationHtml = Object.keys(names).map(t => {
    const s = state.sources[t] || {};
    const label = t === 'orca' ? (s.detail || '等待 Orca CLI') : t === 'codex' && s.desktopSessions ? s.detail : t === 'cursor' && s.running && s.cloudWindows && !s.cloudConfigured ? `检测到 ${s.cloudWindows} 个云端窗口 · 下方连接云端` : s.installed ? (s.lastEventAt ? '已接收到本机任务事件' : t === 'cursor' && s.running ? '本机钩子已就绪 · 等待新任务' : '已安装 · 等待首个事件') : (s.running ? '工具已打开 · 需要安装钩子' : '安装钩子以接收任务事件');
    return `<div class="integration-row"><span class="tool-icon ${t}">${icons[t]}</span><div class="integration-info"><div class="integration-name">${names[t]}</div><div class="integration-status ${s.status === 'connected' ? 'connected' : ''}">${escapeHtml(label)}</div></div>${t === 'orca' ? `<span class="integration-status">${sourceLabel(t)}</span>` : `<button class="integration-button ${s.installed ? 'installed' : ''}" data-integrate="${t}" ${pending.has(t) ? 'disabled' : ''}>${pending.has(t) ? '处理中' : s.installed ? '移除接入' : '接入'}</button>`}</div>`;
  }).join('');
  if (lastIntegrationMarkup !== integrationHtml) { lastIntegrationMarkup = integrationHtml; $('integration-list').innerHTML = integrationHtml; }
  setSwitch('sound-toggle', state.settings.sound); setSwitch('notification-toggle', state.settings.notifications); setSwitch('top-toggle', state.settings.alwaysOnTop); setSwitch('startup-toggle', state.settings.launchAtLogin);
  $('startup-toggle').disabled = !state.packaged;
  $('startup-note').textContent = state.packaged ? '登录 Windows 时自动打开' : '便携版支持，开发模式暂不可用';
  if (document.activeElement !== $('volume')) $('volume').value = state.settings.volume ?? 55;
  $('volume-label').textContent = `音量 ${state.settings.volume ?? 55}%`;
  $('shortcut-label').textContent = state.shortcut ? '展开 / 收起' : '快捷键被占用';
  const cloud = state.sources.cursor || {};
  $('cursor-cloud-status').textContent = cloudConnectError || cloud.cloudDetail || ({ connected: '已连接', partial: '部分同步', checking: '正在连接', error: '连接失败' })[cloud.cloudStatus] || (cloud.cloudWindows ? '需要 Cursor API Key' : '未连接云端');
  $('cursor-cloud-disconnect').hidden = !cloud.cloudConfigured;
  $('cursor-cloud-key').placeholder = cloud.cloudConfigured ? '已加密保存，输入新 Key 可更换' : '输入 Cursor API Key';
  renderTasks(); renderPage();
}
function playChime({ volume }) {
  try {
    audioContext ||= new AudioContext(); audioContext.resume();
    const now = audioContext.currentTime;
    [659.25, 880].forEach((frequency, i) => {
      const osc = audioContext.createOscillator(), gain = audioContext.createGain();
      osc.type = 'sine'; osc.frequency.value = frequency;
      const start = now + i * .16, level = Math.max(0, Math.min(100, volume)) / 100 * .16;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(level, start + .018); gain.gain.exponentialRampToValueAtTime(.0001, start + .65);
      osc.connect(gain); gain.connect(audioContext.destination); osc.start(start); osc.stop(start + .7);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    });
  } catch (e) { toast(`无法播放提示音：${e.message}`); }
}
$('hide').innerHTML = icons.hide; $('quit').innerHTML = icons.quit;
$('summary').onclick = $('expand').onclick = () => action('expand', !state.expanded);
$('mute').onclick = () => action('settings', { sound: !state.settings.sound });
$('hide').onclick = () => action('hide'); $('quit').onclick = () => action('quit');
$('clear-history').onclick = () => action('clear');
$('connect-tools').onclick = () => showPage('settings');
$('demo').onclick = $('settings-demo').onclick = () => { showPage('tasks'); filter = 'all'; selectedTool = 'all'; updateFilters(); action('demo'); };
$('tool-strip').onclick = e => {
  const chip = e.target.closest('[data-tool]'); if (!chip) return;
  if (chip.dataset.tool === 'cursor' && state.sources.cursor?.cloudWindows && !state.sources.cursor.cloudConfigured && !state.tasks.some(t => t.tool === 'cursor' && active.has(t.status))) {
    showPage('settings'); document.querySelector('.cloud-connection').scrollIntoView({ block: 'center' }); return;
  }
  selectedTool = selectedTool === chip.dataset.tool ? 'all' : chip.dataset.tool; showPage('tasks'); render();
};
document.querySelectorAll('[data-page]').forEach(el => el.onclick = () => showPage(el.dataset.page));
function updateFilters() { document.querySelectorAll('[data-filter]').forEach(el => el.classList.toggle('selected', filter === el.dataset.filter)); renderTasks(); }
document.querySelectorAll('[data-filter]').forEach(el => el.onclick = () => { filter = el.dataset.filter; updateFilters(); });
$('integration-list').onclick = async e => {
  const button = e.target.closest('[data-integrate]'); if (!button) return;
  const tool = button.dataset.integrate; if (pending.has(tool)) return;
  pending.add(tool); render();
  const removing = state.sources[tool]?.installed;
  const result = await action(removing ? 'uninstall' : 'install', tool);
  pending.delete(tool); render();
  if (result !== null) toast(removing ? `${names[tool]} 接入已移除。重启工具后生效。` : `${names[tool]} 钩子已安装，原配置已备份。\n重启工具${tool === 'codex' ? '，并在 /hooks 中信任新增钩子' : '后开始接收任务事件'}。`);
};
for (const [id, key] of [['sound-toggle', 'sound'], ['notification-toggle', 'notifications'], ['top-toggle', 'alwaysOnTop'], ['startup-toggle', 'launchAtLogin']]) $(id).onclick = () => action('settings', { [key]: !state.settings[key] });
$('volume').oninput = () => $('volume-label').textContent = `音量 ${$('volume').value}%`;
$('volume').onchange = () => action('settings', { volume: Number($('volume').value) });
$('test-sound').onclick = () => action('test-sound'); $('next-display').onclick = () => action('next-display'); $('reset-position').onclick = () => action('reset-position');
$('refresh-sources').onclick = async () => { const button = $('refresh-sources'); button.disabled = true; try { await action('refresh-sources'); } finally { button.disabled = false; } };
$('cursor-cloud-dashboard').onclick = () => action('cursor-cloud-dashboard');
$('cursor-cloud-disconnect').onclick = () => action('cursor-cloud-disconnect');
$('cursor-cloud-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('cursor-cloud-connect'); if (button.disabled) return;
  cloudConnectError = '';
  button.disabled = true; button.textContent = '连接中';
  const key = $('cursor-cloud-key').value; $('cursor-cloud-key').value = '';
  try { const result = await api.action('cursor-cloud-connect', key); if (result?.connected) toast(`Cursor 云端已连接，已同步 ${result.tasks} 个任务。`); }
  catch (error) { cloudConnectError = error.message.replace(/^Error invoking remote method.*?: Error: /, ''); $('cursor-cloud-status').textContent = cloudConnectError; toast(cloudConnectError); }
  finally { button.disabled = false; button.textContent = '连接云端'; }
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') action('expand', false); });
api.onState(next => { state = next; render(); });
api.onChime(playChime);
action('state').then(next => { if (next) { state = next; render(); } });
setInterval(() => {
  document.querySelectorAll('[data-time]').forEach(el => { const task = state.tasks.find(t => t.id === el.dataset.time); if (task) el.textContent = duration(task); });
  if (!state.tasks.some(t => active.has(t.status))) render();
}, 1000);
