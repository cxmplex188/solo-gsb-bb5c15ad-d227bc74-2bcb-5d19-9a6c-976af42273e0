'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const L = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, [f, b]]) => [k, { front: f, back: b }]));

test('初始状态：每格单片、正面朝上、正立', () => {
  const s = E.initialState(2, 3, L({ '0,0': ['1', '2'] }));
  assert.equal(Object.keys(s.stacks).length, 6);
  assert.deepEqual(s.stacks['0,0'], ['0,0']);
  assert.equal(E.visibleFace(s.panels['0,0']).side, 'front');
  assert.equal(E.visibleFace(s.panels['0,0']).upright, true);
  assert.equal(s.panels['0,0'].front, '1');
  assert.equal(s.panels['0,0'].back, '2');
});

test('1×2 向右对折（左瓣翻过折线落到右侧）：移动片在上，骑马钉顺序 1..4', () => {
  const s0 = E.initialState(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '3'] }));
  assert.equal(E.validateFold(s0, { axis: 'v', line: 1, dir: 'r' }), null);
  const s = E.applyFold(s0, { axis: 'v', line: 1, dir: 'r' });
  assert.deepEqual(Object.keys(s.stacks), ['1,0']);
  assert.deepEqual(s.stacks['1,0'], ['0,0', '1,0']);
  const seq = E.pageSequence(s);
  assert.equal(seq.folded, true);
  assert.deepEqual(seq.stacks[0].sequence, ['1', '2', '3', '4']);
  // 顶片是被翻面的左瓣：朝上的是其背面（页码 1）
  assert.equal(seq.stacks[0].leaves[0].upper.face, 'back');
  assert.equal(seq.stacks[0].leaves[0].upper.label, '1');
});

test('向左对折：右瓣叠到左格上方', () => {
  const s = E.applyFold(E.initialState(1, 2), { axis: 'v', line: 1, dir: 'l' });
  assert.deepEqual(s.stacks['0,0'], ['1,0', '0,0']);
});

test('拒绝：折线越界 / 移动侧为空（折线不在当前外轮廓）', () => {
  const s0 = E.initialState(2, 2);
  assert.equal(E.validateFold(s0, { axis: 'v', line: 0, dir: 'l' }).code, 'contour');
  assert.equal(E.validateFold(s0, { axis: 'v', line: 2, dir: 'r' }).code, 'contour');
  const s1 = E.applyFold(s0, { axis: 'v', line: 1, dir: 'r' });   // 沿中线把左瓣折到右边
  assert.deepEqual(Object.keys(s1.stacks).sort(), ['1,0', '1,1']);
  // 再想“向右折”：左瓣已无占用
  assert.equal(E.validateFold(s1, { axis: 'v', line: 1, dir: 'r' }).code, 'contour');
});

test('拒绝：镜像悬空（折线不在当前外轮廓），标出冲突格', () => {
  const s0 = E.initialState(2, 3);
  // 沿 x=1 折左瓣：x=0 镜像到 x=1（有格）合法；
  // 沿 x=2 折左瓣（宽两列的瓣折向右边）：x=1→x=2 合法，但 x=0→x=3 悬空
  const e = E.validateFold(s0, { axis: 'v', line: 2, dir: 'r' });
  assert.equal(e.code, 'contour');
  assert.ok(e.conflicts.includes('0,0'));
  assert.ok(e.conflicts.includes('3,0'));
  assert.equal(Object.keys(s0.stacks).length, 6);   // 校验不改状态
});

test('拒绝：厚度不一致（包折/单折页），标出两侧冲突格', () => {
  const s0 = E.initialState(1, 3);
  // 先把最左列折到中列：中列 2 层，右列 1 层
  const s1 = E.applyFold(s0, { axis: 'v', line: 1, dir: 'r' });
  assert.equal(s1.stacks['1,0'].length, 2);
  // 再把右列折向中列（向左折）：1 层 vs 2 层
  const e = E.validateFold(s1, { axis: 'v', line: 2, dir: 'l' });
  assert.equal(e.code, 'thickness');
  assert.ok(e.conflicts.includes('2,0'));
  assert.ok(e.conflicts.includes('1,0'));
});

