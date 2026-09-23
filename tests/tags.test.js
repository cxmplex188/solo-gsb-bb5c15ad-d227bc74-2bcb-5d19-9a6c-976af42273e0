'use strict';
/*
 * 方案存档标签 / 备注 / 列表筛选的 HTTP 测试：
 *  - 保存时标签 0..8 个、服务端 trim / 折叠空白 / 去重持久化，备注随方案保存
 *  - 非法标签（空、非字符串、超长、含分隔符、超过 8 个）与过长名称 / 备注整请求 400 拒绝
 *  - 非法请求不改写已有存档（原子性）
 *  - 列表支持标签交集、名称关键词、最近更新时间筛选，稳定排序与匹配计数
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-tags-'));
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

const STEP = { axis: 'v', line: 1, dir: 'r' };
function plan(over = {}) {
  return {
    name: '标签测试方案', rows: 1, cols: 2, labels: {},
    steps: [STEP], tags: [], note: '', ...over
  };
}

// ---------- 规范化与持久化 ----------
test('保存：标签 trim / 折叠空白 / 去重并随方案持久化', async () => {
  const r = await post('/api/plans', plan({
    id: 'tags-normalize',
    tags: [' 骑马钉 ', '骑马钉', 'A4  骑马钉', 'A4 骑马钉', '待复核'],
    note: '  首件备注  '
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.plan.tags, ['骑马钉', 'A4 骑马钉', '待复核']);
  assert.equal(r.json.plan.note, '首件备注');
  assert.ok(r.json.plan.createdAt && r.json.plan.updatedAt);
  assert.equal(r.json.plan.createdAt, r.json.plan.updatedAt);

  const loaded = await (await fetch(`${base}/api/plans/tags-normalize`)).json();
  assert.deepEqual(loaded.tags, ['骑马钉', 'A4 骑马钉', '待复核']);
  assert.equal(loaded.note, '首件备注');
});

test('保存：缺省 tags/note 时规范化为空数组/空字符串；GET 单档原样返回', async () => {
  const r = await post('/api/plans', {
    id: 'tags-default', name: '无标签方案', rows: 1, cols: 2, labels: {}, steps: []
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.plan.tags, []);
  assert.equal(r.json.plan.note, '');
  const loaded = await (await fetch(`${base}/api/plans/tags-default`)).json();
  assert.deepEqual(loaded.tags, []);
  assert.equal(loaded.note, '');
});

test('保存：恰好 8 个标签接受；中文按码点计数（20 个汉字标签合法）', async () => {
  const tags = Array.from({ length: 8 }, (_, i) => '标签' + i);
  const r = await post('/api/plans', plan({ id: 'tags-eight', tags }));
  assert.equal(r.status, 200);
  assert.equal(r.json.plan.tags.length, 8);

  const cnTag = '中'.repeat(20);
  const r2 = await post('/api/plans', plan({ id: 'tags-cn-len', tags: [cnTag] }));
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.plan.tags, [cnTag]);
});

// ---------- 整请求拒绝 ----------
test('保存：空标签 / 非字符串标签 / 含分隔符返回 400 与具体错误码', async () => {
  let r = await post('/api/plans', plan({ tags: ['   '] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_tags');

  r = await post('/api/plans', plan({ tags: [123] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_tags');

  r = await post('/api/plans', plan({ tags: ['a,b'] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'tag_forbidden');

  r = await post('/api/plans', plan({ tags: ['a;b'] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'tag_forbidden');

  r = await post('/api/plans', plan({ tags: ['a|b'] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'tag_forbidden');

  r = await post('/api/plans', plan({ tags: '不是数组' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_tags');
});

test('保存：标签超 20 字符 / 数量超 8 个返回 400', async () => {
  let r = await post('/api/plans', plan({ tags: ['a'.repeat(21)] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'tag_too_long');

  // 去重后仍有 9 个不同标签
  const nine = Array.from({ length: 9 }, (_, i) => 't' + i);
  r = await post('/api/plans', plan({ tags: nine }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'too_many_tags');

  // 10 个输入去重为 9 个：同样拒绝（去重不绕过限量）
  r = await post('/api/plans', plan({ tags: nine.concat(['t0']) }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'too_many_tags');
});

test('保存：空名称 / 名称超长 / 备注超长 / 备注非字符串返回 400', async () => {
  let r = await post('/api/plans', plan({ name: '   ' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_name');

  r = await post('/api/plans', plan({ name: 'x'.repeat(41) }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'name_too_long');

  r = await post('/api/plans', plan({ note: 'x'.repeat(501) }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'note_too_long');

  r = await post('/api/plans', plan({ note: 123 }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_note');
});

test('保存：非法请求不改动任何已有存档（保留旧标签/备注/更新时间）', async () => {
  const first = await post('/api/plans', plan({
    id: 'tags-keep', name: '旧名称', tags: ['旧标签'], note: '旧备注'
  }));
  assert.equal(first.status, 200);
  const before = JSON.parse(fs.readFileSync(path.join(tmpData, 'tags-keep.json'), 'utf8'));

  // 等待以确保若误写则 updatedAt 必然不同
  await new Promise((r) => setTimeout(r, 15));

  const bad = await post('/api/plans', {
    ...plan(), id: 'tags-keep', name: '新名称', tags: ['非法,标签'], note: '新备注'
  });
  assert.equal(bad.status, 400);

  const after = JSON.parse(fs.readFileSync(path.join(tmpData, 'tags-keep.json'), 'utf8'));
  assert.equal(after.name, '旧名称');
  assert.deepEqual(after.tags, ['旧标签']);
  assert.equal(after.note, '旧备注');
  assert.equal(after.updatedAt, before.updatedAt, 'updatedAt 不得变化');
  assert.deepEqual(after, before);

  // 非法方案几何（bad_plan）同样不得覆盖旧档
  const badGeom = await post('/api/plans', {
    id: 'tags-keep', rows: 2, cols: 2, steps: [{ axis: 'z' }], tags: []
  });
  assert.equal(badGeom.status, 400);
  const still = JSON.parse(fs.readFileSync(path.join(tmpData, 'tags-keep.json'), 'utf8'));
  assert.deepEqual(still, before);
});

test('保存：更新已有方案时 createdAt 保留、updatedAt 刷新', async () => {
  const first = await post('/api/plans', plan({ id: 'tags-update', tags: ['v1'] }));
  assert.equal(first.status, 200);
  const { createdAt } = first.json.plan;
  await new Promise((r) => setTimeout(r, 15));
  const second = await post('/api/plans', plan({ id: 'tags-update', tags: ['v2'] }));
  assert.equal(second.status, 200);
  assert.equal(second.json.plan.createdAt, createdAt);
  assert.ok(second.json.plan.updatedAt >= first.json.plan.updatedAt);
  assert.deepEqual(second.json.plan.tags, ['v2']);
});

// ---------- 列表筛选 ----------
const seed = [
  { id: 'p-alpha', name: '骑马钉样册', tags: ['骑马钉', 'A4'], note: '一版' },
  { id: 'p-beta', name: '胶装说明书', tags: ['胶装', 'A4', '待复核'], note: '' },
  { id: 'p-gamma', name: '骑马钉海报', tags: ['骑马钉'], note: '大尺寸' },
  { id: 'p-delta', name: '未命名方案', tags: [], note: '' },
  { id: 'p-old', name: '骑马钉旧档', tags: ['骑马钉', 'A3'], note: '' }
];

test('列表准备：批量存档（按顺序写入并拉开更新时间）', async () => {
  for (const s of seed) {
    const r = await post('/api/plans', plan(s));
    assert.equal(r.status, 200, `${s.id} 应保存成功`);
    await new Promise((res) => setTimeout(res, 12));
  }
});

test('列表：无筛选返回全部、计数、标签聚合与更新时间倒序稳定排序', async () => {
  const r = await get('/api/plans');
  assert.equal(r.status, 200);
  // 至少包含 5 个种子存档与此前测试保存的其它存档
  assert.ok(r.json.total >= seed.length);
  assert.equal(r.json.matched, r.json.total);

  // 更新时间倒序；同时间按 id 升序（稳定）
  const times = r.json.items.map((it) => it.updatedAt);
  const sorted = times.slice().sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  assert.deepEqual(times, sorted);

  // 每条摘要含标签 / 备注 / 时间戳
  const alpha = r.json.items.find((it) => it.id === 'p-alpha');
  assert.deepEqual(alpha.tags, ['骑马钉', 'A4']);
  assert.equal(alpha.note, '一版');
  assert.equal(typeof alpha.updatedAt, 'string');

  // allTags 按出现次数倒序聚合（种子档中骑马钉 3、A4 2，另含此前测试的同名标签）
  const counts = Object.fromEntries(r.json.allTags.map((t) => [t.tag, t.count]));
  assert.ok(counts['骑马钉'] >= 3);
  assert.ok(counts['A4'] >= 2);
  assert.equal(r.json.allTags[0].tag, '骑马钉');
});

test('列表：标签交集（逗号 / 分号分隔、含空白）只返回同时命中的方案', async () => {
  const r = await get('/api/plans?tags=' + encodeURIComponent(' 骑马钉 , A4 '));
  assert.equal(r.status, 200);
  const ids = r.json.items.map((it) => it.id);
  assert.ok(ids.includes('p-alpha'));
  assert.ok(!ids.includes('p-beta'), '胶装说明书不含骑马钉');
  assert.ok(!ids.includes('p-gamma'), '骑马钉海报不含 A4');
  assert.ok(r.json.items.every((it) =>
    it.tags.includes('骑马钉') && it.tags.includes('A4')));
  assert.equal(r.json.matched, r.json.items.length);

  const r2 = await get('/api/plans?tags=' + encodeURIComponent('骑马钉;A4'));
  assert.deepEqual(r2.json.items.map((it) => it.id).sort(),
    r.json.items.map((it) => it.id).sort());
});

test('列表：名称关键词大小写不敏感子串匹配，并可与标签交集组合', async () => {
  const r = await get('/api/plans?q=' + encodeURIComponent('骑马'));
  assert.ok(r.json.items.length >= 3);
  assert.ok(r.json.items.every((it) => it.name.includes('骑马')));

  const both = await get('/api/plans?q=' + encodeURIComponent('骑马') +
    '&tags=' + encodeURIComponent('A4'));
  const ids = both.json.items.map((it) => it.id);
  assert.ok(ids.includes('p-alpha'));
  assert.ok(!ids.includes('p-gamma'));
});

test('列表：since 仅返回该时间之后更新的存档', async () => {
  // p-old 是最后写入的；取 p-old 之前一刻为界，应只剩 p-old
  const oldItem = (await get('/api/plans')).json.items.find((it) => it.id === 'p-old');
  const t = new Date(oldItem.updatedAt).getTime() - 5;
  const r = await get('/api/plans?since=' + t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((it) => it.id), ['p-old']);

  // 遥远未来：零匹配，计数为 0（ISO 字符串，规避超大毫秒数被查询解析器处理的歧义）
  const future = new Date(Date.now() + 99999999).toISOString();
  const none = await get('/api/plans?since=' + encodeURIComponent(future));
  assert.equal(none.status, 200, JSON.stringify(none.json));
  assert.equal(none.json.matched, 0);
  assert.deepEqual(none.json.items, []);
  assert.ok(none.json.total > 0, 'total 不受筛选影响');

  // ISO 字符串同样可用
  const iso = await get('/api/plans?since=' + encodeURIComponent(new Date(t).toISOString()));
  assert.deepEqual(iso.json.items.map((it) => it.id), ['p-old']);
});

test('列表：非法 since / 非法标签筛选返回 400，且不影响后续正常请求', async () => {
  const badSince = await get('/api/plans?since=not-a-date');
  assert.equal(badSince.status, 400);
  assert.equal(badSince.json.error.code, 'bad_since');

  // 逗号是合法的标签分隔（此处表示 a 与 b 两个标签）；竖线才是标签非法字符
  const twoTags = await get('/api/plans?tags=' + encodeURIComponent('a,b'));
  assert.equal(twoTags.status, 200);
  const badPipe = await get('/api/plans?tags=' + encodeURIComponent('a|b'));
  assert.equal(badPipe.status, 400);
  assert.equal(badPipe.json.error.code, 'bad_tag_filter');

  const ok = await get('/api/plans');
  assert.equal(ok.status, 200);
  assert.ok(ok.json.matched > 0);
});

test('列表：筛选命中计数与排序在组合筛选下自洽', async () => {
  const r = await get('/api/plans?tags=' + encodeURIComponent('骑马钉') +
    '&q=' + encodeURIComponent('样册'));
  assert.equal(r.json.matched, 1);
  assert.equal(r.json.items[0].id, 'p-alpha');
  assert.ok(r.json.total >= r.json.matched);
});

// ---------- 旧档兼容 ----------
test('列表：缺少 tags/note/updatedAt 的旧存档以空标签/空备注/mtime 兼容呈现', async () => {
  const legacyPath = path.join(tmpData, 'legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify({
    name: '旧版存档', rows: 1, cols: 2, labels: {}, steps: []
  }));
  const r = await get('/api/plans');
  const legacy = r.json.items.find((it) => it.id === 'legacy');
  assert.ok(legacy, '旧档应出现在列表');
  assert.deepEqual(legacy.tags, []);
  assert.equal(legacy.note, '');
  assert.ok(!Number.isNaN(new Date(legacy.updatedAt).getTime()));

  // 更新旧档：服务端补齐标签/备注与时间戳
  const upd = await post('/api/plans', plan({ id: 'legacy', name: '旧版存档', tags: ['补标'] }));
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.json.plan.tags, ['补标']);
  assert.ok(upd.json.plan.updatedAt);
});

test('GET /api/plans/:id：保存的标签备注经往返保持顺序与内容', async () => {
  const tags = ['封面四色', '内文单色', '纸厚157g', '客户A', 'v2', '加急', '骑马钉', 'A4'];
  const r = await post('/api/plans', plan({ id: 'tags-roundtrip', tags, note: '第一行\n第二行' }));
  assert.equal(r.status, 200);
  const loaded = await (await fetch(`${base}/api/plans/tags-roundtrip`)).json();
  assert.deepEqual(loaded.tags, tags);
  assert.equal(loaded.note, '第一行\n第二行');
});
