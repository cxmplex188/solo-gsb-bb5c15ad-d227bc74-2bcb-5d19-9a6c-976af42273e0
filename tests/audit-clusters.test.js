'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS_2x2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
const L = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, [f, b]]) => [k, { front: f, back: b }]));

test('聚类：干净方案无簇，摘要计数为 0', () => {
  const r = E.auditPlan(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '3'] }),
    [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.deepEqual(r.clusters, []);
  assert.deepEqual(r.clusterSummary, { clusters: 0, members: 0, errors: 0, warnings: 0, infos: 0 });
});

test('聚类：同规则相邻阅读槽位（1/2、7/8 传递）合并为一个倒置簇', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const inv = r.clusters.filter((c) => c.rule === 'inverted_page');
  assert.equal(inv.length, 1);
  const c = inv[0];
  assert.equal(c.severity, 'error');
  assert.equal(c.memberCount, 4);
  assert.deepEqual(c.slots.map((s) => s.slot), [1, 2, 7, 8]);
  assert.deepEqual(c.cells, ['0,0', '1,0']);
  // 成员保留严重级别、槽位和说明
  for (const m of c.members) {
    assert.equal(m.severity, 'error');
    assert.equal(m.rule, 'inverted_page');
    assert.ok(m.slots.length === 1 && typeof m.slots[0].slot === 'number');
    assert.ok(m.note && m.note.length > 0);
  }
  assert.ok(c.notes.length === 4);
  // 摘要计数
  assert.equal(r.clusterSummary.members, 16);
  assert.equal(r.clusterSummary.errors, 1);
});

test('聚类：同规则槽位不相邻且不共享原格时分为独立簇（重复页码 槽1/槽3）', () => {
  const r = E.auditPlan(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '1'] }),
    [{ axis: 'v', line: 1, dir: 'r' }]);
  const dup = r.clusters.filter((c) => c.rule === 'duplicate_page');
  assert.equal(dup.length, 2, '槽 1 与槽 3 既不相邻也不共享原格，不得合并');
  assert.ok(dup.every((c) => c.memberCount === 1));
  assert.deepEqual(dup.map((c) => c.cells[0]).sort(), ['0,0', '1,0']);
});

test('聚类：共享原始纸格把同规则非相邻槽位合并（同格倒置）', () => {
  // 0,0 的正面在槽 2、反面在槽 7：两槽不相邻，但共享原格 0,0，
  // 与各自相邻成员并查集传递后，全部倒置槽仍为一簇（不拆成两个）。
  const r = E.auditPlan(2, 2, L({ '0,0': ['5', '9'] }), STEPS_2x2);
  const inv = r.clusters.filter((c) => c.rule === 'inverted_page');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].memberCount, 4);
});

test('聚类：未覆盖纸格彼此独立成簇（无槽位邻接，不共享原格）', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const unc = r.clusters.filter((c) => c.rule === 'uncovered_cell');
  assert.equal(unc.length, 4);
  assert.ok(unc.every((c) => c.memberCount === 1 && c.slots.length === 0
    && c.severity === 'warning' && /^\d+,\d+$/.test(c.cells[0])));
});

test('聚类：分离叠层为单一全局簇，携带全部受影响原格与各叠槽位', () => {
  const r = E.auditPlan(2, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }]);
  const splitFinding = r.findings.find((f) => f.id === 'split_stacks');
  const split = r.clusters.filter((c) => c.rule === 'split_stacks');
  assert.equal(split.length, 1);
  assert.equal(split[0].severity, 'error');
  assert.equal(split[0].memberCount, 1);
  assert.deepEqual(split[0].cells, ['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
  // 槽位数 = 各叠 2×厚度（两叠厚 2、两叠厚 1 → 12）
  const expectedSlots = splitFinding.details.reduce((n, d) => n + 2 * d.depth, 0);
  assert.equal(split[0].slots.length, expectedSlots);
  assert.ok(split[0].slots.every((s) => s.cell === null));
});

test('聚类：不同规则即使同槽位/同原格也不合并（倒置槽也是空白槽）', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const inv = r.clusters.filter((c) => c.rule === 'inverted_page');
  const blank = r.clusters.filter((c) => c.rule === 'blank_page');
  assert.equal(inv.length, 1);
  // 空白槽 1..8 全相邻（传递）→ 1 簇；不与倒置簇跨规则合并
  assert.equal(blank.length, 1);
  assert.equal(blank[0].memberCount, 8);
  assert.notEqual(inv[0].cid, blank[0].cid);
});

