'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS_2x2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];

test('爬移：前置条件复用单叠合法性（非法折/非单叠/坏网格均禁用）', () => {
  assert.equal(E.creepEligibility(2, 2, {}, STEPS_2x2).ok, true);

  // 非单叠
  let r = E.creepCompensation(2, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }], 0.1, 3);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_single_stack');

  // 非法折叠（厚度冲突）
  r = E.creepCompensation(1, 3, {}, [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 2, dir: 'l' }
  ], 0.1, 3);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'thickness');
  assert.equal(r.stepIndex, 1);

  // 网格非法
  r = E.creepCompensation(0, 2, {}, [], 0.1, 3);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_grid');
});

test('爬移：参数非法返回 bad_thickness / bad_bleed', () => {
  let r = E.creepCompensation(1, 2, {}, [{ axis: 'v', line: 1, dir: 'r' }], -1, 3);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_thickness');

  r = E.creepCompensation(1, 2, {}, [{ axis: 'v', line: 1, dir: 'r' }], 0.1, 'abc');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_bleed');

  r = E.creepCompensation(1, 2, {}, [{ axis: 'v', line: 1, dir: 'r' }], NaN, -0.01);
  assert.equal(r.ok, false);
});

test('爬移：最外叶为第 0 层且补偿 0；补偿量 = 纸厚 × 外侧叶数；最大补偿在最内叶', () => {
  const r = E.creepCompensation(2, 2, {}, STEPS_2x2, 0.1, 3);
  assert.equal(r.ok, true);
  assert.equal(r.leafCount, 4);
  assert.deepEqual(r.leaves.map((l) => l.leafIndex), [0, 1, 2, 3]);
  assert.deepEqual(r.leaves.map((l) => l.outsideCount), [0, 1, 2, 3]);
  assert.deepEqual(r.leaves.map((l) => l.creep), [0, 0.1, 0.2, 0.3]);
  assert.equal(r.maxCompensation, 0.3);
  // 最外叶为叠顶（封面叶）
  const { state } = E.replay(2, 2, {}, STEPS_2x2);
  const cell = Object.keys(state.stacks)[0];
  assert.equal(r.leaves[0].panelId, state.stacks[cell][0]);
});

test('爬移：1×1 未折叠单叠——书脊 none、全部偏移为 0、可应用', () => {
  const r = E.creepCompensation(1, 1, {}, [], 0.1, 0);
  assert.equal(r.ok, true);
  assert.equal(r.spineAxis, 'none');
  assert.equal(r.spineSide, null);
  assert.equal(r.maxCompensation, 0);
  assert.equal(r.canApply, true);
  assert.deepEqual(r.worldDir, { x: 0, y: 0 });
});

test('爬移：竖直末折（向右折）书脊在终叠左缘，世界方向 −x；正/反面带符号偏移相反', () => {
  // 1×2 沿 x=1 向右折：终叠在格(1,0)，书脊左缘
  const r = E.creepCompensation(1, 2, {}, [{ axis: 'v', line: 1, dir: 'r' }], 0.1, 0.5);
  assert.equal(r.spineAxis, 'vertical');
  assert.equal(r.spineSide, 'left');
  assert.deepEqual(r.worldDir, { x: -1, y: 0 });
  const inner = r.leaves[1];
  assert.equal(inner.origin, '1,0');
  assert.equal(inner.axis, 'x');
  // 内叶末态 frame.x 已被竖折取反：世界 −x 内移 -> 原格 dx = +0.1？(详见标架逆映射)
  // 正面版偏移即原格 dx；反面长边翻面镜像 -> 符号相反
  assert.equal(inner.front.offset, -inner.back.offset);
  assert.notEqual(inner.front.offset, 0);
});

test('爬移：竖直末折向左折时书脊在右缘，世界方向 +x，符号与右折相反', () => {
  const r = E.creepCompensation(1, 2, {}, [{ axis: 'v', line: 1, dir: 'l' }], 0.1, 0.5);
  assert.equal(r.spineSide, 'right');
  assert.deepEqual(r.worldDir, { x: 1, y: 0 });
  // 与右折的内叶正面偏移符号相反
  const rr = E.creepCompensation(1, 2, {}, [{ axis: 'v', line: 1, dir: 'r' }], 0.1, 0.5);
  assert.equal(
    Math.sign(r.leaves[1].front.offset),
    -Math.sign(rr.leaves[1].front.offset)
  );
});

