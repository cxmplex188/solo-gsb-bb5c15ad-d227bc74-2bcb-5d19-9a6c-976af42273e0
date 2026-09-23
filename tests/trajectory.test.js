'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const L = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, [f, b]]) => [k, { front: f, back: b }]));

test('轨迹：无步骤时只有第 0 步节点，正面朝上、正立、顶层', () => {
  const r = E.trackPanel(1, 2, L({ '0,0': ['1', '2'] }), [], { cell: '0,0', face: 'front' });
  assert.equal(r.ok, true);
  assert.equal(r.completed, true);
  assert.equal(r.interrupted, null);
  assert.equal(r.points.length, 1);
  assert.deepEqual(r.points[0], {
    step: 0, cell: '0,0', layer: 1, depth: 1,
    face: 'front', faceUp: true, upright: true, label: '1'
  });
});

test('轨迹：初始时反面朝下，空白页码 label 为 null', () => {
  const r = E.trackPanel(1, 2, {}, [], { cell: '1,0', face: 'back' });
  assert.equal(r.points[0].faceUp, false);
  assert.equal(r.points[0].upright, true);
  assert.equal(r.points[0].label, null);
});

test('轨迹：1×2 向右对折，左格面片以原始身份移入右格顶层，正面翻为朝下', () => {
  const r = E.trackPanel(1, 2, L({ '0,0': ['4', '1'] }),
    [{ axis: 'v', line: 1, dir: 'r' }], { cell: '0,0', face: 'front' });
  assert.equal(r.completed, true);
  assert.equal(r.points.length, 2);
  assert.deepEqual(r.points.map((p) => p.cell), ['0,0', '1,0']);
  assert.deepEqual(r.points.map((p) => [p.layer, p.depth]), [[1, 1], [1, 2]]);
  assert.deepEqual(r.points.map((p) => p.faceUp), [true, false]);
  assert.deepEqual(r.points.map((p) => p.upright), [true, true]);
  // 同一面片的反面此时朝上，页码随片携带
  assert.equal(r.points[1].label, '4');
  const rb = E.trackPanel(1, 2, L({ '0,0': ['4', '1'] }),
    [{ axis: 'v', line: 1, dir: 'r' }], { cell: '0,0', face: 'back' });
  assert.deepEqual(rb.points.map((p) => p.faceUp), [false, true]);
  assert.equal(rb.points[1].label, '1');
});

test('轨迹：向左对折时右格面片叠到左格上方，追踪右格身份不丢', () => {
  const r = E.trackPanel(1, 2, {},
    [{ axis: 'v', line: 1, dir: 'l' }], { cell: '1,0', face: 'front' });
  assert.equal(r.points[1].cell, '0,0');
  assert.equal(r.points[1].layer, 1);
  assert.equal(r.points[1].depth, 2);
  // 静止的左格面片沉到第二层
  const r0 = E.trackPanel(1, 2, {},
    [{ axis: 'v', line: 1, dir: 'l' }], { cell: '0,0', face: 'front' });
  assert.equal(r0.points[1].cell, '0,0');
  assert.equal(r0.points[1].layer, 2);
  assert.equal(r0.points[1].depth, 2);
  assert.equal(r0.points[1].faceUp, true);   // 静止片未翻面
});

test('轨迹：2×2 两次对折，合并后各片层序与朝向逐一正确', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'h', line: 1, dir: 'd' }
  ];
  // 终叠 stack['1,1'] = ['1,0','0,0','0,1','1,1']
  const p00 = E.trackPanel(2, 2, {}, steps, { cell: '0,0', face: 'front' });
  assert.deepEqual(p00.points.map((p) => p.step), [0, 1, 2]);
  assert.deepEqual(p00.points.map((p) => p.cell), ['0,0', '1,0', '1,1']);
  assert.deepEqual(p00.points.map((p) => p.layer), [1, 1, 2]);
  assert.deepEqual(p00.points.map((p) => p.depth), [1, 2, 4]);
  assert.deepEqual(p00.points.map((p) => p.faceUp), [true, false, true]);
  assert.deepEqual(p00.points.map((p) => p.upright), [true, true, false]);

  const p11 = E.trackPanel(2, 2, {}, steps, { cell: '1,1', face: 'front' });
  assert.deepEqual(p11.points.map((p) => p.cell), ['1,1', '1,1', '1,1']);
  assert.deepEqual(p11.points.map((p) => p.layer), [1, 2, 4]);
  assert.deepEqual(p11.points.map((p) => p.depth), [1, 2, 4]);
  assert.ok(p11.points.every((p) => p.faceUp && p.upright), '静止片始终正面朝上、正立');

  const p10 = E.trackPanel(2, 2, {}, steps, { cell: '1,0', face: 'back' });
  assert.deepEqual(p10.points.map((p) => p.layer), [1, 2, 1]);
  assert.equal(p10.points[2].cell, '1,1');
});

