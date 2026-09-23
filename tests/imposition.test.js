'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS_2x2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
const STEPS_1x2 = [{ axis: 'v', line: 1, dir: 'r' }];

function replaySeq(rows, cols, labels, steps) {
  const { state, error } = E.replay(rows, cols, labels, steps);
  assert.equal(error, null);
  return E.pageSequence(state).stacks[0].sequence;
}

test('自动拼版：2×2 折帖从第 1 页起 8 页，回放得到连续封面→封底序列', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 8);
  assert.equal(r.ok, true);
  assert.equal(r.capacity, 8);
  assert.equal(r.blankTrailing, 0);
  assert.deepEqual(replaySeq(2, 2, r.labels, STEPS_2x2),
    ['1', '2', '3', '4', '5', '6', '7', '8']);
  // 反向映射：1×2 折手的经典摆位，格(0,0) 正面 4 / 反面 1
  const r12 = E.autoImpose(1, 2, {}, STEPS_1x2, 1, 4);
  assert.deepEqual(r12.labels['0,0'], { front: '4', back: '1' });
  assert.deepEqual(r12.labels['1,0'], { front: '2', back: '3' });
});

test('自动拼版：起始页码任意，连续递增', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 17, 8);
  assert.deepEqual(replaySeq(2, 2, r.labels, STEPS_2x2),
    ['17', '18', '19', '20', '21', '22', '23', '24']);
});

test('自动拼版：成品页数小于容量时末尾槽位空白，并标明纸格与面', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 4);
  assert.equal(r.ok, true);
  assert.equal(r.blankTrailing, 4);
  assert.equal(r.slots.length, 8);
  const filled = r.slots.filter((s) => !s.blank).map((s) => s.page);
  assert.deepEqual(filled, ['1', '2', '3', '4']);
  for (const s of r.slots.slice(4)) {
    assert.equal(s.blank, true);
    assert.equal(s.page, null);
    assert.match(s.origin, /^\d+,\d+$/);
    assert.ok(s.face === 'front' || s.face === 'back');
  }
  // 回放后尾部阅读槽位为 null（空白）
  assert.deepEqual(replaySeq(2, 2, r.labels, STEPS_2x2),
    ['1', '2', '3', '4', null, null, null, null]);
});

test('自动拼版：容量为页数上限；页数为 1 合法', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 1);
  assert.equal(r.ok, true);
  assert.equal(r.slots.filter((s) => !s.blank).length, 1);
  assert.equal(replaySeq(2, 2, r.labels, STEPS_2x2)[0], '1');
});

test('自动拼版：页数超出容量被拒，原因具体', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 9);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_many_pages');
  assert.ok(r.message.includes('9'));
  assert.ok(r.message.includes('8'));
});

test('自动拼版：非法起始页/页数被拒', () => {
  assert.equal(E.autoImpose(2, 2, {}, STEPS_2x2, 0, 8).code, 'bad_start');
  assert.equal(E.autoImpose(2, 2, {}, STEPS_2x2, -3, 8).code, 'bad_start');
  assert.equal(E.autoImpose(2, 2, {}, STEPS_2x2, 1.5, 8).code, 'bad_start');
  assert.equal(E.autoImpose(2, 2, {}, STEPS_2x2, 1, 0).code, 'bad_count');
  assert.equal(E.autoImpose(2, 2, {}, STEPS_2x2, 1, -2).code, 'bad_count');
});

test('自动拼版：存在非法折叠（厚度/外轮廓）时禁用', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 2, dir: 'l' }   // 1×3 厚度冲突
  ];
  const r = E.autoImpose(1, 3, {}, steps, 1, 6);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'thickness');
  assert.equal(r.stepIndex, 1);
  assert.ok(r.message.includes('第 2 步'));
  // eligibility 同样拒绝
  assert.equal(E.impositionEligibility(1, 3, {}, steps).ok, false);
});

test('自动拼版：未收成单叠时禁用，给出分离叠层数', () => {
  // 2×3 仅把左列折到中列：剩 (1,0)(2,0)(1,1)(2,1) 四个叠层
  const r = E.autoImpose(2, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }], 1, 12);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_single_stack');
  assert.equal(r.stackCount, 4);
  assert.ok(r.message.includes('4'));
});

test('自动拼版：网格非法时禁用', () => {
  assert.equal(E.autoImpose(0, 2, {}, [], 1, 1).code, 'bad_grid');
  assert.equal(E.impositionEligibility(2, 0, {}, []).code, 'bad_grid');
});

test('自动拼版：slots 与纸格正反面的映射覆盖全部面且无重复', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 8);
  const seen = new Set();
  for (const s of r.slots) {
    const k = `${s.origin}:${s.face}`;
    assert.ok(!seen.has(k), `面 ${k} 被重复映射`);
    seen.add(k);
  }
  assert.equal(seen.size, 8);   // 4 格 × 正反 2 面
});

test('自动拼版：纯函数，不改写传入的现有标注', () => {
  const labels = { '0,0': { front: 'X', back: 'Y' } };
  const snapshot = JSON.stringify(labels);
  E.autoImpose(2, 2, labels, STEPS_2x2, 1, 8);
  assert.equal(JSON.stringify(labels), snapshot);
});

test('impositionOverwrite：汇总将被覆盖/清空的现有非空标注', () => {
  // 手工 8 页标注（与拼版结果不同）
  const labels = {
    '0,0': { front: '4', back: '5' }, '1,0': { front: '6', back: '3' },
    '0,1': { front: '8', back: '1' }, '1,1': { front: '7', back: '2' }
  };
  const r = E.autoImpose(2, 2, labels, STEPS_2x2, 1, 8);
  const ov = E.impositionOverwrite(labels, r);
  assert.ok(ov.length > 0);
  for (const o of ov) {
    assert.notEqual(o.from, '');
    assert.notEqual(o.from, o.to);
  }
  // 拼版结果与自身对比 → 无需覆盖
  assert.deepEqual(E.impositionOverwrite(r.labels, r), []);
  // 短页数会把部分现有的面清空：blanked 被标记
  const r4 = E.autoImpose(2, 2, labels, STEPS_2x2, 1, 4);
  const blanks = E.impositionOverwrite(labels, r4).filter((o) => o.blanked);
  assert.ok(blanks.length > 0);
  assert.ok(blanks.every((o) => o.to === ''));
});

test('自动拼版：写回的 labels 可经 normalizePlan 往返保存/导入', () => {
  const r = E.autoImpose(2, 2, {}, STEPS_2x2, 3, 8);
  const plan = E.normalizePlan({
    name: '拼版结果', rows: 2, cols: 2,
    labels: r.labels, steps: STEPS_2x2
  });
  assert.deepEqual(plan.labels, r.labels);
  assert.deepEqual(replaySeq(2, 2, plan.labels, plan.steps),
    ['3', '4', '5', '6', '7', '8', '9', '10']);
});