test('爬移：水平末折书脊为横边，纵向偏移正/反面相同（长边翻转仅镜像横向）', () => {
  const d = E.creepCompensation(2, 1, {}, [{ axis: 'h', line: 1, dir: 'd' }], 0.1, 0.5);
  assert.equal(d.spineAxis, 'horizontal');
  assert.equal(d.spineSide, 'top');
  assert.deepEqual(d.worldDir, { x: 0, y: -1 });
  const inner = d.leaves[1];
  assert.equal(inner.axis, 'y');
  assert.equal(inner.front.offset, inner.back.offset);
  assert.notEqual(inner.front.offset, 0);

  const u = E.creepCompensation(2, 1, {}, [{ axis: 'h', line: 1, dir: 'u' }], 0.1, 0.5);
  assert.equal(u.spineSide, 'bottom');
  assert.deepEqual(u.worldDir, { x: 0, y: 1 });
  assert.equal(Math.sign(u.leaves[1].front.offset), -Math.sign(inner.front.offset));
});

test('爬移：2×2 先竖后横（末折为脊）各叶偏移符号逐叶朝同一书脊边', () => {
  const r = E.creepCompensation(2, 2, {}, STEPS_2x2, 0.1, 1);
  assert.equal(r.spineAxis, 'horizontal');
  assert.equal(r.spineSide, 'top');
  // 所有非零叶沿 y 方向承载偏移
  for (const lf of r.leaves) assert.equal(lf.axis, 'y');
  // 正反偏移绝对值等于该叶补偿量
  for (const lf of r.leaves) {
    assert.equal(Math.abs(lf.front.offset), lf.creep);
    assert.equal(Math.abs(lf.back.offset), lf.creep);
  }
});

test('爬移：逐面偏移与末态标架手算一致（2×2）', () => {
  const steps = STEPS_2x2;
  const r = E.creepCompensation(2, 2, {}, steps, 0.1, 1);
  const { state } = E.replay(2, 2, {}, steps);
  for (const lf of r.leaves) {
    const p = state.panels[lf.panelId];
    const W = { x: r.worldDir.x * lf.creep, y: r.worldDir.y * lf.creep };
    const lx = W.x * (p.frame.x.x || 0) + W.y * (p.frame.x.y || 0);
    const ly = W.x * (p.frame.y.x || 0) + W.y * (p.frame.y.y || 0);
    assert.ok(Math.abs(lx - lf.front.dx) < 1e-9);
    assert.ok(Math.abs(ly - lf.front.dy) < 1e-9);
    assert.ok(Math.abs(-lx - lf.back.dx) < 1e-9);
    assert.ok(Math.abs(ly - lf.back.dy) < 1e-9);
  }
});

test('爬移：1×4 四连折两折后逐叶补偿 0/.1/.2/.3，正反面 |offset|=creep', () => {
  const steps = [
    { axis: 'v', line: 2, dir: 'r' },
    { axis: 'v', line: 3, dir: 'l' }
  ];
  const r = E.creepCompensation(1, 4, {}, steps, 0.1, 1);
  assert.equal(r.leafCount, 4);
  assert.equal(r.maxCompensation, 0.3);
  assert.deepEqual(r.leaves.map((l) => l.creep), [0, 0.1, 0.2, 0.3]);
  for (const lf of r.leaves) {
    assert.equal(lf.axis, 'x');
    assert.equal(Math.abs(lf.front.offset), lf.creep);
    assert.equal(Math.abs(lf.back.offset), lf.creep);
    if (lf.creep > 0) assert.equal(lf.front.offset, -lf.back.offset);
  }
});

