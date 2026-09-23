'use strict';
/*
 * 轻量 DOM 桩：在无浏览器环境下加载 public/app.js，
 * 驱动“建格→标注→合法/非法折叠→回放→顺序→存取载荷”主流程冒烟。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const FE = require('../public/foldEngine.js');

function makeEl(id) {
  const listeners = {};
  const el = {
    id, hidden: false, value: '', textContent: '', innerHTML: '',
    style: { cssText: '', setProperty() {} }, className: '', disabled: false,
    checked: false,
    dataset: {}, files: [], max: '0',
    width: 0, height: 0,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatch(t, ev = {}) { (listeners[t] || []).forEach((fn) => fn(ev)); },
    click() {}, focus() {},
    __children: [],
    appendChild(c) { el.__children.push(c); if (el.options) el.options.push(c); },
    append(...cs) { el.__children.push(...cs); },
    querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    removeAttribute() {}, setAttribute() {},
    options: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); }
    },
    getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {},
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      arcTo() {}, closePath() {}, fillText() {}, translate() {}, rotate() {},
      rect() {}, set fillStyle(v) {}, get fillStyle() { return ''; },
      set strokeStyle(v) {}, get strokeStyle() { return ''; },
      set lineWidth(v) {}, get lineWidth() { return 1; },
      set font(v) {}, get font() { return ''; },
      set textAlign(v) {}, set textBaseline(v) {},
      measureText: () => ({ width: 40 }),
      setLineDash() {}, arc() {}
    }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  };
  // 桩保真：设置 innerHTML 时同步一份去标签的 textContent（app 常用 innerHTML、断言看 textContent）
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); el.textContent = html.replace(/<[^>]*>/g, ''); el.__children = []; }
  });
  return el;
}

const ids = ['rowsInput', 'colsInput', 'createGridBtn', 'axisSelect', 'lineSelect',
  'foldError', 'saveBtn', 'exportBtn', 'importBtn', 'importFile', 'loadListBtn',
  'deletePlanBtn', 'planList', 'saveMsg', 'firstBtn', 'prevBtn', 'playBtn', 'nextBtn',
  'stepSlider', 'stepLabel', 'statusBadge', 'board', 'canvasHint', 'stepList',
  'delStepBtn', 'clearStepsBtn', 'orientInfo', 'sequenceBox', 'foldState',
  'cellEditor', 'editorOrigin', 'editorRows', 'editorCancel', 'editorOk', 'planName',
  'tagInput', 'tagAddBtn', 'tagClearBtn', 'tagChips', 'tagCountHint', 'planNote',
  'planFilter', 'filterTags', 'filterQ', 'filterSince', 'filterApplyBtn',
  'filterResetBtn', 'planFilterMsg',
  'imposeStart', 'imposeCount', 'imposePreviewBtn', 'imposeStatus', 'imposePreview',
  'imposeSummary', 'imposeOverwrite', 'imposeRows', 'imposeCancelBtn', 'imposeConfirmBtn',
  'pathCell', 'pathFace', 'pathSearchBtn', 'pathStatus', 'pathResults',
  'trackCell', 'trackFace', 'trackStatus', 'trackTimeline',
  'duplexCard', 'duplexFlip', 'duplexOpenBtn', 'duplexStatus',
  'duplexOverlay', 'duplexFlipOverlay', 'duplexScreenNote', 'duplexPrintBtn',
  'duplexCloseBtn', 'plateFrontMeta', 'plateBackMeta', 'plateFrontSheet',
  'plateBackSheet',
  'auditCard', 'auditVerdict', 'auditStatus', 'auditFindings', 'auditExportBtn',
  'auditToolbar', 'auditViewFindings', 'auditViewClusters',
  'auditClusterSeverity', 'auditClusters',
  'creepCard', 'creepThickness', 'creepBleed', 'creepApplyBtn', 'creepClearBtn',
  'creepStatus', 'creepSummary', 'creepApplied', 'creepTableWrap', 'creepRows',
  'annotationCard', 'annoOpenOnly', 'annoSeverityFilter', 'annoFaceFilter',
  'annoStatus', 'annoList', 'annoEditor', 'annoEditorTarget', 'annoEditorMeta',
  'annoSeverity', 'annoStepText', 'annoText', 'annoCharHint', 'annoEditorMsg',
  'annoDeleteBtn', 'annoCancelBtn', 'annoSaveBtn',
  'reviewVersionsBtn', 'reviewOverlay', 'reviewFromSel', 'reviewToSel',
  'reviewSummary', 'reviewMsg', 'reviewDiffList', 'reviewBanner',
  'reviewBannerText', 'reviewExitViewBtn', 'reviewRestoreBtn', 'reviewSwapBtn',
  'reviewCloseBtn', 'restoreConfirm', 'restoreConfirmText', 'restoreConfirmWarn',
  'restoreCancelBtn', 'restoreOkBtn'];
const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
els.rowsInput.value = '2';
els.colsInput.value = '2';
els.planName.value = '冒烟方案';
els.axisSelect.value = 'v';
els.duplexFlip.value = 'long';
els.duplexFlipOverlay.value = 'long';
els.creepThickness.value = '0.1';
els.creepBleed.value = '3';

const foldBtns = ['l', 'r', 'u', 'd'].map((dir) => {
  const b = makeEl('fold-' + dir);
  b.dataset.dir = dir;
  return b;
});

// 存档存储桩：记录 POST 载荷与列表筛选查询，供标签/筛选流程断言
const planStore = new Map();
const versionStore = new Map();   // id -> [{ version, snapshot }]
const fetchCalls = [];
function makeJsonResponse(obj, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => obj };
}
function saveSnapshot(id, body) {
  const list = versionStore.get(id) || [];
  const version = list.length + 1;
  // 深拷贝：前端保存成功后会把响应里的数组/对象引用回填到工作区，
  // 快照必须持有独立副本（等价于真实服务端 JSON 落盘 + 浏览器 resp.json()）。
  const snapshot = { ...JSON.parse(JSON.stringify(body)), version, savedAt: '2026-09-23T00:00:00.000Z' };
  list.push({ version, snapshot });
  versionStore.set(id, list);
  return { version, snapshot: JSON.parse(JSON.stringify(snapshot)) };
}
async function stubFetch(url, opts = {}) {
  fetchCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  if (url === '/api/plans' && (opts.method || 'GET') === 'POST') {
    const body = JSON.parse(opts.body);
    const id = body.id || 'auto-' + planStore.size;
    planStore.set(id, body);
    const { version, snapshot } = saveSnapshot(id, body);
    return makeJsonResponse({ ok: true, id, version, plan: snapshot });
  }
  // 版本差异审阅相关只读接口
  let m = /^\/api\/plans\/([^/]+)\/versions\/diff$/.exec(url);
  if (m && (opts.method || 'GET') === 'POST') {
    const q = JSON.parse(opts.body);
    const list = versionStore.get(m[1]) || [];
    const ra = list.find((x) => x.version === q.from);
    const rb = list.find((x) => x.version === q.to);
    if (!ra || !rb) return makeJsonResponse({ ok: false, error: { message: '版本不存在' } }, 404);
    return makeJsonResponse({ ok: true, id: m[1], from: q.from, to: q.to,
      diff: FE.diffPlans(ra.snapshot, rb.snapshot) });
  }
  m = /^\/api\/plans\/([^/]+)\/versions\/(\d+)$/.exec(url);
  if (m) {
    const list = versionStore.get(m[1]) || [];
    const hit = list.find((x) => x.version === Number(m[2]));
    return hit ? makeJsonResponse({ ok: true, snapshot: hit.snapshot })
      : makeJsonResponse({ ok: false, error: { message: '版本不存在' } }, 404);
  }
  m = /^\/api\/plans\/([^/]+)\/versions$/.exec(url);
  if (m) {
    const list = versionStore.get(m[1]) || [];
    return makeJsonResponse({
      ok: true, id: m[1], count: list.length,
      items: list.map(({ version, snapshot: p }) => ({
        version, savedAt: p.savedAt, name: p.name, rows: p.rows, cols: p.cols,
        steps: p.steps.length, tags: p.tags || [], note: p.note || '',
        annotations: (p.annotations || []).length, openAnnotations: 0, restoredFrom: p.restoredFrom || null
      }))
    });
  }
  if (url.startsWith('/api/plans') && (opts.method || 'GET') === 'GET') {
    const qIndex = url.indexOf('?');
    const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
    const items = [...planStore.entries()].map(([id, p]) => ({
      id, name: p.name, rows: p.rows, cols: p.cols, steps: p.steps.length,
      tags: p.tags || [], note: p.note || '', updatedAt: '2026-09-22T00:00:00.000Z'
    }));
    return makeJsonResponse({ total: items.length, matched: items.length, items, allTags: [] });
  }
  return { json: async () => ({ ok: false }) };
}

const win = { devicePixelRatio: 1, addEventListener() {} };
const sandbox = {
  console,
  window: win,
  document: {
    getElementById: (id) => els[id],
    querySelectorAll: (sel) => sel === 'button.fold' ? foldBtns : [],
    createElement: () => makeEl('dyn')
  },
  fetch: stubFetch,
  Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  FileReader: class { readAsText() {} },
  alert() {}, confirm() { return false; },
  setTimeout, clearInterval, setInterval: () => 1,
  URLSearchParams, Date
};
vm.createContext(sandbox);
// foldEngine 通过 window.FoldEngine 暴露；让 window 也成为全局对象的一部分
sandbox.window.FoldEngine = undefined;

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'foldEngine.js'), 'utf8'), sandbox);
vm.runInContext('var FoldEngine = window.FoldEngine;', sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), sandbox);
const ui = sandbox.window.__foldApp;

// init() 已在 app.js 末尾执行：默认创建了 2×2 网格
assert.equal(ui.plan.rows, 2);
assert.equal(ui.plan.cols, 2);

// 模拟添加合法竖折（左瓣向右落）
ui.plan.labels = {
  '0,0': { front: '4', back: '5' }, '1,0': { front: '6', back: '3' },
  '0,1': { front: '8', back: '1' }, '1,1': { front: '7', back: '2' }
};
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(ui.plan.steps.length, 1);
assert.equal(els.foldError.hidden, true);

// 非法折：水平方向用左右方向不匹配，由表单分支处理；直接给厚度冲突
// 先加合法水平折，再试图重复 -> contour
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
assert.equal(ui.plan.steps.length, 2);
ui.requestStep({ axis: 'h', line: 1, dir: 'd' }); // 上瓣已空
assert.equal(ui.plan.steps.length, 2, '非法步骤不应入列');
assert.equal(els.foldError.hidden, false);

// 回放与阅读顺序
ui.setUpto(0);
assert.equal(ui.upto, 0);
ui.setUpto(2);
const seq = FE.pageSequence(ui.replay.state).stacks[0].sequence;
assert.deepEqual(seq, ['3', '4', '1', '7', '2', '8', '5', '6']);
assert.ok(/单叠|阅读顺序/.test(els.foldState.textContent), '折叠状态已渲染');

// 厚度冲突场景（1×3）
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'v', line: 2, dir: 'l' });
assert.equal(ui.plan.steps.length, 1, '厚度冲突步应被拒绝');
assert.ok(els.foldError.textContent.includes('厚度不一致'));
assert.ok(ui.replay.error.code === 'thickness');
assert.deepEqual(ui.replay.error.conflicts, ['2,0', '1,0']);

// ---------- 自动拼版 ----------
// 非法折叠场景：生成被禁用。被拒绝的折法不会写入步骤，因此这里直接置入
// 一条非法步骤（等价于导入含非法折叠的方案）后重渲染。
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });   // 1 层压向 2 层：厚度冲突
ui.render();
assert.equal(ui.imposition.eligible.ok, false);
assert.equal(ui.imposition.eligible.code, 'thickness');
assert.equal(els.imposePreviewBtn.disabled, true);
assert.ok(els.imposeStatus.textContent.includes('禁用生成'));
ui.plan.steps.pop();   // 恢复为只有合法首步的状态

// 未收成单叠场景（2×3 只折一次）
els.rowsInput.value = '2'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(ui.imposition.eligible.ok, false);
assert.equal(ui.imposition.eligible.code, 'not_single_stack');
assert.equal(els.imposePreviewBtn.disabled, true);

// 合法 2×2 折帖：v1 右折 + h1 下折，收成 8 面单叠
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
assert.equal(ui.imposition.eligible.ok, true);
assert.equal(ui.imposition.eligible.capacity, 8);
assert.equal(els.imposePreviewBtn.disabled, false);

// 页数超出容量：引擎拒绝，不出预览
els.imposeStart.value = '1';
els.imposeCount.value = '9';
els.imposePreviewBtn.dispatch('click');
assert.equal(ui.imposition.result, null);
assert.ok(els.imposeStatus.textContent.includes('超出纸格总面数'));
assert.equal(els.imposePreview.hidden, true);

// 生成预览：不得直接改动当前标注
els.imposeCount.value = '8';
els.imposePreviewBtn.dispatch('click');
assert.ok(ui.imposition.result && ui.imposition.result.ok);
assert.deepEqual(ui.plan.labels, {}, '预览阶段标注不得被修改');
assert.equal(els.imposePreview.hidden, false);
assert.equal(ui.imposition.result.blankTrailing, 0);

// 确认写入后：阅读序列为连续 1..8，反向映射正确（1×2 例与手工标注一致）
els.imposeConfirmBtn.dispatch('click');
const imposedSeq = FE.pageSequence(ui.replay.state).stacks[0].sequence;
assert.deepEqual(imposedSeq, ['1', '2', '3', '4', '5', '6', '7', '8']);
assert.deepEqual(ui.plan.labels['0,1'], { front: '6', back: '3' });

// 部分页数 4：末尾 4 槽空白，被空白的面在预览中可定位
ui.plan.labels = {};
ui.render();
els.imposeCount.value = '4';
els.imposePreviewBtn.dispatch('click');
assert.equal(ui.imposition.result.blankTrailing, 4);
const blankSlots = ui.imposition.result.slots.filter((s) => s.blank);
assert.equal(blankSlots.length, 4);
assert.ok(blankSlots.every((s) => s.origin && s.face));

// 现有标注非空：确认前覆盖汇总非空（confirm 在桩中返回 false，不会误写入）
ui.plan.labels = { '0,0': { front: '99', back: '98' } };
ui.render();
els.imposePreviewBtn.dispatch('click');
assert.equal(els.imposeOverwrite.hidden, false);
assert.ok(els.imposeOverwrite.textContent.includes('0,0'));
els.imposeConfirmBtn.dispatch('click');
assert.equal(ui.plan.labels['0,0'].front, '99', '未确认时不得覆盖现有标注');

// 确认后旧预览作废：再改回干净标注、重新确认（绕过 confirm 直接调用）
ui.plan.labels = {};
ui.render();
els.imposeCount.value = '8';
els.imposePreviewBtn.dispatch('click');
ui.confirmImposition();   // 无现有标注，不弹确认框
assert.deepEqual(FE.pageSequence(ui.replay.state).stacks[0].sequence,
  ['1', '2', '3', '4', '5', '6', '7', '8']);

// ---------- 双面印刷版预览 ----------
// 合法 2×2 折帖 + 已确认拼版标注：预览按钮可用
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
assert.equal(els.duplexOpenBtn.disabled, false);

// 长边版：正面不镜像、背面左右镜像；格位旋转与引擎朝向一致
ui.openDuplex();
assert.equal(els.duplexOverlay.hidden, false);
let plate = ui.duplex.result;
assert.equal(plate.flip, 'long');
assert.equal(plate.front.grid[0][0].origin, '0,0');
assert.equal(plate.back.grid[0][0].origin, '1,0');
assert.equal(plate.back.grid[0][1].origin, '0,0');
assert.equal(plate.back.grid[1][0].origin, '1,1');
assert.equal(plate.front.edge, 'right');
assert.equal(plate.back.edge, 'left');
// frame.y.y<0 的格（如 0,0 / 1,0）正面版旋转 180°；0,1 / 1,1 不转
assert.equal(plate.front.grid[0][0].rotate, 180);
assert.equal(plate.front.grid[0][1].rotate, 180);
assert.equal(plate.front.grid[1][0].rotate, 0);
assert.equal(plate.front.grid[1][1].rotate, 0);
assert.ok(plate.front.grid.flat().every((c) => c.face === 'front'));
assert.ok(plate.back.grid.flat().every((c) => c.face === 'back'));
// 长边反面版与正面版旋转规则相同
assert.equal(plate.back.grid[0][0].rotate, 180);
assert.equal(plate.back.grid[1][1].rotate, 0);

// 切短边：改为上下镜像、翻面边变为横边
els.duplexFlipOverlay.value = 'short';
els.duplexFlipOverlay.dispatch('change', { target: els.duplexFlipOverlay });
plate = ui.duplex.result;
assert.equal(plate.flip, 'short');
assert.equal(plate.back.grid[0][0].origin, '0,1');
assert.equal(plate.back.grid[0][1].origin, '1,1');
assert.equal(plate.back.grid[1][0].origin, '0,0');
assert.equal(plate.back.grid[1][1].origin, '1,0');
assert.equal(plate.front.edge, 'top');
assert.equal(plate.back.edge, 'bottom');
// 短边反面版旋转规则与长边相反：0,0 在长边为 180°，短边为 0°
assert.equal(plate.back.grid[1][0].rotate, 0);
assert.equal(plate.back.grid[0][1].rotate, 180);
assert.equal(plate.front.grid[0][0].rotate, 180, '正面版旋转不随翻面方式变化');
ui.closeDuplex();
assert.equal(els.duplexOverlay.hidden, true);

// 未收成单叠时禁用并说明原因
els.rowsInput.value = '2'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(els.duplexOpenBtn.disabled, true);
assert.ok(/尚未收成单叠/.test(els.duplexStatus.textContent));

// 非法折叠时禁用并给出原因（厚度冲突）
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });
ui.renderDuplex();
assert.equal(els.duplexOpenBtn.disabled, true);
assert.ok(/禁用预览/.test(els.duplexStatus.textContent));

// 打开预览后方案被改坏 → 自动关闭
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
ui.openDuplex();
assert.equal(els.duplexOverlay.hidden, false);
ui.plan.steps.push({ axis: 'v', line: 1, dir: 'r' });
ui.renderDuplex();
assert.equal(els.duplexOverlay.hidden, true);

// ---------- 折手自动寻路 ----------
// 干净 2×2：寻路按钮可用，目标 (1,0) 反面 → 2 步最短，给出 ≤3 条等长方案
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
assert.equal(ui.plan.rows, 2);
assert.equal(els.pathSearchBtn.disabled, false);
els.pathCell.value = '1,0';
els.pathFace.value = 'back';
ui.doPathfindSearch();
assert.ok(ui.pathfind.result && ui.pathfind.result.solved, '寻路应成功');
assert.equal(ui.pathfind.result.depth, 2);
assert.ok(ui.pathfind.result.solutions.length >= 2);
assert.ok(ui.pathfind.result.solutions.length <= 3);
for (const sol of ui.pathfind.result.solutions) assert.equal(sol.steps.length, 2);
assert.ok(/最短/.test(els.pathStatus.textContent));
assert.equal(els.pathResults.hidden, false);

// 追加任一方案到当前步骤：进入末态回放，收成单叠、封面正确
const firstSol = ui.pathfind.result.solutions[0];
const before = ui.plan.steps.length;
ui.appendPathSolution(firstSol);
assert.equal(ui.plan.steps.length, before + 2);
assert.equal(ui.upto, ui.plan.steps.length);
const finalCells = Object.keys(ui.replay.state.stacks);
assert.equal(finalCells.length, 1);
const topPanel = ui.replay.state.panels[ui.replay.state.stacks[finalCells[0]][0]];
assert.equal(topPanel.ox + ',' + topPanel.oy, '1,0');
assert.ok(topPanel.frame.n.z < 0);
assert.equal(ui.pathfind.result, null, '追加后旧寻路结果作废');

// 无解目标（正面封面）：状态文字提示“无解”，不展示方案
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
els.pathCell.value = '0,0';
els.pathFace.value = 'front';
ui.doPathfindSearch();
assert.equal(ui.pathfind.result.solved, false);
assert.equal(ui.pathfind.result.reason, 'no_solution');
assert.ok(els.pathStatus.textContent.includes('无解'));
assert.equal(els.pathResults.hidden, true);

// 超过 4×4：搜索按钮禁用并给出原因
els.rowsInput.value = '3'; els.colsInput.value = '5';
els.createGridBtn.dispatch('click');
assert.equal(ui.plan.cols, 5, '输入框 5 在 1..12 范围内应被接受');
ui.renderPathfind();
assert.equal(els.pathSearchBtn.disabled, true);
assert.ok(els.pathStatus.textContent.includes('4×4'));

// 前缀非法折叠时寻路禁用
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'v', line: 2, dir: 'l' });   // 厚度冲突，被拒绝
assert.equal(ui.plan.steps.length, 1);
// 只有 1 步合法，末态合法可寻路；制造一个真正的非法前缀：直接塞入非法步
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });
ui.renderPathfind();
assert.equal(els.pathSearchBtn.disabled, true);
assert.ok(/非法/.test(els.pathStatus.textContent));

// ---------- 面片轨迹 ----------
// 干净 2×2 折帖（v1 右折 + h1 下折），追踪原格 0,0 的正面
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
els.trackCell.value = '0,0';
els.trackFace.value = 'front';
ui.renderTrack('0,0', 'front');
assert.ok(ui.track.result && ui.track.result.ok, '轨迹应计算成功');
assert.equal(ui.track.result.completed, true);
assert.equal(ui.track.result.interrupted, null);
assert.equal(ui.track.result.points.length, 3);
assert.deepEqual(ui.track.result.points.map((p) => p.cell), ['0,0', '1,0', '1,1']);
assert.deepEqual(ui.track.result.points.map((p) => [p.layer, p.depth]), [[1, 1], [1, 2], [2, 4]]);
assert.deepEqual(ui.track.result.points.map((p) => p.faceUp), [true, false, true]);
assert.deepEqual(ui.track.result.points.map((p) => p.upright), [true, true, false]);
assert.equal(els.trackTimeline.hidden, false);
assert.ok(/中断/.test(els.trackStatus.textContent) === false);

// 点击第 1 步节点：联动既有回放定位，画布上按原始身份高亮该片
ui.jumpTrackPoint(1);
assert.equal(ui.upto, 1);
const info1 = ui.currentTrackInfo(ui.replay.state);
assert.equal(info1.id, '0,0');
assert.equal(info1.cell, '1,0');
assert.equal(info1.layer, 1);
assert.equal(info1.depth, 2);
// 末步节点：该片已合并入终叠第二层
ui.jumpTrackPoint(2);
const info2 = ui.currentTrackInfo(ui.replay.state);
assert.equal(info2.cell, '1,1');
assert.equal(info2.layer, 2);
assert.equal(info2.depth, 4);
assert.deepEqual(Object.keys(ui.replay.state.stacks), ['1,1']);

// 切到反面追踪：第 1 步反面朝上
ui.renderTrack('0,0', 'back');
assert.equal(ui.track.target.face, 'back');
assert.deepEqual(ui.track.result.points.map((p) => p.faceUp), [false, true, false]);

// 网格、标注或步骤变化后自动重算（标注变化页码随之更新）
ui.plan.labels = { '0,0': { front: '4', back: '1' } };
ui.renderTrack();
assert.equal(ui.track.result.target.face, 'back');
assert.equal(ui.track.result.points[0].label, '1');   // 标签随面片身份携带
assert.equal(ui.track.result.points[1].label, '1');

// 首个非法步骤：保留此前节点并标明中断原因
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.plan.steps.push({ axis: 'v', line: 1, dir: 'r' });   // 合法：0 列叠入 1 列（2 层）
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });   // 1 层压向 2 层：厚度冲突
ui.renderTrack('0,0', 'front');
assert.equal(ui.track.result.completed, false);
assert.deepEqual(ui.track.result.points.map((p) => p.step), [0, 1]);
assert.equal(ui.track.result.interrupted.stepIndex, 1);
assert.equal(ui.track.result.interrupted.code, 'thickness');
assert.deepEqual(ui.track.result.interrupted.conflicts, ['2,0', '1,0']);
assert.ok(/中断/.test(els.trackStatus.textContent));
// 回放在非法步时：节点定位到中断前最后一步，画布里身份仍可追踪
ui.setUpto(2, true);
assert.ok(ui.replay.error, '回放在非法步应带错误');
const stalledInfo = ui.currentTrackInfo(ui.replay.state);
assert.equal(stalledInfo.cell, '1,0');
assert.equal(stalledInfo.depth, 2);
ui.jumpTrackPoint(0);
assert.equal(ui.upto, 0);
assert.equal(ui.currentTrackInfo(ui.replay.state).cell, '0,0');

// 目标非法（网格切换后旧选择失效由下拉重建兜底；直接构造越界）
const badTarget = FE.trackPanel(1, 3, {}, [], { cell: '9,9', face: 'front' });
assert.equal(badTarget.ok, false);
assert.equal(badTarget.code, 'bad_target');

// ---------- 生产质量审计 ----------
// 干净 1×2 折帖：全部检查通过，结论可发布，可导出报告
els.rowsInput.value = '1'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.plan.labels = { '0,0': { front: '4', back: '1' }, '1,0': { front: '2', back: '3' } };
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(ui.audit.result.ok, true);
assert.equal(ui.audit.result.verdict, 'pass');
assert.equal(ui.audit.result.summary.total, 0);
assert.ok(/可发布/.test(els.auditVerdict.textContent));
assert.equal(els.auditExportBtn.disabled, false);
assert.equal(els.auditFindings.hidden, false);
ui.exportAudit();   // 桩环境（Blob/URL/click 已桩）下不抛错
assert.ok(/审计报告/.test(els.saveMsg.textContent));

// 重复 + 空白 + 未覆盖 + 倒置：结论需修订，分级结果入列
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.plan.labels = {
  '0,0': { front: '1', back: '2' },
  '1,0': { front: '1', back: '' }   // 与 0,0 正面重复；反面空白；0,1 / 1,1 整格未覆盖
};
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
assert.equal(ui.audit.result.ok, true);
assert.equal(ui.audit.result.verdict, 'fail');
const auditIds = new Set(ui.audit.result.findings.map((f) => f.id));
assert.ok(auditIds.has('duplicate_page'));
assert.ok(auditIds.has('blank_page'));
assert.ok(auditIds.has('uncovered_cell'));
assert.ok(auditIds.has('inverted_page'));
assert.ok(/需修订/.test(els.auditVerdict.textContent));
assert.ok(/错误/.test(els.auditStatus.textContent));

// ---------- 审计问题簇：只读派生视图 ----------
assert.ok(ui.audit.clusters.length > 0, '重算后应形成问题簇');
assert.ok(ui.audit.clusters.every((c) => /^C\d+$/.test(c.id)), '簇编号为 C<n>');
assert.ok(ui.audit.clusters.some((c) => c.ruleId === 'inverted_page'),
  '同一规则相邻槽位/共享原格的倒置结果应合并成簇');
assert.ok(ui.audit.clusters.every((c) => c.members.length === c.memberCount));
// 簇保留成员严重级别、槽位与说明
const invCluster = ui.audit.clusters.find((c) => c.ruleId === 'inverted_page');
assert.ok(invCluster.members.every((m) =>
  m.severity === 'error' && m.slot > 0 && m.cell && m.message));
assert.equal(invCluster.severity, 'error', '簇严重级别取成员最高级别');

// 切到簇视图：簇列表显示、逐条列表隐藏
ui.setAuditView('clusters');
assert.equal(els.auditClusters.hidden, false);
assert.equal(els.auditFindings.hidden, true);

// 严重级别筛选：仅错误时警告簇被过滤
els.auditClusterSeverity.value = 'error';
els.auditClusterSeverity.dispatch('change', { target: els.auditClusterSeverity });
const visibleIds = els.auditClusters.__children.map((li) => li.dataset.clusterId);
assert.ok(visibleIds.length > 0);
assert.ok(visibleIds.every((id) =>
  ui.audit.clusters.find((c) => c.id === id).severity === 'error'),
  '仅错误筛选下不出现警告簇');
els.auditClusterSeverity.value = 'all';
els.auditClusterSeverity.dispatch('change', { target: els.auditClusterSeverity });

// 点簇联动：选中簇 → 画布映射命中其全部受影响原格；再点取消
const target = ui.audit.clusters.find((c) => c.ruleId === 'inverted_page');
ui.selectAuditCluster(target.id);
assert.equal(ui.selectedAuditCluster().id, target.id);
const amap = ui.currentAuditClusterMap(ui.replay.state);
const highlighted = new Set([...amap.values()].flatMap((e) => [...e.origins]));
for (const cell of target.cells) assert.ok(highlighted.has(cell), `簇原格 ${cell} 应高亮`);
ui.selectAuditCluster(target.id);
assert.equal(ui.selectedAuditCluster(), null);

// 编号复用：重算（计划未变）后簇 id 保持不变
const beforeIds = ui.audit.clusters.map((c) => c.id + ':' + c.memberKeys.join(','));
ui.render();
const afterIds = ui.audit.clusters.map((c) => c.id + ':' + c.memberKeys.join(','));
assert.deepEqual(afterIds, beforeIds, '同内容重算簇编号稳定');

// 成员变化：给四成员空白簇中的 0,1 正面补页码 → 簇存活、编号复用并报移除成员
const blankBefore = ui.audit.clusters.find((c) =>
  c.ruleId === 'blank_page' && c.cells.includes('0,1') && c.cells.includes('1,1'));
assert.ok(blankBefore, '修改前存在含 0,1/1,1 的四成员空白簇');
const beforeCount = blankBefore.memberCount;
ui.plan.labels['0,1'] = { front: '6', back: '' };
ui.render();
const sameBlank = ui.audit.clusters.find((c) => c.id === blankBefore.id);
assert.ok(sameBlank, '仍有存活成员的同身份簇应复用旧编号');
assert.equal(sameBlank.memberCount, beforeCount - 1);
assert.ok(sameBlank.removed.some((m) => m.cell === '0,1' && m.face === 'front'),
  '消失成员应在 removed 中列出');
// 簇内剩余成员经相邻槽位/共享原格仍连成一簇，未被错误拆散
assert.deepEqual(sameBlank.cells.sort(), ['0,1', '1,1']);

ui.setAuditView('findings');

// 非法步骤：审计中止，仅报告首个错误，不展示后续结论
els.rowsInput.value = '1'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.plan.steps.push({ axis: 'v', line: 1, dir: 'r' });   // 合法
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });   // 厚度冲突
ui.render();
assert.equal(ui.audit.result.ok, false);
assert.equal(ui.audit.result.code, 'thickness');
assert.equal(ui.audit.result.stepIndex, 1);
assert.ok(/审计中止/.test(els.auditVerdict.textContent));
assert.ok(/首个错误/.test(els.auditStatus.textContent));
assert.equal(els.auditFindings.hidden, true, '中止时不展示结论列表');

// 修正非法步骤后自动恢复审计
ui.plan.steps.pop();
ui.render();
assert.equal(ui.audit.result.ok, true);

// ---------- 书帖爬移补偿 ----------
// 未创建网格时禁用
els.rowsInput.value = '0'; els.colsInput.value = '2';
// rows 不接受 0（createGrid 钳制到 1）；改用未收成单叠场景验证禁用原因
els.rowsInput.value = '2'; els.colsInput.value = '3';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.equal(els.creepApplyBtn.disabled, true);
assert.ok(/尚未收成单叠/.test(els.creepStatus.textContent));
assert.equal(els.creepTableWrap.hidden, true);

// 非法折叠时禁用并说明
ui.plan.steps.push({ axis: 'v', line: 2, dir: 'l' });
ui.renderCreep();
assert.equal(els.creepApplyBtn.disabled, true);
assert.ok(/非法折叠/.test(els.creepStatus.textContent));
ui.plan.steps.pop();

// 合法 2×2 折帖：逐叶明细、最大补偿 0.3，均可应用
els.rowsInput.value = '2'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
els.creepThickness.value = '0.1';
els.creepBleed.value = '3';

// 捕获 #creepRows 动态 appendChild 的行节点（桩默认 appendChild 为空操作）
const creepTableRowSnapshots = () => (els.creepRows.__children || [])
  .map((tr) => ({ className: tr.className, textContent: tr.textContent }));
els.creepRows.__children = [];
els.creepRows.appendChild = (tr) => { els.creepRows.__children.push(tr); };
// app.js 每次重渲染先 tbody.innerHTML=''：让 innerHTML setter 顺带清空捕获
const desc = Object.getOwnPropertyDescriptor(els.creepRows, 'innerHTML');
Object.defineProperty(els.creepRows, 'innerHTML', {
  configurable: true,
  get: desc.get,
  set(v) { desc.set.call(els.creepRows, v); els.creepRows.__children = []; }
});
ui.renderCreep();
assert.ok(ui.creep.result && ui.creep.result.ok);
assert.equal(ui.creep.result.leafCount, 4);
assert.equal(ui.creep.result.maxCompensation, 0.3);
assert.deepEqual(ui.creep.result.leaves.map((l) => l.creep), [0, 0.1, 0.2, 0.3]);
assert.equal(els.creepApplyBtn.disabled, false);
assert.equal(els.creepTableWrap.hidden, false);
assert.ok(/书脊/.test(els.creepSummary.textContent));
// 逐叶明细 4 行已挂入表体，且行 class 包含层序/中缝标记
{
  const rows = creepTableRowSnapshots();
  assert.equal(rows.length, 4);
  assert.ok(rows[0].className.includes('leaf-cover'));
  assert.ok(rows[3].className.includes('leaf-center'));
  assert.ok(rows.every((r) => /格\(/.test(r.textContent)));
  assert.ok(rows[3].textContent.includes('0.3'));
}

// 参数输入实时重算：纸厚变化 -> 最大补偿变化
els.creepThickness.dispatch('input');
els.creepThickness.value = '0.2';
ui.renderCreep();
assert.equal(ui.creep.result.maxCompensation, 0.6);

// 出血不足：标红对应原始纸格两面并禁用应用
els.creepBleed.value = '0.05';
ui.renderCreep();
assert.equal(ui.creep.result.canApply, false);
assert.equal(els.creepApplyBtn.disabled, true);
assert.ok(/超过可用出血/.test(els.creepStatus.textContent));
{
  // 补偿 0.1/0.2/0.3 的内三叶均超 0.05：对应行带 creep-over 标红 class，最外叶不标
  const rows = creepTableRowSnapshots();
  assert.equal(rows.filter((r) => r.className.includes('creep-over')).length, 3);
  assert.ok(!rows[0].className.includes('creep-over'));
  assert.ok(rows.some((r) => /超出血/.test(r.textContent)));
}

// 参数非法：禁用并提示
els.creepThickness.value = '-1';
ui.renderCreep();
assert.equal(els.creepApplyBtn.disabled, true);
assert.ok(/禁用应用/.test(els.creepStatus.textContent));

// 恢复合法参数后应用：写入独立方案字段，清除按钮出现
els.creepThickness.value = '0.1';
els.creepBleed.value = '3';
ui.renderCreep();
assert.equal(els.creepApplyBtn.disabled, false);
els.creepApplyBtn.dispatch('click');
assert.ok(ui.plan.creepCompensation, '应用后应写入 creepCompensation 独立字段');
assert.equal(ui.plan.creepCompensation.params.paperThickness, 0.1);
assert.equal(ui.plan.creepCompensation.params.bleed, 3);
assert.equal(ui.plan.creepCompensation.maxCompensation, 0.3);
assert.deepEqual(Object.keys(ui.plan.creepCompensation.faces).sort(),
  ['0,0', '0,1', '1,0', '1,1']);
assert.equal(els.creepClearBtn.hidden, false);
assert.ok(/已应用/.test(els.creepApplied.textContent));
assert.ok(ui.plan.creepCompensation.basis.stepsSignature.length > 0);

// 保存载荷含独立字段
assert.ok(JSON.stringify(ui.plan).includes('creepCompensation'));

// 应用后参数变化：字段保留但提示过期，实时明细仍重算
els.creepThickness.value = '0.15';
ui.renderCreep();
assert.ok(ui.plan.creepCompensation, '过期不清空已应用字段');
assert.ok(/不一致/.test(els.creepApplied.textContent), '过期应标黄提示重新应用');

// 清除：删除独立字段
els.creepThickness.value = '0.1';
ui.renderCreep();
els.creepClearBtn.dispatch('click');
assert.equal(ui.plan.creepCompensation, undefined);
assert.equal(els.creepClearBtn.hidden, true);

// 导入含爬移字段的方案：参数回填、字段保留（经 normalizePlan 规整）
ui.applyPlan({
  name: '爬移载入', rows: 1, cols: 2, labels: {},
  steps: [{ axis: 'v', line: 1, dir: 'r' }],
  creepCompensation: {
    params: { paperThickness: 0.25, bleed: 2.5 },
    spineAxis: 'vertical', spineSide: 'left', maxCompensation: 0.25,
    faces: { '0,0': { front: 0, back: 0, axis: 'x', creep: 0 },
             '1,0': { front: 0.25, back: -0.25, axis: 'x', creep: 0.25 } },
    basis: { rows: 1, cols: 2, stepsSignature: 'old' },
    appliedAt: '2026-09-22T00:00:00Z'
  }
}, null);
assert.ok(ui.plan.creepCompensation);
assert.equal(els.creepThickness.value, '0.25');
assert.equal(els.creepBleed.value, '2.5');
assert.equal(ui.plan.creepCompensation.faces['1,0'].front, 0.25);

// ---------- 标签与备注 ----------
// 新建网格会清空标签与备注
els.rowsInput.value = '1'; els.colsInput.value = '2';
els.createGridBtn.dispatch('click');
ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
assert.deepEqual(ui.plan.tags, []);
assert.equal(els.planNote.value, '');
assert.equal(els.tagCountHint.textContent, '0 / 8 个标签');

// 添加标签：trim 规范化；重复项被拒；chip 渲染到标签区
assert.equal(ui.addTag(' 骑马钉 '), true);
assert.equal(ui.plan.tags[0], '骑马钉');
assert.equal(ui.addTag('骑马钉'), false, '规范化后重复标签应被拒');
assert.equal(ui.addTag('A4'), true);
assert.equal(els.tagCountHint.textContent, '2 / 8 个标签');
assert.equal(els.tagChips.__children.length, 2);

// 非法标签：空、超长、含分隔符 / 控制字符一律拒绝
assert.equal(ui.addTag('   '), false);
assert.equal(ui.addTag('a'.repeat(21)), false);
assert.equal(ui.addTag('a,b'), false);
assert.equal(ui.addTag('x|y'), false);

// 输入框 + 按钮添加路径
els.tagInput.value = '待复核';
els.tagAddBtn.dispatch('click');
assert.deepEqual(ui.plan.tags, ['骑马钉', 'A4', '待复核']);
assert.equal(els.tagInput.value, '', '添加成功后输入框清空');

// 删除单个标签、清除全部
ui.removeTag('A4');
assert.deepEqual(ui.plan.tags, ['骑马钉', '待复核']);
els.tagClearBtn.dispatch('click');
assert.deepEqual(ui.plan.tags, []);

// 超过 8 个标签被拒
for (let i = 0; i < 8; i++) ui.addTag('标签' + i);
assert.equal(ui.plan.tags.length, 8);
assert.equal(ui.addTag('第9个'), false);
assert.ok(/最多 8 个标签/.test(els.saveMsg.textContent));

// 保存载荷含标签与备注；严格元信息校验在本地拦截非法请求（不发出请求）
els.planNote.value = '用于首件确认';
ui.plan.name = '标签冒烟方案';
const payload = ui.planPayload();
assert.deepEqual(payload.tags, ['标签0', '标签1', '标签2', '标签3', '标签4', '标签5', '标签6', '标签7']);
assert.equal(payload.note, '用于首件确认');

const callsBefore = fetchCalls.length;
ui.plan.tags.push('a,b');
els.saveBtn.dispatch('click');
assert.equal(fetchCalls.length, callsBefore, '非法标签不得发出保存请求');
assert.ok(/保存被拒绝/.test(els.saveMsg.textContent));
ui.plan.tags.pop();

// 备注超长同样本地拒绝
els.planNote.value = 'x'.repeat(501);
els.saveBtn.dispatch('click');
assert.equal(fetchCalls.length, callsBefore, '备注超长不得发出保存请求');
els.planNote.value = '用于首件确认';

// 合法保存：请求体带规范化标签与规范化标签与备注
els.planList.hidden = true;   // 避免保存成功后自动刷新列表干扰 fetch 记录断言
els.saveBtn.dispatch('click');
(async () => {
  await new Promise((r) => setTimeout(r, 0));
  const saveCall = fetchCalls[fetchCalls.length - 1];
  assert.equal(saveCall.method, 'POST');
  assert.deepEqual(saveCall.body.tags, payload.tags);
  assert.equal(saveCall.body.note, '用于首件确认');

  // 载入存档：标签与备注回填
  ui.applyPlan({
    name: '标签载入', rows: 1, cols: 2, labels: {},
    steps: [{ axis: 'v', line: 1, dir: 'r' }],
    tags: ['骑马钉', ' A4 ', '骑马钉', ''], note: '  复核备注  '
  }, 'id-tags');
  assert.deepEqual(ui.plan.tags, ['骑马钉', 'A4'], '导入路径对标签做宽容规整去重');
  assert.equal(els.planNote.value, '复核备注');
  assert.equal(els.tagCountHint.textContent, '2 / 8 个标签');

  // 列表筛选：设置条件后拉取，请求 query 含标签交集 / 关键词 / since
  els.filterTags.value = '骑马钉,A4';
  els.filterQ.value = '骑马';
  els.filterSince.value = '86400000';
  els.filterApplyBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  const listCall = fetchCalls[fetchCalls.length - 1];
  assert.match(listCall.url, /tags=/);
  assert.match(listCall.url, /q=/);
  assert.match(listCall.url, /since=/);
  assert.equal(els.planFilter.hidden, false);
  assert.ok(/筛选命中/.test(els.planFilterMsg.textContent));

  // 清除筛选：再次拉取不带 query
  els.filterResetBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  const resetCall = fetchCalls[fetchCalls.length - 1];
  assert.equal(resetCall.url, '/api/plans');
  assert.deepEqual(ui.listFilter, { tags: '', q: '', since: '' });

  // ---------- 校样批注 ----------
  // 干净 2×2 折帖（v1 右折 + h1 下折）
  els.rowsInput.value = '2'; els.colsInput.value = '2';
  els.createGridBtn.dispatch('click');
  ui.requestStep({ axis: 'v', line: 1, dir: 'r' });
  ui.requestStep({ axis: 'h', line: 1, dir: 'd' });
  assert.deepEqual(ui.plan.annotations, []);

  // 在第 1 步为原格 0,0 正面新建批注
  ui.setUpto(1, true);
  ui.openAnnotationEditor('0,0', 'front');
  assert.equal(els.annoEditor.hidden, false);
  assert.ok(els.annoEditorTarget.textContent.includes('0,0'));
  assert.ok(els.annoStepText.textContent.includes('第 1 / 2 步'));
  els.annoSeverity.value = 'error';
  els.annoText.value = '封面套印偏差';
  els.annoSaveBtn.dispatch('click');
  assert.equal(els.annoEditor.hidden, true);
  assert.equal(ui.plan.annotations.length, 1);
  const anno1 = ui.plan.annotations[0];
  assert.equal(anno1.cell, '0,0');
  assert.equal(anno1.face, 'front');
  assert.equal(anno1.severity, 'error');
  assert.equal(anno1.text, '封面套印偏差');
  assert.equal(anno1.step, 1);
  assert.equal(anno1.resolved, false);
  assert.equal(ui.annotation.selectedId, anno1.id);

  // 末步再为原格 1,1 反面加一条建议级批注
  ui.setUpto(2, true);
  ui.openAnnotationEditor('1,1', 'back');
  els.annoSeverity.value = 'info';
  els.annoText.value = '建议加大出血';
  els.annoSaveBtn.dispatch('click');
  assert.equal(ui.plan.annotations.length, 2);
  const anno2 = ui.plan.annotations[1];

  // 画布标记：末态两条批注都聚到终叠 (1,1)，且分属正/反两面
  ui.renderAnnotations();
  let marks = ui.currentAnnotationMarks(ui.replay.state);
  assert.deepEqual([...marks.keys()], ['1,1']);
  const slot = marks.get('1,1');
  assert.equal(slot.faces.front.length, 1);
  assert.equal(slot.faces.back.length, 1);
  assert.equal(slot.faces.front[0].id, anno1.id);

  // 切回第 0 步：批注按原始身份回到各自初始格位（不依赖批注创建步）
  ui.setUpto(0, true);
  marks = ui.currentAnnotationMarks(ui.replay.state);
  assert.ok(marks.has('0,0'));
  assert.ok(marks.has('1,1'));

  // 截断步骤后批注仍可定位（只保留第 1 步：0,0 在 1,0）
  ui.plan.steps = ui.plan.steps.slice(0, 1);
  ui.setUpto(1, true);
  marks = ui.currentAnnotationMarks(ui.replay.state);
  assert.ok(marks.has('1,0'), '0,0 经竖折位于 1,0');
  assert.ok(marks.has('1,1'), '1,1 未参与首折仍在原位');

  // 恢复完整折法
  ui.plan.steps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'h', line: 1, dir: 'd' }
  ];
  ui.setUpto(2, true);

  // 定位接口（本地引擎）：格位 / 层序 / 面朝向
  const loc = ui.annotationLocations();
  assert.equal(loc.ok, true);
  const p1 = loc.points.find((p) => p.id === anno1.id);
  assert.equal(p1.at, '1,1');
  assert.equal(p1.layer, 2);
  assert.equal(p1.faceUp, true);

  // 筛选：仅未解决 → 2 条；把 anno2 标记解决后仅 1 条
  els.annoOpenOnly.checked = true;
  ui.renderAnnotations();
  assert.ok(/未解决 2/.test(els.annoStatus.textContent));
  ui.setAnnotationResolved(anno2.id, true);
  assert.equal(ui.plan.annotations[1].resolved, true);
  assert.equal(typeof ui.plan.annotations[1].resolvedAt, 'string');
  ui.renderAnnotations();
  assert.ok(/未解决 1/.test(els.annoStatus.textContent));
  assert.ok(/已解决 1/.test(els.annoStatus.textContent));

  // 级别筛选 + 面别筛选（桩环境通过渲染出的列表子节点 class 验证）
  const renderedItems = () => (els.annoList.__children || [])
    .filter((n) => n.className && n.className.includes('anno-item'));
  els.annoOpenOnly.checked = false;
  els.annoSeverityFilter.value = 'error';
  ui.renderAnnotations();
  assert.equal(renderedItems().length, 1);
  assert.ok(renderedItems()[0].className.includes('sev-error'));
  els.annoSeverityFilter.value = '';
  els.annoFaceFilter.value = 'back';
  ui.renderAnnotations();
  assert.equal(renderedItems().length, 1);
  els.annoFaceFilter.value = '';

  // 恢复（取消解决）：resolvedAt 被移除
  ui.setAnnotationResolved(anno2.id, false);
  assert.equal(ui.plan.annotations[1].resolved, false);
  assert.equal(ui.plan.annotations[1].resolvedAt, undefined);

  // 编辑已解决批注的正文 → 自动恢复为未解决
  ui.setAnnotationResolved(anno1.id, true);
  ui.openAnnotationEditor(null, null, anno1.id);
  assert.equal(els.annoDeleteBtn.hidden, false);
  els.annoText.value = '封面套印偏差（已复测）';
  els.annoSaveBtn.dispatch('click');
  const edited = ui.plan.annotations.find((a) => a.id === anno1.id);
  assert.equal(edited.text, '封面套印偏差（已复测）');
  assert.equal(edited.resolved, false, '内容修改后自动恢复为未解决');
  assert.equal(edited.createdAt, anno1.createdAt, '创建时间保留');

  // 空正文：前端严格校验拦截，不写入
  ui.openAnnotationEditor('0,0', 'back');
  els.annoText.value = '   ';
  els.annoSaveBtn.dispatch('click');
  assert.equal(els.annoEditor.hidden, false);
  assert.equal(ui.plan.annotations.length, 2);
  els.annoCancelBtn.dispatch('click');

  // 删除编辑中的批注
  ui.openAnnotationEditor(null, null, anno2.id);
  els.annoDeleteBtn.dispatch('click');
  assert.equal(ui.plan.annotations.length, 1);

  // 保存载荷含批注；本地严格校验通过
  const annoPayload = ui.planPayload();
  assert.equal(annoPayload.annotations.length, 1);
  assert.equal(annoPayload.annotations[0].id, anno1.id);

  // 保存：批注进入 POST 请求体并被服务端桩回填
  els.planList.hidden = true;
  els.saveBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  const annoSaveCall = fetchCalls[fetchCalls.length - 1];
  assert.equal(annoSaveCall.method, 'POST');
  assert.equal(annoSaveCall.body.annotations.length, 1);

  // 新建网格清空批注
  els.rowsInput.value = '1'; els.colsInput.value = '2';
  els.createGridBtn.dispatch('click');
  assert.deepEqual(ui.plan.annotations, []);

  // 导入含批注的方案（宽容规整：坏条目丢弃、非法级别降级）
  ui.applyPlan({
    name: '批注载入', rows: 2, cols: 2, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'h', line: 1, dir: 'd' }
    ],
    annotations: [
      { cell: '0,0', face: 'front', severity: 'error', text: '导入批注', step: 0 },
      { cell: '9,9', face: 'front', text: '越界应丢弃' },
      { cell: '1,0', face: 'side', text: '坏面别应丢弃' },
      { cell: '1,0', face: 'back', severity: 'fatal', text: ' 降级为建议 ' }
    ]
  }, null);
  assert.equal(ui.plan.annotations.length, 2);
  assert.equal(ui.plan.annotations[0].text, '导入批注');
  assert.equal(ui.plan.annotations[1].severity, 'info');
  assert.ok(/批注 2 条/.test(els.saveMsg.textContent));
  // 载入后标记按末态定位
  marks = ui.currentAnnotationMarks(ui.replay.state);
  assert.deepEqual([...marks.keys()], ['1,1']);

  // ---------- 版本差异审阅 ----------
  // 准备一个已保存三次的服务器存档（桩 fetch 会为每次 POST 生成递增快照）
  els.rowsInput.value = '1'; els.colsInput.value = '2';
  els.createGridBtn.dispatch('click');
  assert.equal(els.reviewVersionsBtn.disabled, true, '新建网格后审阅入口禁用');

  // 以固定 id 走三版保存
  ui.applyPlan({
    name: '审阅方案', rows: 1, cols: 2,
    labels: {}, steps: [{ axis: 'v', line: 1, dir: 'r' }]
  }, 'review-plan');
  assert.equal(els.reviewVersionsBtn.disabled, false, '载入服务器存档后审阅入口可用');
  els.saveBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  // v2：追加页码 + 标签
  ui.plan.labels = { '1,0': { front: '2', back: '3' } };
  ui.addTag('骑马钉');
  els.saveBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  // v3：批注
  ui.openAnnotationEditor('0,0', 'front');
  els.annoSeverity.value = 'error';
  els.annoText.value = '封面问题';
  els.annoSaveBtn.dispatch('click');
  assert.equal(ui.plan.annotations.length, 1);
  els.saveBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  // 打开审阅：拉取版本列表并默认比较倒数第二版 -> 最新版
  await ui.openReview();
  assert.equal(els.reviewOverlay.hidden, false);
  assert.equal(ui.review.versions.length, 3);
  assert.ok(ui.review.diff, '默认两版本应自动计算差异');
  assert.ok(ui.review.diff.summary.total > 0);
  // v2 -> v3 的差异含新增批注；高亮纸格至少包含批注原格 0,0
  assert.ok(ui.review.diff.annotations.some((e) => e.kind === 'add' && e.cell === '0,0'));
  assert.ok(ui.review.highlightCells.includes('0,0'));

  // 显式比较 v1 -> v2：页码新增 + 标签新增
  els.reviewFromSel.value = '1';
  els.reviewToSel.value = '2';
  ui.onReviewSelectChange();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ui.review.fromV, 1);
  assert.equal(ui.review.toV, 2);
  assert.ok(ui.review.diff.labels.some((e) => e.cell === '1,0' && e.face === 'front' && e.kind === 'add'));
  assert.ok(ui.review.diff.meta.some((e) => e.field === 'tag' && e.kind === 'add'));
  // 画布差异定位映射：1,0 在末态（竖折后）当前格位为 1,0
  const diffMap = ui.currentDiffCellMap(ui.replay.state);
  assert.ok(diffMap.has('1,0') || diffMap.size > 0);

  // 点击页码差异项：进入 v2 只读查看，回放到末步、高亮具体纸格
  const labelEntry = ui.review.diff.labels.find((e) => e.cell === '1,0' && e.face === 'front');
  await ui.focusReviewEntry({ section: 'labels', kind: 'add', entry: labelEntry, cells: ['1,0'] });
  assert.equal(ui.isReviewing(), true);
  assert.equal(ui.review.view.version, 2, '新增类差异查看新版本 B=v2');
  assert.equal(ui.review.highlightCell, '1,0');
  assert.equal(ui.upto, 1);
  assert.ok(els.reviewBanner.hidden === false);

  // 只读守卫：查看历史版本时不能编辑（折叠/标签/批注/保存/建网格均被拦）
  assert.equal(ui.requestStep({ axis: 'h', line: 1, dir: 'd'}), undefined);
  assert.equal(ui.plan.steps.length, 1, '只读查看时不得追加步骤');
  assert.equal(ui.addTag('试图改动'), false);
  const stepsBefore = ui.plan.steps.length;
  ui.setAnnotationResolved(ui.plan.annotations && ui.plan.annotations[0] && ui.plan.annotations[0].id, true);
  assert.equal(ui.plan.steps.length, stepsBefore);

  // 返回差异列表：草稿（含 v3 批注）恢复，未被只读视图污染
  ui.exitVersionView();
  assert.equal(ui.isReviewing(), false);
  assert.equal(ui.plan.annotations.length, 1, '草稿批注应恢复');

  // 删除类差异点击：只读查看旧版本 A=v1（无页码）
  await ui.focusReviewEntry({
    section: 'labels', kind: 'remove',
    entry: { cell: '1,0', face: 'front' }, cells: ['1,0']
  });
  assert.equal(ui.review.view.version, 1);
  assert.equal(Object.keys(ui.plan.labels).length, 0, 'v1 无页码标注');

  // 恢复 v1 为当前草稿（确认弹层）
  ui.askRestoreVersion();
  assert.equal(els.restoreConfirm.hidden, false);
  assert.ok(/v1/.test(els.restoreConfirmText.textContent));
  ui.confirmRestoreVersion();
  assert.equal(els.restoreConfirm.hidden, true);
  assert.equal(ui.isReviewing(), false);
  assert.equal(ui.loadedId, 'review-plan', '恢复沿用同一存档 id，延续版本谱系');
  assert.equal(ui.restoredFrom, 1, '记录恢复来源，下次保存透传');
  assert.deepEqual(ui.plan.tags, [], '草稿内容为 v1');
  assert.equal(ui.plan.annotations.length, 0);

  // 恢复后继续沿用既有保存流程：生成新版本且不覆盖历史（桩中 restoredFrom 透传）
  els.saveBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  const restoreCall = fetchCalls[fetchCalls.length - 1];
  assert.equal(restoreCall.method, 'POST');
  assert.equal(restoreCall.body.restoredFrom, 1);
  assert.equal(ui.restoredFrom, null, '落盘后恢复来源只保留在版本元信息上');

  // 再次打开审阅：历史版本数量增加，旧版本仍可访问
  await ui.openReview();
  assert.ok(ui.review.versions.length >= 4);
  const v1 = ui.review.versions.find((v) => v.version === 1);
  assert.ok(v1, '历史 v1 未被覆盖');
  ui.closeReview();
  assert.equal(els.reviewOverlay.hidden, true);
  assert.equal(ui.review.open, false);

  // 引擎差异函数在未打开审阅时不产生画布高亮
  assert.equal(ui.currentDiffCellMap(ui.replay.state).size, 0);

  console.log('前端冒烟流程全部通过');
})();
