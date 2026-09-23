'use strict';
/*
 * 方案元信息（名称 / 标签 / 备注）规范化的引擎单元测试：
 * 严格版 normalizePlanMeta（保存路径，非法即抛带 code 错误）
 * 与宽容版 coercePlanMeta（导入路径，逐项过滤/截断）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

test('normalizePlanMeta：trim / 折叠空白 / 去重 / 保持首次出现顺序', () => {
  const m = E.normalizePlanMeta({
    name: '  折帖 A  ',
    tags: [' 骑马钉 ', '骑马钉', 'A4  骑马钉', 'A4 骑马钉'],
    note: ' 备注 \n 第二行 '
  });
  assert.equal(m.name, '折帖 A');
  assert.deepEqual(m.tags, ['骑马钉', 'A4 骑马钉']);
  assert.equal(m.note, '备注 \n 第二行', '仅去首尾空白，内部换行保留');
});

test('normalizePlanMeta：缺省字段给出空标签/空备注；空标签数组合法（0 个）', () => {
  const m = E.normalizePlanMeta({ name: 'x' });
  assert.deepEqual(m.tags, []);
  assert.equal(m.note, '');
  const m2 = E.normalizePlanMeta({ name: 'x', tags: [], note: '' });
  assert.deepEqual(m2.tags, []);
});

test('normalizePlanMeta：各类非法输入抛出对应错误码', () => {
  const expectCode = (body, code) => {
    let thrown = null;
    try {
      E.normalizePlanMeta(body);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, `应抛出错误：${code}`);
    assert.equal(thrown.code, code);
    assert.ok(thrown.message);
  };
  expectCode({ name: '' }, 'bad_name');
  expectCode({ name: '   ' }, 'bad_name');
  expectCode({ name: 'x'.repeat(41) }, 'name_too_long');
  expectCode({ name: 'x', tags: null }, 'bad_tags');
  expectCode({ name: 'x', tags: {} }, 'bad_tags');
  expectCode({ name: 'x', tags: [1] }, 'bad_tags');
  expectCode({ name: 'x', tags: [' '] }, 'bad_tags');
  expectCode({ name: 'x', tags: ['a,b'] }, 'tag_forbidden');
  expectCode({ name: 'x', tags: ['a;b'] }, 'tag_forbidden');
  expectCode({ name: 'x', tags: ['a|b'] }, 'tag_forbidden');
  expectCode({ name: 'x', tags: ['a'.repeat(21)] }, 'tag_too_long');
  expectCode({ name: 'x', tags: Array.from({ length: 9 }, (_, i) => 't' + i) },
    'too_many_tags');
  expectCode({ name: 'x', note: 1 }, 'bad_note');
  expectCode({ name: 'x', note: 'x'.repeat(501) }, 'note_too_long');
});

test('normalizePlanMeta：中文按码点计数；恰好 8 个 / 20 字标签 / 500 字备注合法', () => {
  assert.doesNotThrow(() => E.normalizePlanMeta({
    name: '中', tags: Array.from({ length: 8 }, (_, i) => '标签' + i), note: ''
  }));
  assert.doesNotThrow(() => E.normalizePlanMeta({ name: '中', tags: ['中'.repeat(20)] }));
  assert.doesNotThrow(() => E.normalizePlanMeta({ name: '中', note: '中'.repeat(500) }));
});

test('normalizePlanMeta：9 个输入含 1 个重复 → 去重为 8 个，合法', () => {
  const m = E.normalizePlanMeta({
    name: '中',
    tags: Array.from({ length: 8 }, (_, i) => 't' + i).concat(['t0'])
  });
  assert.equal(m.tags.length, 8);
});

test('coercePlanMeta：宽容规整非法导入——过滤坏标签、截断超长、限量 8 个', () => {
  const m = E.coercePlanMeta({
    name: '',   // 空名退回默认
    tags: [' ok ', 'ok', 'a,b', 5, 'x'.repeat(30), 't1', 't2', 't3', 't4', 't5', 't6', 't7'],
    note: 'y'.repeat(600)
  });
  assert.equal(m.name, '未命名方案');
  // ' ok '→'ok'；'a,b' 与 5 被过滤；超长标签截断为 20 字；最终至多 8 个
  assert.ok(m.tags.includes('ok'));
  assert.ok(!m.tags.some((t) => t.includes(',')));
  assert.ok(m.tags.every((t) => [...t].length <= 20));
  assert.ok(m.tags.length <= 8);
  assert.equal([...m.note].length, 500);
});

test('normalizePlan：导入方案自动带宽容规整后的 tags/note，不影响几何', () => {
  const p = E.normalizePlan({
    rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    name: ' 名称 ', tags: [' A ', 'A', 5], note: ' 备注 '
  });
  assert.equal(p.name, '名称');
  assert.deepEqual(p.tags, ['A']);
  assert.equal(p.note, '备注');
  assert.equal(p.steps.length, 1);
});
