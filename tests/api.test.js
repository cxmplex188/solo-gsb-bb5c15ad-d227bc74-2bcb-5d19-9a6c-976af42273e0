'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 使用独立临时数据目录，避免污染开发环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-data-'));
process.env.DATA_DIR = tmpData;
const app = require('../server.js');

const STEPS = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpData, { recursive: true, force: true });
});

async function post(p, body) {
  const resp = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: resp.status, json: await resp.json() };
}

test('POST /api/impose：合法折帖返回连续页码、slots 与反向 labels', async () => {
  const { status, json } = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 1, pageCount: 8
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.capacity, 8);
  assert.equal(json.slots.length, 8);
  assert.deepEqual(json.slots.map((s) => s.page),
    ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.ok(json.slots.every((s) => /^\d+,\d+$/.test(s.origin) && (s.face === 'front' || s.face === 'back')));
});

test('POST /api/impose：短页数返回末尾空白槽位', async () => {
  const { json } = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 5, pageCount: 4
  });
  assert.equal(json.ok, true);
  assert.equal(json.blankTrailing, 4);
  const blanks = json.slots.filter((s) => s.blank);
  assert.equal(blanks.length, 4);
  assert.deepEqual(json.slots.filter((s) => !s.blank).map((s) => s.page), ['5', '6', '7', '8']);
});

test('POST /api/impose：未收成单叠 / 超容量均返回具体原因', async () => {
  let r = await post('/api/impose', {
    rows: 2, cols: 3, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }], startPage: 1, pageCount: 1
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'not_single_stack');

  r = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 1, pageCount: 99
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'too_many_pages');
  assert.ok(r.json.error.message.includes('8'));
});

test('POST /api/impose：非法折叠时返回步骤号与冲突', async () => {
  const r = await post('/api/impose', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    startPage: 1, pageCount: 1
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'thickness');
  assert.equal(r.json.error.stepIndex, 1);
  assert.deepEqual(r.json.error.conflicts, ['2,0', '1,0']);
});

test('POST /api/impose：overwrites 汇总现有非空标注', async () => {
  const r = await post('/api/impose', {
    rows: 2, cols: 2,
    labels: { '0,0': { front: '4', back: '5' } },
    steps: STEPS, startPage: 1, pageCount: 8
  });
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.overwrites));
  const cells = new Set(r.json.overwrites.map((o) => o.cell));
  assert.ok(cells.has('0,0'));
  assert.ok(r.json.overwrites.every((o) => o.from && o.from !== o.to));
});