test('聚类：结果确定性 —— 同方案多次构建簇 key / cid / 顺序完全一致', () => {
  const a = E.auditPlan(2, 2, {}, STEPS_2x2);
  const b = E.auditPlan(2, 2, {}, STEPS_2x2);
  assert.deepEqual(a.clusters.map((c) => c.key), b.clusters.map((c) => c.key));
  assert.deepEqual(a.clusters.map((c) => c.cid), b.clusters.map((c) => c.cid));
});

test('聚类：成员 key 与页码文案解耦 —— 改页码后簇 key 不变', () => {
  const before = E.auditPlan(2, 2, {}, STEPS_2x2);
  const after = E.auditPlan(2, 2, L({ '0,0': ['5', ''] }), STEPS_2x2);
  const invBefore = before.clusters.find((c) => c.rule === 'inverted_page');
  const invAfter = after.clusters.find((c) => c.rule === 'inverted_page');
  assert.equal(invBefore.key, invAfter.key);
  // 但成员 label 投影反映新文案（槽 2 带上页码 5）
  const slot2 = invAfter.members.find((m) => m.slots[0].slot === 2);
  assert.equal(slot2.slots[0].label, '5');
});

test('聚类：cid 按严重级别→规则→成员数→key 稳定排序后规范编号', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const rank = { error: 0, warning: 1, info: 2 };
  for (let i = 1; i < r.clusters.length; i++) {
    const a = r.clusters[i - 1], b = r.clusters[i];
    assert.ok(rank[a.severity] <= rank[b.severity]);
    assert.equal(a.cid, `c${i}`);
    assert.equal(b.cid, `c${i + 1}`);
  }
});

test('聚类：只读派生 —— findings 原始审计结论不被改动', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  assert.equal(r.findings.length, 16);
  assert.equal(r.verdict, 'fail');
  assert.ok(r.findings.every((f) => !f.cluster));
  // 簇成员数量 = findings 中槽位类/纸格类/全局类成员总数
  assert.equal(r.clusterSummary.members, r.findings.length);
});

// ---------- reconcileAuditClusters：重算复用 ----------

function synthCluster(rule, memberKeys, severity = 'error', cid = null) {
  const keys = [...memberKeys].sort();
  return {
    cid, key: `${rule}|${keys.join(';')}`,
    rule, title: rule, severity, cells: [], slots: [],
    memberCount: keys.length,
    members: keys.map((key) => ({ key, severity, rule, title: rule, cells: [], slots: [], note: '' })),
    notes: []
  };
}
function synthNumbered(groups) {
  return groups.map((g, i) => synthCluster(g.rule, g.keys, g.severity || 'error', `c${i + 1}`));
}

test('复用：成员集合完全相同（key 相等）原样复用 cid，无增删', () => {
  const prev = synthNumbered([{ rule: 'inverted_page', keys: ['a', 'b'] }]);
  const next = [synthCluster('inverted_page', ['b', 'a'])];
  const { clusters, removed } = E.reconcileAuditClusters(prev, next);
  assert.equal(clusters[0].cid, 'c1');
  assert.deepEqual(clusters[0].addedMemberKeys, []);
  assert.deepEqual(clusters[0].removedMemberKeys, []);
  assert.deepEqual(removed, []);
});

test('复用：成员增减时沿用 cid 并给出 added/removed，不会误并到其它簇', () => {
  const prev = synthNumbered([
    { rule: 'inverted_page', keys: ['a', 'b'] },
    { rule: 'blank_page', keys: ['x'] }
  ]);
  const next = [
    synthCluster('inverted_page', ['a']),          // 旧 c1 少了 b
    synthCluster('blank_page', ['x']),              // 旧 c2 原样
    synthCluster('inverted_page', ['m', 'n'])       // 全新倒置簇
  ];
  const { clusters } = E.reconcileAuditClusters(prev, next);
  const byRule = new Map();
  for (const c of clusters) {
    if (!byRule.has(c.rule)) byRule.set(c.rule, []);
    byRule.get(c.rule).push(c);
  }
  const inv = byRule.get('inverted_page').sort((a, b) => a.cid.localeCompare(b.cid));
  assert.equal(inv[0].cid, 'c1');
  assert.deepEqual(inv[0].addedMemberKeys, []);
  assert.deepEqual(inv[0].removedMemberKeys, ['b']);
  assert.equal(inv[1].cid, 'c3', '新簇取旧最大序号之后的新号，绝不复用 c2');
  assert.deepEqual(inv[1].addedMemberKeys.sort(), ['m', 'n']);
  const blank = byRule.get('blank_page')[0];
  assert.equal(blank.cid, 'c2');
});

