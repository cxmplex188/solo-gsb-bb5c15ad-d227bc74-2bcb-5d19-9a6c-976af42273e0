'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

test('寻路：1×2 指定左格反面为封面，最短 1 步且方案可合法回放', () => {
  const r = E.findFoldPath(1, 2, {}, [], { cell: '0,0', face: 'back' });
  assert.equal(r.ok, true);
  assert.equal(r.solved, true);
  assert.equal(r.depth, 1);
  assert.equal(r.solutions.length, 1);
  assert.deepEqual(r.solutions[0].steps, [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.equal(r.solutions[0].topPanel, '0,0');
  assert.equal(r.solutions[0].coverFace, 'back');
  // 回放追加路径后确为单叠且封面正确
  const rep = E.replay(1, 2, {}, r.solutions[0].steps);
  assert.equal(rep.error, null);
  const cell = Object.keys(rep.state.stacks)[0];
  const top = rep.state.panels[rep.state.stacks[cell][0]];
  assert.equal(top.ox + ',' + top.oy, '0,0');
  assert.equal(top.frame.n.z < 0, true);
});

test('寻路：1×2 要求正面封面无解（一次对折后左格必为反面朝上）', () => {
  const r = E.findFoldPath(1, 2, {}, [], { cell: '0,0', face: 'front' });
  assert.equal(r.ok, true);
  assert.equal(r.solved, false);
  assert.equal(r.reason, 'no_solution');
});

test('寻路：2×2 指定原格(1,0)反面封面，最短 2 步且给出不同终态的多条等长方案', () => {
  const r = E.findFoldPath(2, 2, {}, [], { cell: '1,0', face: 'back' });
  assert.equal(r.solved, true);
  assert.equal(r.depth, 2);
  assert.ok(r.solutions.length >= 2);
  // 所有方案等长、可回放、终态均为单叠且封面正确
  const finals = new Set();
  for (const sol of r.solutions) {
    assert.equal(sol.steps.length, 2);
    const rep = E.replay(2, 2, {}, sol.steps);
    assert.equal(rep.error, null);
    const cells = Object.keys(rep.state.stacks);
    assert.deepEqual(cells, [sol.finalCell]);
    assert.equal(sol.topPanel, '1,0');
    assert.equal(sol.coverFace, 'back');
    finals.add(E.stateKey(rep.state));
  }
  assert.equal(finals.size, r.solutions.length, '方案对应不同的最终状态');
  // 至多 3 条
  assert.ok(r.solutions.length <= 3);
});

test('寻路：2×2 正面封面在折帖中不可能（2 折后顶面皆为反面），判无解', () => {
  const r = E.findFoldPath(2, 2, {}, [], { cell: '0,0', face: 'front' });
  assert.equal(r.solved, false);
  assert.equal(r.reason, 'no_solution');
});

test('寻路：从已有合法末态继续搜索，找到后整体回放合法', () => {
  // 1×4：先向右折一次（0 列叠入 1 列，1 列成 2 层），再寻路收成单叠
  const prefix = [{ axis: 'v', line: 1, dir: 'r' }];
  const r = E.findFoldPath(1, 4, {}, prefix, { cell: '1,0', face: 'back' });
  assert.equal(r.ok, true);
  assert.equal(r.solved, true);
  const all = prefix.concat(r.solutions[0].steps);
  const rep = E.replay(1, 4, {}, all);
  assert.equal(rep.error, null);
  assert.equal(Object.keys(rep.state.stacks).length, 1);
  const cell = Object.keys(rep.state.stacks)[0];
  const top = rep.state.panels[rep.state.stacks[cell][0]];
  assert.equal(top.ox + ',' + top.oy, '1,0');
  // 寻路起点是 prefix 末态：prefix 之后单叠不可能（1×4 需 3 折）
  assert.ok(r.depth >= 1);
});

test('寻路：末态已是目标（0 步方案）', () => {
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  const r = E.findFoldPath(1, 2, {}, steps, { cell: '0,0', face: 'back' });
  assert.equal(r.solved, true);
  assert.equal(r.depth, 0);
  assert.deepEqual(r.solutions[0].steps, []);
});

test('寻路：前缀方案存在非法折叠时拒绝并给出步号', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 2, dir: 'l' }   // 1×3 厚度冲突
  ];
  const r = E.findFoldPath(1, 3, {}, steps, { cell: '0,0', face: 'back' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_prefix');
  assert.equal(r.stepIndex, 1);
  assert.deepEqual(r.conflicts, ['2,0', '1,0']);
});

test('寻路：超过 4×4 直接拒绝', () => {
  assert.equal(E.findFoldPath(2, 5, {}, [], { cell: '0,0', face: 'back' }).code, 'grid_too_large');
  assert.equal(E.findFoldPath(5, 5, {}, [], { cell: '0,0', face: 'back' }).code, 'grid_too_large');
  assert.equal(E.findFoldPath(4, 4, {}, [], { cell: '0,0', face: 'back' }).ok, true);
});

test('寻路：目标原格越界 / 面别非法 / 网格非法', () => {
  assert.equal(E.findFoldPath(2, 2, {}, [], { cell: '3,0', face: 'back' }).code, 'bad_target');
  assert.equal(E.findFoldPath(2, 2, {}, [], { cell: '0,0', face: 'side' }).code, 'bad_target');
  assert.equal(E.findFoldPath(0, 2, {}, [], { cell: '0,0', face: 'back' }).code, 'bad_grid');
});

test('寻路：maxDepth / timeoutMs 越界拒绝', () => {
  const t = { cell: '0,0', face: 'back' };
  assert.equal(E.findFoldPath(2, 2, {}, [], t, { maxDepth: 9 }).code, 'bad_limit');
  assert.equal(E.findFoldPath(2, 2, {}, [], t, { maxDepth: -1 }).code, 'bad_limit');
  assert.equal(E.findFoldPath(2, 2, {}, [], t, { timeoutMs: 2001 }).code, 'bad_limit');
  assert.equal(E.findFoldPath(2, 2, {}, [], t, { timeoutMs: 0 }).code, 'bad_limit');
});

test('寻路：极小时间预算（1ms）在 4×4 上返回搜索超限而非无解', () => {
  const r = E.findFoldPath(4, 4, {}, [], { cell: '0,0', face: 'front' },
    { maxDepth: 8, timeoutMs: 1 });
  assert.equal(r.ok, true);
  // 4×4 搜索量大，1ms 内无法穷尽，应报 limit_exceeded
  assert.equal(r.solved, false);
  assert.equal(r.reason, 'limit_exceeded');
  assert.ok(r.message.includes('秒'));
  assert.ok(r.searched.states >= 1);
});

test('寻路：无解与超限是两种不同结果（放宽时间后 4×4 深度内可正常判定）', () => {
  // 给足 2 秒：4×4 深度 8 空间可完全穷尽（约千级状态）
  const r = E.findFoldPath(4, 4, {}, [], { cell: '0,0', face: 'front' },
    { maxDepth: 8, timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no_solution');
});

test('寻路：缩短 maxDepth 会使原本 2 步可达的目标变为无解', () => {
  const t = { cell: '1,0', face: 'back' };
  assert.equal(E.findFoldPath(2, 2, {}, [], t, { maxDepth: 2 }).solved, true);
  const r = E.findFoldPath(2, 2, {}, [], t, { maxDepth: 1 });
  assert.equal(r.solved, false);
  assert.equal(r.reason, 'no_solution');
  assert.equal(r.maxDepth, 1);
});

test('stateKey：叠层顺序/面片朝向/相对位置任一不同均产生不同键', () => {
  const s0 = E.initialState(1, 2, {});
  const sr = E.applyFold(s0, { axis: 'v', line: 1, dir: 'r' });
  const sl = E.applyFold(s0, { axis: 'v', line: 1, dir: 'l' });
  // 相对位置不同（一个收成 1,0、一个收成 0,0）
  assert.notEqual(E.stateKey(sr), E.stateKey(sl));
  // 同一网格内：构造“层序相同但某片面片朝向不同”的两个状态
  const a = E.applyFold(E.initialState(1, 2, {}), { axis: 'v', line: 1, dir: 'r' });
  const b = E.cloneState(a);
  const topId = b.stacks['1,0'][0];
  b.panels[topId].frame.n = { x: 0, y: 0, z: -b.panels[topId].frame.n.z };
  assert.notEqual(E.stateKey(a), E.stateKey(b), '朝向不同不得合并');
  // 层序不同：交换叠内两片
  const c = E.cloneState(a);
  c.stacks['1,0'] = c.stacks['1,0'].slice().reverse();
  assert.notEqual(E.stateKey(a), E.stateKey(c), '层序不同不得合并');
  // 克隆自身键一致
  assert.equal(E.stateKey(a), E.stateKey(E.cloneState(a)));
});

test('candidateSteps / describeStep：枚举与描述', () => {
  const all = E.candidateSteps(2, 3);
  assert.equal(all.length, 6);   // 竖线 (3-1)×2 + 横线 (2-1)×2
  assert.deepEqual(all.slice(0, 4), [
    { axis: 'v', line: 1, dir: 'r' }, { axis: 'v', line: 1, dir: 'l' },
    { axis: 'v', line: 2, dir: 'r' }, { axis: 'v', line: 2, dir: 'l' }
  ]);
  assert.match(E.describeStep({ axis: 'v', line: 1, dir: 'l' }), /竖线 1.*向左折/);
  assert.match(E.describeStep({ axis: 'h', line: 2, dir: 'd' }), /横线 2.*向下折/);
});
