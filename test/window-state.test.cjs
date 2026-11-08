const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contains, detectDock, windowBounds, activitySummary } = require('../src/window-state.cjs');

test('dock detection preserves the dragged location and works with negative monitor coordinates', () => {
  const area = { x: -1920, y: 40, width: 1920, height: 1040 };
  assert.equal(detectDock({ x: -1915, y: 500, width: 450, height: 76 }, area).edge, 'left');
  assert.equal(detectDock({ x: -455, y: 500, width: 450, height: 76 }, area).edge, 'right');
  assert.equal(detectDock({ x: -1000, y: 42, width: 450, height: 76 }, area).edge, 'top');
  assert.equal(detectDock({ x: -1000, y: 1000, width: 450, height: 76 }, area).edge, 'bottom');
  assert.equal(detectDock({ x: -1000, y: 400, width: 450, height: 76 }, area).edge, null);
  assert.equal(detectDock({ x: -1920, y: 522, width: 450, height: 76 }, area).offset, 0.5);
});

test('peek tabs and hover panels stay inside each work area, including small displays and corners', () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1366, y: -768, width: 1366, height: 728 }, { x: 200, y: 50, width: 400, height: 300 }]) {
    for (const edge of ['left', 'right', 'top', 'bottom']) for (const offset of [0, 0.5, 1]) {
      for (const hidden of [true, false]) {
        const bounds = windowBounds(area, { edge, offset, hidden, expanded: true });
        assert.ok(bounds.x >= area.x && bounds.y >= area.y);
        assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
        assert.equal(hidden ? Math.min(bounds.width, bounds.height) : bounds.width, hidden ? 14 : Math.min(508, area.width));
      }
    }
  }
  assert.equal(windowBounds({ x: 0, y: 0, width: 1920, height: 1080 }, { centerX: 0 }).x, 0);
  assert.equal(contains({ x: -14, y: 0, width: 14, height: 88 }, { x: -1, y: 87 }), true);
  assert.equal(contains({ x: -14, y: 0, width: 14, height: 88 }, { x: 0, y: 87 }), false);
});

test('green means all tasks completed; active tasks, waits and uncertain or failed outcomes take precedence', () => {
  const summarize = (...statuses) => activitySummary(statuses.map(status => ({ status })));
  assert.equal(summarize().state, 'idle');
  assert.equal(summarize('completed', 'completed').state, 'completed');
  assert.equal(summarize('completed', 'unknown').state, 'unknown');
  assert.equal(summarize('completed', 'offline').state, 'unknown');
  assert.equal(summarize('completed', 'failed').state, 'error');
  assert.equal(summarize('completed', 'interrupted').state, 'error');
  assert.equal(summarize('completed', 'running', 'failed').state, 'running');
  const mixed = summarize('starting', 'running', 'waiting', 'completed');
  assert.equal(mixed.state, 'waiting'); assert.equal(mixed.running, 2); assert.equal(mixed.waiting, 1); assert.equal(mixed.completed, 1);
});
