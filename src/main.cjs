const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, powerMonitor, Notification, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { TaskStore, normalizeHook, orcaTasks, TOOLS, ACTIVE } = require('./core.cjs');
const integrations = require('./integrations.cjs');
const { CodexDesktopMonitor } = require('./codex-desktop.cjs');
const { CursorCloudMonitor } = require('./cursor-cloud.cjs');
const { CursorLocalMonitor } = require('./cursor-local.cjs');
const { EDGES, SIZES: sizes, contains, detectDock, windowBounds, activitySummary } = require('./window-state.cjs');

const smoke = process.argv.includes('--smoke');
if (smoke && process.env.AGENT_ISLAND_TEST_DATA) app.setPath('userData', process.env.AGENT_ISLAND_TEST_DATA);
app.setName('AI Island');
// Keep existing preferences, task history and encrypted keys after the rename.
// The hook spool also retains its old path so installed hooks keep working.
if (!smoke) {
  const legacyData = path.join(app.getPath('appData'), 'Agent Island');
  app.setPath('userData', fs.existsSync(legacyData) ? legacyData : path.join(app.getPath('appData'), 'AI Island'));
}
app.setAppUserModelId('local.ai-island.desktop');
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  let win, tray, quitting = false, expanded = false, emitTimer, saveTimer;
  const store = new TaskStore();
  const runtime = smoke ? path.join(app.getPath('userData'), 'runtime') : path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'AgentIsland');
  const eventDir = path.join(runtime, 'events');
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const historyFile = path.join(app.getPath('userData'), 'history.json');
  const cloudKeyFile = path.join(app.getPath('userData'), 'cursor-cloud-key.bin');
  const diagnosticsFile = path.join(app.getPath('userData'), 'diagnostics.json');
  const defaults = { sound: true, volume: 55, notifications: false, launchAtLogin: false, alwaysOnTop: true, displayId: null };
  let settings = { ...defaults };
  try { settings = { ...defaults, ...integrations.readJson(settingsFile) }; store.restore(integrations.readJson(historyFile, [])); } catch (e) { console.error(e.message); }
  let sources = Object.fromEntries(TOOLS.map(t => [t, { installed: false, running: false, status: 'checking', lastEventAt: null }]));
  let timers = [], orcaBusy = false, desktopBusy = false, eventsBusy = false, processesBusy = false, firstOrca = true, firstDesktop = true, firstEvents = true;
  const desktopMonitor = new CodexDesktopMonitor(smoke ? { root: path.join(runtime, 'codex-sessions'), discoverEvery: 250 } : {});
  let cloudMonitor = new CursorCloudMonitor(), cloudBusy = false, firstCloud = true, cloudRetryAt = 0;
  const cursorLocalMonitor = new CursorLocalMonitor();
  settings.dockEdge = EDGES.has(settings.dockEdge) ? settings.dockEdge : null;
  let dockHidden = Boolean(settings.dockEdge), dragging = false, applyingBounds = false, dockEditing = false, leaveAt = 0, moveTimer;
  let testCursor = { x: -100000, y: -100000 };

  function snapshot() { const tasks = store.snapshot(); return { tasks, activity: activitySummary(tasks), dock: { edge: settings.dockEdge, hidden: dockHidden }, settings, sources, expanded, packaged: app.isPackaged, platform: process.platform, shortcut: shortcutRegistered, version: app.getVersion() }; }
  function send() { if (win && !win.isDestroyed()) win.webContents.send('island:state', snapshot()); }
  function scheduleState() {
    clearTimeout(emitTimer); emitTimer = setTimeout(send, 60);
  }
  function changed() {
    scheduleState();
    if (!saveTimer) saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        integrations.atomicJson(historyFile, store.serialize());
        integrations.atomicJson(diagnosticsFile, { version: app.getVersion(), updatedAt: Date.now(), sources });
      } catch (e) { console.error(e.message); }
    }, 5000);
  }
  store.on('change', changed);
  store.on('complete', task => {
    if (settings.sound) win?.webContents.send('island:chime', { volume: settings.volume });
    if (settings.notifications && Notification.isSupported()) new Notification({ title: `${task.tool === 'claude' ? 'Claude Code' : task.tool} 已完成`, body: task.title, silent: true }).show();
  });
  function display() { return screen.getAllDisplays().find(d => d.id === settings.displayId) || screen.getPrimaryDisplay(); }
  function position() {
    applyingBounds = true;
    try {
      const area = display().workArea;
      const requested = windowBounds(area, { expanded, edge: settings.dockEdge, hidden: dockHidden, offset: settings.dockOffset, centerX: settings.centerX, top: settings.windowTop });
      win.setBounds(requested);
      // Windows can round a requested size by one DIP at fractional scale factors.
      const actual = win.getBounds();
      const x = Math.max(area.x, Math.min(actual.x, area.x + area.width - actual.width));
      const y = Math.max(area.y, Math.min(actual.y, area.y + area.height - actual.height));
      if (x !== actual.x || y !== actual.y) win.setBounds({ ...requested, x, y });
      win.setAlwaysOnTop(settings.alwaysOnTop, process.platform === 'win32' ? 'normal' : 'floating');
    }
    finally { applyingBounds = false; }
  }
  function hideDock() {
    if (!settings.dockEdge || dragging || dockEditing) return;
    dockHidden = true; expanded = false; leaveAt = 0; position(); send();
  }
  function openDock() {
    if (!settings.dockEdge || !dockHidden || dragging) return;
    dockHidden = false; expanded = true; leaveAt = 0; position(); win.showInactive(); send();
  }
  function checkDock() {
    if (!settings.dockEdge || dragging || !win || win.isDestroyed() || !win.isVisible()) return;
    const point = smoke ? testCursor : screen.getCursorScreenPoint();
    const tab = windowBounds(display().workArea, { edge: settings.dockEdge, hidden: true, offset: settings.dockOffset });
    const inside = contains(win.getBounds(), point) || contains(tab, point);
    if (inside) { leaveAt = 0; if (dockHidden) openDock(); }
    else if (!dockHidden && !dockEditing) {
      if (!leaveAt) leaveAt = Date.now();
      else if (Date.now() - leaveAt >= 650) hideDock();
    }
  }
  function finishMove() {
    if (!dragging || !win || win.isDestroyed()) return;
    dragging = false;
    const bounds = win.getBounds(), target = screen.getDisplayMatching(bounds), dock = detectDock(bounds, target.workArea);
    settings.displayId = target.id; settings.centerX = bounds.x + bounds.width / 2; settings.windowTop = bounds.y;
    settings.dockEdge = dock.edge; settings.dockOffset = dock.offset;
    dockHidden = Boolean(dock.edge); if (dockHidden) expanded = false;
    position(); saveSettings(); send();
  }
  function setExpanded(value) {
    if (settings.dockEdge) {
      if (!value) { dockEditing = false; hideDock(); }
      else { openDock(); expanded = true; dockHidden = false; leaveAt = Date.now() + 2000; position(); send(); }
      return;
    }
    expanded = Boolean(value);
    position(); send();
  }
  function reveal(open = true) { win.show(); if (open) setExpanded(true); win.focus(); }
  function saveSettings() { integrations.atomicJson(settingsFile, settings); }
  function refreshInstalled() {
    for (const t of ['codex', 'claude', 'cursor']) sources[t].installed = !smoke && integrations.installed(t);
  }
  async function pollEvents() {
    if (eventsBusy) return; eventsBusy = true;
    try {
      const files = (await fs.promises.readdir(eventDir)).filter(f => /^[a-f0-9]{32}\.json$/.test(f)).slice(0, 2000);
      const events = [];
      for (const file of files) {
        const full = path.join(eventDir, file);
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size <= 32768) {
            const event = normalizeHook(JSON.parse(await fs.promises.readFile(full, 'utf8')));
            if (event) events.push(event);
          }
          await fs.promises.unlink(full);
        } catch (e) {
          // Invalid files are quarantined by removal; a partially-written event never has .json extension.
          if (e.code !== 'ENOENT') await fs.promises.unlink(full).catch(() => {});
        }
      }
      events.sort((a, b) => a.updatedAt - b.updatedAt);
      for (const event of events) {
        sources[event.tool] = { ...sources[event.tool], running: true, status: 'connected', lastEventAt: event.updatedAt };
        store.ingest(event, { silent: firstEvents || Date.now() - event.updatedAt > 30_000 });
      }
      firstEvents = false; store.expire(); scheduleState();
    } catch (e) { console.error('events:', e.message); }
    finally { eventsBusy = false; }
  }
  async function pollOrca() {
    if (orcaBusy || smoke) return; orcaBusy = true;
    try {
      const result = orcaTasks(await integrations.pollOrca());
      const activeCount = result.tasks.filter(task => ACTIVE.has(task.status)).length;
      sources.orca = { installed: true, running: true, status: result.truncated ? 'partial' : 'connected', lastEventAt: Date.now(), taskCount: result.tasks.length, activeCount, detail: result.truncated ? '返回数量受限，部分任务未显示' : `已同步 ${activeCount} 个活动任务 · 每 3 秒刷新` };
      store.reconcileOrca(result.tasks, { complete: !result.truncated, silent: firstOrca });
      firstOrca = false;
    } catch (e) {
      const missing = e.code === 'ENOENT';
      sources.orca = { ...sources.orca, status: missing ? 'unavailable' : 'offline', running: false, detail: missing ? '未找到 Orca CLI' : `无法连接 Orca（${errorCode(e)}），等待重试` };
      store.markSourceUnknown('orca', 'Orca 连接已断开'); store.markSourceUnknown('orca-hook', 'Orca 连接已断开');
    } finally { orcaBusy = false; scheduleState(); }
  }
  async function pollProcesses() {
    if (processesBusy || smoke) return; processesBusy = true;
    try {
      const running = await integrations.detectProcesses();
      refreshInstalled();
      const cursorHealth = await cursorLocalMonitor.poll().catch(() => ({ localReady: false, remoteWindows: 0 }));
      Object.assign(sources.cursor, cursorHealth);
      for (const t of ['codex', 'claude', 'cursor']) {
        sources[t].running = Boolean(running[t]);
        sources[t].status = sources[t].desktopSessions || sources[t].cloudStatus === 'connected' || (sources[t].lastEventAt && Date.now() - sources[t].lastEventAt < 30 * 60_000) ? 'connected' : (sources[t].installed ? 'listening' : 'not-installed');
      }
    } catch (e) { console.error('processes:', e.message); }
    finally { processesBusy = false; scheduleState(); }
  }
  function errorCode(error) { return typeof error?.code === 'string' ? error.code : error?.killed ? '超时' : '暂不可用'; }
  function acceptCloud(result) {
    sources.cursor.cloudConfigured = true;
    sources.cursor.cloudStatus = result.truncated ? 'partial' : 'connected';
    sources.cursor.cloudDetail = result.truncated ? '部分云端任务已同步' : `已同步 ${result.tasks.length} 个云端任务`;
    sources.cursor.status = 'connected';
    for (const task of result.tasks) store.ingest(task, { silent: firstCloud });
    firstCloud = false; scheduleState();
  }
  async function pollCloud() {
    if (cloudBusy || !cloudMonitor.key || Date.now() < cloudRetryAt || smoke) return;
    cloudBusy = true;
    try { acceptCloud(await cloudMonitor.poll()); }
    catch (error) {
      sources.cursor.cloudStatus = 'error'; sources.cursor.cloudDetail = error.message;
      cloudRetryAt = Date.now() + (error.status === 429 ? 60000 : 15000);
      store.markSourceUnknown('cursor-cloud', '云端连接已断开，等待重试');
    } finally { cloudBusy = false; scheduleState(); }
  }
  async function pollDesktop() {
    if (desktopBusy) return; desktopBusy = true;
    try {
      const result = await desktopMonitor.poll();
      sources.codex.desktopSessions = result.sessions;
      sources.codex.desktopStatus = result.errors ? 'partial' : 'connected';
      if (result.sessions) {
        sources.codex.status = 'connected';
        sources.codex.detail = `桌面版自动接入 · ${result.sessions} 个会话`;
      }
      for (const task of result.events) store.ingest(task, { silent: firstDesktop });
      for (const task of result.tasks) store.ingest(task, { silent: firstDesktop });
      firstDesktop = false;
    } catch (error) {
      sources.codex.desktopStatus = 'offline';
      store.markSourceUnknown('codex-desktop', '桌面会话数据暂时不可用');
      console.error('codex-desktop:', error.message);
    } finally { desktopBusy = false; scheduleState(); }
  }
  function demo() {
    const now = Date.now();
    const samples = [
      { tool: 'codex', title: '实现顶部悬浮任务面板', cwd: 'C:/Projects/ai-island', status: 'running', detail: '正在验证界面' },
      { tool: 'claude', title: '检查 API 的边界情况', cwd: 'C:/Projects/atlas-api', status: 'waiting', detail: '等待你的确认' },
      { tool: 'cursor', title: '优化仪表盘加载速度', cwd: 'C:/Projects/dashboard', status: 'running', detail: '正在运行测试' }
    ];
    for (const [index, item] of samples.entries()) {
      const task = { ...item, id: `demo:${item.tool}`, sessionId: 'demo', source: 'demo', isDemo: true, updatedAt: now, stateStartedAt: now - (index + 1) * 23000 };
      store.ingest(task, { silent: true });
      const timer = setTimeout(() => {
        if (store.tasks.has(task.id)) store.ingest({ ...task, status: 'completed', detail: '演示任务已完成', updatedAt: Date.now() });
      }, (smoke ? 60000 : 5500) + index * 3000);
      timers.push(timer);
    }
    setExpanded(true);
  }
  let shortcutRegistered = false;
  const actions = {
    state: () => snapshot(),
    expand: value => setExpanded(value),
    hide: () => win.hide(),
    quit: () => { quitting = true; app.quit(); },
    clear: () => store.clearHistory(),
    'refresh-sources': async () => { await Promise.all([pollOrca(), pollProcesses(), pollDesktop(), pollCloud()]); return snapshot(); },
    demo,
    'test-sound': () => win.webContents.send('island:chime', { volume: settings.volume }),
    'cursor-cloud-dashboard': () => shell.openExternal('https://cursor.com/dashboard'),
    'cursor-cloud-connect': async value => {
      if (smoke) throw new Error('隔离测试不使用真实云端凭据');
      if (cloudBusy) throw new Error('正在同步云端状态，请稍后重试');
      const key = typeof value === 'string' ? value.trim() : '';
      if (key.length < 10 || key.length > 1024) throw new Error('请输入有效的 Cursor API Key');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密暂不可用，无法安全保存 API Key');
      cloudBusy = true;
      try {
        const candidate = new CursorCloudMonitor({ key });
        const result = await candidate.poll();
        fs.writeFileSync(cloudKeyFile, safeStorage.encryptString(key));
        cloudMonitor = candidate; firstCloud = true; cloudRetryAt = 0; acceptCloud(result);
        return { connected: true, tasks: result.tasks.length };
      } finally { cloudBusy = false; }
    },
    'cursor-cloud-disconnect': () => {
      if (cloudBusy) throw new Error('正在同步云端状态，请稍后重试');
      cloudMonitor = new CursorCloudMonitor();
      if (fs.existsSync(cloudKeyFile)) fs.unlinkSync(cloudKeyFile);
      sources.cursor.cloudConfigured = false; sources.cursor.cloudStatus = 'not-configured'; sources.cursor.cloudDetail = '';
      store.markSourceUnknown('cursor-cloud', '已断开云端连接'); pollProcesses(); send();
    },
    'dock-hover': () => openDock(),
    'dock-editing': value => { dockEditing = value === true; },
    'reset-position': () => { settings.centerX = null; settings.windowTop = null; settings.dockEdge = null; dockHidden = false; settings.displayId = screen.getPrimaryDisplay().id; position(); saveSettings(); send(); },
    'next-display': () => { const all = screen.getAllDisplays(); const index = all.findIndex(d => d.id === display().id); settings.displayId = all[(index + 1) % all.length].id; settings.centerX = null; settings.windowTop = null; settings.dockEdge = null; dockHidden = false; position(); saveSettings(); send(); },
    settings: value => {
      if (!value || typeof value !== 'object') throw new Error('无效设置');
      for (const key of ['sound', 'notifications', 'alwaysOnTop', 'launchAtLogin']) if (typeof value[key] === 'boolean') settings[key] = value[key];
      if (Number.isFinite(value.volume)) settings.volume = Math.max(0, Math.min(100, value.volume));
      win.setAlwaysOnTop(settings.alwaysOnTop, process.platform === 'win32' ? 'normal' : 'floating');
      if (app.isPackaged && !smoke) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath });
      saveSettings(); send(); return snapshot();
    },
    install: tool => {
      if (smoke) throw new Error('测试模式不修改工具配置');
      const result = integrations.install(tool, { runtime, asset: path.join(__dirname, '..', 'assets', 'island-hook.ps1') });
      refreshInstalled(); send(); return result;
    },
    uninstall: tool => { if (smoke) throw new Error('测试模式不修改工具配置'); integrations.uninstall(tool); refreshInstalled(); sources[tool].lastEventAt = null; send(); }
  };
  if (smoke) actions['finish-demo'] = () => {
    for (const task of store.snapshot().filter(t => t.isDemo)) store.ingest({ ...task, status: 'completed', updatedAt: Date.now() });
  };
  if (smoke) actions['pulse-demo'] = index => {
    const task = store.tasks.get(`demo:${['codex', 'claude', 'cursor'][index % 3]}`);
    if (task) store.ingest({ ...task, detail: `pulse ${index}`, updatedAt: Date.now() });
  };
  if (smoke) actions['test-orca-tasks'] = payload => {
    const parsed = orcaTasks(payload); store.reconcileOrca(parsed.tasks, { complete: !parsed.truncated });
  };
  if (smoke) actions['test-dock-cursor'] = point => { testCursor = point; checkDock(); return snapshot(); };
  app.whenReady().then(() => {
    fs.mkdirSync(eventDir, { recursive: true });
    refreshInstalled();
    if (!smoke && fs.existsSync(cloudKeyFile)) {
      try {
        cloudMonitor.key = safeStorage.decryptString(fs.readFileSync(cloudKeyFile));
        sources.cursor.cloudConfigured = true; sources.cursor.cloudStatus = 'checking';
      } catch { sources.cursor.cloudStatus = 'error'; sources.cursor.cloudDetail = '无法读取已保存的凭据，请重新连接'; }
    }
    win = new BrowserWindow({ ...sizes.small, transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop, show: false, hasShadow: false, backgroundColor: '#00000000',
      title: 'AI Island', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    });
    position();
    win.setAlwaysOnTop(settings.alwaysOnTop, process.platform === 'win32' ? 'normal' : 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    win.on('will-move', () => {
      if (applyingBounds) return;
      dragging = true; dockHidden = false; leaveAt = 0; settings.dockEdge = null;
      clearTimeout(moveTimer);
    });
    win.on('moved', () => {
      if (!dragging || applyingBounds) return;
      clearTimeout(moveTimer); moveTimer = setTimeout(finishMove, 120);
    });
    win.on('blur', () => { dockEditing = false; });
    win.once('ready-to-show', () => { if (!smoke) win.showInactive(); send(); });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    ipcMain.handle('island:action', async (event, action, value) => {
      if (event.sender !== win.webContents || !Object.hasOwn(actions, action)) throw new Error('不支持的操作');
      return actions[action](value);
    });
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 24, height: 24 }));
    tray.setToolTip('AI Island · AI 任务监控');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示任务面板', click: () => reveal() },
      { label: '收起悬浮窗', click: () => { win.show(); setExpanded(false); } },
      { label: '重置到屏幕顶部', click: () => { actions['reset-position'](); win.showInactive(); } },
      { type: 'separator' },
      { label: '退出 AI Island', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => reveal());
    shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+Space', () => win.isVisible() && expanded ? setExpanded(false) : reveal());
    const displayChanged = () => { settings.displayId = display().id; position(); send(); };
    screen.on('display-removed', displayChanged); screen.on('display-metrics-changed', displayChanged);
    powerMonitor.on('resume', () => { position(); pollOrca(); pollEvents(); pollDesktop(); cloudRetryAt = 0; pollCloud(); });
    timers.push(setInterval(checkDock, 100));
    pollEvents(); timers.push(setInterval(pollEvents, 700));
    pollDesktop(); timers.push(setInterval(pollDesktop, 1000));
    if (!smoke) {
      pollOrca(); pollProcesses();
      pollCloud(); timers.push(setInterval(pollOrca, 3000), setInterval(pollProcesses, 15000), setInterval(pollCloud, 10000));
    }
  });
  app.on('second-instance', () => win && reveal());
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true; timers.forEach(t => clearTimeout(t)); clearTimeout(saveTimer); clearTimeout(emitTimer); clearTimeout(moveTimer);
    globalShortcut.unregisterAll();
    try { saveSettings(); integrations.atomicJson(historyFile, store.serialize()); } catch {}
    tray?.destroy();
  });
}
