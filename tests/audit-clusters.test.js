'use strict';
/*
 * 审计问题聚类（只读派生视图）单元测试：
 *  - 同规则 + 相邻阅读槽位 / 共享原始纸格 → 并查集合并
 *  - 不同规则绝不连边；多叠层槽位相邻作用域限定在本叠层
 *  - 构建结果与 findings 数组顺序无关（确定性）
 *  - reconcile 按稳定成员 key 复用簇编号，成员变化记 added/removed，无交集不误合并
 *  - 不改写原始审计结论（findings / verdict / summary 不变）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/foldEngine.js');

const STEPS_2x2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];
const L = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, [f, b]]) => [k, { front: f, back: b }]));

test('聚类：每个成员带稳定 key、严重级别、槽位与说明', () => {
  const r = E.auditPlan(2, 2,
    L({ '0,0': ['1', '2'], '1,0': ['1', ''] }), STEPS_2x2);
  const cs = E.buildAuditClusters(r);
  for (const c of cs) {
    assert.ok(typeof c.ruleId === 'string' && c.ruleId.length);
    assert.ok(['error', 'warning', 'info'].includes(c.severity));
    assert.equal(c.memberCount, c.members.length);
    assert.deepEqual(c.memberKeys, c.members.map((m) => m.key));
    for (const m of c.members) {
      assert.equal(m.ruleId, c.ruleId);
      assert.ok(m.severity);
      assert.ok(typeof m.message === 'string' && m.message.length);
      assert.ok(typeof m.key === 'string' && m.key.startsWith(c.ruleId + '|')
        || m.key === c.ruleId);
      if (m.slot != null) assert.ok(Number.isInteger(m.slot) && m.slot >= 1);
    }
  }
});

test('聚类：同一规则相邻槽位结果合并为一个倒置簇（并查集传递合并）', () => {
  // 全空白 2×2：倒置槽 1、2、7、8，经 1-2 / 7-8 相邻 + 共享原格 0,0、1,0 传递相连
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const cs = E.buildAuditClusters(r);
  const inv = cs.filter((c) => c.ruleId === 'inverted_page');
  assert.equal(inv.length, 1, '四个倒置槽位应全部并入同一簇');
  assert.equal(inv[0].memberCount, 4);
  assert.equal(inv[0].severity, 'error');
  assert.deepEqual(inv[0].slots.sort((a, b) => a - b), [1, 2, 7, 8]);
  assert.deepEqual(inv[0].cells.sort(), ['0,0', '1,0']);
});

test('聚类：非相邻槽位且不共享原格的同规则结果保持不同簇（不误合并）', () => {
  // 未覆盖纸格 4 个原格，彼此无槽位、不共享原格 → 4 个独立簇
  const r = E.auditPlan(2, 2, {}, []);
  const unc = E.buildAuditClusters(r).filter((c) => c.ruleId === 'uncovered_cell');
  assert.equal(unc.length, 4);
  assert.deepEqual(unc.map((c) => c.cells[0]).sort(), ['0,0', '0,1', '1,0', '1,1']);
});

test('聚类：共享原始纸格把正反面两条同规则结果合并', () => {
  // 1×2 单竖折：2×1 折一次后 2 个叠层，每个叠层同格正反面各占一个槽位，
  // 正面槽与反面槽在同叠层中位置首尾，槽位不相邻但共享原格 → 合并
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  const r = E.auditPlan(1, 2, {}, steps);
  const blanks = E.buildAuditClusters(r).filter((c) => c.ruleId === 'blank_page');
  // 叠层1（0,0|1,0）：4 个空白槽经共享原格全部相连；叠层2 不存在（已收成单叠）
  assert.ok(blanks.some((c) => c.memberCount === 4 &&
    c.cells.length === 2 && c.cells.includes('0,0') && c.cells.includes('1,0')));
});

test('聚类：不同规则的结果绝不连边（倒置槽与空白槽不混簇）', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const cs = E.buildAuditClusters(r);
  const rules = new Set(cs.map((c) => c.ruleId));
  for (const rule of rules) {
    for (const c of cs.filter((x) => x.ruleId === rule)) {
      assert.ok(c.members.every((m) => m.ruleId === rule));
    }
  }
  // 倒置簇 4 成员（error），不会吞掉同槽位的空白警告成员
  const inv = cs.find((c) => c.ruleId === 'inverted_page');
  assert.equal(inv.memberCount, 4);
  assert.equal(inv.severity, 'error');
});

test('聚类：多叠层下槽位相邻只在同一叠层内连边', () => {
  // 1×3 单竖折 line=1：2 个叠层（0,0|1,0 厚 2；2,0 厚 1），各叠层槽位独立编号
  const r = E.auditPlan(1, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }]);
  const cs = E.buildAuditClusters(r);
  const blanks = cs.filter((c) => c.ruleId === 'blank_page').sort(
    (a, b) => a.memberCount - b.memberCount);
  assert.equal(blanks.length, 2);
  assert.equal(blanks[0].memberCount, 2);
  assert.deepEqual(blanks[0].cells, ['2,0']);
  assert.equal(blanks[1].memberCount, 4);
  assert.deepEqual(blanks[1].cells.sort(), ['0,0', '1,0']);
  assert.deepEqual(blanks[0].stacks, [2]);
  assert.deepEqual(blanks[1].stacks, [1]);
});

test('聚类：分离叠层 / 容量类规则为全局单成员簇', () => {
  const r = E.auditPlan(2, 3, {}, [{ axis: 'v', line: 1, dir: 'r' }]);
  const cs = E.buildAuditClusters(r);
  const split = cs.filter((c) => c.ruleId === 'split_stacks');
  assert.equal(split.length, 1);
  assert.equal(split[0].memberCount, 1);
  assert.equal(split[0].severity, 'error');
  const r2 = E.auditPlan(1, 1, L({ '0,0': ['1', '2'] }), []);
  const cap = E.buildAuditClusters(r2).filter((c) => c.ruleId === 'capacity_multiple');
  assert.equal(cap.length, 1);
  assert.equal(cap[0].memberCount, 1);
});

test('聚类：重复页码按每次出现（含页码）生成成员并稳定 key', () => {
  const r = E.auditPlan(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '1'] }),
    [{ axis: 'v', line: 1, dir: 'r' }]);
  const dup = E.buildAuditClusters(r).filter((c) => c.ruleId === 'duplicate_page');
  // 两处出现既不相邻（槽位 1 与 4）也不共享原格 → 两条独立成员（两个簇）
  assert.equal(dup.reduce((n, c) => n + c.memberCount, 0), 2);
  const keys = dup.flatMap((c) => c.memberKeys).sort();
  assert.deepEqual(keys,
    ['duplicate_page|1|0,0|back', 'duplicate_page|1|1,0|back']);
  assert.ok(dup.every((c) => c.members[0].label === '1'));
});

test('聚类：构建结果与 findings 数组顺序无关（确定性）', () => {
  const r = E.auditPlan(2, 2, L({ '0,0': ['1', '2'], '1,0': ['1', ''] }), STEPS_2x2);
  const a = E.buildAuditClusters(r);
  const b = E.buildAuditClusters({ ...r, findings: r.findings.slice().reverse() });
  assert.deepEqual(
    b.map((c) => [c.ruleId, c.severity, c.memberKeys, c.cells, c.slots]),
    a.map((c) => [c.ruleId, c.severity, c.memberKeys, c.cells, c.slots]));
});

test('聚类：输出按严重级别 → 规则 → 首成员 key 稳定排序', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const cs = E.buildAuditClusters(r);
  const rank = { error: 0, warning: 1, info: 2 };
  for (let i = 1; i < cs.length; i++) {
    const prev = cs[i - 1], cur = cs[i];
    const keyOf = (c) => [rank[c.severity], c.ruleId, c.memberKeys[0]];
    assert.ok(JSON.stringify(keyOf(prev)) <= JSON.stringify(keyOf(cur)));
  }
});

test('聚类：assignAuditClusterIds 给出顺序编号 C1..', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const cs = E.assignAuditClusterIds(E.buildAuditClusters(r));
  assert.deepEqual(cs.map((c) => c.id), cs.map((_, i) => `C${i + 1}`));
});

test('复用：同内容重算簇编号完全稳定', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(r));
  const c2 = E.reconcileAuditClusters(E.buildAuditClusters(r), c1);
  assert.deepEqual(c2.map((c) => c.id), c1.map((c) => c.id));
  assert.ok(c2.every((c) => c.added.length === 0 && c.removed.length === 0));
});

test('复用：成员变化时保留簇编号并给出 added/removed 明细', () => {
  // v1：全空白 2×2 —— 8 个空白槽经相邻槽位全链合并为一个空白簇
  const r1 = E.auditPlan(2, 2, {}, STEPS_2x2);
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(r1));
  const blanks1 = c1.filter((c) => c.ruleId === 'blank_page');
  assert.equal(blanks1.length, 1);
  const blankId = blanks1[0].id;

  // v2：给 0,1 正面补上页码（该成员从空白簇移除，簇仍有 7 个成员）
  const r2 = E.auditPlan(2, 2, L({ '0,1': ['6', ''] }), STEPS_2x2);
  const c2 = E.reconcileAuditClusters(E.buildAuditClusters(r2), c1);
  const same = c2.find((c) => c.id === blankId);
  assert.ok(same, '簇编号应按成员 key 复用');
  assert.equal(same.removed.length, 1);
  assert.equal(same.removed[0].key, 'blank_page|0,1|front');
  assert.equal(same.removed[0].ruleId, 'blank_page');
  assert.equal(same.removed[0].severity, 'warning');
  assert.ok(same.removed[0].message.length, '移除成员保留可读说明');
  assert.equal(same.memberCount, 7);
});

test('复用：簇新增成员时在 added 中列出，原成员仍在', () => {
  const r1 = E.auditPlan(2, 2, L({ '0,1': ['6', ''] }), STEPS_2x2);
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(r1));
  const r2 = E.auditPlan(2, 2, {}, STEPS_2x2);   // 去掉标注 → 多回一个空白成员
  const c2 = E.reconcileAuditClusters(E.buildAuditClusters(r2), c1);
  const grown = c2.find((c) => c.added.some((m) => m.key === 'blank_page|0,1|front'));
  assert.ok(grown);
  assert.equal(grown.added[0].severity, 'warning');
  assert.ok(grown.added[0].message.length);
});

test('复用：成员完全不同（无 key 交集）绝不复用旧编号，避免误合并', () => {
  // v1：仅 0,0 已标注 → 未覆盖 {0,1, 1,0, 1,1}
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(
    E.auditPlan(2, 2, L({ '0,0': ['1', '2'] }), [])));
  assert.ok(c1.some((c) => c.memberKeys.includes('uncovered_cell|0,1')));
  // v2：0,0 清空、其余三格标注 → 未覆盖 {0,0}；与 v1 的未覆盖集合零交集
  const r2 = E.auditPlan(2, 2,
    L({ '0,1': ['3', '4'], '1,0': ['5', '6'], '1,1': ['7', '8'] }), []);
  const c2 = E.reconcileAuditClusters(E.buildAuditClusters(r2), c1);
  const unc = c2.filter((c) => c.ruleId === 'uncovered_cell');
  assert.equal(unc.length, 1);
  assert.deepEqual(unc[0].cells, ['0,0']);
  const oldIds = new Set(c1.map((c) => c.id));
  assert.ok(!oldIds.has(unc[0].id), '无成员交集时必须分配新编号');
  assert.equal(unc[0].added.length, 1);
});

test('复用：整个簇消失后编号不复用给其它簇（旧 id 不重生）', () => {
  const r1 = E.auditPlan(2, 2, {}, []);
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(r1));
  const all = L({ '0,0': ['1', '2'], '0,1': ['3', '4'], '1,0': ['5', '6'], '1,1': ['7', '8'] });
  const c2 = E.reconcileAuditClusters(
    E.buildAuditClusters(E.auditPlan(2, 2, all, [])), c1);
  assert.equal(c2.filter((c) => c.ruleId === 'uncovered_cell').length, 0);
  // 出现的任何新 id 都不与消失簇 id 撞号
  const ids = new Set(c1.map((c) => c.id));
  assert.ok(c2.every((c) => !ids.has(c.id) || c.ruleId !== 'uncovered_cell'));
});

test('复用：配对贪心为一对一，两个新簇不会复用同一个旧簇', () => {
  const r1 = E.auditPlan(2, 2, L({ '0,1': ['6', ''] }), STEPS_2x2);
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(r1));
  const r2 = E.auditPlan(2, 2, {}, STEPS_2x2);
  const c2 = E.reconcileAuditClusters(E.buildAuditClusters(r2), c1);
  const reused = new Set();
  for (const c of c2) {
    if (c1.some((o) => o.id === c.id)) {
      assert.ok(!reused.has(c.id), '旧簇编号至多被一个新簇复用');
      reused.add(c.id);
    }
  }
});

test('复用：对旧簇顺序不敏感（reconcile 自身确定性）', () => {
  const r1 = E.auditPlan(2, 2, {}, STEPS_2x2);
  const c1 = E.assignAuditClusterIds(E.buildAuditClusters(r1));
  const r2 = E.auditPlan(2, 2, L({ '0,1': ['6', ''] }), STEPS_2x2);
  const fresh = E.buildAuditClusters(r2);
  const a = E.reconcileAuditClusters(fresh, c1);
  const b = E.reconcileAuditClusters(fresh, c1.slice().reverse());
  assert.deepEqual(
    b.map((c) => [c.id, c.memberKeys, c.added.map((m) => m.key), c.removed.map((m) => m.key)]),
    a.map((c) => [c.id, c.memberKeys, c.added.map((m) => m.key), c.removed.map((m) => m.key)]));
});

test('聚类：严重级别取簇内最高级别；summary 计数正确', () => {
  const r = E.auditPlan(2, 2, {}, STEPS_2x2);
  const cs = E.assignAuditClusterIds(E.buildAuditClusters(r));
  const sum = E.auditClusterSummary(cs);
  assert.equal(sum.members, cs.reduce((n, c) => n + c.memberCount, 0));
  assert.equal(sum.clusters, cs.length);
  assert.equal(sum.errorClusters, cs.filter((c) => c.severity === 'error').length);
  assert.equal(sum.warningClusters, cs.filter((c) => c.severity === 'warning').length);
});

test('聚类：空审计（全部通过）产出空簇数组', () => {
  const r = E.auditPlan(1, 2, L({ '0,0': ['4', '1'], '1,0': ['2', '3'] }),
    [{ axis: 'v', line: 1, dir: 'r' }]);
  assert.deepEqual(E.buildAuditClusters(r), []);
  assert.deepEqual(E.auditClusterSummary([]),
    { clusters: 0, errorClusters: 0, warningClusters: 0, infoClusters: 0, members: 0 });
});

test('聚类：只读派生，不改变原始审计结论', () => {
  const labels = {};
  const r = E.auditPlan(2, 2, labels, STEPS_2x2);
  const snapFindings = JSON.stringify(r.findings);
  const snapVerdict = r.verdict;
  const snapSummary = JSON.stringify(r.summary);
  E.buildAuditClusters(r);
  E.assignAuditClusterIds(E.buildAuditClusters(r));
  assert.equal(JSON.stringify(r.findings), snapFindings);
  assert.equal(r.verdict, snapVerdict);
  assert.equal(JSON.stringify(r.summary), snapSummary);
});

test('聚类：未知规则 id 走兜底成员，不抛错', () => {
  const fake = {
    ok: true, stats: { stacks: 1 },
    findings: [{ id: 'future_rule', severity: 'info', title: '未来规则',
      message: 'x', cells: ['1,2'], step: null }]
  };
  const cs = E.buildAuditClusters(fake);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].ruleId, 'future_rule');
  assert.equal(cs[0].cells[0], '1,2');
});
