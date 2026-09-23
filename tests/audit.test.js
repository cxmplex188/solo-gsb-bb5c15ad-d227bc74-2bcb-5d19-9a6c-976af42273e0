'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS_2x2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
const L = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, [f, b]]) => [k, { front: f, back: b }]));

test('审计：干净 1×2 折帖全部通过，结论可发布', () => {
  const r = E.auditPlan(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '3'] }),
    [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.summary.total, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.stats, {
    rows: 1, cols: 2, capacity: 4, steps: 1, folded: true,
    stacks: 1, leaves: 2, labeledFaces: 4, blankFaces: 0
  });
});

test('审计：未标注方案报空白页码与未覆盖纸格（警告）', () => {
  // 1×2 单竖折：无水平折，所有面片正立，纯空白方案只有警告、结论可发布
  const r = E.auditPlan(1, 2, {}, [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'pass', '仅警告时结论仍为可发布');
  assert.equal(r.summary.errors, 0);
  assert.equal(r.summary.warnings, 6);           // 4 空白面 + 2 未覆盖格
  const blanks = r.findings.filter((f) => f.id === 'blank_page');
  const uncovered = r.findings.filter((f) => f.id === 'uncovered_cell');
  assert.equal(blanks.length, 4);
  assert.equal(uncovered.length, 2);
  assert.ok(blanks.every((f) => f.severity === 'warning' && f.cells.length === 1));
  assert.deepEqual(uncovered.map((f) => f.cells[0]).sort(), ['0,0', '1,0']);
  assert.equal(r.stats.blankFaces, 4);
  assert.equal(r.stats.labeledFaces, 0);
});

test('审计：先竖折再水平折的空白倒置槽位不再漏报（错误 → 需修订）', () => {
  // 2×2 全部面未标注：水平折使槽位 1/2/7/8 倒置，空白倒置同样是交付错误
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'fail', '倒置空白槽不得再显示“可发布”');
  assert.equal(r.summary.errors, 4);
  assert.equal(r.summary.warnings, 12);          // 8 空白面 + 4 未覆盖格（统计不变）
  const inv = r.findings.filter((f) => f.id === 'inverted_page');
  assert.equal(inv.length, 4);
  assert.ok(inv.every((f) => f.severity === 'error'));
  // 每条含原始纸格、面别与槽位，且空白槽文案不虚构页码
  assert.deepEqual(inv.map((f) => f.details[0].slot), [1, 2, 7, 8]);
  assert.deepEqual(inv.map((f) => `${f.details[0].cell}:${f.details[0].face}`),
    ['1,0:back', '0,0:front', '0,0:back', '1,0:front']);
  for (const f of inv) {
    assert.equal(f.details[0].label, null);
    assert.ok(f.message.includes('空白面'), '空白槽须明示未标注，不得虚构页码');
    assert.ok(!f.message.includes('“”') && !/“\s*”/.test(f.message));
    assert.ok(f.message.includes(`原格(${f.details[0].cell})`));
    assert.ok(f.message.includes(`第 ${f.details[0].slot} 槽`));
  }
  // 空白/未覆盖统计与结构保持兼容
  assert.equal(r.findings.filter((f) => f.id === 'blank_page').length, 8);
  assert.equal(r.findings.filter((f) => f.id === 'uncovered_cell').length, 4);
  assert.equal(r.stats.blankFaces, 8);
  assert.equal(r.stats.labeledFaces, 0);
});

test('审计：部分标注时倒置槽按有无标签分别给出文案', () => {
  // 仅标注 0,0 正面（落在倒置槽 2）：该槽报真实页码，其余倒置空白槽不虚构页码
  const r = E.auditPlan(2, 2, L({ '0,0': ['5', ''] }), STEPS_2x2);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'fail');
  const inv = r.findings.filter((f) => f.id === 'inverted_page');
  assert.equal(inv.length, 4);
  const labeled = inv.filter((f) => f.details[0].label != null);
  const blank = inv.filter((f) => f.details[0].label == null);
  assert.equal(labeled.length, 1);
  assert.equal(blank.length, 3);
  assert.ok(labeled[0].message.includes('“5”'), '已标注槽仍报真实页码');
  assert.ok(blank.every((f) => f.message.includes('空白面') && !f.message.includes('页码 “')));
  // 统计兼容：7 空白面 + 1 已标注面
  assert.equal(r.stats.blankFaces, 7);
  assert.equal(r.stats.labeledFaces, 1);
  assert.equal(r.findings.filter((f) => f.id === 'blank_page').length, 7);
});

test('审计：完整标注的 8 页折帖检出倒置页码（错误 → 需修订）', () => {
  const labels = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 8).labels;
  const r = E.auditPlan(2, 2, labels, STEPS_2x2);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'fail');
  const inv = r.findings.filter((f) => f.id === 'inverted_page');
  assert.equal(inv.length, 4);                   // 页码 1、2、7、8 所在面片倒置
  assert.ok(inv.every((f) => f.severity === 'error'));
  assert.deepEqual([...new Set(inv.flatMap((f) => f.cells))].sort(), ['0,0', '1,0']);
  // 无空白、无重复、无未覆盖
  assert.equal(r.findings.filter((f) => f.id === 'blank_page').length, 0);
  assert.equal(r.findings.filter((f) => f.id === 'duplicate_page').length, 0);
  assert.equal(r.findings.filter((f) => f.id === 'uncovered_cell').length, 0);
  // 错误排在警告之前
  const ranks = { error: 0, warning: 1, info: 2 };
  const order = r.findings.map((f) => ranks[f.severity]);
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
});

