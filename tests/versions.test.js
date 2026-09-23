'use strict';
/*
 * 版本差异引擎 diffPlans 单元测试：
 *  - 以原始纸格坐标为身份的正反页码增 / 删 / 改（含清空=空白）
 *  - 以步骤序号为身份的折叠步骤增 / 删 / 改与受影响纸格
 *  - 校样批注按 id 身份的增删改（字段级 from/to；元数据字段不参与）
 *  - 名称 / 备注 / 标签元信息差异；网格尺寸变化；affectedCells/removedCells
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

function basePlan(over = {}) {
  return {
    name: '方案', rows: 1, cols: 2, labels: {}, steps: [],
    tags: [], note: '', annotations: [], ...over
  };
}

test('正反页码：按原始纸格身份报告 增 / 删 / 改 / 清空（空白面）', () => {
  const from = basePlan({
    labels: { '0,0': { front: '4', back: '1' }, '1,0': { front: '2', back: '3' } }
  });
  const to = basePlan({
    // 0,0 front 修改；1,0 front 清空（remove）；back 保持；新格无（网格相同）
    labels: { '0,0': { front: '9', back: '1' }, '1,0': { front: '', back: '3' } }
  });
  const d = E.diffPlans(from, to);
  assert.equal(d.ok, true);
  const find = (cell, face) => d.labels.find((e) => e.cell === cell && e.face === face);
  assert.equal(find('0,0', 'front').kind, 'modify');
  assert.equal(find('0,0', 'front').from, '4');
  assert.equal(find('0,0', 'front').to, '9');
  assert.equal(find('1,0', 'front').kind, 'remove');
  assert.equal(find('1,0', 'front').from, '2');
  assert.equal(find('1,0', 'front').to, '');
  assert.equal(find('0,0', 'back'), undefined, '未变化面不报告');
  // 从无标注到有标注 = add
  const d2 = E.diffPlans(basePlan(), basePlan({ labels: { '0,0': { front: '1', back: '' } } }));
  assert.equal(d2.labels.length, 1);
  assert.equal(d2.labels[0].kind, 'add');
  assert.equal(d2.labels[0].face, 'front');
  // 汇总
  assert.deepEqual(d.summary.labels, { add: 0, remove: 1, modify: 1 });
});

test('正反页码：受影响纸格去重且按行列排序', () => {
  const from = basePlan({
    rows: 2, cols: 2,
    labels: {
      '1,0': { front: 'a', back: '' },
      '0,1': { front: '', back: 'b' },
      '0,0': { front: 'c', back: '' }
    }
  });
  const to = basePlan({
    rows: 2, cols: 2,
    labels: {
      '1,0': { front: 'a2', back: '' },
      '0,1': { front: '', back: 'b2' },
      '0,0': { front: 'c2', back: '' }
    }
  });
  const d = E.diffPlans(from, to);
  assert.deepEqual(d.affectedCells, ['0,0', '1,0', '0,1']);
});

test('折叠步骤：按步骤序号报告新增 / 删除 / 修改，fromCells/toCells 给移动原格', () => {
  const stepV = { axis: 'v', line: 1, dir: 'r' };
  // 中间插入：序号 1 的步骤身份变化 → modify（v1 右折 -> h1 下折），末尾新增
  const from = basePlan({ rows: 2, cols: 2, steps: [stepV] });
  const to = basePlan({
    rows: 2, cols: 2,
    steps: [stepV, { axis: 'h', line: 1, dir: 'd' }]
  });
  let d = E.diffPlans(from, to);
  assert.equal(d.summary.steps.add, 1);
  assert.equal(d.steps[0].kind, 'add');
  assert.equal(d.steps[0].index, 1);
  assert.deepEqual(d.steps[0].toCells.sort(), ['0,0', '1,0'],
    'h1 下折移动上半行两格（原始身份）');

  // 修改首步：方向变化
  d = E.diffPlans(
    basePlan({ rows: 1, cols: 2, steps: [stepV] }),
    basePlan({ rows: 1, cols: 2, steps: [{ axis: 'v', line: 1, dir: 'l' }] })
  );
  assert.equal(d.steps.length, 1);
  assert.equal(d.steps[0].kind, 'modify');
  assert.deepEqual(d.steps[0].from, stepV);
  assert.equal(d.steps[0].to.dir, 'l');
  assert.deepEqual(d.steps[0].fromCells, ['0,0']);
  assert.deepEqual(d.steps[0].toCells, ['1,0']);
  assert.ok(d.steps[0].fromText.includes('竖线'));

  // 删除末步
  d = E.diffPlans(
    basePlan({ rows: 2, cols: 2, steps: [stepV, { axis: 'h', line: 1, dir: 'd' }] }),
    basePlan({ rows: 2, cols: 2, steps: [stepV] })
  );
  assert.equal(d.steps[0].kind, 'remove');
  assert.equal(d.steps[0].index, 1);
  assert.deepEqual(d.steps[0].to, null);
});

test('折叠步骤：前缀非法时 fromCells 几何兜底（移动半区原格）', () => {
  const from = basePlan({
    rows: 1, cols: 3,
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }   // 厚度冲突的非法步
    ]
  });
  const to = basePlan({
    rows: 1, cols: 3,
    steps: [{ axis: 'v', line: 1, dir: 'r' }]
  });
  const d = E.diffPlans(from, to);
  assert.equal(d.steps[0].kind, 'remove');
  // 非法步 l 折移动右侧（cx>=line=2）半区：初始原格 2,0
  assert.deepEqual(d.steps[0].fromCells, ['2,0']);
});

test('校样批注：按 id 身份报告新增 / 删除 / 字段级修改', () => {
  const a1 = {
    id: 'ann000001', cell: '0,0', face: 'front', severity: 'error',
    text: '旧正文', step: 0, resolved: false,
    createdAt: '2026-09-22T00:00:00.000Z'
  };
  const a2 = {
    id: 'ann000002', cell: '1,0', face: 'back', severity: 'info',
    text: '将被删除', step: 1, resolved: true, resolvedAt: '2026-09-22T02:00:00.000Z'
  };
  const from = basePlan({ annotations: [a1, a2] });
  const to = basePlan({
    annotations: [
      { ...a1, text: '新正文', severity: 'warning', resolved: true, resolvedAt: '2026-09-23T00:00:00Z' },
      { id: 'ann000003', cell: '0,0', face: 'back', severity: 'info', text: '新增', step: 0, resolved: false }
    ]
  });
  const d = E.diffPlans(from, to);
  assert.deepEqual(d.summary.annotations, { add: 1, remove: 1, modify: 1 });
  const mod = d.annotations.find((e) => e.id === 'ann000001');
  assert.equal(mod.kind, 'modify');
  const fields = Object.fromEntries(mod.fields.map((f) => [f.field, f]));
  assert.equal(fields.text.from, '旧正文');
  assert.equal(fields.text.to, '新正文');
  assert.equal(fields.severity.from, 'error');
  assert.equal(fields.severity.to, 'warning');
  assert.equal(fields.resolved.from, false);
  assert.equal(fields.resolved.to, true);
  // createdAt / resolvedAt 为元数据，不产生差异
  assert.equal(fields.createdAt, undefined);
  assert.equal(fields.resolvedAt, undefined);
  const removed = d.annotations.find((e) => e.id === 'ann000002');
  assert.equal(removed.kind, 'remove');
  assert.equal(removed.to, null);
  const added = d.annotations.find((e) => e.id === 'ann000003');
  assert.equal(added.kind, 'add');
  assert.equal(added.from, null);
});

test('批注修改：移动纸格（cell 变）高亮新旧两个原格', () => {
  const from = basePlan({
    annotations: [{
      id: 'ann000009', cell: '0,0', face: 'front', severity: 'info',
      text: 'x', step: 0, resolved: false
    }]
  });
  const to = basePlan({
    annotations: [{
      id: 'ann000009', cell: '1,0', face: 'front', severity: 'info',
      text: 'x', step: 0, resolved: false
    }]
  });
  const d = E.diffPlans(from, to);
  assert.equal(d.annotations[0].fields[0].field, 'cell');
  assert.deepEqual(d.affectedCells, ['0,0', '1,0']);
});

test('元信息：名称 / 备注修改与标签增删', () => {
  const from = basePlan({ name: '旧名', note: '旧备注', tags: ['骑马钉', 'A4'] });
  const to = basePlan({ name: '新名', note: '新备注', tags: ['骑马钉', '胶装'] });
  const d = E.diffPlans(from, to);
  const byField = Object.fromEntries(d.meta.map((e) => [e.field + ':' + e.kind, e]));
  assert.ok(byField['name:modify']);
  assert.equal(byField['name:modify'].to, '新名');
  assert.ok(byField['note:modify']);
  assert.equal(byField['tag:add'].value, '胶装');
  assert.equal(byField['tag:remove'].value, 'A4');
});

test('网格尺寸变化：grid 非空；越出新版网格的旧纸格进入 removedCells', () => {
  const from = {
    name: 'p', rows: 2, cols: 3,
    labels: { '2,1': { front: '9', back: '' } },
    steps: [], tags: [], note: '', annotations: []
  };
  const to = {
    name: 'p', rows: 2, cols: 2,
    labels: {}, steps: [], tags: [], note: '', annotations: []
  };
  const d = E.diffPlans(from, to);
  assert.deepEqual(d.grid, { from: { rows: 2, cols: 3 }, to: { rows: 2, cols: 2 } });
  assert.deepEqual(d.removedCells, ['2,1'], '2,1 越出新版 2×2 网格');
  assert.ok(!d.affectedCells.includes('2,1'),
    'affectedCells 仅含可在新版画布上高亮的纸格，越界者进 removedCells');
});

test('完全相同的两版本：total=0、grid=null、无差异条目', () => {
  const p = basePlan({
    labels: { '0,0': { front: '1', back: '2' } },
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    annotations: [{
      id: 'ann000010', cell: '0,0', face: 'front', severity: 'info',
      text: 'a', step: 1, resolved: false
    }]
  });
  const d = E.diffPlans(p, JSON.parse(JSON.stringify(p)));
  assert.equal(d.grid, null);
  assert.equal(d.labels.length, 0);
  assert.equal(d.steps.length, 0);
  assert.equal(d.annotations.length, 0);
  assert.equal(d.meta.length, 0);
  assert.equal(d.summary.total, 0);
});

test('宽容输入：缺字段 / null / 数组 steps 不抛错', () => {
  assert.doesNotThrow(() => E.diffPlans(null, undefined));
  const d = E.diffPlans({}, { name: 'x' });
  assert.ok(Array.isArray(d.labels) && Array.isArray(d.steps));
  assert.equal(d.meta.find((e) => e.field === 'name').to, 'x');
});