test('复用：簇分裂后两个新簇之一继承旧 cid（共享更多成员），另一个取新号', () => {
  const prev = synthNumbered([{ rule: 'inverted_page', keys: ['a', 'b', 'c', 'd'] }]);
  const next = [
    synthCluster('inverted_page', ['a', 'b', 'c']),
    synthCluster('inverted_page', ['d'])
  ];
  const { clusters } = E.reconcileAuditClusters(prev, next);
  const inherit = clusters.find((c) => c.cid === 'c1');
  const fresh = clusters.find((c) => c.cid !== 'c1');
  assert.ok(inherit);
  assert.deepEqual(inherit.removedMemberKeys, ['d']);
  assert.match(fresh.cid, /^c\d+$/);
  assert.notEqual(fresh.cid, 'c1');
  assert.deepEqual(fresh.addedMemberKeys, ['d']);
});

test('复用：旧簇完全消失进入 removed；旧 cid 号段不被新簇复用', () => {
  const prev = synthNumbered([
    { rule: 'inverted_page', keys: ['a'] },
    { rule: 'blank_page', keys: ['x'] }
  ]);
  const next = [synthCluster('uncovered_cell', ['g'], 'warning')];
  const { clusters, removed } = E.reconcileAuditClusters(prev, next);
  assert.equal(removed.length, 2);
  assert.deepEqual(removed.map((c) => c.cid).sort(), ['c1', 'c2']);
  assert.ok(Number(clusters[0].cid.slice(1)) >= 3, '新簇号必须大于历史最大号');
});

test('复用：实际审计序列 —— 方案修正使倒置簇消失，其它簇身份延续', () => {
  // 全空白 2×2：倒置簇 + 空白簇 + 4 未覆盖簇
  const bad = E.auditPlan(2, 2, {}, STEPS_2x2);
  // 自动拼版完整标注：倒置仍在（方案折法决定），但空白/未覆盖全部消失
  const labels = E.autoImpose(2, 2, {}, STEPS_2x2, 1, 8).labels;
  const fixed = E.auditPlan(2, 2, labels, STEPS_2x2);
  const { clusters, removed } = E.reconcileAuditClusters(bad.clusters, fixed.clusters);
  const invOld = bad.clusters.find((c) => c.rule === 'inverted_page');
  const invNew = clusters.find((c) => c.rule === 'inverted_page');
  assert.equal(invNew.cid, invOld.cid, '倒置由折法决定：成员未变，簇身份延续');
  assert.deepEqual(invNew.addedMemberKeys, []);
  // 空白与未覆盖簇随标注补全而消失
  assert.ok(removed.some((c) => c.rule === 'blank_page'));
  assert.ok(removed.every((c) => c.rule !== 'inverted_page'));
  assert.ok(!clusters.some((c) => c.rule === 'uncovered_cell'));
});

test('复用：无历史上下文时为规范编号，且不污染输入', () => {
  const next = [synthCluster('a', ['x']), synthCluster('b', ['y'], 'warning')];
  const { clusters } = E.reconcileAuditClusters(null, next);
  assert.deepEqual(clusters.map((c) => c.cid), ['c1', 'c2']);
  // 输入对象不被就地改写 cid
  assert.equal(next[0].cid, null);
});

test('buildAuditClusters：直接调用容错（非数组/坏条目跳过）', () => {
  assert.deepEqual(E.buildAuditClusters(null).clusters, []);
  const v = E.buildAuditClusters([null, {}, { id: 'uncovered_cell', severity: 'warning', cells: ['2,3'] }]);
  assert.equal(v.clusters.length, 1);
  assert.equal(v.clusters[0].cells[0], '2,3');
});