test('自动拼版标签写入后 /api/simulate 保留标签并回放为连续阅读顺序', async () => {
  const imp = await post('/api/impose', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, startPage: 1, pageCount: 8
  });
  const sim = await post('/api/simulate', {
    rows: 2, cols: 2, labels: imp.json.labels, steps: STEPS
  });
  assert.equal(sim.json.ok, true);
  assert.equal(sim.json.folded, true);
  assert.deepEqual(sim.json.stacks[0].sequence,
    ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('自动拼版标签经保存/载入往返后完整保留', async () => {
  const imp = await post('/api/impose', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    startPage: 1, pageCount: 4
  });
  const saved = await post('/api/plans', {
    name: '拼版存档', rows: 1, cols: 2,
    labels: imp.json.labels,
    steps: [{ axis: 'v', line: 1, dir: 'r' }]
  });
  assert.equal(saved.json.ok, true);
  const loaded = await (await fetch(`${base}/api/plans/${saved.json.id}`)).json();
  assert.deepEqual(loaded.labels, imp.json.labels);
  assert.deepEqual(loaded.labels['0,0'], { front: '4', back: '1' });
});

// ---------- 双面印刷版预览 ----------
test('POST /api/duplex-plate：长边版返回正面/背面两版与镜像旋转数据', async () => {
  const r = await post('/api/duplex-plate', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, flip: 'long'
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.flip, 'long');
  assert.equal(r.json.flipAxis, 'vertical');
  assert.deepEqual(r.json.front.grid.map((row) => row.map((c) => c.origin)),
    [['0,0', '1,0'], ['0,1', '1,1']]);
  assert.deepEqual(r.json.back.grid.map((row) => row.map((c) => c.origin)),
    [['1,0', '0,0'], ['1,1', '0,1']]);
  const all = r.json.front.grid.flat().concat(r.json.back.grid.flat());
  assert.equal(all.length, 8);
  assert.ok(all.every((c) => c.rotate === 0 || c.rotate === 180));
  assert.ok(all.every((c) => /^\d+,\d+$/.test(c.origin)));
});

test('POST /api/duplex-plate：短边版上下镜像、翻面边为横边', async () => {
  const r = await post('/api/duplex-plate', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, flip: 'short'
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.flipAxis, 'horizontal');
  assert.deepEqual(r.json.back.grid.map((row) => row.map((c) => c.origin)),
    [['0,1', '1,1'], ['0,0', '1,0']]);
  assert.equal(r.json.front.edge, 'top');
  assert.equal(r.json.back.edge, 'bottom');
});

test('POST /api/duplex-plate：未收成单叠 / 非法折叠 / 非法翻面返回具体原因', async () => {
  let r = await post('/api/duplex-plate', {
    rows: 2, cols: 3, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }], flip: 'long'
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'not_single_stack');

  r = await post('/api/duplex-plate', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    flip: 'long'
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'thickness');
  assert.equal(r.json.error.stepIndex, 1);

  r = await post('/api/duplex-plate', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, flip: 'weird'
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_flip');
});

test('POST /api/duplex-plate：空白面以 blank 占位返回', async () => {
  const r = await post('/api/duplex-plate', {
    rows: 2, cols: 2,
    labels: { '0,0': { front: '', back: '' } },
    steps: STEPS, flip: 'long'
  });
  assert.equal(r.status, 200);
  const blank = r.json.front.grid.flat().find((c) => c.origin === '0,0');
  assert.equal(blank.blank, true);
  assert.equal(blank.label, null);
});

// ---------- 折手自动寻路 ----------
test('POST /api/find-path：2×2 反面封面返回等长最短方案（≤3 条）', async () => {
  const r = await post('/api/find-path', {
    rows: 2, cols: 2, labels: {}, steps: [],
    target: { cell: '1,0', face: 'back' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.solved, true);
  assert.equal(r.json.depth, 2);
  assert.ok(r.json.solutions.length >= 2 && r.json.solutions.length <= 3);
  for (const sol of r.json.solutions) {
    assert.equal(sol.steps.length, 2);
    assert.equal(sol.topPanel, '1,0');
    assert.equal(sol.coverFace, 'back');
  }
});

test('POST /api/find-path：无解返回 solved:false / no_solution', async () => {
  const r = await post('/api/find-path', {
    rows: 2, cols: 2, labels: {}, steps: [],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.solved, false);
  assert.equal(r.json.reason, 'no_solution');
  assert.ok(r.json.message.includes('无解'));
});

test('POST /api/find-path：非法方案返回 400；超过 4×4 返回 grid_too_large', async () => {
  const bad = await post('/api/find-path', {
    rows: 2, cols: 2, steps: [{ axis: 'z' }],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_plan');

  const big = await post('/api/find-path', {
    rows: 3, cols: 5, labels: {}, steps: [],
    target: { cell: '0,0', face: 'back' }
  });
  assert.equal(big.status, 200);
  assert.equal(big.json.ok, false);
  assert.equal(big.json.error.code, 'grid_too_large');
});

test('POST /api/find-path：前缀非法折叠返回 bad_prefix 与步号', async () => {
  const r = await post('/api/find-path', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    target: { cell: '0,0', face: 'back' }
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_prefix');
  assert.equal(r.json.error.stepIndex, 1);
});

test('POST /api/find-path：服务端把时间预算钳制到 2 秒以内，超限返回 limit_exceeded', async () => {
  const r = await post('/api/find-path', {
    rows: 4, cols: 4, labels: {}, steps: [],
    target: { cell: '0,0', face: 'front' },
    options: { timeoutMs: 1, maxDepth: 8 }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.solved, false);
  assert.equal(r.json.reason, 'limit_exceeded');

  // 超出上限的 5000ms 会被钳制为 2000（4×4 空间在 2 秒内可穷尽 → no_solution）
  const r2 = await post('/api/find-path', {
    rows: 4, cols: 4, labels: {}, steps: [],
    target: { cell: '0,0', face: 'front' },
    options: { timeoutMs: 5000 }
  });
  assert.equal(r2.json.reason, 'no_solution');
});

test('POST /api/find-path：返回方案追加后经 /api/simulate 回放为目标单叠', async () => {
  const found = await post('/api/find-path', {
    rows: 1, cols: 2, labels: {}, steps: [],
    target: { cell: '0,0', face: 'back' }
  });
  const steps = found.json.solutions[0].steps;
  const sim = await post('/api/simulate', { rows: 1, cols: 2, labels: {}, steps });
  assert.equal(sim.json.ok, true);
  assert.equal(sim.json.folded, true);
  assert.equal(sim.json.occupied[0].panels[0].ox, 0);
  assert.ok(sim.json.occupied[0].panels[0].frame.n.z < 0);
});

// ---------- 面片轨迹 ----------
test('POST /api/trajectory：合法折帖返回逐步格位/层序/朝向时间线', async () => {
  const r = await post('/api/trajectory', {
    rows: 2, cols: 2, labels: {}, steps: STEPS,
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.completed, true);
  assert.equal(r.json.interrupted, null);
  assert.equal(r.json.points.length, 3);
  assert.deepEqual(r.json.points.map((p) => p.step), [0, 1, 2]);
  assert.deepEqual(r.json.points.map((p) => p.cell), ['0,0', '1,0', '1,1']);
  assert.deepEqual(r.json.points.map((p) => p.layer), [1, 1, 2]);
  assert.deepEqual(r.json.points.map((p) => p.depth), [1, 2, 4]);
  assert.deepEqual(r.json.points.map((p) => p.faceUp), [true, false, true]);
  assert.deepEqual(r.json.points.map((p) => p.upright), [true, true, false]);
});

test('POST /api/trajectory：首个非法步截断时间线并给出中断原因', async () => {
  const r = await post('/api/trajectory', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.completed, false);
  assert.deepEqual(r.json.points.map((p) => p.step), [0, 1]);
  assert.equal(r.json.interrupted.stepIndex, 1);
  assert.equal(r.json.interrupted.code, 'thickness');
  assert.deepEqual(r.json.interrupted.conflicts, ['2,0', '1,0']);
});

test('POST /api/trajectory：目标非法返回 ok:false；方案非法返回 400', async () => {
  const r = await post('/api/trajectory', {
    rows: 2, cols: 2, labels: {}, steps: STEPS,
    target: { cell: '9,9', face: 'front' }
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_target');

  const badFace = await post('/api/trajectory', {
    rows: 2, cols: 2, labels: {}, steps: STEPS,
    target: { cell: '0,0', face: 'side' }
  });
  assert.equal(badFace.json.error.code, 'bad_target');

  const badPlan = await post('/api/trajectory', {
    rows: 2, cols: 2, steps: [{ axis: 'z' }],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(badPlan.status, 400);
  assert.equal(badPlan.json.error.code, 'bad_plan');
});

// ---------- 生产质量审计 ----------
test('POST /api/audit：干净折帖返回可发布结论与统计', async () => {
  const r = await post('/api/audit', {
    rows: 1, cols: 2,
    labels: { '0,0': { front: '4', back: '1' }, '1,0': { front: '2', back: '3' } },
    steps: [{ axis: 'v', line: 1, dir: 'r' }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verdict, 'pass');
  assert.equal(r.json.summary.total, 0);
  assert.deepEqual(r.json.findings, []);
  assert.equal(r.json.stats.capacity, 4);
  assert.equal(r.json.stats.folded, true);
  assert.equal(r.json.stats.labeledFaces, 4);
});

test('POST /api/audit：重复/空白/倒置/未覆盖按严重级别汇总为需修订', async () => {
  const r = await post('/api/audit', {
    rows: 2, cols: 2,
    labels: {
      '0,0': { front: '1', back: '2' },
      '1,0': { front: '1', back: '' }
      // 0,1 / 1,1 整格未覆盖；页码 1 重复；水平折致部分页倒置
    },
    steps: STEPS
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verdict, 'fail');
  const ids = new Set(r.json.findings.map((f) => f.id));
  assert.ok(ids.has('duplicate_page'));
  assert.ok(ids.has('inverted_page'));
  assert.ok(ids.has('blank_page'));
  assert.ok(ids.has('uncovered_cell'));
  assert.ok(r.json.summary.errors >= 2);
  assert.equal(r.json.summary.total, r.json.findings.length);
  const dup = r.json.findings.find((f) => f.id === 'duplicate_page');
  assert.deepEqual(dup.cells.slice().sort(), ['0,0', '1,0']);
  assert.ok(r.json.findings.every((f) =>
    f.severity && f.title && f.message && Array.isArray(f.cells)));
});

test('POST /api/audit：全空白 2×2 的倒置空白槽报 error，结论需修订', async () => {
  const r = await post('/api/audit', { rows: 2, cols: 2, labels: {}, steps: STEPS });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verdict, 'fail', '倒置空白槽不得再漏报为可发布');
  assert.equal(r.json.summary.errors, 4);
  assert.equal(r.json.summary.warnings, 12);     // 8 空白面 + 4 未覆盖格
  const inv = r.json.findings.filter((f) => f.id === 'inverted_page');
  assert.equal(inv.length, 4);
  assert.ok(inv.every((f) => f.severity === 'error'));
  assert.deepEqual(inv.map((f) => f.details[0].slot), [1, 2, 7, 8]);
  assert.deepEqual(inv.flatMap((f) => f.cells).sort(), ['0,0', '0,0', '1,0', '1,0']);
  for (const f of inv) {
    assert.equal(f.details[0].label, null);
    assert.ok(f.message.includes('空白面'), '空白槽文案不虚构页码');
    assert.ok(f.message.includes(`原格(${f.details[0].cell})`));
    assert.ok(f.message.includes(`第 ${f.details[0].slot} 槽`));
  }
  // 统计与结构保持兼容
  assert.equal(r.json.stats.blankFaces, 8);
  assert.equal(r.json.stats.labeledFaces, 0);
  assert.equal(r.json.stats.folded, true);
  assert.equal(r.json.summary.total, r.json.findings.length);
});

test('POST /api/audit：未收成单叠报分离叠层错误', async () => {
  const r = await post('/api/audit', {
    rows: 2, cols: 3, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }]
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.verdict, 'fail');
  const split = r.json.findings.find((f) => f.id === 'split_stacks');
  assert.ok(split);
  assert.equal(split.severity, 'error');
  assert.equal(split.details.length, 4);
});

test('POST /api/audit：非法折叠仅报告首个错误，不伪造后续结论', async () => {
  const r = await post('/api/audit', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'thickness');
  assert.equal(r.json.error.stepIndex, 1);
  assert.deepEqual(r.json.error.conflicts, ['2,0', '1,0']);
  assert.ok(!('findings' in r.json), '不得附带后续检查结论');
});

test('POST /api/audit：方案非法返回 400 bad_plan', async () => {
  const r = await post('/api/audit', { rows: 2, cols: 2, steps: [{ axis: 'z' }] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_plan');
});

// ---------- 书帖爬移补偿 ----------
test('POST /api/creep-compensation：合法折帖返回逐叶偏移、书脊与最大补偿', async () => {
  const r = await post('/api/creep-compensation', {
    rows: 2, cols: 2, labels: {}, steps: STEPS, paperThickness: 0.1, bleed: 3
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.leafCount, 4);
  assert.equal(r.json.maxCompensation, 0.3);
  assert.equal(r.json.spineAxis, 'horizontal');
  assert.equal(r.json.spineSide, 'top');
  assert.equal(r.json.canApply, true);
  assert.equal(r.json.overBleedCount, 0);
  assert.deepEqual(r.json.leaves.map((l) => l.creep), [0, 0.1, 0.2, 0.3]);
  // 每叶正反两面偏移齐全，绝对值等于补偿量；横折脊两面纵向偏移相同
  for (const lf of r.json.leaves) {
    assert.equal(lf.axis, 'y');
    assert.equal(Math.abs(lf.front.offset), lf.creep);
    assert.equal(lf.front.offset, lf.back.offset);
    assert.match(lf.origin, /^\d+,\d+$/);
  }
});

test('POST /api/creep-compensation：竖折脊正/反面横向偏移符号相反', async () => {
  const r = await post('/api/creep-compensation', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    paperThickness: 0.2, bleed: 1
  });
  assert.equal(r.json.spineAxis, 'vertical');
  assert.equal(r.json.spineSide, 'left');
  assert.equal(r.json.maxCompensation, 0.2);
  const inner = r.json.leaves[1];
  assert.equal(inner.axis, 'x');
  assert.equal(inner.front.offset, -inner.back.offset);
  assert.equal(Math.abs(inner.front.offset), 0.2);
});

test('POST /api/creep-compensation：超出血时 canApply=false 并标红对应面', async () => {
  const r = await post('/api/creep-compensation', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    paperThickness: 0.1, bleed: 0.05
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.canApply, false);
  assert.equal(r.json.overBleedCount, 2);
  assert.equal(r.json.leaves[1].front.overBleed, true);
  assert.equal(r.json.leaves[1].back.overBleed, true);
  assert.equal(r.json.leaves[0].front.overBleed, false);
});

test('POST /api/creep-compensation：非单叠/非法折/坏参数返回具体原因', async () => {
  let r = await post('/api/creep-compensation', {
    rows: 2, cols: 3, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }], paperThickness: 0.1, bleed: 3
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'not_single_stack');

  r = await post('/api/creep-compensation', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' }
    ],
    paperThickness: 0.1, bleed: 3
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'thickness');
  assert.equal(r.json.error.stepIndex, 1);

  r = await post('/api/creep-compensation', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    paperThickness: -1, bleed: 3
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_thickness');

  r = await post('/api/creep-compensation', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    paperThickness: 0.1, bleed: null
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_bleed');
});

test('爬移补偿方案经保存/载入往返后独立字段完整保留', async () => {
  const calc = await post('/api/creep-compensation', {
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    paperThickness: 0.1, bleed: 3
  });
  assert.equal(calc.json.ok, true);
  const faces = {};
  for (const lf of calc.json.leaves) {
    faces[lf.origin] = { front: lf.front.offset, back: lf.back.offset, axis: lf.axis, creep: lf.creep };
  }
  const scheme = {
    params: { paperThickness: 0.1, bleed: 3 },
    spineAxis: calc.json.spineAxis,
    spineSide: calc.json.spineSide,
    maxCompensation: calc.json.maxCompensation,
    faces,
    basis: { rows: 1, cols: 2, stepsSignature: 'sig' },
    appliedAt: '2026-09-22T00:00:00Z'
  };
  const saved = await post('/api/plans', {
    name: '爬移存档', rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    creepCompensation: scheme
  });
  assert.equal(saved.json.ok, true);
  const loaded = await (await fetch(`${base}/api/plans/${saved.json.id}`)).json();
  assert.deepEqual(loaded.creepCompensation, scheme);

  // 非法爬移字段不影响方案保存（被规整丢弃）
  const savedBad = await post('/api/plans', {
    name: '坏爬移', rows: 1, cols: 2, labels: {}, steps: [],
    creepCompensation: { params: { paperThickness: -1, bleed: 3 }, faces: {} }
  });
  assert.equal(savedBad.json.ok, true);
  const loadedBad = await (await fetch(`${base}/api/plans/${savedBad.json.id}`)).json();
  assert.equal(loadedBad.creepCompensation, undefined);
});
