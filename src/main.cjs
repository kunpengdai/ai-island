const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, powerMonitor, Notification, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { TaskStore, normalizeHook, orcaTasks, TOOLS, ACTIVE } = require('./core.cjs');
const integrations = require('./integrations.cjs');
const { CodexDesktopMonitor } = require('./codex-desktop.cjs');
const { CursorCloudMonitor } = require('./cursor-cloud.cjs');
const { CursorLocalMonitor } = require('./cursor-local.cjs');

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
  const sizes = { small: { width: 450, height: 76 }, large: { width: 508, height: 650 } };

  function snapshot() { return { tasks: store.snapshot(), settings, sources, expanded, packaged: app.isPackaged, platform: process.platform, shortcut: shortcutRegistered, version: app.getVersion() }; }
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
  function position(centerX) {
    const d = display(); const { x, y, width, height } = d.workArea;
    const size = expanded ? sizes.large : sizes.small;
    const cx = centerX ?? (settings.centerX || x + width / 2);
    win.setBounds({ x: Math.round(Math.max(x, Math.min(cx - size.width / 2, x + width - size.width))), y: y + 8, width: size.width, height: Math.min(size.height, height - 16) });
  }
  function setExpanded(value) {
    const bounds = win.getBounds();
    expanded = Boolean(value);
    const target = screen.getDisplayMatching(bounds);
    settings.displayId = target.id;
    settings.centerX = bounds.x + bounds.width / 2;
    position(settings.centerX); send();
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
    'reset-position': () => { settings.centerX = null; settings.displayId = screen.getPrimaryDisplay().id; position(); saveSettings(); },
    'next-display': () => { const all = screen.getAllDisplays(); const index = all.findIndex(d => d.id === display().id); settings.displayId = all[(index + 1) % all.length].id; settings.centerX = null; position(); saveSettings(); },
    settings: value => {
      if (!value || typeof value !== 'object') throw new Error('无效设置');
      for (const key of ['sound', 'notifications', 'alwaysOnTop', 'launchAtLogin']) if (typeof value[key] === 'boolean') settings[key] = value[key];
      if (Number.isFinite(value.volume)) settings.volume = Math.max(0, Math.min(100, value.volume));
      win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
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
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    win.on('moved', () => {
      const b = win.getBounds(); const d = screen.getDisplayMatching(b);
      settings.displayId = d.id; settings.centerX = b.x + b.width / 2;
    });
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
    screen.on('display-removed', () => position()); screen.on('display-metrics-changed', () => position());
    powerMonitor.on('resume', () => { pollOrca(); pollEvents(); pollDesktop(); cloudRetryAt = 0; pollCloud(); });
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
    quitting = true; timers.forEach(t => clearTimeout(t)); clearTimeout(saveTimer); clearTimeout(emitTimer);
    globalShortcut.unregisterAll();
    try { saveSettings(); integrations.atomicJson(historyFile, store.serialize()); } catch {}
    tray?.destroy();
  });
}