test('爬移：出血阈值——等于是界内，超出标红并禁用应用', () => {
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  // 出血 0.1，最大 |偏移| 0.1：等于不超
  let r = E.creepCompensation(1, 2, {}, steps, 0.1, 0.1);
  assert.equal(r.canApply, true);
  assert.equal(r.overBleedCount, 0);
  assert.equal(r.leaves[1].front.overBleed, false);

  // 出血 0.09：最内叶两面超限标红，最外叶仍界内
  r = E.creepCompensation(1, 2, {}, steps, 0.1, 0.09);
  assert.equal(r.canApply, false);
  assert.equal(r.overBleedCount, 2);
  assert.equal(r.leaves[0].front.overBleed, false);
  assert.equal(r.leaves[1].front.overBleed, true);
  assert.equal(r.leaves[1].back.overBleed, true);

  // 出血 0：最内叶（非零偏移）即超限
  r = E.creepCompensation(1, 2, {}, steps, 0.1, 0);
  assert.equal(r.canApply, false);
  assert.equal(r.overBleedCount, 2);

  // 纸厚 0：全部为 0，出血 0 也可应用
  r = E.creepCompensation(1, 2, {}, steps, 0, 0);
  assert.equal(r.canApply, true);
  assert.equal(r.maxCompensation, 0);
});

test('爬移：每个原始纸格恰好出现一次且正反两面齐全', () => {
  const r = E.creepCompensation(2, 2, {}, STEPS_2x2, 0.1, 3);
  const ids = r.leaves.map((l) => l.origin).sort();
  assert.deepEqual(ids, ['0,0', '0,1', '1,0', '1,1']);
  for (const lf of r.leaves) {
    assert.equal(typeof lf.front.offset, 'number');
    assert.equal(typeof lf.back.offset, 'number');
    assert.equal(lf.panelId, lf.origin);
  }
});

test('爬移：纯函数，不改写 labels/steps/参数', () => {
  const labels = { '0,0': { front: '1', back: '2' } };
  const steps = STEPS_2x2.map((s) => ({ ...s }));
  const snapL = JSON.stringify(labels);
  const snapS = JSON.stringify(steps);
  E.creepCompensation(2, 2, labels, steps, 0.1, 3);
  assert.equal(JSON.stringify(labels), snapL);
  assert.equal(JSON.stringify(steps), snapS);
});

test('爬移：normalizeCreepScheme 规整/丢弃规则', () => {
  const good = E.normalizeCreepScheme({
    params: { paperThickness: '0.1', bleed: 3 },
    faces: {
      '0,0': { front: 0, back: 0, axis: 'x', creep: 0 },
      '1,0': { front: -0.1, back: 0.1, axis: 'x', creep: 0.1 }
    },
    basis: { rows: 1, cols: 2, stepsSignature: 'sig' },
    spineAxis: 'vertical', maxCompensation: 0.1, appliedAt: 't'
  }, 1, 2);
  assert.equal(good.params.paperThickness, 0.1);
  assert.equal(good.faces['1,0'].front, -0.1);
  assert.equal(good.basis.stepsSignature, 'sig');

  assert.equal(E.normalizeCreepScheme(null, 1, 2), null);
  assert.equal(E.normalizeCreepScheme('x', 1, 2), null);
  assert.equal(E.normalizeCreepScheme([], 1, 2), null);
  assert.equal(E.normalizeCreepScheme({ params: { paperThickness: -1, bleed: 3 }, faces: {} }, 1, 2), null);
  assert.equal(E.normalizeCreepScheme({ params: { paperThickness: 0.1, bleed: 3 } }, 1, 2), null);
  // 越界格被剔除，非法 axis 被忽略，未知字段不透传
  const oob = E.normalizeCreepScheme({
    params: { paperThickness: 0.1, bleed: 3 },
    faces: { '9,9': { front: 1, back: 2 }, '0,0': { front: 0, back: 0, axis: 'z' } },
    unknownField: 123
  }, 1, 2);
  assert.deepEqual(Object.keys(oob.faces), ['0,0']);
  assert.equal(oob.faces['0,0'].axis, undefined);
  assert.equal(oob.unknownField, undefined);
});

test('爬移：normalizePlan 保留合法独立字段、丢弃非法字段', () => {
  const p = E.normalizePlan({
    rows: 1, cols: 2,
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    creepCompensation: {
      params: { paperThickness: 0.1, bleed: 3 },
      faces: { '1,0': { front: -0.1, back: 0.1, axis: 'x', creep: 0.1 } }
    }
  });
  assert.ok(p.creepCompensation);
  assert.equal(p.creepCompensation.faces['1,0'].back, 0.1);

  const dropped = E.normalizePlan({
    rows: 1, cols: 2,
    creepCompensation: { params: { paperThickness: 'bad', bleed: 3 }, faces: {} }
  });
  assert.equal(dropped.creepCompensation, undefined);
});