test('轨迹：水平下折后移动片页码倒置（upright=false）', () => {
  const r = E.trackPanel(2, 1, {},
    [{ axis: 'h', line: 1, dir: 'd' }], { cell: '0,0', face: 'front' });
  assert.equal(r.points[1].cell, '0,1');
  assert.equal(r.points[1].upright, false);
  assert.equal(r.points[1].faceUp, false);
});

test('轨迹：首个非法步中断，保留此前节点并标明原因与冲突格', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },   // 合法
    { axis: 'v', line: 2, dir: 'l' }    // 1×3 厚度冲突
  ];
  const r = E.trackPanel(1, 3, {}, steps, { cell: '0,0', face: 'front' });
  assert.equal(r.ok, true);
  assert.equal(r.completed, false);
  assert.deepEqual(r.points.map((p) => p.step), [0, 1]);
  assert.equal(r.points[1].cell, '1,0');
  assert.equal(r.points[1].depth, 2);
  assert.ok(r.interrupted);
  assert.equal(r.interrupted.stepIndex, 1);
  assert.equal(r.interrupted.code, 'thickness');
  assert.deepEqual(r.interrupted.conflicts, ['2,0', '1,0']);
  assert.ok(r.interrupted.message.length > 0);
});

test('轨迹：外轮廓非法步同样中断并标 contour', () => {
  const steps = [{ axis: 'v', line: 2, dir: 'r' }];   // 2×3 宽瓣悬空
  const r = E.trackPanel(2, 3, {}, steps, { cell: '0,0', face: 'front' });
  assert.equal(r.completed, false);
  assert.equal(r.points.length, 1, '非法步不生成节点');
  assert.equal(r.interrupted.code, 'contour');
  assert.equal(r.interrupted.stepIndex, 0);
  assert.ok(r.interrupted.conflicts.includes('0,0'));
});

test('轨迹：四片合并为单叠后身份仍可逐层追踪（1×4 连续对折）', () => {
  // 1×4：先把左列折入 1 列，再把右侧两列（3→2）折，末折把两叠合拢
  // 可行合法序列：v1 r（0→1），v3 l（3→2），v2 l（2 列叠[3,2]压向 1 列叠[0,1]）
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 3, dir: 'l' },
    { axis: 'v', line: 2, dir: 'l' }
  ];
  const rep = E.replay(1, 4, {}, steps);
  assert.equal(rep.error, null, '前置：该序列合法');
  assert.deepEqual(Object.keys(rep.state.stacks), ['1,0']);
  for (const id of ['0,0', '1,0', '2,0', '3,0']) {
    const r = E.trackPanel(1, 4, {}, steps, { cell: id, face: 'front' });
    assert.equal(r.points.length, 4);
    const last = r.points[3];
    assert.equal(last.cell, '1,0');
    assert.equal(last.depth, 4);
    assert.ok(last.layer >= 1 && last.layer <= 4);
    // 每个层序恰好被一片占据
    assert.equal(rep.state.stacks['1,0'][last.layer - 1], id);
  }
  // 四片终态层序互不相同
  const layers = ['0,0', '1,0', '2,0', '3,0'].map((id) =>
    E.trackPanel(1, 4, {}, steps, { cell: id, face: 'front' }).points[3].layer);
  assert.equal(new Set(layers).size, 4);
});

test('轨迹：非法网格 / 目标原格越界 / 面别非法均返回 ok:false', () => {
  assert.equal(E.trackPanel(0, 2, {}, [], { cell: '0,0', face: 'front' }).code, 'bad_grid');
  assert.equal(E.trackPanel(2, 2, {}, [], { cell: '2,0', face: 'front' }).code, 'bad_target');
  assert.equal(E.trackPanel(2, 2, {}, [], { cell: 'x', face: 'front' }).code, 'bad_target');
  assert.equal(E.trackPanel(2, 2, {}, [], { cell: '0,0', face: 'side' }).code, 'bad_target');
  // steps 非数组按空序列处理，不抛错
  const r = E.trackPanel(2, 2, {}, null, { cell: '0,0', face: 'front' });
  assert.equal(r.ok, true);
  assert.equal(r.points.length, 1);
});

test('轨迹：标注变化后页码随节点更新（标签不影响几何轨迹）', () => {
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  const a = E.trackPanel(1, 2, {}, steps, { cell: '0,0', face: 'back' });
  const b = E.trackPanel(1, 2, L({ '0,0': ['4', '1'] }), steps, { cell: '0,0', face: 'back' });
  assert.equal(a.points[1].label, null);
  assert.equal(b.points[1].label, '1');
  assert.deepEqual(a.points.map((p) => [p.cell, p.layer, p.depth, p.faceUp, p.upright]),
    b.points.map((p) => [p.cell, p.layer, p.depth, p.faceUp, p.upright]));
});