test('审计：重复页码给出错误并列出全部出现位置', () => {
  const r = E.auditPlan(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '1'] }),
    [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.equal(r.verdict, 'fail');
  const dup = r.findings.filter((f) => f.id === 'duplicate_page');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, 'error');
  assert.deepEqual(dup[0].cells.sort(), ['0,0', '1,0']);
  assert.ok(dup[0].message.includes('“1”'));
  assert.ok(dup[0].message.includes('2 次'));
  assert.equal(dup[0].details.length, 2);
});

test('审计：最终分离叠层为错误并给出各叠层原格明细', () => {
  const r = E.auditPlan(2, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'fail');
  const split = r.findings.find((f) => f.id === 'split_stacks');
  assert.ok(split);
  assert.equal(split.severity, 'error');
  assert.equal(split.details.length, 4);         // 2×3 折一次后 4 个叠层
  assert.ok(split.message.includes('4 个分离叠层'));
  assert.deepEqual(split.cells.sort(), ['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
  assert.equal(r.stats.folded, false);
  assert.equal(r.stats.stacks, 4);
});

test('审计：1×1 未折叠单叠容量 2 页，提示非 4 的倍数（警告）', () => {
  const r = E.auditPlan(1, 1, L({ '0,0': ['1', '2'] }), []);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'pass');
  const cap = r.findings.find((f) => f.id === 'capacity_multiple');
  assert.ok(cap);
  assert.equal(cap.severity, 'warning');
  assert.ok(cap.message.includes('2 页'));
  assert.equal(r.stats.capacity, 2);
});

test('审计：容量守恒校验在正常方案上不触发（叶子数 × 2 = 容量）', () => {
  for (const [rows, cols, steps] of [
    [1, 2, [{ axis: 'v', line: 1, dir: 'r' }]],
    [2, 2, STEPS_2x2],
    [2, 3, [{ axis: 'v', line: 1, dir: 'r' }]]
  ]) {
    const r = E.auditPlan(rows, cols, {}, steps);
    assert.equal(r.findings.some((f) => f.id === 'capacity_mismatch'), false);
    assert.equal(r.stats.leaves, rows * cols);
  }
});

test('审计：非法折叠只报告首个错误，不伪造后续结论', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },   // 合法
    { axis: 'v', line: 2, dir: 'l' }    // 1×3 厚度冲突
  ];
  const r = E.auditPlan(1, 3, {}, steps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'thickness');
  assert.equal(r.stepIndex, 1);
  assert.deepEqual(r.conflicts, ['2,0', '1,0']);
  assert.ok(r.message.includes('首个错误'));
  assert.equal(r.findings, undefined, '不得附带后续检查结论');
  assert.equal(r.verdict, undefined);
});

test('审计：外轮廓非法同样中止并报告首个错误', () => {
  const r = E.auditPlan(2, 3, {}, [{ axis: 'v', line: 2, dir: 'r' }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'contour');
  assert.equal(r.stepIndex, 0);
  assert.ok(r.conflicts.includes('0,0'));
});

test('审计：非法网格返回 bad_grid；steps 非数组按空序列处理', () => {
  assert.equal(E.auditPlan(0, 2, {}, []).code, 'bad_grid');
  assert.equal(E.auditPlan(2, 2.5, {}, []).code, 'bad_grid');
  const r = E.auditPlan(1, 1, {}, null);
  assert.equal(r.ok, true);
  assert.equal(r.stats.steps, 0);
});

test('审计：finding 结构完整（id/severity/title/message/cells/step）', () => {
  const r = E.auditPlan(2, 2, L({ '0,0': ['1', '1'] }), STEPS_2x2);
  assert.ok(r.findings.length > 0);
  for (const f of r.findings) {
    assert.ok(typeof f.id === 'string' && f.id.length > 0);
    assert.ok(['error', 'warning', 'info'].includes(f.severity));
    assert.ok(typeof f.title === 'string' && f.title.length > 0);
    assert.ok(typeof f.message === 'string' && f.message.length > 0);
    assert.ok(Array.isArray(f.cells));
    assert.ok(f.cells.every((c) => /^\d+,\d+$/.test(c)));
    assert.equal(f.step, null);
  }
});

test('审计：纯函数，不改写标注与步骤', () => {
  const labels = L({ '0,0': ['1', '2'] });
  const steps = STEPS_2x2.map((s) => ({ ...s }));
  const snapL = JSON.stringify(labels);
  const snapS = JSON.stringify(steps);
  E.auditPlan(2, 2, labels, steps);
  assert.equal(JSON.stringify(labels), snapL);
  assert.equal(JSON.stringify(steps), snapS);
});
