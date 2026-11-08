const EDGES = new Set(['left', 'right', 'top', 'bottom']);
const SIZES = { small: { width: 450, height: 76 }, large: { width: 508, height: 650 } };
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
const contains = (rect, point) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;

function detectDock(bounds, area, threshold = 24) {
  const distances = [
    ['left', Math.abs(bounds.x - area.x)], ['right', Math.abs(bounds.x + bounds.width - area.x - area.width)],
    ['top', Math.abs(bounds.y - area.y)], ['bottom', Math.abs(bounds.y + bounds.height - area.y - area.height)]
  ].sort((a, b) => a[1] - b[1]);
  const [edge, distance] = distances[0];
  if (distance > threshold) return { edge: null, offset: 0.5 };
  const vertical = edge === 'left' || edge === 'right';
  const offset = vertical ? (bounds.y + bounds.height / 2 - area.y) / area.height : (bounds.x + bounds.width / 2 - area.x) / area.width;
  return { edge, offset: clamp(offset, 0, 1) };
}

function windowBounds(area, { expanded = false, edge = null, hidden = false, offset = 0.5, centerX = null, top = null } = {}) {
  edge = EDGES.has(edge) ? edge : null;
  const vertical = edge === 'left' || edge === 'right';
  const size = hidden && edge ? (vertical ? { width: 14, height: 88 } : { width: 88, height: 14 }) : SIZES[expanded ? 'large' : 'small'];
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
  let x = (Number.isFinite(centerX) ? centerX : area.x + area.width / 2) - width / 2;
  let y = Number.isFinite(top) ? top : area.y + 8;
  if (edge) {
    offset = Number.isFinite(offset) ? clamp(offset, 0, 1) : 0.5;
    const inset = hidden ? 0 : 8;
    if (vertical) { x = edge === 'left' ? area.x + inset : area.x + area.width - width - inset; y = area.y + area.height * offset - height / 2; }
    else { x = area.x + area.width * offset - width / 2; y = edge === 'top' ? area.y + inset : area.y + area.height - height - inset; }
  }
  return { x: Math.round(clamp(x, area.x, area.x + area.width - width)), y: Math.round(clamp(y, area.y, area.y + area.height - height)), width, height };
}

function activitySummary(tasks) {
  const running = tasks.filter(t => ['starting', 'running'].includes(t.status)).length;
  const waiting = tasks.filter(t => t.status === 'waiting').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const state = waiting ? 'waiting' : running ? 'running' : tasks.some(t => ['failed', 'interrupted'].includes(t.status)) ? 'error' : tasks.some(t => ['unknown', 'offline'].includes(t.status)) ? 'unknown' : tasks.length && completed === tasks.length ? 'completed' : 'idle';
  const label = ({ waiting: '有任务待交互', running: '任务运行中', error: '有任务失败或中断', unknown: '有任务状态待确认', completed: '全部任务已完成', idle: '暂无任务' })[state];
  return { state, running, waiting, completed, label, description: `${label} · 运行中 ${running} · 待交互 ${waiting} · 已完成 ${completed}` };
}

module.exports = { EDGES, SIZES, contains, detectDock, windowBounds, activitySummary };
