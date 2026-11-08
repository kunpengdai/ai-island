const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const EVENTS = {
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'],
  claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'],
  cursor: ['workspaceOpen', 'sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd']
};
const MARKER = 'island-hook.ps1';
function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`${path.basename(file)} 无法解析，请先修复 JSON：${e.message}`); }
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function configPath(tool, home = os.homedir()) {
  return path.join(home, `.${tool}`, tool === 'claude' ? 'settings.json' : 'hooks.json');
}
function owned(hook) { return typeof hook?.command === 'string' && hook.command.includes(MARKER) && hook.command.includes('-Tool '); }
function withoutOwned(config) {
  const result = structuredClone(config);
  for (const [event, groups] of Object.entries(result.hooks || {})) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} 应为数组，未修改配置`);
    result.hooks[event] = groups.flatMap(group => {
      if (owned(group)) return [];
      if (Array.isArray(group.hooks)) {
        const remaining = group.hooks.filter(h => !owned(h));
        if (!remaining.length && group.hooks.some(owned)) return [];
        return [{ ...group, hooks: remaining }];
      }
      return [group];
    });
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  return result;
}
function mergeHooks(tool, config, hookFile) {
  if (!EVENTS[tool]) throw new Error('不支持的工具');
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('配置根节点应为对象');
  const result = withoutOwned(config);
  result.hooks ||= {};
  if (tool === 'cursor') result.version ??= 1;
  for (const event of EVENTS[tool]) {
    const command = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${hookFile}" -Tool ${tool} -Event ${event}`;
    const handler = { type: 'command', command, timeout: 3 };
    if (tool === 'cursor') { delete handler.type; result.hooks[event] = [...(result.hooks[event] || []), handler]; }
    else result.hooks[event] = [...(result.hooks[event] || []), { hooks: [handler] }];
  }
  return result;
}
function install(tool, { home = os.homedir(), runtime, asset }) {
  if (!EVENTS[tool]) throw new Error('不支持的工具');
  const file = configPath(tool, home);
  const original = readJson(file);
  const hookFile = path.join(runtime, MARKER);
  const updated = mergeHooks(tool, original, hookFile);
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(asset, hookFile);
  let backup = null;
  if (fs.existsSync(file)) { backup = `${file}.island-backup-${Date.now()}`; fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
  atomicJson(file, updated);
  return { file, backup };
}
function uninstall(tool, home = os.homedir()) {
  if (!EVENTS[tool]) throw new Error('不支持的工具');
  const file = configPath(tool, home);
  if (!fs.existsSync(file)) return;
  const config = readJson(file);
  fs.copyFileSync(file, `${file}.island-backup-${Date.now()}`, fs.constants.COPYFILE_EXCL);
  atomicJson(file, withoutOwned(config));
}
function installed(tool, home = os.homedir()) {
  try {
    const config = readJson(configPath(tool, home));
    return EVENTS[tool].every(event => (config.hooks?.[event] || []).some(group => owned(group) || group.hooks?.some(owned)));
  } catch { return false; }
}
function resolveOrca() {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
  return fs.existsSync(local) ? local : 'orca';
}
async function pollOrca(command = resolveOrca()) {
  const { stdout } = await exec(command, ['worktree', 'ps', '--limit', '1000', '--json'], { windowsHide: true, timeout: 12_000, maxBuffer: 6 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
async function detectProcesses() {
  if (process.platform !== 'win32') return {};
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name codex,claude,cursor,orca -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 8000 });
  const names = JSON.parse(stdout || '[]');
  return Object.fromEntries([].concat(names).map(name => [name.toLowerCase(), true]));
}
module.exports = { EVENTS, readJson, atomicJson, configPath, mergeHooks, withoutOwned, install, uninstall, installed, pollOrca, detectProcesses, resolveOrca };
