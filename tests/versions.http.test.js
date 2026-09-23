'use strict';
/*
 * 版本差异审阅服务端 HTTP 测试：
 *  - 每次成功保存追加单调递增的不可变快照，head.version 与快照一致
 *  - 版本列表 / 单版本快照 / 两版本差异接口
 *  - 非法请求不产生新版本（不可变性）；快照内容不被后续保存改写
 *  - 恢复历史版本后保存生成新版本、不覆盖历史（restoredFrom 谱系）
 *  - 删除存档连带删除历史；旧档（无 version）首次保存补存 v1
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');
const os = require('node:os');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-versions-'));
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
const del = (p) => req('DELETE', p);

const STEP = { axis: 'v', line: 1, dir: 'r' };
function plan(over = {}) {
  return {
    id: 'ver-demo', name: '版本方案', rows: 1, cols: 2, labels: {},
    steps: [STEP], tags: [], note: '', annotations: [], ...over
  };
}

test('连续三次保存：版本号 1..3，head.version 与最新快照一致', async () => {
  let r = await post('/api/plans', plan());
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 1);
  await new Promise((res) => setTimeout(res, 5));

  r = await post('/api/plans', plan({ tags: ['骑马钉'] }));
  assert.equal(r.json.version, 2);
  await new Promise((res) => setTimeout(res, 5));

  r = await post('/api/plans', plan({
    tags: ['骑马钉'],
    labels: { '1,0': { front: '2', back: '3' } },
    note: '第三版'
  }));
  assert.equal(r.json.version, 3);
  assert.equal(r.json.plan.version, 3);

  const head = await get('/api/plans/ver-demo');
  assert.equal(head.json.version, 3);
  // 文件系统上确有三个 6 位序号快照
  const files = fs.readdirSync(path.join(tmpData, 'ver-demo.versions'));
  assert.deepEqual(files, ['000001.json', '000002.json', '000003.json']);
});

test('GET 版本列表：按序号升序、含规格/标签/批注计数', async () => {
  const r = await get('/api/plans/ver-demo/versions');
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 3);
  assert.deepEqual(r.json.items.map((v) => v.version), [1, 2, 3]);
  const v2 = r.json.items.find((v) => v.version === 2);
  assert.deepEqual(v2.tags, ['骑马钉']);
  assert.equal(v2.steps, 1);
  assert.equal(v2.rows, 1);
  assert.ok(v2.savedAt);
});

test('GET 单版本快照：返回当时完整内容；快照不可被后续保存改写', async () => {
  const v1 = await get('/api/plans/ver-demo/versions/1');
  assert.equal(v1.status, 200);
  assert.deepEqual(v1.json.snapshot.tags, []);
  assert.equal(v1.json.snapshot.note, '');
  assert.equal(v1.json.snapshot.labels['1,0'], undefined);
  assert.equal(v1.json.snapshot.version, 1);

  // 再次保存（v4），v1 文件内容逐字节保持
  const v1Before = fs.readFileSync(path.join(tmpData, 'ver-demo.versions', '000001.json'), 'utf8');
  await post('/api/plans', plan({ tags: ['骑马钉', 'A4'], note: '第四版' }));
  const v1After = fs.readFileSync(path.join(tmpData, 'ver-demo.versions', '000001.json'), 'utf8');
  assert.equal(v1After, v1Before, '历史快照不可变');

  const list = await get('/api/plans/ver-demo/versions');
  assert.equal(list.json.count, 4);
});

test('非法保存被整请求拒绝：不新增版本、head 与历史保持不变', async () => {
  const before = fs.readFileSync(path.join(tmpData, 'ver-demo.json'), 'utf8');
  const r = await post('/api/plans', plan({ name: '', tags: ['非法,标签'] }));
  assert.equal(r.status, 400);
  const after = fs.readFileSync(path.join(tmpData, 'ver-demo.json'), 'utf8');
  assert.equal(after, before);
  const list = await get('/api/plans/ver-demo/versions');
  assert.equal(list.json.count, 4, '非法请求不得产生版本快照');

  const badGeom = await post('/api/plans', plan({ rows: 0 }));
  assert.equal(badGeom.status, 400);
  const list2 = await get('/api/plans/ver-demo/versions');
  assert.equal(list2.json.count, 4);
});

test('POST diff v1 -> v3：页码新增 / 标签 / 备注差异，稳定身份为原始纸格', async () => {
  const r = await post('/api/plans/ver-demo/versions/diff', { from: 1, to: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.json.from, 1);
  assert.equal(r.json.to, 3);
  const d = r.json.diff;
  const addPages = d.labels.filter((e) => e.kind === 'add');
  assert.equal(addPages.length, 2);
  assert.ok(addPages.every((e) => e.cell === '1,0'));
  assert.deepEqual(addPages.map((e) => e.face).sort(), ['back', 'front']);
  assert.ok(d.meta.some((e) => e.field === 'tag' && e.kind === 'add' && e.value === '骑马钉'));
  assert.ok(d.meta.some((e) => e.field === 'note'));
  assert.deepEqual(d.affectedCells, ['1,0']);
});

test('POST diff 相同版本号：total=0', async () => {
  const r = await post('/api/plans/ver-demo/versions/diff', { from: 2, to: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.diff.summary.total, 0);
});

test('差异/快照接口错误码：不存在的方案/版本/非法版本号', async () => {
  assert.equal((await get('/api/plans/no-such-plan/versions')).status, 404);
  assert.equal((await get('/api/plans/ver-demo/versions/99')).status, 404);
  assert.equal((await get('/api/plans/ver-demo/versions/0')).status, 400);
  assert.equal((await get('/api/plans/bad-id!!/versions')).status, 400);
  const badBody = await post('/api/plans/ver-demo/versions/diff', { from: 1 });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.json.error.code, 'bad_version');
  const missing = await post('/api/plans/ver-demo/versions/diff', { from: 1, to: 99 });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'version_not_found');
});

test('批注增删改进入版本差异（id 稳定身份；resolvedAt 不参与）', async () => {
  await post('/api/plans', plan({
    note: '带批注版',
    annotations: [{
      id: 'ann000001', cell: '0,0', face: 'front', severity: 'error',
      text: '封面偏差', step: 1, resolved: false
    }]
  }));
  const list = await get('/api/plans/ver-demo/versions');
  const v5 = list.json.count;
  await post('/api/plans', plan({
    note: '带批注版',
    annotations: [{
      id: 'ann000001', cell: '0,0', face: 'front', severity: 'warning',
      text: '封面偏差已复测', step: 1, resolved: true
    }]
  }));
  const r = await post('/api/plans/ver-demo/versions/diff', { from: v5, to: v5 + 1 });
  const mod = r.json.diff.annotations.find((e) => e.id === 'ann000001');
  assert.equal(mod.kind, 'modify');
  const fields = mod.fields.map((f) => f.field);
  assert.ok(fields.includes('severity'));
  assert.ok(fields.includes('text'));
  assert.ok(fields.includes('resolved'));
  assert.ok(!fields.includes('resolvedAt'));
  assert.ok(!fields.includes('createdAt'));
});

test('恢复历史版本：恢复为草稿保存后生成新版本、不覆盖任何历史', async () => {
  // 取 v1 快照内容（旧标签/备注），以同一 id 作为“恢复后的草稿”保存
  const v1 = (await get('/api/plans/ver-demo/versions/1')).json.snapshot;
  const listBefore = (await get('/api/plans/ver-demo/versions')).json.items;
  const totalBefore = listBefore.length;
  const r = await post('/api/plans', {
    ...v1,
    id: 'ver-demo',
    version: undefined,       // 版本号由服务端分配，客户端不能指定
    restoredFrom: 1
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, totalBefore + 1, '恢复保存追加为新版本');
  assert.equal(r.json.plan.restoredFrom, 1);

  // 历史 v1..vN 全部仍在；新 head 内容等于 v1 的业务内容
  const listAfter = await get('/api/plans/ver-demo/versions');
  assert.equal(listAfter.json.count, totalBefore + 1);
  assert.deepEqual(listAfter.json.items.map((v) => v.version),
    Array.from({ length: totalBefore + 1 }, (_, i) => i + 1));
  const v1Still = await get('/api/plans/ver-demo/versions/1');
  assert.deepEqual(v1Still.json.snapshot.tags, []);
  assert.equal(v1Still.json.snapshot.restoredFrom, null, 'v1 快照本身不被改写');

  const head = await get('/api/plans/ver-demo');
  assert.deepEqual(head.json.tags, []);
  assert.equal(head.json.note, '');
  assert.equal(head.json.restoredFrom, 1);
});

test('旧档（无 version 字段、无版本目录）首次保存：补存 v1 再写 v2', async () => {
  const oldPath = path.join(tmpData, 'legacy-ver.json');
  fs.writeFileSync(oldPath, JSON.stringify({
    name: '旧档', rows: 1, cols: 2, labels: {}, steps: [STEP],
    tags: [], note: '', annotations: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
  }));
  const r = await post('/api/plans', {
    id: 'legacy-ver', name: '旧档更新', rows: 1, cols: 2, labels: {},
    steps: [STEP], tags: ['新标签'], note: ''
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 2);
  const list = await get('/api/plans/legacy-ver/versions');
  assert.deepEqual(list.json.items.map((v) => v.version), [1, 2]);
  assert.equal(list.json.items[0].name, '旧档', 'v1 为升级前旧 head 内容');
  assert.equal(list.json.items[1].name, '旧档更新');
});

test('DELETE 删除存档连带删除版本历史', async () => {
  const r = await del('/api/plans/ver-demo');
  assert.equal(r.json.ok, true);
  assert.ok(!fs.existsSync(path.join(tmpData, 'ver-demo.json')));
  assert.ok(!fs.existsSync(path.join(tmpData, 'ver-demo.versions')));
  assert.equal((await get('/api/plans/ver-demo/versions')).status, 404);
});

test('新方案首存即产生 v1；列表摘要带当前版本号', async () => {
  const r = await post('/api/plans', {
    id: 'ver-fresh', name: '全新', rows: 1, cols: 2, labels: {}, steps: []
  });
  assert.equal(r.json.version, 1);
  const list = await get('/api/plans');
  const item = list.json.items.find((it) => it.id === 'ver-fresh');
  assert.equal(item.version, 1);
});
