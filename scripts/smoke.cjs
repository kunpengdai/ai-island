const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-island-smoke-'));
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const env = { ...process.env, AGENT_ISLAND_TEST_DATA: testData }; delete env.ELECTRON_RUN_AS_NODE;
  const errors = []; let instance;
  try {
    const packaged = process.argv.includes('--packaged');
    instance = await electron.launch({
      ...(packaged ? { executablePath: path.join(root, 'release', `AI-Island-${require('../package.json').version}-win-x64`, 'AI Island.exe'), args: ['--smoke'] } : { args: [root, '--smoke'] }),
      cwd: root, env, timeout: 60000
    });
    const page = await instance.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => window.island && document.getElementById('summary-running').textContent === '0');
    const small = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.ok(Math.abs(small.height - 76) <= 1); assert.ok(Math.abs(small.width - 450) <= 1);
    await page.screenshot({ path: path.join(artifacts, 'island-collapsed.png'), omitBackground: true });
    await page.evaluate(() => window.island.action('expand', true));
    await page.waitForSelector('#expanded-content:not([hidden])');
    await page.evaluate(() => window.island.action('settings', { sound: false, volume: 0 }));
    await page.click('#demo');
    await page.waitForSelector('.task-card.running');
    assert.equal(await page.locator('.task-card').count(), 3);
    assert.equal(await page.locator('#summary-running').innerText(), '2');
    assert.equal(await page.locator('#summary-waiting').innerText(), '1');
    assert.equal(await page.locator('#summary-completed').innerText(), '0');
    await page.screenshot({ path: path.join(artifacts, 'island-tasks.png'), omitBackground: true });
    await page.evaluate(() => {
      window.stableTaskNodes = [...document.querySelectorAll('.task-card')];
      window.stableTaskIds = window.stableTaskNodes.map(n => n.dataset.taskId);
      window.stableToolButton = document.querySelector('[data-tool="orca"]');
      window.stableConnectButton = document.querySelector('[data-integrate="cursor"]');
      document.querySelector('#task-list').scrollTop = 25;
      window.stableScroll = document.querySelector('#task-list').scrollTop;
    });
    for (let pulse = 0; pulse < 5; pulse++) {
      await page.evaluate(index => window.island.action('pulse-demo', index), pulse);
      await page.waitForFunction(index => [...document.querySelectorAll('.task-detail')].some(n => n.textContent === `pulse ${index}`), pulse);
      assert.equal(await page.evaluate(() => {
        const current = [...document.querySelectorAll('.task-card')];
        return current.every((node, index) => node === window.stableTaskNodes[index] && node.dataset.taskId === window.stableTaskIds[index]);
      }), true, 'tool events retain DOM nodes and card order');
      assert.equal(await page.evaluate(() => window.stableToolButton === document.querySelector('[data-tool="orca"]') && window.stableConnectButton === document.querySelector('[data-integrate="cursor"]')), true, 'polling must not detach tool and integration buttons');
      assert.equal(await page.evaluate(() => document.querySelector('#task-list').scrollTop), await page.evaluate(() => window.stableScroll));
    }
    console.log('Alternating running-task updates preserve card identity, order, and scroll.');
    console.log('Native window and multi-session task panel passed.');
    await page.click('[data-filter="active"]'); assert.equal(await page.locator('.task-card').count(), 3);
    await page.click('[data-filter="completed"]'); assert.equal(await page.locator('.task-card').count(), 0);
    await page.click('[data-filter="all"]');
    await page.click('[data-filter="waiting"]'); assert.equal(await page.locator('.task-card').count(), 1);
    await page.click('[data-filter="all"]');
    await page.click('[data-page="settings"]');
    console.log('Task filters passed; checking settings.');
    await page.waitForSelector('#settings-page:not([hidden])');
    await page.fill('#cursor-cloud-key', 'test-key-not-real');
    await page.press('#cursor-cloud-key', 'Enter');
    await page.waitForFunction(() => document.querySelector('#cursor-cloud-status').textContent.includes('隔离测试'));
    assert.equal(await page.inputValue('#cursor-cloud-key'), '');
    await page.click('#sound-toggle');
    await page.waitForFunction(() => document.querySelector('#sound-toggle').getAttribute('aria-checked') === 'true');
    await page.evaluate(() => {
      window.testChimeCount = 0;
      window.island.onChime(() => window.testChimeCount++);
    });
    await page.click('#test-sound');
    await page.waitForFunction(() => window.testChimeCount === 1);
    console.log('Settings and sound IPC passed.');
    await page.evaluate(() => window.island.action('settings', { sound: false }));
    await page.screenshot({ path: path.join(artifacts, 'island-settings.png'), omitBackground: true });
    const overflow = await page.evaluate(() => ({ body: document.body.scrollWidth > innerWidth, settings: document.querySelector('#settings-page').scrollWidth > document.querySelector('#settings-page').clientWidth }));
    assert.deepEqual(overflow, { body: false, settings: false });
    await page.click('[data-page="tasks"]');
    await page.evaluate(() => window.island.action('finish-demo'));
    await page.waitForFunction(() => document.querySelectorAll('.task-card.completed').length === 3, { timeout: 18000 });
    console.log('Demo completion and muted sound passed.');
    await page.screenshot({ path: path.join(artifacts, 'island-completed.png'), omitBackground: true });
    assert.equal(await page.evaluate(() => window.testChimeCount), 1, 'muted completions must not chime');
    await page.click('#clear-history'); await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 0);
    // Run the production PowerShell observer into the isolated event spool.
    const hook = event => {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'assets', 'island-hook.ps1'), '-Tool', 'claude', '-Event', event], {
        input: JSON.stringify({ session_id: 'e2e-session', prompt: '<img src=x onerror="window.injected=true"> 中文测试任务', cwd: 'C:/Projects/安全测试' }),
        env: { ...env, AGENT_ISLAND_EVENT_DIR: path.join(testData, 'runtime', 'events'), ORCA_PANE_KEY: '', ORCA_WORKTREE_ID: '' }, encoding: 'utf8', windowsHide: true, timeout: 6000
      });
      assert.equal(result.status, 0, result.stderr);
    };
    await page.evaluate(() => window.island.action('settings', { sound: true }));
    hook('UserPromptSubmit');
    await page.waitForSelector('.task-card.starting');
    assert.match(await page.locator('.task-title').innerText(), /中文测试任务/);
    assert.equal(await page.locator('.task-title img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    hook('PreToolUse'); await page.waitForSelector('.task-card.running');
    hook('Stop'); await page.waitForSelector('.task-card.completed');
    await page.waitForFunction(() => window.testChimeCount === 2);
    const firstStop = await page.evaluate(async () => (await window.island.action('state')).tasks[0].eventId);
    hook('Stop');
    await page.waitForFunction(async previous => (await window.island.action('state')).tasks[0].eventId !== previous, firstStop);
    assert.equal(await page.evaluate(() => window.testChimeCount), 2, 'duplicate real stop must not chime twice');
    const sessionDir = path.join(testData, 'runtime', 'codex-sessions'); fs.mkdirSync(sessionDir, { recursive: true });
    const desktopFile = path.join(sessionDir, 'rollout-desktop-e2e.jsonl');
    const desktopRow = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
    fs.writeFileSync(desktopFile,
      desktopRow('session_meta', { id: 'desktop-e2e', source: 'vscode', originator: 'Codex Desktop', cwd: 'C:/Projects/Desktop' }) +
      desktopRow('event_msg', { type: 'task_started', turn_id: 'desktop-turn' }) +
      desktopRow('event_msg', { type: 'user_message', message: '独立 Codex 桌面任务' }));
    await page.waitForSelector('[data-task-id="codex:desktop-e2e"].running');
    assert.equal(await page.locator('#summary-running').innerText(), '1');
    fs.appendFileSync(desktopFile, desktopRow('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'desktop-question' }));
    await page.waitForSelector('[data-task-id="codex:desktop-e2e"].waiting');
    await page.evaluate(() => window.island.action('expand', false));
    await page.waitForFunction(() => document.querySelector('#expanded-content').hidden);
    assert.equal(await page.locator('#summary-running').innerText(), '0');
    assert.equal(await page.locator('#summary-waiting').innerText(), '1');
    assert.equal(await page.locator('#summary-completed').innerText(), '1');
    assert.equal(await page.locator('#summary-waiting').isVisible(), true);
    assert.equal(await page.locator('#summary-completed').isVisible(), true);
    const metricsFit = await page.evaluate(() => {
      const header = document.querySelector('.island-head').getBoundingClientRect();
      return [...document.querySelectorAll('.summary-metric')].every(el => {
        const rect = el.getBoundingClientRect(); return rect.left >= header.left && rect.right < document.querySelector('#mute').getBoundingClientRect().left;
      });
    });
    assert.equal(metricsFit, true, 'all compact counters fit without clipping');
    await page.screenshot({ path: path.join(artifacts, 'island-compact-counts.png'), omitBackground: true });
    fs.appendFileSync(desktopFile, desktopRow('response_item', { type: 'function_call_output', call_id: 'desktop-question', output: '已回答' }));
    await page.waitForFunction(() => document.querySelector('#summary-running').textContent === '1');
    fs.appendFileSync(desktopFile, desktopRow('event_msg', { type: 'task_complete', turn_id: 'desktop-turn' }));
    await page.waitForFunction(() => document.querySelector('#summary-completed').textContent === '2');
    await page.waitForFunction(() => window.testChimeCount === 3);
    await page.evaluate(() => window.island.action('expand', true));
    await page.click('#clear-history');
    await page.waitForFunction(() => document.querySelector('#summary-completed').textContent === '0');
    await page.waitForFunction(async () => (await window.island.action('state')).tasks.length === 0);
    console.log('Desktop rollout discovery, waiting/resume/completion, compact counters, and history dismissal passed.');
    const orcaPayload = { ok: true, result: { worktrees: [{ hostId: 'local', worktreeId: 'smoke-work', hasAttachedPty: true, path: 'C:/Projects/Orca', agents: [{ paneKey: 'smoke-pane', agentType: 'codex', state: 'working', hasLivePty: true, updatedAt: Date.now(), stateStartedAt: Date.now() }] }] } };
    await page.evaluate(payload => window.island.action('test-orca-tasks', payload), orcaPayload);
    await page.waitForSelector('[data-task-id="orca:smoke-work:smoke-pane"].running');
    await page.click('[data-tool="orca"]');
    assert.equal(await page.locator('.task-card').count(), 1);
    assert.equal(await page.locator('.task-card .task-tool').innerText(), 'Orca');
    assert.equal(await page.locator('.task-card .task-source').innerText(), 'Codex');
    orcaPayload.result.worktrees[0].agents.push({ paneKey: 'unknown-pane', agentType: 'codex', state: 'unrecognized-state', taskTitle: '状态待确认的任务', hasLivePty: true, updatedAt: Date.now() });
    await page.evaluate(payload => window.island.action('test-orca-tasks', payload), orcaPayload);
    await page.waitForSelector('[data-task-id="orca:smoke-work:unknown-pane"].unknown');
    assert.equal(await page.locator('#unknown-count').innerText(), '1');
    assert.equal(await page.locator('#active-count').innerText(), '1');
    assert.equal(await page.locator('#completed-count').innerText(), '0');
    assert.equal(await page.locator('[data-group="unknown"]').innerText(), '状态未知 · 1');
    await page.click('[data-filter="unknown"]');
    assert.equal(await page.locator('.task-card').count(), 1);
    assert.equal(await page.locator('.task-card.unknown').count(), 1);
    await page.click('[data-filter="active"]');
    assert.equal(await page.locator('.task-card').count(), 1);
    assert.equal(await page.locator('.task-card.unknown').count(), 0);
    await page.click('[data-filter="completed"]');
    assert.equal(await page.locator('.task-card').count(), 0);
    await page.click('[data-filter="all"]');
    assert.deepEqual(await page.locator('.task-card').evaluateAll(nodes => nodes.map(n => n.dataset.taskId)), ['orca:smoke-work:smoke-pane', 'orca:smoke-work:unknown-pane']);
    await page.screenshot({ path: path.join(artifacts, 'island-unknown-category.png'), omitBackground: true });
    Object.assign(orcaPayload.result.worktrees[0], { hasAttachedPty: false });
    Object.assign(orcaPayload.result.worktrees[0].agents[0], { state: 'done', hasLivePty: false, updatedAt: Date.now() });
    await page.evaluate(payload => window.island.action('test-orca-tasks', payload), orcaPayload);
    await page.waitForSelector('[data-task-id="orca:smoke-work:smoke-pane"].completed');
    await page.waitForFunction(() => window.testChimeCount === 4);
    await page.click('#clear-history');
    await page.waitForFunction(() => document.querySelector('#unknown-count').textContent === '0');
    assert.equal(await page.locator('[data-group="unknown"]').count(), 0);
    await page.click('[data-tool="orca"]');
    console.log('Orca grouping, separate unknown category/count/section, active/completed exclusion and completion after terminal exit passed.');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#expanded-content').hidden);
    const native = await instance.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]; return { top: w.isAlwaysOnTop(), taskbar: w.isVisible(), bounds: w.getBounds() };
    });
    assert.equal(native.top, true); assert.equal(native.bounds.height, 76);
    assert.deepEqual(errors, []);
    console.log('Electron smoke passed: native floating window, expand/collapse, three sessions, filtering, settings, audio IPC, muted completion, history clear, PowerShell → event spool → task UI → one completion chime, HTML escaping, no renderer errors.');
    console.log(`Screenshots: ${artifacts}`);
  } finally {
    if (instance) { await instance.evaluate(({ app }) => app.exit(0)).catch(() => {}); await instance.close().catch(() => {}); }
    if (testData.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(testData, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