test('2×2 两次对半折收成四片单叠（8 页折帖），输出骑马钉顺序', () => {
  const s0 = E.initialState(2, 2, L({
    '0,0': ['4', '5'], '1,0': ['6', '3'],
    '0,1': ['8', '1'], '1,1': ['7', '2']
  }));
  const s1 = E.applyFold(s0, { axis: 'v', line: 1, dir: 'r' });
  assert.equal(Object.keys(s1.stacks).length, 2);
  assert.equal(s1.stacks['1,0'].length, 2);
  assert.equal(s1.stacks['1,1'].length, 2);
  const s2 = E.applyFold(s1, { axis: 'h', line: 1, dir: 'd' });
  assert.equal(Object.keys(s2.stacks).length, 1);
  assert.equal(s2.stacks['1,1'].length, 4);
  const seq = E.pageSequence(s2);
  // stack['1,1'] 顶→底 = [b,a,c,d]；骑马钉序列 = 各上面(顶→底)+各下面(底→顶)
  assert.deepEqual(seq.stacks[0].sequence, ['3', '4', '1', '7', '2', '8', '5', '6']);
  // b、a 经过末轮水平折，页码倒置；c 只经竖直折、d 未被水平折，保持正立
  const leaves = Object.fromEntries(seq.stacks[0].leaves.map((l) => [l.panelId, l]));
  assert.equal(leaves['1,0'].upper.upright, false);   // b
  assert.equal(leaves['0,0'].upper.upright, false);   // a
  assert.equal(leaves['0,1'].upper.upright, true);    // c
  assert.equal(leaves['1,1'].upper.upright, true);    // d
});

test('2×3 竖折后水平对折：镜像对等厚，合法收成 4 层双格', () => {
  const s1 = E.applyFold(E.initialState(2, 3), { axis: 'v', line: 1, dir: 'r' });
  assert.equal(E.validateFold(s1, { axis: 'h', line: 1, dir: 'd' }), null);
  const s2 = E.applyFold(s1, { axis: 'h', line: 1, dir: 'd' });
  assert.deepEqual(Object.keys(s2.stacks).sort(), ['1,1', '2,1']);
  assert.equal(s2.stacks['1,1'].length, 4);
  assert.equal(s2.stacks['2,1'].length, 2);
});

test('3×1 连续同向单页折 → 第二次厚度冲突（1 层压向 2 层）', () => {
  const s1 = E.applyFold(E.initialState(3, 1), { axis: 'h', line: 1, dir: 'd' });
  assert.equal(s1.stacks['0,1'].length, 2);   // 上行折入中行
  const e = E.validateFold(s1, { axis: 'h', line: 2, dir: 'u' });
  assert.equal(e.code, 'thickness');
  assert.ok(e.conflicts.includes('0,2'));
  assert.ok(e.conflicts.includes('0,1'));
});

test('水平折使页码倒置可被检出（frame.y 翻转）', () => {
  const s0 = E.initialState(2, 1, L({ '0,0': ['A', 'B'], '0,1': ['C', 'D'] }));
  const s = E.applyFold(s0, { axis: 'h', line: 1, dir: 'd' });
  const top = s.stacks['0,1'][0];
  const p = s.panels[top];
  assert.deepEqual(p.frame.y, { x: 0, y: -1, z: 0 });
  const leaf = E.pageSequence(s).stacks[0].leaves.find((l) => l.panelId === top);
  assert.equal(leaf.upper.upright, false);
  assert.equal(leaf.lower.upright, false);
});

test('replay：重放全部步骤，失败步返回错误且冲突可定位', () => {
  const plan = {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }   // 厚度冲突
    ]
  };
  const r = E.replay(plan.rows, plan.cols, plan.labels, plan.steps);
  assert.ok(r.error);
  assert.equal(r.error.stepIndex, 1);
  assert.equal(r.error.code, 'thickness');
  const r0 = E.replay(plan.rows, plan.cols, plan.labels, plan.steps, 1);
  assert.deepEqual(Object.keys(r0.state.stacks), ['1,0','2,0']);
  assert.equal(r0.error, null);
});

test('normalizePlan：接受合法方案，拒绝非法步骤/越界标签', () => {
  const p = E.normalizePlan({
    name: 't', rows: 2, cols: 2,
    labels: { '0,0': { front: 1, back: 8 } },
    steps: [{ axis: 'v', line: 1, dir: 'r' }]
  });
  assert.equal(p.labels['0,0'].front, '1');
  assert.throws(() => E.normalizePlan({ rows: 0, cols: 2 }));
  assert.throws(() => E.normalizePlan({
    rows: 2, cols: 2,
    labels: { '5,5': { front: 'x', back: 'y' } }
  }));
  assert.throws(() => E.normalizePlan({ rows: 2, cols: 2, steps: [{ axis: 'z' }] }));
});

test('空白页码输出为 null', () => {
  const s = E.applyFold(E.initialState(1, 2), { axis: 'v', line: 1, dir: 'r' });
  assert.deepEqual(E.pageSequence(s).stacks[0].sequence, [null, null, null, null]);
});
