'use strict';
/*
 * 校样批注单元测试：
 *  - normalizeAnnotations：严格规整（保存路径），各类非法输入对应错误码
 *  - coerceAnnotations / normalizePlan：宽容规整（导入路径），坏条目逐条丢弃
 *  - annotationStats：统计
 *  - locateAnnotations：批注绑定原始面片身份，跨回放步 / 重排折叠 / 非法步截断定位
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
const GRID = { rows: 2, cols: 2, steps: STEPS };

test('normalizeAnnotations：合法记录被规整（trim、补 id/时间戳/resolved 字段）', () => {
  const out = E.normalizeAnnotations([
    { cell: '0,0', face: 'front', severity: 'warning', text: ' 套印偏差 ', step: 1 },
    { cell: '1,1', face: 'back', severity: 'error', text: '严重问题', step: 2, resolved: true }
  ], GRID);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, '套印偏差');
  assert.match(out[0].id, /^[A-Za-z0-9_-]{6,32}$/);
  assert.equal(out[0].resolved, false);
  assert.equal(out[0].resolvedAt, undefined);
  assert.equal(typeof out[0].createdAt, 'string');
  assert.equal(out[1].resolved, true);
  assert.equal(typeof out[1].resolvedAt, 'string');
});

test('normalizeAnnotations：null/undefined → 空数组；空数组合法', () => {
  assert.deepEqual(E.normalizeAnnotations(null, GRID), []);
  assert.deepEqual(E.normalizeAnnotations(undefined, GRID), []);
  assert.deepEqual(E.normalizeAnnotations([], GRID), []);
});

test('normalizeAnnotations：各类非法输入抛出对应错误码', () => {
  const expectCode = (raw, code) => {
    let thrown = null;
    try { E.normalizeAnnotations(raw, GRID); } catch (e) { thrown = e; }
    assert.ok(thrown, `应抛出：${code}`);
    assert.equal(thrown.code, code, thrown.message);
  };
  expectCode({}, 'bad_annotations');
  expectCode('x', 'bad_annotations');
  expectCode([null], 'bad_annotation');
  expectCode([42], 'bad_annotation');
  expectCode([[]], 'bad_annotation');
  expectCode([{ cell: 'x', face: 'front', severity: 'error', text: 'a', step: 0 }],
    'bad_annotation_cell');
  expectCode([{ cell: '2,0', face: 'front', severity: 'error', text: 'a', step: 0 }],
    'bad_annotation_cell');
  expectCode([{ cell: '0,0', face: 'side', severity: 'error', text: 'a', step: 0 }],
    'bad_annotation_face');
  expectCode([{ cell: '0,0', face: 'front', severity: 'fatal', text: 'a', step: 0 }],
    'bad_annotation_severity');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error', text: 1, step: 0 }],
    'bad_annotation_text');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error', text: '   ', step: 0 }],
    'bad_annotation_text');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error',
    text: '中'.repeat(501), step: 0 }], 'annotation_too_long');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error',
    text: 'a\u0001', step: 0 }], 'annotation_control_chars');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error', text: 'a', step: -1 }],
    'bad_annotation_step');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error', text: 'a', step: 3 }],
    'bad_annotation_step');
  expectCode([{ id: 'bad id!', cell: '0,0', face: 'front', severity: 'error',
    text: 'a', step: 0 }], 'bad_annotation_id');
  expectCode([
    { id: 'sameid01', cell: '0,0', face: 'front', severity: 'error', text: 'a', step: 0 },
    { id: 'sameid01', cell: '1,0', face: 'front', severity: 'error', text: 'b', step: 0 }
  ], 'duplicate_annotation_id');
  expectCode([{ cell: '0,0', face: 'front', severity: 'error', text: 'a',
    step: 0, resolved: 'yes' }], 'bad_annotation_resolved');
  expectCode(Array.from({ length: 201 }, (_, i) => ({
    cell: '0,0', face: 'front', severity: 'info', text: 't' + i, step: 0
  })), 'too_many_annotations');
});

test('normalizeAnnotations：500 字正文 / step 取末步合法；TAB 与换行允许', () => {
  assert.doesNotThrow(() => E.normalizeAnnotations([{
    cell: '0,0', face: 'back', severity: 'info',
    text: '中'.repeat(500), step: 2
  }], GRID));
  const out = E.normalizeAnnotations([{
    cell: '0,0', face: 'front', severity: 'info', text: '第一行\n第二行\t尾', step: 0
  }], GRID);
  assert.equal(out[0].text, '第一行\n第二行\t尾');
});

test('coerceAnnotations：宽容规整——坏条目丢弃 / 级别降级 / 超长截断 / step 钳制 / id 重建', () => {
  const out = E.coerceAnnotations([
    null, 'x', 42, {},
    { cell: 'bad', face: 'front', text: 'a' },
    { cell: '3,0', face: 'front', text: '越界' },
    { cell: '0,0', face: 'side', text: 'a' },
    { cell: '0,0', face: 'front', severity: 'fatal', text: ' 级别降级 ' },
    { cell: '1,0', face: 'back', text: 'x'.repeat(600), step: 99 },
    { id: '非法 id', cell: '1,1', face: 'front', text: '重建 id', resolved: true }
  ], 2, 2, STEPS);
  assert.equal(out.length, 3);
  assert.equal(out[0].cell, '0,0');
  assert.equal(out[0].severity, 'info');
  assert.equal(out[0].text, '级别降级');
  assert.equal(out[1].cell, '1,0');
  assert.equal([...out[1].text].length, 500);
  assert.equal(out[1].step, 2, 'step 超过步数钳制到 2');
  assert.match(out[2].id, /^[A-Za-z0-9_-]{6,32}$/);
  assert.equal(out[2].resolved, true);
  assert.equal(typeof out[2].resolvedAt, 'string');
});

test('coerceAnnotations：控制字符被剔除；重复非法 id 重建为不同 id', () => {
  const out = E.coerceAnnotations([
    { cell: '0,0', face: 'front', text: 'a\u0001b' },
    { id: 'bad', cell: '0,0', face: 'back', text: 'c' },
    { id: 'bad', cell: '1,0', face: 'front', text: 'd' }
  ], 2, 2, []);
  assert.equal(out[0].text, 'ab');
  assert.notEqual(out[1].id, out[2].id);
});

test('normalizePlan：批注随方案宽容规整载入，非数组变为空数组', () => {
  const p = E.normalizePlan({
    rows: 2, cols: 2, labels: {}, steps: STEPS,
    annotations: [{ cell: '0,0', face: 'front', severity: 'error', text: '载入', step: 1 }]
  });
  assert.equal(p.annotations.length, 1);
  assert.equal(p.annotations[0].text, '载入');
  const p2 = E.normalizePlan({ rows: 1, cols: 1, labels: {}, steps: [], annotations: 'x' });
  assert.deepEqual(p2.annotations, []);
});

test('annotationStats：总数 / 未解决 / 已解决与分级别统计', () => {
  const annos = E.normalizeAnnotations([
    { cell: '0,0', face: 'front', severity: 'error', text: 'a', step: 0 },
    { cell: '0,0', face: 'back', severity: 'error', text: 'b', step: 0, resolved: true },
    { cell: '1,0', face: 'front', severity: 'warning', text: 'c', step: 0 }
  ], GRID);
  const s = E.annotationStats(annos);
  assert.deepEqual(s, {
    total: 3, open: 2, resolved: 1,
    bySeverity: {
      error: { total: 2, open: 1 },
      warning: { total: 1, open: 1 },
      info: { total: 0, open: 0 }
    }
  });
});

test('locateAnnotations：批注以原始面片身份跨回放步定位（格位/层序/面朝向）', () => {
  const annos = E.normalizeAnnotations([
    { cell: '0,0', face: 'front', severity: 'error', text: '封面错位', step: 0 },
    { cell: '0,0', face: 'back', severity: 'info', text: '反面备注', step: 0 },
    { cell: '1,1', face: 'back', severity: 'warning', text: '末叶问题', step: 2 }
  ], GRID);

  const step0 = E.locateAnnotations(2, 2, {}, STEPS, 0, annos);
  assert.equal(step0.ok, true);
  assert.equal(step0.interrupted, null);
  const a0 = step0.points.find((p) => p.id === annos[0].id);
  assert.equal(a0.at, '0,0');
  assert.equal(a0.layer, 1);
  assert.equal(a0.depth, 1);
  assert.equal(a0.faceUp, true);
  assert.equal(a0.upright, true);

  // 末态：原格 0,0 已折叠到 (1,1) 叠的第 2 层，其正面朝上（封面侧）
  const step2 = E.locateAnnotations(2, 2, {}, STEPS, 2, annos);
  const a2 = step2.points.find((p) => p.id === annos[0].id);
  assert.equal(a2.at, '1,1');
  assert.equal(a2.layer, 2);
  assert.equal(a2.depth, 4);
  assert.equal(a2.faceUp, true);
  // 同一原格反面在末态朝下
  const b2 = step2.points.find((p) => p.id === annos[1].id);
  assert.equal(b2.at, '1,1');
  assert.equal(b2.faceUp, false);
  // 所有批注都落在唯一终叠
  assert.ok(step2.points.every((p) => p.at === '1,1'));
});

test('locateAnnotations：upto 缺省回放全部步骤；非法步截断时仍定位此前格位并带 interrupted', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },   // 合法
    { axis: 'v', line: 2, dir: 'l' }    // 厚度冲突（1×3）
  ];
  const annos = E.normalizeAnnotations([
    { cell: '0,0', face: 'front', severity: 'error', text: 'x', step: 1 }
  ], { rows: 1, cols: 3, steps });
  const r = E.locateAnnotations(1, 3, {}, steps, undefined, annos);
  assert.equal(r.ok, true);
  assert.equal(r.interrupted.stepIndex, 1);
  assert.equal(r.points.length, 1);
  assert.equal(r.points[0].at, '1,0');
  assert.equal(r.points[0].depth, 2);
});

test('locateAnnotations：重排/截断步骤序列后仍以面片身份定位，不依赖批注创建时步', () => {
  const annos = E.normalizeAnnotations([
    { cell: '0,0', face: 'front', severity: 'info', text: '始终跟我', step: 2 }
  ], GRID);
  // 只保留第一步：0,0 经竖折移动到 1,0（不是末态的 1,1）
  const one = E.locateAnnotations(2, 2, {}, STEPS.slice(0, 1), 1, annos);
  assert.equal(one.points[0].at, '1,0');
  // 反向顺序（先横折后竖折，同为合法序列）：身份不随“折叠重排”丢失
  const reordered = E.locateAnnotations(2, 2, {},
    [{ axis: 'h', line: 1, dir: 'd' }, { axis: 'v', line: 1, dir: 'r' }], 2, annos);
  assert.equal(reordered.ok, true);
  assert.equal(reordered.points.length, 1);
  assert.equal(reordered.points[0].cell, '0,0');
  assert.equal(reordered.points[0].depth, 4);
});

test('locateAnnotations：非法网格返回 bad_grid', () => {
  assert.equal(E.locateAnnotations(0, 2, {}, [], 0, []).ok, false);
  assert.equal(E.locateAnnotations(0, 2, {}, [], 0, []).code, 'bad_grid');
});
