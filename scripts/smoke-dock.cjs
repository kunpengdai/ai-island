const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-island-dock-'));
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const env = { ...process.env, AGENT_ISLAND_TEST_DATA: testData }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const errors = []; let instance, page;
  const start = async () => {
    instance = await electron.launch({
      ...(packaged ? { executablePath: path.join(root, 'release', `AI-Island-${require('../package.json').version}-win-x64`, 'AI Island.exe'), args: ['--smoke'] } : { args: [root, '--smoke'] }),
      cwd: root, env, timeout: 60000
    });
    page = await instance.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => window.island && document.querySelector('#summary-running').textContent === '0');
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  };
  const bounds = () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const cursor = point => page.evaluate(point => window.island.action('test-dock-cursor', point), point);
  const outside = () => cursor({ x: -100000, y: -100000 });
  const dragTo = async (edge = null) => {
    await instance.evaluate(({ BrowserWindow, screen }, edge) => {
      const w = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workArea, b = w.getBounds();
      const next = { ...b, x: area.x + Math.round((area.width - b.width) / 2), y: area.y + Math.round((area.height - b.height) / 2) };
      if (edge === 'left') next.x = area.x;
      if (edge === 'right') next.x = area.x + area.width - b.width;
      if (edge === 'top') next.y = area.y;
      if (edge === 'bottom') next.y = area.y + area.height - b.height;
      w.emit('will-move', {}, next); w.setBounds(next); w.emit('moved');
    }, edge);
    await page.waitForFunction(async edge => (await window.island.action('state')).dock.edge === edge, edge);
  };
  const hover = async () => {
    const tab = await bounds(); await cursor({ x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 });
    await page.waitForFunction(() => !document.querySelector('#expanded-content').hidden && document.querySelector('#edge-tab').hidden);
  };
  const update = async (state, extra = []) => {
    await page.evaluate(({ state, extra }) => window.island.action('test-orca-tasks', {
      ok: true, result: { worktrees: [{ hostId: 'local', worktreeId: 'dock-demo', path: 'C:/Projects/Demo', hasAttachedPty: true,
        agents: [{ paneKey: 'dock-task', agentType: 'codex', taskTitle: 'Edge docking demo', state, hasLivePty: true, updatedAt: Date.now(), stateStartedAt: Date.now() }, ...extra] }] }
    }), { state, extra });
  };
  const activity = state => page.waitForFunction(state => document.body.dataset.activity === state, state);
  try {
    await start();
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
    assert.equal((await page.evaluate(() => window.island.action('state'))).dock.edge, null, 'default top position does not dock itself');
    await page.evaluate(() => { window.dockChimes = 0; window.island.onChime(() => window.dockChimes++); return window.island.action('settings', { sound: true, volume: 0 }); });
    await dragTo('right'); await page.waitForSelector('#edge-tab:not([hidden])');
    console.log('Initial dock:', JSON.stringify({ bounds: await bounds(), dock: (await page.evaluate(() => window.island.action('state'))).dock }));
    assert.ok(Math.abs((await bounds()).width - 14) <= 1);
    const area = await instance.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    await page.evaluate(() => window.island.action('settings', { alwaysOnTop: false }));
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
    await page.evaluate(() => window.island.action('settings', { alwaysOnTop: true }));
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
    assert.ok(Math.abs((await bounds()).x + (await bounds()).width - area.x - area.width) <= 1);
    await update('working'); await activity('running');
    assert.match(await page.locator('#edge-tab').getAttribute('aria-label'), /运行中 1/);
    assert.equal(await page.locator('#edge-tab').evaluate(el => getComputedStyle(el).animationName), 'edge-running');
    await page.screenshot({ path: path.join(artifacts, 'island-edge-running.png'), omitBackground: true });
    await hover();
    const opened = await bounds(); assert.ok(Math.abs(opened.width - 508) <= 1); assert.ok(Math.abs(opened.height - Math.min(650, area.height)) <= 1);
    assert.equal(await page.locator('#island').evaluate(el => getComputedStyle(el).animationName), 'island-running-glow');
    await page.screenshot({ path: path.join(artifacts, 'island-running-glow.png'), omitBackground: true });
    await page.waitForTimeout(1000);
    assert.equal((await page.evaluate(() => window.island.action('state'))).dock.hidden, false, 'original tab area keeps the hover panel open');
    await outside(); await page.waitForSelector('#edge-tab:not([hidden])');
    await update('waiting'); await activity('waiting');
    await page.screenshot({ path: path.join(artifacts, 'island-edge-waiting.png'), omitBackground: true });
    await update('done'); await activity('completed');
    await page.waitForFunction(() => window.dockChimes === 1);
    assert.equal(await page.locator('#edge-tab').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.screenshot({ path: path.join(artifacts, 'island-edge-completed.png'), omitBackground: true });
    await update('done', [{ paneKey: 'uncertain', state: 'unrecognized', hasLivePty: true, updatedAt: Date.now() }]); await activity('unknown');
    await update('error'); await activity('error');
    assert.equal(await page.evaluate(() => window.dockChimes), 1, 'hidden completions chime once; duplicate stops and failures do not');
    await hover();
    await page.click('[data-page="settings"]');
    await page.locator('#cursor-cloud-key').focus();
    await outside(); await page.waitForTimeout(1000);
    assert.equal((await page.evaluate(() => window.island.action('state'))).dock.hidden, false, 'editing a form prevents auto-hide');
    await page.locator('#cursor-cloud-key').evaluate(el => el.blur());
    await page.waitForSelector('#edge-tab:not([hidden])');
    for (const edge of ['left', 'top', 'bottom']) {
      await page.evaluate(() => window.island.action('reset-position'));
      await dragTo(edge); await page.waitForSelector('#edge-tab:not([hidden])');
      const tab = await bounds();
      assert.ok(Math.abs((edge === 'left' ? tab.width : tab.height) - 14) <= 1);
      await hover(); await outside(); await page.waitForSelector('#edge-tab:not([hidden])');
    }
    await hover(); await dragTo(null); await outside(); await page.waitForTimeout(1000);
    assert.equal((await page.evaluate(() => window.island.action('state'))).dock.hidden, false, 'dragging away from an edge disables auto-hide');
    await page.evaluate(() => window.island.action('reset-position'));
    await update('working'); await activity('running');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#island').evaluate(el => getComputedStyle(el).animationName), 'none');
    await dragTo('left'); await page.waitForSelector('#edge-tab:not([hidden])');
    assert.equal(await page.locator('#edge-tab').evaluate(el => getComputedStyle(el).animationName), 'none');
    await instance.close(); instance = null;
    await start(); await page.waitForSelector('#edge-tab:not([hidden])');
    assert.equal((await page.evaluate(() => window.island.action('state'))).dock.edge, 'left', 'docking survives restart');
    assert.ok(Math.abs((await bounds()).width - 14) <= 1);
    assert.deepEqual(errors, []);
    console.log('Dock smoke passed: four edges, hover/leave, stable tab hover, live colors, all-done correctness, undocking, reduced motion, restart persistence.');
  } finally {
    if (instance) { await instance.evaluate(({ app }) => app.exit(0)).catch(() => {}); await instance.close().catch(() => {}); }
    if (testData.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(testData, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
