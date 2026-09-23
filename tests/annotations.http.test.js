'use strict';
/*
 * 校样批注持久化与定位的 HTTP 测试：
 *  - 保存时批注随方案持久化，GET 往返完整保留
 *  - 各类非法批注整请求 400 拒绝（错误码），且不改动旧存档
 *  - 导入宽容（normalizePlan 在各 API 中不丢方案）
 *  - POST /api/annotations/locate：按回放步以原始面片身份定位
 *  - 列表摘要含批注总数 / 未解决数
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-anno-'));
process.env.DATA_DIR = tmpData;
const app = require('../server.js');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpData, { recursive: true, force: true });
});

async function req(method, p, body) {
  const resp = await fetch(base + p, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: resp.status, json: await resp.json() };
}
const post = (p, body) => req('POST', p, body);
const get = (p) => req('GET', p);

const STEPS = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
function plan(over = {}) {
  return {
    name: '批注测试方案', rows: 2, cols: 2, labels: {},
    steps: STEPS, tags: [], note: '', annotations: [], ...over
  };
}

test('保存：批注随方案持久化，GET 往返完整保留', async () => {
  const annos = [
    { id: 'annofirst01', cell: '0,0', face: 'front', severity: 'error',
      text: '封面套印不准', step: 1, resolved: false, createdAt: '2026-09-22T01:00:00.000Z' },
    { id: 'anno-second2', cell: '1,1', face: 'back', severity: 'info',
      text: '建议加大出血', step: 2, resolved: true,
      createdAt: '2026-09-22T02:00:00.000Z', resolvedAt: '2026-09-22T03:00:00.000Z' }
  ];
  const r = await post('/api/plans', plan({ id: 'anno-keep', annotations: annos }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.plan.annotations, annos);

  const loaded = await (await fetch(`${base}/api/plans/anno-keep`)).json();
  assert.deepEqual(loaded.annotations, annos);
});

test('保存：缺省 annotations 持久化为空数组', async () => {
  const r = await post('/api/plans', {
    id: 'anno-default', name: '无批注方案', rows: 1, cols: 2, labels: {}, steps: []
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.plan.annotations, []);
});

test('保存：缺失 id/时间戳的合法批注由服务端补齐', async () => {
  const r = await post('/api/plans', plan({
    id: 'anno-autoid',
    annotations: [{ cell: '0,0', face: 'front', severity: 'warning', text: '待确认', step: 0 }]
  }));
  assert.equal(r.status, 200);
  const a = r.json.plan.annotations[0];
  assert.match(a.id, /^[A-Za-z0-9_-]{6,32}$/);
  assert.equal(typeof a.createdAt, 'string');
  assert.equal(a.resolved, false);
});

test('保存：各类非法批注整请求 400 并给出错误码', async () => {
  const expect400 = async (annotations, code) => {
    const r = await post('/api/plans', plan({ id: 'anno-bad', annotations }));
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.error.code, code);
  };
  await expect400('nope', 'bad_annotations');
  await expect400([null], 'bad_annotation');
  await expect400([{ cell: '9,9', face: 'front', severity: 'error', text: 'x', step: 0 }],
    'bad_annotation_cell');
  await expect400([{ cell: '0,0', face: 'side', severity: 'error', text: 'x', step: 0 }],
    'bad_annotation_face');
  await expect400([{ cell: '0,0', face: 'front', severity: 'fatal', text: 'x', step: 0 }],
    'bad_annotation_severity');
  await expect400([{ cell: '0,0', face: 'front', severity: 'error', text: '', step: 0 }],
    'bad_annotation_text');
  await expect400([{ cell: '0,0', face: 'front', severity: 'error', text: 'x', step: 99 }],
    'bad_annotation_step');
  await expect400(Array.from({ length: 201 }, (_, i) => ({
    cell: '0,0', face: 'front', severity: 'info', text: 't' + i, step: 0
  })), 'too_many_annotations');
});

test('保存：非法批注不改动任何已有存档（原子性）', async () => {
  const good = await post('/api/plans', plan({
    id: 'anno-atomic',
    annotations: [{ id: 'annogood001', cell: '0,0', face: 'front',
      severity: 'error', text: '旧批注', step: 0 }]
  }));
  assert.equal(good.status, 200);
  const before = JSON.parse(fs.readFileSync(path.join(tmpData, 'anno-atomic.json'), 'utf8'));
  await new Promise((r) => setTimeout(r, 15));

  const bad = await post('/api/plans', plan({
    id: 'anno-atomic',
    annotations: [{ cell: '0,0', face: 'front', severity: 'error', text: '', step: 0 }]
  }));
  assert.equal(bad.status, 400);
  const after = JSON.parse(fs.readFileSync(path.join(tmpData, 'anno-atomic.json'), 'utf8'));
  assert.deepEqual(after, before);
});

test('列表：摘要含批注总数与未解决数', async () => {
  await post('/api/plans', plan({
    id: 'anno-list',
    annotations: [
      { id: 'annolisto01', cell: '0,0', face: 'front', severity: 'error', text: 'a', step: 0 },
      { id: 'annolisto02', cell: '0,0', face: 'back', severity: 'warning', text: 'b', step: 0 },
      { id: 'annolisto03', cell: '1,0', face: 'front', severity: 'info', text: 'c',
        step: 0, resolved: true }
    ]
  }));
  const r = await get('/api/plans');
  const it = r.json.items.find((x) => x.id === 'anno-list');
  assert.ok(it);
  assert.equal(it.annotations, 3);
  assert.equal(it.openAnnotations, 2);
});

test('POST /api/annotations/locate：按 upto 以原始面片身份定位', async () => {
  const annotations = [
    { id: 'annolocate1', cell: '0,0', face: 'front', severity: 'error', text: '跟我', step: 0 }
  ];
  const r0 = await post('/api/annotations/locate',
    plan({ upto: 0, annotations }));
  assert.equal(r0.status, 200);
  assert.equal(r0.json.ok, true);
  assert.equal(r0.json.upto, 0);
  assert.equal(r0.json.points[0].at, '0,0');
  assert.equal(r0.json.points[0].layer, 1);

  const r2 = await post('/api/annotations/locate',
    plan({ upto: 2, annotations }));
  assert.equal(r2.json.points[0].at, '1,1');
  assert.equal(r2.json.points[0].layer, 2);
  assert.equal(r2.json.points[0].depth, 4);
});

test('POST /api/annotations/locate：upto 越界被钳制；宽容规整坏批注不致接口失败', async () => {
  const r = await post('/api/annotations/locate', plan({
    upto: 99,
    annotations: [
      { cell: '9,9', face: 'front', severity: 'error', text: '越界丢弃', step: 0 },
      { cell: '0,0', face: 'front', severity: 'wat', text: ' 级别降级 ', step: 0 }
    ]
  }));
  assert.equal(r.status, 200);
  assert.equal(r.json.upto, 2, 'upto 钳制到步数上限');
  assert.equal(r.json.points.length, 1, '越界批注被宽容丢弃');
  assert.equal(r.json.points[0].severity, 'info', '非法级别降级为 info');
});
