'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS_2x2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];

function gridOrigins(plate) {
  return plate.grid.map((row) => row.map((c) => c.origin));
}

test('双面版：前置条件与自动拼版一致（合法折帖可用）', () => {
  const elig = E.duplexEligibility(2, 2, {}, STEPS_2x2);
  assert.equal(elig.ok, true);
  assert.equal(elig.capacity, 8);
});

test('双面版：非法折叠 / 未收成单叠 / 网格非法时禁用并给出原因', () => {
  const badSteps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 2, dir: 'l' }
  ];
  let r = E.buildDuplexPlates(1, 3, {}, badSteps, 'long');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'thickness');
  assert.equal(r.stepIndex, 1);

  r = E.buildDuplexPlates(2, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }], 'long');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_single_stack');
  assert.equal(r.stackCount, 4);

  r = E.buildDuplexPlates(0, 2, {}, [], 'long');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_grid');

  assert.equal(E.duplexEligibility(1, 3, {}, badSteps).ok, false);
});

test('双面版：非法翻面方式返回 bad_flip', () => {
  const r = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'sideways');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_flip');
});

test('双面版：正面版不镜像；长边翻转背面版左右镜像', () => {
  const r = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'long');
  assert.equal(r.ok, true);
  assert.equal(r.flip, 'long');
  assert.equal(r.flipAxis, 'vertical');
  assert.deepEqual(gridOrigins(r.front), [
    ['0,0', '1,0'],
    ['0,1', '1,1']
  ]);
  assert.deepEqual(gridOrigins(r.back), [
    ['1,0', '0,0'],
    ['1,1', '0,1']
  ]);
  assert.equal(r.front.edge, 'right');
  assert.equal(r.back.edge, 'left');
});

test('双面版：短边翻转背面版上下镜像，翻面边为横边', () => {
  const r = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'short');
  assert.equal(r.flipAxis, 'horizontal');
  assert.deepEqual(gridOrigins(r.back), [
    ['0,1', '1,1'],
    ['0,0', '1,0']
  ]);
  assert.deepEqual(gridOrigins(r.front), [
    ['0,0', '1,0'],
    ['0,1', '1,1']
  ]);
  assert.equal(r.front.edge, 'top');
  assert.equal(r.back.edge, 'bottom');
  assert.equal(r.back.mirrored, true);
});

test('双面版：非方阵（1 行 4 列四连折）镜像方向各自正确', () => {
  // 1×4 对折再对折：先 line=2 左瓣右折（0,1 镜像到 3,2 配对），再 line=3 右瓣左折
  const okSteps = [
    { axis: 'v', line: 2, dir: 'r' },
    { axis: 'v', line: 3, dir: 'l' }
  ];
  assert.equal(E.replay(1, 4, {}, okSteps).error, null);
  const r = E.buildDuplexPlates(1, 4, {}, okSteps, 'long');
  assert.deepEqual(gridOrigins(r.front), [['0,0', '1,0', '2,0', '3,0']]);
  assert.deepEqual(gridOrigins(r.back), [['3,0', '2,0', '1,0', '0,0']]);
  // 短边翻转时 1 行网格 y 方向只有一行，不发生上下镜像
  const rs = E.buildDuplexPlates(1, 4, {}, okSteps, 'short');
  assert.deepEqual(gridOrigins(rs.back), [['0,0', '1,0', '2,0', '3,0']]);
});

test('双面版：每格正反两面各出现一次，页码与空白标记正确', () => {
  const labels = {
    '0,0': { front: '4', back: '' },          // 反面空白
    '1,0': { front: '6', back: '3' },
    '0,1': { front: '', back: '' },           // 整格空白
    '1,1': { front: '7', back: '2' }
  };
  const r = E.buildDuplexPlates(2, 2, labels, STEPS_2x2, 'long');
  const all = r.front.grid.flat().concat(r.back.grid.flat());
  assert.equal(all.length, 8);
  const keys = new Set(all.map((c) => `${c.origin}:${c.face}`));
  assert.equal(keys.size, 8);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      assert.ok(keys.has(`${x},${y}:front`));
      assert.ok(keys.has(`${x},${y}:back`));
    }
  }
  // 空白面：保留占位、label=null、blank=true
  const back00 = r.back.grid.flat().find((c) => c.origin === '0,0' && c.face === 'back');
  assert.equal(back00.blank, true);
  assert.equal(back00.label, null);
  const front10 = r.front.grid.flat().find((c) => c.origin === '1,0' && c.face === 'front');
  assert.equal(front10.blank, false);
  assert.equal(front10.label, '6');
});

test('双面版：制版旋转由面片朝向 frame.y 决定（长边规则）', () => {
  const r = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'long');
  const { state } = E.replay(2, 2, {}, STEPS_2x2);
  for (const plate of [r.front, r.back]) {
    for (const c of plate.grid.flat()) {
      const p = state.panels[c.origin];
      const expectRot = p.frame.y.y < 0 ? 180 : 0;
      assert.equal(c.rotate, expectRot, `${plate.face} ${c.origin} rotate`);
      assert.equal(c.upright, true);
    }
  }
});

test('双面版：短边翻转时反面旋转规则反转，正面不变', () => {
  const r = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'short');
  const { state } = E.replay(2, 2, {}, STEPS_2x2);
  for (const c of r.front.grid.flat()) {
    const p = state.panels[c.origin];
    assert.equal(c.rotate, p.frame.y.y < 0 ? 180 : 0);
  }
  for (const c of r.back.grid.flat()) {
    const p = state.panels[c.origin];
    // tumble：反面字形初始沿 -y，frame.y.y>0（末态与 +y 同向）才需 180° 补偿
    assert.equal(c.rotate, p.frame.y.y > 0 ? 180 : 0);
  }
});

test('双面版：视图格位坐标 (x,y) 与网格遍历位置一致', () => {
  const r = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'long');
  for (const plate of [r.front, r.back]) {
    plate.grid.forEach((rowArr, y) => rowArr.forEach((c, x) => {
      assert.equal(c.x, x);
      assert.equal(c.y, y);
    }));
  }
});

test('双面版：纯函数，不改写标注与步骤', () => {
  const labels = { '0,0': { front: '4', back: '5' } };
  const steps = STEPS_2x2.map((s) => ({ ...s }));
  const snapL = JSON.stringify(labels);
  const snapS = JSON.stringify(steps);
  E.buildDuplexPlates(2, 2, labels, steps, 'long');
  E.buildDuplexPlates(2, 2, labels, steps, 'short');
  assert.equal(JSON.stringify(labels), snapL);
  assert.equal(JSON.stringify(steps), snapS);
});

test('双面版：长边与短边仅背面不同；正面版完全一致', () => {
  const a = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'long');
  const b = E.buildDuplexPlates(2, 2, {}, STEPS_2x2, 'short');
  assert.deepEqual(
    a.front.grid.flat().map((c) => [c.origin, c.face, c.rotate, c.label]),
    b.front.grid.flat().map((c) => [c.origin, c.face, c.rotate, c.label])
  );
});

test('双面版：配合自动拼版标注，正反面页码覆盖连续 1..N（与回放槽位一致）', () => {
  const imp = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 8);
  const r = E.buildDuplexPlates(2, 2, imp.labels, STEPS_2x2, 'long');
  const pages = r.front.grid.flat().concat(r.back.grid.flat())
    .map((c) => c.label).filter(Boolean).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(pages, ['1', '2', '3', '4', '5', '6', '7', '8']);
});
