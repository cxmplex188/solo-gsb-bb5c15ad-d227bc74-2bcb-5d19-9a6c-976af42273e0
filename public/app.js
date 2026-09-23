'use strict';
/* global FoldEngine */

const E = FoldEngine;
const CELL = 88;
const PAD = 64;

// ---------- 应用状态 ----------
const app = {
  plan: {
    name: '未命名方案', rows: 0, cols: 0, labels: {}, steps: [],
    tags: [], note: '', annotations: []
  },
  upto: 0,                  // 当前回放到第几步
  replay: null,             // { state, error }
  loadedId: null,
  hitCells: [],             // 画布可点击格位
  hitHandles: [],           // 画布折叠手柄
  hoverHandle: null,
  editingCell: null,
  playTimer: null,
  imposition: { eligible: null, result: null, sig: null },  // 自动拼版状态
  pathfind: { result: null, sig: null, gridKey: null },      // 折手自动寻路状态
  track: { result: null, gridKey: null, target: null },  // 面片轨迹
  duplex: { eligible: null, open: false, flip: 'long', result: null, sig: null },  // 双面印刷版
  audit: {
    result: null,                // 生产质量审计（只读，随方案变化自动重算）
    clusters: [],                // 问题簇（只读派生，按成员 key 稳定复用编号）
    selectedClusterId: null,     // 点选联动画布高亮的簇 id
    severityFilter: 'all',       // 簇列表严重级别筛选
    view: 'findings',            // findings=逐条问题 / clusters=问题簇
    nextClusterId: 1             // 客户端簇编号游标（仅在服务端谱系之外的新簇使用）
  },  // 生产质量审计（只读，随方案变化自动重算）
  creep: { eligible: null, result: null },  // 书帖爬移补偿（实时重算，应用后写入独立字段）
  annotation: { editing: null, selectedId: null },  // 校样批注弹层 / 画布定位高亮
  listFilter: { tags: '', q: '', since: '' },  // 存档列表当前筛选条件
  // 版本差异审阅：
  //   open 覆盖层是否打开；view 为只读查看某历史版本时的状态（plan=快照，fromPlan=草稿备份）；
  //   diff 为当前两版本差异结果；highlightCells / highlightCell 为画布紫色高亮。
  review: {
    open: false,
    versions: [],
    fromV: null, toV: null,
    diff: null,
    view: null,
    highlightCells: [],
    highlightCell: null
  }
};

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

// ---------- 初始化 ----------
function init() {
  $('createGridBtn').addEventListener('click', createGrid);
  document.querySelectorAll('button.fold').forEach((b) =>
    b.addEventListener('click', () => addStepFromForm(b.dataset.dir)));
  $('axisSelect').addEventListener('change', refreshLineSelect);

  $('firstBtn').addEventListener('click', () => setUpto(0));
  $('prevBtn').addEventListener('click', () => setUpto(app.upto - 1));
  $('nextBtn').addEventListener('click', () => setUpto(app.upto + 1));
  $('playBtn').addEventListener('click', togglePlay);
  $('stepSlider').addEventListener('input', (e) => setUpto(Number(e.target.value)));

  $('delStepBtn').addEventListener('click', truncateSteps);
  $('clearStepsBtn').addEventListener('click', () => {
    if (reviewBlocked()) return;
    if (!app.plan.steps.length) return;
    app.plan.steps = [];
    setUpto(0, true);
  });

  $('saveBtn').addEventListener('click', savePlan);
  $('exportBtn').addEventListener('click', exportPlan);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importPlan);
  $('loadListBtn').addEventListener('click', loadList);
  $('reviewVersionsBtn').addEventListener('click', openReview);
  $('reviewCloseBtn').addEventListener('click', closeReview);
  $('reviewSwapBtn').addEventListener('click', swapReviewSides);
  $('reviewFromSel').addEventListener('change', onReviewSelectChange);
  $('reviewToSel').addEventListener('change', onReviewSelectChange);
  $('reviewExitViewBtn').addEventListener('click', exitVersionView);
  $('reviewRestoreBtn').addEventListener('click', askRestoreVersion);
  $('restoreCancelBtn').addEventListener('click', () => $('restoreConfirm').hidden = true);
  $('restoreOkBtn').addEventListener('click', confirmRestoreVersion);
  $('deletePlanBtn').addEventListener('click', deleteLoaded);

  // 标签编辑 / 存档列表筛选
  $('tagAddBtn').addEventListener('click', addTagFromInput);
  $('tagClearBtn').addEventListener('click', clearTags);
  $('tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
  });
  $('filterApplyBtn').addEventListener('click', () => {
    app.listFilter = {
      tags: $('filterTags').value.trim(),
      q: $('filterQ').value.trim(),
      since: $('filterSince').value
    };
    loadList();
  });
  $('filterResetBtn').addEventListener('click', () => {
    $('filterTags').value = '';
    $('filterQ').value = '';
    $('filterSince').value = '';
    app.listFilter = { tags: '', q: '', since: '' };
    loadList();
  });

  $('editorCancel').addEventListener('click', () => $('cellEditor').hidden = true);
  $('editorOk').addEventListener('click', commitEditor);

  $('imposePreviewBtn').addEventListener('click', previewImposition);
  $('imposeConfirmBtn').addEventListener('click', confirmImposition);
  $('imposeCancelBtn').addEventListener('click', closeImposition);
  $('imposeStart').addEventListener('input', renderImposition);
  $('imposeCount').addEventListener('input', renderImposition);

  $('pathSearchBtn').addEventListener('click', runPathfind);

  $('trackCell').addEventListener('change', (e) => renderTrack(e.target.value, $('trackFace').value));
  $('trackFace').addEventListener('change', (e) => renderTrack($('trackCell').value, e.target.value));

  $('duplexOpenBtn').addEventListener('click', openDuplex);
  $('duplexCloseBtn').addEventListener('click', closeDuplex);
  $('duplexPrintBtn').addEventListener('click', () => window.print());
  $('duplexFlip').addEventListener('change', (e) => {
    app.duplex.flip = e.target.value;
    $('duplexFlipOverlay').value = e.target.value;
    renderDuplexPreview();
  });
  $('duplexFlipOverlay').addEventListener('change', (e) => {
    app.duplex.flip = e.target.value;
    $('duplexFlip').value = e.target.value;
    renderDuplexPreview();
  });

  $('auditExportBtn').addEventListener('click', exportAudit);
  $('auditViewFindings').addEventListener('click', () => setAuditView('findings'));
  $('auditViewClusters').addEventListener('click', () => setAuditView('clusters'));
  $('auditClusterSeverity').addEventListener('change', (e) => {
    app.audit.severityFilter = e.target.value;
    renderAuditClusters();
  });

  $('creepThickness').addEventListener('input', renderCreep);
  $('creepBleed').addEventListener('input', renderCreep);
  $('creepApplyBtn').addEventListener('click', applyCreep);
  $('creepClearBtn').addEventListener('click', clearCreep);

  // 校样批注
  $('annoOpenOnly').addEventListener('change', renderAnnotations);
  $('annoSeverityFilter').addEventListener('change', renderAnnotations);
  $('annoFaceFilter').addEventListener('change', renderAnnotations);
  $('annoCancelBtn').addEventListener('click', closeAnnotationEditor);
  $('annoSaveBtn').addEventListener('click', commitAnnotation);
  $('annoDeleteBtn').addEventListener('click', deleteEditingAnnotation);
  $('annoText').addEventListener('input', () => {
    $('annoCharHint').textContent = `${[...$('annoText').value].length} / ${E.ANNO_LIMITS.MAX_TEXT_LEN}`;
  });

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('mouseleave', () => { app.hoverHandle = null; draw(); });
  $('planName').addEventListener('input', (e) => {
    if (isReviewing()) { e.target.value = app.plan.name || ''; reviewBlocked(); return; }
    app.plan.name = e.target.value;
  });
  $('planNote').addEventListener('input', (e) => {
    if (isReviewing()) { e.target.value = app.plan.note || ''; reviewBlocked(); return; }
    app.plan.note = e.target.value;
  });

  // 默认演示网格
  createGrid();
}

// ---------- 网格 / 方案 ----------
function createGrid() {
  if (reviewBlocked()) return;
  const rows = clampInt($('rowsInput').value, 1, 12, 2);
  const cols = clampInt($('colsInput').value, 1, 12, 2);
  app.plan = {
    name: $('planName').value || '未命名方案',
    rows, cols, labels: {}, steps: [],
    tags: [], note: '', annotations: []
  };
  app.annotation.editing = null;
  app.annotation.selectedId = null;
  $('planNote').value = '';
  renderTagChips();
  app.loadedId = null;
  app.restoredFrom = null;
  $('deletePlanBtn').hidden = true;
  $('reviewVersionsBtn').disabled = true;
  setUpto(0, true);
  refreshLineSelect();
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function refreshLineSelect() {
  const axis = $('axisSelect').value;
  const n = axis === 'v' ? app.plan.cols : app.plan.rows;
  const sel = $('lineSelect');
  sel.innerHTML = '';
  if (n < 2) {
    const o = document.createElement('option');
    o.textContent = '（该方向只有一格，无折线）';
    o.value = '';
    sel.appendChild(o);
    return;
  }
  for (let k = 1; k < n; k++) {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = axis === 'v'
      ? `第 ${k} 条竖线（第 ${k} 与 ${k + 1} 列之间）`
      : `第 ${k} 条横线（第 ${k} 与 ${k + 1} 行之间）`;
    sel.appendChild(o);
  }
}

function addStepFromForm(dir) {
  const axis = $('axisSelect').value;
  const line = Number($('lineSelect').value);
  if (!line) {
    showFoldError({ code: 'contour', message: '当前网格该方向没有可用折线。', conflicts: [] });
    return;
  }
  const compatible = axis === 'v' ? (dir === 'l' || dir === 'r') : (dir === 'u' || dir === 'd');
  if (!compatible) {
    showFoldError({ code: 'contour', message: '折叠方向与折线不匹配：竖线只能左/右折，横线只能上/下折。', conflicts: [] });
    return;
  }
  requestStep({ axis, line, dir });
}

/**
 * 尝试追加一步：先在当前回放状态校验。
 * 若当前不在最新步，则先把回放推进到最新再校验（步骤只追加在末尾）。
 */
function requestStep(step) {
  if (reviewBlocked()) return;
  // 校验基于“已应用此前所有步骤”的状态
  const base = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  const err = E.validateFold(base, step);
  if (err) {
    showFoldError(err);
    flashConflict(err);
    return;
  }
  app.plan.steps.push(step);
  clearFoldError();
  setUpto(app.plan.steps.length, true);
}

function flashConflict(err) {
  // 冲突以“应用全部已添加步骤后”的状态为底图显示
  const state = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  app.replay = { state, error: err };
  draw();
  renderControls();
  renderSteps();
  renderImposition();
  renderPathfind();
}

function truncateSteps() {
  if (reviewBlocked()) return;
  app.plan.steps = app.plan.steps.slice(0, app.upto);
  setUpto(app.plan.steps.length, true);
}

// ---------- 回放 ----------
function setUpto(n, force) {
  const max = app.plan.steps.length;
  n = Math.max(0, Math.min(max, n));
  if (!force && n === app.upto && app.replay) return;
  app.upto = n;
  stopPlay();
  render();
}

function rerunReplay() {
  if (!app.plan.rows) { app.replay = null; return; }
  app.replay = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, app.upto);
}

function togglePlay() {
  if (app.playTimer) { stopPlay(); return; }
  if (app.upto >= app.plan.steps.length) setUpto(0);
  $('playBtn').textContent = '⏸';
  app.playTimer = setInterval(() => {
    if (app.upto >= app.plan.steps.length) { stopPlay(); return; }
    setUpto(app.upto + 1);
  }, 800);
}
function stopPlay() {
  if (app.playTimer) clearInterval(app.playTimer);
  app.playTimer = null;
  $('playBtn').textContent = '▶';
}

// ---------- 渲染 ----------
function render() {
  rerunReplay();
  draw();
  renderSteps();
  renderSequence();
  renderControls();
  renderImposition();
  renderPathfind();
  renderTrack();
  renderDuplex();
  renderAudit();
  renderCreep();
  renderAnnotations();
}

function renderControls() {
  const max = app.plan.steps.length;
  const slider = $('stepSlider');
  slider.max = String(max);
  slider.value = String(app.upto);
  $('stepLabel').textContent = `第 ${app.upto} / ${max} 步`;
  $('delStepBtn').disabled = app.upto === 0;
  $('clearStepsBtn').disabled = max === 0;
  $('prevBtn').disabled = app.upto === 0;
  $('nextBtn').disabled = app.upto >= max;
  $('canvasHint').textContent = app.plan.rows
    ? '点击纸格编辑正反面页码；点击网格边缘箭头添加折叠。红色虚线手柄表示该折非法。'
    : '先在左侧创建行列纸格。';

  const badge = $('statusBadge');
  if (app.replay && app.replay.error) {
    badge.className = 'badge err';
    badge.textContent = '冲突：' + (app.replay.error.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓');
  } else if (app.replay) {
    const info = E.pageSequence(app.replay.state);
    if (info.folded) { badge.className = 'badge ok'; badge.textContent = '已收成单叠'; }
    else { badge.className = 'badge idle'; badge.textContent = `${info.stacks.length} 个叠层`; }
  } else { badge.className = 'badge idle'; badge.textContent = ''; }
}

function renderSteps() {
  const ol = $('stepList');
  ol.innerHTML = '';
  if (!app.plan.steps.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '尚无步骤';
    ol.appendChild(li);
    return;
  }
  const dirText = { l: '◀ 向左折', r: '▶ 向右折', u: '▲ 向上折', d: '▼ 向下折' };
  // 逐步重放以标记非法步
  let st = E.initialState(app.plan.rows, app.plan.cols, app.plan.labels);
  app.plan.steps.forEach((s, i) => {
    const err = E.validateFold(st, s);
    const li = document.createElement('li');
    const pos = s.axis === 'v' ? `竖线 ${s.line}` : `横线 ${s.line}`;
    li.textContent = `${i + 1}. ${pos}，${dirText[s.dir]}`;
    if (err) {
      li.classList.add('bad');
      li.textContent += '（非法）';
    }
    if (i < app.upto && !err) li.classList.add('current');
    li.addEventListener('click', () => setUpto(i + 1));
    ol.appendChild(li);
    if (!err) st = E.applyFold(st, s);
  });
}

function renderSequence() {
  const box = $('sequenceBox');
  const foldState = $('foldState');
  box.innerHTML = '';
  if (!app.replay) {
    box.innerHTML = '<span class="muted">完成折叠后在此输出页码序列。</span>';
    foldState.textContent = '';
    return;
  }
  const { stacks, folded } = E.pageSequence(app.replay.state);
  stacks.forEach((grp, gi) => {
    if (stacks.length > 1) {
      const tag = document.createElement('div');
      tag.style.cssText = 'width:100%;font-size:12px;color:var(--muted)';
      tag.textContent = `叠层 @格(${grp.cell})，厚 ${grp.depth} 片`;
      box.appendChild(tag);
    }
    grp.sequence.forEach((label, i) => {
      if (i > 0) {
        const ar = document.createElement('span');
        ar.className = 'seq-arrow';
        ar.textContent = '→';
        box.appendChild(ar);
      }
      // 正立信息：封面到封底序列前半为各叶上面、后半为各叶下面
      const leafCount = grp.leaves.length;
      const leaf = grp.leaves[i < leafCount ? i : 2 * leafCount - 1 - i];
      const up = leaf && (i < leafCount ? leaf.upper.upright : leaf.lower.upright);
      const span = document.createElement('span');
      span.className = 'seq-page' + (label == null ? ' blank' : '') + (up ? '' : ' inverted');
      span.innerHTML = label == null
        ? '空白<span class="small">blank</span>'
        : escapeHtml(label) + (up ? '' : '<span class="small">⟲ 倒排</span>');
      span.title = up ? '页码正立' : '页码倒置 180°';
      box.appendChild(span);
    });
    if (gi < stacks.length - 1) {
      const gap = document.createElement('div');
      gap.style.cssText = 'width:100%;height:2px';
      box.appendChild(gap);
    }
  });
  foldState.textContent = folded
    ? '所有面片已收成单叠：上方序列即为从封面到封底的完整阅读顺序。'
    : `当前仍有 ${stacks.length} 个分离叠层，继续折叠直到单叠即可得到全书顺序。`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Canvas 绘制 ----------
function originXY(x, y) {
  return { x: PAD + x * CELL, y: PAD + y * CELL };
}

function draw() {
  app.hitCells = [];
  app.hitHandles = [];
  if (!app.plan.rows) {
    sizeCanvas(1, 1);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const w = app.plan.cols * CELL + PAD * 2;
  const h = app.plan.rows * CELL + PAD * 2;
  sizeCanvas(w, h);
  ctx.clearRect(0, 0, w, h);

  // 原始网格淡线
  ctx.save();
  ctx.strokeStyle = '#eef1f5';
  ctx.lineWidth = 1;
  for (let x = 0; x <= app.plan.cols; x++) {
    line(PAD + x * CELL, PAD, PAD + x * CELL, PAD + app.plan.rows * CELL);
  }
  for (let y = 0; y <= app.plan.rows; y++) {
    line(PAD, PAD + y * CELL, PAD + app.plan.cols * CELL, PAD + y * CELL);
  }
  ctx.restore();

  const state = app.replay ? app.replay.state : null;
  const err = app.replay ? app.replay.error : null;
  const conflicts = new Set(err ? err.conflicts : []);
  const movingCells = app.hoverHandle ? previewMoving(app.hoverHandle) : new Set();

  if (state) {
    const track = currentTrackInfo(state);
    const annoMap = currentAnnotationMarks(state);
    const diffMap = currentDiffCellMap(state);
    const auditMap = currentAuditClusterMap(state);
    for (const [cellKey, ids] of Object.entries(state.stacks)) {
      const [cx, cy] = cellKey.split(',').map(Number);
      drawStack(cx, cy, ids, state, conflicts.has(cellKey), movingCells.has(cellKey),
        track && track.cell === cellKey ? track : null,
        annoMap.get(cellKey) || null,
        diffMap.get(cellKey) || null,
        auditMap.get(cellKey) || null);
    }
  }

  drawFoldHandles();
}

/** 审阅模式（只读查看某历史版本）判定。 */
function isReviewing() { return !!(app.review.open && app.review.view); }

/**
 * 版本差异高亮：把“受影响原始纸格”集合按身份定位到当前回放状态，
 * 返回 Map<当前格位key, { origins:Set<原始纸格>, selected:string|null }>。
 * 仅在差异审阅覆盖层打开时有值；与追踪/批注高亮相互独立、可并存。
 */
function currentDiffCellMap(state) {
  const map = new Map();
  if (!app.review.open) return map;
  const list = app.review.highlightCells || [];
  if (!state || !list.length) return map;
  for (const origin of list) {
    const p = state.panels[origin];
    if (!p) continue;
    const at = p.cx + ',' + p.cy;
    if (!state.stacks[at]) continue;
    let entry = map.get(at);
    if (!entry) { entry = { origins: new Set(), selected: null }; map.set(at, entry); }
    entry.origins.add(origin);
    if (app.review.highlightCell === origin) entry.selected = origin;
  }
  return map;
}

/**
 * 当前回放状态下的批注标记（以原始面片身份定位）。
 * @returns Map<当前格位key, { faces:{front:marks, back:marks}, selectedFace }>
 *   marks: [{ severity, resolved }]；任一面有批注就在该格顶部打点。
 */
function currentAnnotationMarks(state) {
  const map = new Map();
  if (!state || !Array.isArray(app.plan.annotations) || !app.plan.annotations.length) return map;
  for (const a of app.plan.annotations) {
    const p = state.panels[a.cell];
    if (!p) continue;
    const at = p.cx + ',' + p.cy;
    if (!state.stacks[at]) continue;
    let entry = map.get(at);
    if (!entry) { entry = { faces: { front: [], back: [] }, selectedFace: null }; map.set(at, entry); }
    if (entry.faces[a.face]) {
      entry.faces[a.face].push({
        severity: a.severity, resolved: a.resolved === true, id: a.id
      });
    }
    if (a.id === app.annotation.selectedId) entry.selectedFace = a.face;
  }
  return map;
}

/**
 * 当前回放状态中被追踪面片的定位信息：
 * 以原始纸格 id 为身份，在任意回放前缀（含非法步截断态）中都可找到。
 */
function currentTrackInfo(state) {
  if (!state || !app.track.target) return null;
  const id = app.track.target.cell;
  const p = state.panels[id];
  if (!p) return null;
  const cell = p.cx + ',' + p.cy;
  const ids = state.stacks[cell];
  if (!ids) return null;
  return {
    id, cell,
    layer: ids.indexOf(id) + 1,   // 1 = 最上层
    depth: ids.length,
    face: app.track.target.face,
    panel: p
  };
}

function sizeCanvas(w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.aspectRatio = `${w} / ${h}`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawStack(cx, cy, ids, state, conflict, moving, track, anno, diff, audit) {
  const { x, y } = originXY(cx, cy);
  const depth = ids.length;
  const trackLayer = track ? track.layer : 0;   // 1 = 最上层

  // 叠层阴影面片
  for (let i = depth - 1; i >= 1; i--) {
    roundRect(x + i * 2.5, y - i * 2.5, CELL - 8, CELL - 8, 6);
    ctx.fillStyle = '#f3ecd6';
    ctx.fill();
    ctx.strokeStyle = '#d8c795';
    ctx.stroke();
  }
  // 被追踪面片若非顶层：在其偏移阴影位补一圈橙色描边（夹在叠层中可见）
  if (track && trackLayer > 1) {
    const ti = trackLayer - 1;
    roundRect(x + ti * 2.5, y - ti * 2.5, CELL - 8, CELL - 8, 6);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#e8820c';
    ctx.stroke();
  }

  // 顶面片
  const top = state.panels[ids[0]];
  const { side, upright } = E.visibleFace(top);
  const label = top[side];
  const isTrackTop = track && trackLayer === 1;
  roundRect(x, y, CELL - 8, CELL - 8, 6);
  ctx.fillStyle = conflict ? '#fde0dd'
    : isTrackTop ? '#fff1de'
    : moving ? '#dbeafe' : '#fdfaf1';
  ctx.fill();
  ctx.lineWidth = conflict ? 2.5 : isTrackTop ? 2.5 : moving ? 2 : 1.2;
  ctx.strokeStyle = conflict ? '#d64545'
    : isTrackTop ? '#e8820c'
    : moving ? '#2f6fed' : '#b99e5e';
  ctx.stroke();

  // 批注定位高亮：所选批注绑定的面片所在叠（与追踪高亮可并存），青色描边
  if (anno && anno.selectedFace) {
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0f9d76';
    roundRect(x - 3, y - 3, CELL - 2, CELL - 2, 8);
    ctx.stroke();
    ctx.restore();
  }

  // 版本差异高亮：受影响原始纸格用紫色虚线圈出；夹在叠层中时按层序偏移显示。
  // 点击差异项选中的单个纸格用加粗实线（selectedLayer）。
  if (diff) {
    for (const origin of diff.origins) {
      const layer = ids.indexOf(origin) + 1;
      if (layer <= 0) continue;
      const li = layer - 1;
      const selected = diff.selected === origin;
      ctx.save();
      ctx.setLineDash(selected ? [] : [6, 4]);
      ctx.lineWidth = selected ? 3 : 2;
      ctx.strokeStyle = '#7c4ee0';
      roundRect(x + li * 2.5 - 3, y - li * 2.5 - 3, CELL - 2, CELL - 2, 8);
      ctx.stroke();
      ctx.restore();
      // 差异角标（仅顶层画一次，避免遮挡页码）
      if (layer === 1) {
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.fillStyle = '#7c4ee0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(selected ? '◆差' : '差', x + 4, y + 13);
        ctx.textBaseline = 'alphabetic';
      }
    }
  }

  // 审计问题簇高亮：点簇后该簇全部受影响原始纸格用红色虚线圈出（按层序偏移）
  if (audit) {
    for (const origin of audit.origins) {
      const layer = ids.indexOf(origin) + 1;
      if (layer <= 0) continue;
      const li = layer - 1;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#d64545';
      roundRect(x + li * 2.5 - 3, y - li * 2.5 - 3, CELL - 2, CELL - 2, 8);
      ctx.stroke();
      ctx.restore();
      if (layer === 1) {
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.fillStyle = '#d64545';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('簇', x + CELL - 12, y + 13);
        ctx.textBaseline = 'alphabetic';
      }
    }
  }

  // 页码（朝向：倒置旋转 180°）
  ctx.save();
  ctx.translate(x + (CELL - 8) / 2, y + (CELL - 8) / 2);
  if (!upright) ctx.rotate(Math.PI);
  ctx.fillStyle = '#1f2933';
  ctx.font = 'bold 26px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label === '' ? '·' : label, 0, 2);
  ctx.restore();

  // 面别与厚度徽标
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = side === 'front' ? '#2f6fed' : '#7b4ed0';
  ctx.fillText(side === 'front' ? '正面↑' : '反面↑', x + 6, y + 13);
  if (depth > 1) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#b99e5e';
    roundRect(x + CELL - 34, y + 3, 24, 15, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8a6d2f';
    ctx.textAlign = 'center';
    ctx.fillText(`×${depth}`, x + CELL - 22, y + 14);
  }
  if (!upright) {
    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('⟲倒', x + CELL - 12, y + CELL - 13);
  }

  // 追踪面片徽标：显示其在叠中的层序（夹在层中时也可辨识）
  if (track) {
    const tag = `轨 ${track.layer}/${track.depth}`;
    ctx.font = 'bold 10px system-ui, sans-serif';
    const tw = ctx.measureText(tag).width + 10;
    roundRect(x + 4, y + CELL - 20, tw, 15, 8);
    ctx.fillStyle = '#e8820c';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, x + 4 + tw / 2, y + CELL - 12.5);
    ctx.textBaseline = 'alphabetic';
  }

  drawAnnotationBadges(x, y, anno);

  app.hitCells.push({ x, y, w: CELL - 8, h: CELL - 8, cell: `${cx},${cy}` });
}

/**
 * 批注徽标：格顶居中并排两枚小圆点（左=正面、右=反面），
 * 颜色取该面<b>未解决</b>批注中的最高严重级别；全部已解决为带勾的绿点；
 * 数量 >1 时圆点内显示条数。该叠内任一层的原始面片批注都聚合到此格。
 */
function drawAnnotationBadges(x, y, anno) {
  if (!anno) return;
  const drawDot = (face, marks, cx) => {
    if (!marks || !marks.length) return;
    const open = marks.filter((m) => !m.resolved);
    const allResolved = open.length === 0;
    const color = allResolved ? '#2e9e5b'
      : open.some((m) => m.severity === 'error') ? '#d64545'
      : open.some((m) => m.severity === 'warning') ? '#c9810a'
      : '#0f9d76';
    ctx.beginPath();
    ctx.arc(cx, y + 8, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, y + 8, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (allResolved) {
      ctx.fillStyle = '#fff';
      ctx.fillText('✓', cx, y + 8.5);
    } else if (marks.length > 1) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(marks.length), cx, y + 8.5);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillText(face === 'front' ? '正' : '反', cx, y + 8.5);
    }
    ctx.textBaseline = 'alphabetic';
  };
  const cxm = x + (CELL - 8) / 2;
  drawDot('front', anno.faces.front, cxm - 10);
  drawDot('back', anno.faces.back, cxm + 10);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 折叠手柄 ----------
function allPossibleSteps() {
  const out = [];
  for (let k = 1; k < app.plan.cols; k++) {
    out.push({ axis: 'v', line: k, dir: 'r' });   // 左瓣向右落
    out.push({ axis: 'v', line: k, dir: 'l' });   // 右瓣向左落
  }
  for (let k = 1; k < app.plan.rows; k++) {
    out.push({ axis: 'h', line: k, dir: 'd' });
    out.push({ axis: 'h', line: k, dir: 'u' });
  }
  return out;
}

function drawFoldHandles() {
  if (!app.replay) return;
  if (isReviewing()) return;   // 历史版本只读：不绘制可点击折叠手柄
  const baseState = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  for (const step of allPossibleSteps()) {
    const err = E.validateFold(baseState, step);
    drawHandle(step, !!err, app.hoverHandle && app.hoverHandle.axis === step.axis
      && app.hoverHandle.line === step.line && app.hoverHandle.dir === step.dir);
  }
}

function handleRect(step) {
  const s = 18;
  const gap = 3;
  if (step.axis === 'v') {
    const gx = PAD + step.line * CELL;
    const y = 20;
    // 左按钮 ◀(dir=l)，右按钮 ▶(dir=r)，居中于网格线
    const x = step.dir === 'l' ? gx - s - gap / 2 : gx + gap / 2;
    return { x, y, w: s, h: s };
  }
  const gy = PAD + step.line * CELL;
  const x = 20;
  // 上按钮 ▲(dir=u)，下按钮 ▼(dir=d)，居中于网格线
  const y = step.dir === 'u' ? gy - s - gap / 2 : gy + gap / 2;
  return { x, y, w: s, h: s };
}

function drawHandle(step, invalid, hovered) {
  const r = handleRect(step);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = invalid ? '#fdecea' : hovered ? '#c5d8fb' : '#eaf1fe';
  ctx.fill();
  ctx.lineWidth = hovered ? 2 : 1;
  ctx.setLineDash(invalid ? [3, 2] : []);
  ctx.strokeStyle = invalid ? '#d64545' : '#2f6fed';
  ctx.stroke();
  ctx.setLineDash([]);

  // 指示线沿网格线画一段淡色虚线（非法为红）
  if (step.axis === 'v') {
    const gx = PAD + step.line * CELL;
    ctx.strokeStyle = invalid ? 'rgba(214,69,69,.5)' : 'rgba(47,111,237,.35)';
    ctx.setLineDash([4, 4]);
    line(gx, PAD - 4, gx, PAD + app.plan.rows * CELL + 4);
    ctx.setLineDash([]);
  } else {
    const gy = PAD + step.line * CELL;
    ctx.strokeStyle = invalid ? 'rgba(214,69,69,.5)' : 'rgba(47,111,237,.35)';
    ctx.setLineDash([4, 4]);
    line(PAD - 4, gy, PAD + app.plan.cols * CELL + 4, gy);
    ctx.setLineDash([]);
  }

  // 箭头：dir 表示落向
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  ctx.fillStyle = invalid ? '#d64545' : '#2f6fed';
  ctx.beginPath();
  const t = 5;
  if (step.dir === 'r') { ctx.moveTo(cx - t, cy - t); ctx.lineTo(cx + t, cy); ctx.lineTo(cx - t, cy + t); }
  if (step.dir === 'l') { ctx.moveTo(cx + t, cy - t); ctx.lineTo(cx - t, cy); ctx.lineTo(cx + t, cy + t); }
  if (step.dir === 'd') { ctx.moveTo(cx - t, cy - t); ctx.lineTo(cx, cy + t); ctx.lineTo(cx + t, cy - t); }
  if (step.dir === 'u') { ctx.moveTo(cx - t, cy + t); ctx.lineTo(cx, cy - t); ctx.lineTo(cx + t, cy + t); }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  app.hitHandles.push({ ...r, step });
}

function previewMoving(handle) {
  const set = new Set();
  if (!app.replay) return set;
  const state = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
  const { axis, line, dir } = handle;
  const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[dir];
  for (const cell of Object.keys(state.stacks)) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r') : (cy < line ? 'u' : 'd');
    if (side === movingSide) set.add(cell);
  }
  return set;
}

// ---------- 画布交互 ----------
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: (e.clientX - rect.left) * (canvas.width / dpr) / rect.width,
    y: (e.clientY - rect.top) * (canvas.height / dpr) / rect.height
  };
}

function hitAt(p) {
  for (const h of app.hitHandles) {
    if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return { type: 'handle', h };
  }
  for (const c of app.hitCells) {
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return { type: 'cell', c };
  }
  return null;
}

function onCanvasClick(e) {
  const hit = hitAt(canvasPoint(e));
  if (!hit) return;
  if (hit.type === 'handle') {
    if (reviewBlocked()) return;
    requestStep(hit.h.step);
  } else {
    if (isReviewing()) return;   // 历史版本只读：点击纸格不打开页码/批注编辑器
    openEditor(hit.c.cell);
  }
}

/**
 * 历史版本只读守卫：正在查看某历史版本时，任何改动当前方案的操作都被拦下，
 * 引导用户先“返回差异列表”（恢复草稿）或把该版本恢复为草稿。
 * @returns true 表示已拦截
 */
function reviewBlocked() {
  if (!isReviewing()) return false;
  $('saveMsg').textContent = '正在只读查看历史版本，不能编辑；请先“返回差异列表”或把该版本恢复为当前草稿。';
  return true;
}

function onCanvasMove(e) {
  const hit = hitAt(canvasPoint(e));
  const hh = hit && hit.type === 'handle' ? hit.h.step : null;
  const changed = JSON.stringify(hh || {}) !== JSON.stringify(app.hoverHandle || {});
  app.hoverHandle = hh;
  canvas.style.cursor = hit ? 'pointer' : 'default';
  if (changed) draw();
}

// ---------- 纸格编辑器 ----------
function openEditor(cellKey) {
  if (!app.replay) return;
  const state = app.replay.state;
  const ids = state.stacks[cellKey];
  if (!ids) return;
  app.editingCell = cellKey;
  const box = $('editorRows');
  box.innerHTML = '';
  $('editorOrigin').textContent = `当前格 (${cellKey})，叠 ${ids.length} 片`;

  const wrap = document.createElement('div');
  wrap.className = 'leaves-edit';
  ids.forEach((id) => {
    const p = state.panels[id];
    const key = E.key(p.ox, p.oy);
    const cur = app.plan.labels[key] || { front: '', back: '' };
    const row = document.createElement('div');
    row.className = 'leaf-row';
    row.dataset.key = key;
    row.innerHTML = `
      <div>
        <div class="tag">原格 (${key}) · 正面页码</div>
        <input data-face="front" type="text" maxlength="8" value="${escapeHtml(cur.front || '')}" />
        <div class="face-anno-row">
          <button type="button" class="face-anno-btn" data-key="${key}" data-face="front">＋ 正面批注</button>
          <span class="face-anno-count" data-count-for="${key}|front"></span>
        </div>
      </div>
      <div>
        <div class="tag">原格 (${key}) · 反面页码</div>
        <input data-face="back" type="text" maxlength="8" value="${escapeHtml(cur.back || '')}" />
        <div class="face-anno-row">
          <button type="button" class="face-anno-btn" data-key="${key}" data-face="back">＋ 反面批注</button>
          <span class="face-anno-count" data-count-for="${key}|back"></span>
        </div>
      </div>`;
    wrap.appendChild(row);
  });
  box.appendChild(wrap);
  // 绑定批注入口：先提交页码编辑（批注基于原始面片，不依赖页码内容），再打开批注弹层
  wrap.querySelectorAll('button.face-anno-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      commitEditor();
      openAnnotationEditor(btn.dataset.key, btn.dataset.face);
    });
  });
  refreshFaceAnnoCounts(wrap);
  $('cellEditor').hidden = false;
}

/** 在页码弹层中显示每个“原格·面”的现有批注数（未解决数红色）。 */
function refreshFaceAnnoCounts(root) {
  root.querySelectorAll('[data-count-for]').forEach((el) => {
    const [key, face] = el.dataset.countFor.split('|');
    const all = (app.plan.annotations || []).filter((a) => a.cell === key && a.face === face);
    const open = all.filter((a) => !a.resolved).length;
    el.textContent = all.length ? `${open} 未解决 / ${all.length} 条` : '';
    el.classList.toggle('open', open > 0);
  });
}

function commitEditor() {
  if (reviewBlocked()) { $('cellEditor').hidden = true; return; }
  document.querySelectorAll('#editorRows .leaf-row').forEach((row) => {
    const key = row.dataset.key;
    const front = row.querySelector('input[data-face="front"]').value.trim();
    const back = row.querySelector('input[data-face="back"]').value.trim();
    if (front || back) app.plan.labels[key] = { front, back };
    else delete app.plan.labels[key];
  });
  $('cellEditor').hidden = true;
  render();
}

// ---------- 校样批注 ----------
/** 当前方案批注（始终为数组）。 */
function annotations() {
  if (!Array.isArray(app.plan.annotations)) app.plan.annotations = [];
  return app.plan.annotations;
}

/** 当前回放下所有批注的身份定位结果（upto 变化即重算，含非法步截断态）。 */
function annotationLocations() {
  if (!app.plan.rows) return null;
  return E.locateAnnotations(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
    app.upto, annotations());
}

const SEVERITY_NAME = { error: '严重', warning: '警告', info: '建议' };
const FACE_NAME = { front: '正面', back: '反面' };

/**
 * 打开批注编辑弹层。
 * @param targetId 编辑单个已有批注（忽略 cell/face/step）；
 *                 否则为新建，须给 cell(原始纸格)、face，step 取当前回放步。
 */
function openAnnotationEditor(cell, face, targetId) {
  if (!app.plan.rows) return;
  let rec;
  if (targetId) {
    rec = annotations().find((a) => a.id === targetId);
    if (!rec) return;
  } else {
    if (!/^\d+,\d+$/.test(cell || '')) return;
    if (face !== 'front' && face !== 'back') return;
    rec = {
      id: null, cell, face,
      severity: 'error', text: '',
      step: app.upto, resolved: false
    };
  }
  app.annotation.editing = rec.id ? { id: rec.id } : { cell: rec.cell, face: rec.face, step: rec.step };
  $('annoEditorTarget').textContent =
    `原格(${rec.cell}) · ${FACE_NAME[rec.face]}`;
  $('annoEditorMeta').textContent = targetId
    ? `编辑已有批注（创建于第 ${rec.step} 步；原格·面不可更改）`
    : `新增批注：绑定原始纸格 (${rec.cell}) 的${FACE_NAME[rec.face]}，` +
      `记录当前回放第 ${rec.step} 步；之后切换步骤或重排折叠仍会定位到该片。`;
  $('annoSeverity').value = rec.severity;
  $('annoStepText').textContent = `第 ${rec.step} / ${app.plan.steps.length} 步`;
  $('annoText').value = rec.text || '';
  $('annoCharHint').textContent = `${[...(rec.text || '')].length} / ${E.ANNO_LIMITS.MAX_TEXT_LEN}`;
  $('annoDeleteBtn').hidden = !rec.id;
  $('annoEditorMsg').hidden = true;
  $('annoEditorMsg').textContent = '';
  $('annoEditor').hidden = false;
  $('annoText').focus();
}

function closeAnnotationEditor() {
  $('annoEditor').hidden = true;
  app.annotation.editing = null;
}

function showAnnoEditorError(msg) {
  const box = $('annoEditorMsg');
  box.hidden = false;
  box.textContent = msg;
}

/** 保存（新建或编辑）批注：在前端按保存路径的同一套严格规则预校验。 */
function commitAnnotation() {
  if (reviewBlocked()) return;
  const editing = app.annotation.editing;
  if (!editing) return;
  const existing = editing.id ? annotations().find((a) => a.id === editing.id) : null;
  const draft = {
    id: existing ? existing.id : undefined,
    cell: existing ? existing.cell : editing.cell,
    face: existing ? existing.face : editing.face,
    severity: $('annoSeverity').value,
    text: $('annoText').value,
    step: existing ? existing.step : editing.step,
    resolved: existing ? existing.resolved : false,
    createdAt: existing ? existing.createdAt : undefined,
    resolvedAt: existing ? existing.resolvedAt : undefined
  };
  let normalized;
  try {
    [normalized] = E.normalizeAnnotations([draft], {
      rows: app.plan.rows, cols: app.plan.cols, steps: app.plan.steps
    });
  } catch (e) {
    showAnnoEditorError(e.message);
    return;
  }
  if (existing) {
    const idx = annotations().findIndex((a) => a.id === existing.id);
    // 保留原创建时间；正文/级别更新后若此前已解决则自动恢复为未解决
    normalized.id = existing.id;
    normalized.createdAt = existing.createdAt;
    normalized.resolved = existing.resolved;
    normalized.resolvedAt = existing.resolvedAt;
    if (existing.resolved &&
        (existing.text !== normalized.text || existing.severity !== normalized.severity)) {
      normalized.resolved = false;
      normalized.resolvedAt = undefined;
    }
    annotations()[idx] = normalized;
    app.annotation.selectedId = normalized.id;
  } else {
    annotations().push(normalized);
    app.annotation.selectedId = normalized.id;
  }
  closeAnnotationEditor();
  render();
  $('saveMsg').textContent = existing ? '批注已更新，记得保存方案。' : '批注已添加，记得保存方案。';
}

function deleteEditingAnnotation() {
  if (reviewBlocked()) return;
  const editing = app.annotation.editing;
  if (!editing || !editing.id) return;
  const before = annotations().length;
  app.plan.annotations = annotations().filter((a) => a.id !== editing.id);
  if (app.annotation.selectedId === editing.id) app.annotation.selectedId = null;
  closeAnnotationEditor();
  render();
  if (app.plan.annotations.length !== before) {
    $('saveMsg').textContent = '批注已删除，记得保存方案。';
  }
}

/** 解决 / 恢复单条批注。 */
function setAnnotationResolved(id, resolved) {
  if (reviewBlocked()) return;
  const rec = annotations().find((a) => a.id === id);
  if (!rec) return;
  rec.resolved = !!resolved;
  if (resolved) rec.resolvedAt = new Date().toISOString();
  else delete rec.resolvedAt;
  app.annotation.selectedId = id;
  render();
}

/** 删除单条批注（列表内）。 */
function deleteAnnotation(id) {
  if (reviewBlocked()) return;
  if (!annotations().some((a) => a.id === id)) return;
  if (!confirm('确定删除该条批注？')) return;
  app.plan.annotations = annotations().filter((a) => a.id !== id);
  if (app.annotation.selectedId === id) app.annotation.selectedId = null;
  render();
  $('saveMsg').textContent = '批注已删除，记得保存方案。';
}

/** 点击列表条目：定位到批注创建步并高亮其面片。 */
function locateAnnotation(id) {
  const rec = annotations().find((a) => a.id === id);
  if (!rec) return;
  app.annotation.selectedId = id;
  setUpto(Math.min(rec.step, app.plan.steps.length), true);
}

/**
 * 渲染批注卡片：统计、筛选与列表。
 * 定位信息由当前回放状态实时给出（upto/折叠重排后自动更新）。
 */
function renderAnnotations() {
  const status = $('annoStatus');
  const list = $('annoList');
  list.innerHTML = '';
  if (!app.plan.rows) {
    status.textContent = '先在左侧创建行列纸格。';
    list.innerHTML = '<li class="anno-empty">尚无批注。</li>';
    draw();
    return;
  }

  const all = annotations();
  const loc = annotationLocations();
  const atById = new Map((loc ? loc.points : []).map((p) => [p.id, p]));
  const stats = E.annotationStats(all);
  const sevText = `严重 ${stats.bySeverity.error.open} · 警告 ${stats.bySeverity.warning.open} · 建议 ${stats.bySeverity.info.open}`;
  status.textContent = all.length
    ? `共 ${stats.total} 条批注：未解决 ${stats.open}（${sevText}），已解决 ${stats.resolved}。` +
      (loc && loc.interrupted ? ' 当前回放在非法步截断，标记按截断前状态定位。' : '')
    : '尚无批注：点击画布格位 → “＋ 正面/反面批注”即可添加。';

  const openOnly = $('annoOpenOnly').checked;
  const sevFilter = $('annoSeverityFilter').value;
  const faceFilter = $('annoFaceFilter').value;

  let visible = all
    .filter((a) => !openOnly || !a.resolved)
    .filter((a) => !sevFilter || a.severity === sevFilter)
    .filter((a) => !faceFilter || a.face === faceFilter);
  // 未解决在前（同级按创建顺序 = 数组顺序）
  visible = visible.slice().sort((a, b) => Number(a.resolved) - Number(b.resolved));

  if (!all.length) {
    list.innerHTML = '<li class="anno-empty">尚无批注。</li>';
  } else if (!visible.length) {
    list.innerHTML = '<li class="anno-empty">当前筛选条件下没有批注。</li>';
  } else {
    visible.forEach((a) => list.appendChild(renderAnnotationItem(a, atById.get(a.id))));
  }
  draw();
}

function renderAnnotationItem(a, at) {
  const li = document.createElement('li');
  li.className = 'anno-item sev-' + a.severity + (a.resolved ? ' resolved' : '');

  const head = document.createElement('div');
  head.className = 'anno-head';
  const sev = document.createElement('span');
  sev.className = 'anno-sev ' + a.severity;
  sev.textContent = SEVERITY_NAME[a.severity] || a.severity;
  const target = document.createElement('span');
  target.className = 'anno-target';
  target.textContent = `原格(${a.cell})`;
  const face = document.createElement('span');
  face.className = 'anno-face ' + a.face;
  face.textContent = FACE_NAME[a.face];
  const where = document.createElement('span');
  where.className = 'anno-at';
  where.textContent = at
    ? `第 ${app.upto} 步位于格(${at.at}) · 层 ${at.layer}/${at.depth}` +
      (at.faceUp ? ' · 该面朝上' : ' · 该面朝下')
    : '当前回放步不可定位';
  head.append(sev, target, face, where);
  if (a.resolved) {
    const done = document.createElement('span');
    done.className = 'anno-resolved-tag';
    done.textContent = '✓ 已解决' + (a.resolvedAt ? ' ' + new Date(a.resolvedAt).toLocaleString() : '');
    head.appendChild(done);
  }
  li.appendChild(head);

  const text = document.createElement('div');
  text.className = 'anno-text';
  text.textContent = a.text;
  li.appendChild(text);

  const meta = document.createElement('div');
  meta.className = 'anno-meta';
  meta.textContent = `批注于第 ${a.step} 步创建` +
    (a.createdAt ? ` · ${new Date(a.createdAt).toLocaleString()}` : '');
  li.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'anno-actions';
  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.textContent = '定位到面片';
  jumpBtn.title = `跳转到批注创建时的第 ${a.step} 步并高亮该片`;
  jumpBtn.addEventListener('click', () => locateAnnotation(a.id));

  const resolveBtn = document.createElement('button');
  resolveBtn.type = 'button';
  resolveBtn.className = 'primary';
  if (a.resolved) {
    resolveBtn.textContent = '恢复为未解决';
    resolveBtn.classList.remove('primary');
  } else {
    resolveBtn.textContent = '标记已解决';
  }
  resolveBtn.addEventListener('click', () => setAnnotationResolved(a.id, !a.resolved));

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => openAnnotationEditor(null, null, a.id));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'danger';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', () => deleteAnnotation(a.id));

  actions.append(jumpBtn, resolveBtn, editBtn, delBtn);
  li.appendChild(actions);
  return li;
}

// ---------- 自动拼版 ----------
/** 方案几何签名：网格、标注或折叠步骤变化后旧预览即失效（回放到不同步不影响）。 */
function planSignature() {
  return JSON.stringify({
    r: app.plan.rows, c: app.plan.cols,
    l: app.plan.labels, s: app.plan.steps
  });
}

function readImposeInputs() {
  return { start: Number($('imposeStart').value), count: Number($('imposeCount').value) };
}

/** 渲染拼版卡片：可用状态、禁用原因、预览内容。 */
function renderImposition() {
  if (!app.plan.rows) {
    app.imposition.eligible = null;
    $('imposePreviewBtn').disabled = true;
    $('imposeStatus').textContent = '先在左侧创建行列纸格并完成折叠。';
    $('imposeStatus').className = 'hint';
    $('imposePreview').hidden = true;
    app.imposition.result = null;
    return;
  }
  const elig = E.impositionEligibility(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.imposition.eligible = elig;

  const countInput = $('imposeCount');
  if (elig.ok) {
    countInput.max = String(elig.capacity);
    if (!countInput.placeholder) countInput.placeholder = String(elig.capacity);
    $('imposePreviewBtn').disabled = false;
    $('imposeStatus').textContent = `可拼版：容量 ${elig.capacity} 面（${app.plan.rows}×${app.plan.cols} 格 × 正反 2 面）。`;
    $('imposeStatus').className = 'hint impose-status-ok';
  } else {
    countInput.removeAttribute('max');
    $('imposePreviewBtn').disabled = true;
    const why = elig.code === 'not_single_stack'
      ? `未收成单叠：${elig.message}`
      : `禁用生成：${elig.message}`;
    $('imposeStatus').textContent = why;
    $('imposeStatus').className = 'hint impose-status-err';
    closeImposition();
    return;
  }

  // 旧预览的方案已被改动 → 作废
  if (app.imposition.result && app.imposition.sig !== planSignature()) {
    closeImposition();
  }
  if (app.imposition.result) renderImpositionPreview(app.imposition.result);
}

function closeImposition() {
  app.imposition.result = null;
  app.imposition.sig = null;
  $('imposePreview').hidden = true;
}

/** 点击“生成预览”：仅计算并展示，绝不直接改写当前标注。 */
function previewImposition() {
  const { start, count } = readImposeInputs();
  const result = E.autoImpose(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, start, count);
  if (!result.ok) {
    closeImposition();
    $('imposeStatus').textContent = '禁用生成：' + result.message;
    $('imposeStatus').className = 'hint impose-status-err';
    return;
  }
  app.imposition.result = result;
  app.imposition.sig = planSignature();
  $('imposePreview').hidden = false;
  renderImpositionPreview(result);
}

function faceText(face) {
  return face === 'front'
    ? '<span class="imp-face-front">正面</span>'
    : '<span class="imp-face-back">反面</span>';
}

function renderImpositionPreview(result) {
  // 摘要
  const blankNote = result.blankTrailing > 0
    ? `；末尾 ${result.blankTrailing} 个槽位为空白（已标明所属纸格与面）`
    : '';
  $('imposeSummary').innerHTML =
    `将向封面→封底共 <b>${result.capacity}</b> 个阅读槽位填入页码 ` +
    `<b>${result.startPage}–${result.startPage + result.pageCount - 1}</b>` +
    `（${result.pageCount} 页）${blankNote}。预览不会改动当前标注，确认后才批量写入。`;

  // 覆盖汇总（现有标注非空时）
  const overwrites = E.impositionOverwrite(app.plan.labels, result);
  const ovBox = $('imposeOverwrite');
  if (overwrites.length) {
    ovBox.hidden = false;
    const faceName = { front: '正面', back: '反面' };
    const lines = overwrites.map((o) => {
      const target = o.blanked ? '<b>空白</b>' : `“${escapeHtml(o.to)}”`;
      return `格(${o.cell}) ${faceName[o.face]}：“${escapeHtml(o.from)}” → ${target}`;
    });
    ovBox.innerHTML = `⚠ 确认后将覆盖 ${overwrites.length} 处现有标注：<br>${lines.join('<br>')}`;
  } else {
    ovBox.hidden = true;
    ovBox.textContent = '';
  }

  // 槽位表
  const tbody = $('imposeRows');
  tbody.innerHTML = '';
  result.slots.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (s.blank) tr.className = 'blank-slot';
    if (i === 0) tr.classList.add('slot-cover');
    if (i === result.slots.length - 1) tr.classList.add('slot-backcover');
    const posName = i === 0 ? '槽 1（封面）'
      : i === result.slots.length - 1 ? `槽 ${i + 1}（封底）`
      : `槽 ${i + 1}`;
    const pageCell = s.blank
      ? '<span class="muted">空白</span>'
      : `<span class="imp-page">${escapeHtml(s.page)}</span>`;
    const upright = s.upright
      ? '正立'
      : '<span class="imp-inv" title="页码倒置 180°">⟲ 倒排</span>';
    tr.innerHTML =
      `<td>${posName}</td>` +
      `<td>${pageCell}</td>` +
      `<td>格(${s.origin}) · ${faceText(s.face)}</td>` +
      `<td>${upright}</td>`;
    tbody.appendChild(tr);
  });
}

/** 用户确认后批量写入（仅在此刻改写 labels）。 */
function confirmImposition() {
  if (reviewBlocked()) return;
  const result = app.imposition.result;
  if (!result || app.imposition.sig !== planSignature()) return;
  const overwrites = E.impositionOverwrite(app.plan.labels, result);
  if (overwrites.length) {
    const faceName = { front: '正面', back: '反面' };
    const detail = overwrites.map((o) =>
      `格(${o.cell}) ${faceName[o.face]} “${o.from}”→${o.blanked ? '空白' : '“' + o.to + '”'}`).join('\n');
    if (!confirm(`以下 ${overwrites.length} 处现有标注将被覆盖：\n${detail}\n\n确认写入自动拼版页码？`)) return;
  }
  app.plan.labels = JSON.parse(JSON.stringify(result.labels));
  closeImposition();
  setUpto(app.upto, true);
  $('saveMsg').textContent =
    `已按自动拼版写入 ${result.pageCount} 个页码（${result.blankTrailing} 个尾部槽位留空），记得保存方案。`;
}

// ---------- 折手自动寻路 ----------
/**
 * 寻路基于“方案全部步骤回放”的末态；只要方案几何（网格/标注/步骤）变化，
 * 旧结果即作废。寻路起点与回放到第几步（upto）无关。
 */
function pathfindSignature() {
  return JSON.stringify({
    r: app.plan.rows, c: app.plan.cols,
    l: app.plan.labels, s: app.plan.steps
  });
}

/** 重建“封面原格”下拉（仅在网格尺寸变化时重建，保留用户选择）。 */
function refreshPathCells() {
  const key = `${app.plan.rows}x${app.plan.cols}`;
  if (app.pathfind.gridKey === key) return;
  app.pathfind.gridKey = key;
  const sel = $('pathCell');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!app.plan.rows) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（先创建网格）';
    sel.appendChild(o);
    return;
  }
  for (let y = 0; y < app.plan.rows; y++) {
    for (let x = 0; x < app.plan.cols; x++) {
      const id = `${x},${y}`;
      const lab = app.plan.labels[id] || {};
      const f = lab.front || '', b = lab.back || '';
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `原格(${id})` + (f || b ? `  正:${f || '空'} / 反:${b || '空'}` : '');
      sel.appendChild(o);
    }
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderPathfind() {
  refreshPathCells();
  const btn = $('pathSearchBtn');
  const status = $('pathStatus');
  if (!app.plan.rows) {
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  if (app.plan.rows > 4 || app.plan.cols > 4) {
    btn.disabled = true;
    status.className = 'hint path-status-err';
    status.textContent = `自动寻路仅支持不超过 4×4 的网格（当前为 ${app.plan.rows}×${app.plan.cols}）。`;
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  // 末态合法性：当前方案全部步骤必须可回放
  const full = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  if (full.error) {
    btn.disabled = true;
    status.className = 'hint path-status-err';
    status.textContent = `当前方案第 ${full.error.stepIndex + 1} 步非法（${
      full.error.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}），请先修正后再寻路。`;
    $('pathResults').hidden = true;
    app.pathfind.result = null;
    return;
  }
  btn.disabled = false;
  if (!app.pathfind.result) {
    status.className = 'hint';
    status.textContent = '从当前方案全部步骤的末态开始搜索；搜索不会改动当前步骤。';
    $('pathResults').hidden = true;
  } else if (app.pathfind.sig !== pathfindSignature() || app.pathfind.target !== `${$('pathCell').value}|${$('pathFace').value}`) {
    // 方案或目标变化后旧结果作废
    app.pathfind.result = null;
    renderPathfind();
    return;
  } else {
    renderPathResults(app.pathfind.result);
  }
}

/** 点击搜索：先显示“搜索中”，下一帧再执行同步 BFS（≤2s），避免界面无反馈。 */
function runPathfind() {
  if (!app.plan.rows || app.plan.rows > 4 || app.plan.cols > 4) return;
  if (!$('pathCell').value) return;
  const btn = $('pathSearchBtn');
  btn.disabled = true;
  $('pathStatus').className = 'hint';
  $('pathStatus').textContent = '搜索中…（最多 8 步、2 秒）';
  $('pathResults').hidden = true;
  setTimeout(doPathfindSearch, 20);
}

function doPathfindSearch() {
  const target = { cell: $('pathCell').value, face: $('pathFace').value };
  const status = $('pathStatus');
  let result;
  try {
    result = E.findFoldPath(
      app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
      target, { maxDepth: 8, timeoutMs: 2000 });
  } catch (e) {
    result = { ok: false, code: 'bad_prefix', message: e.message };
  }
  $('pathSearchBtn').disabled = false;
  if (!result.ok) {
    status.className = 'hint path-status-err';
    status.textContent = '无法搜索：' + result.message;
    app.pathfind.result = null;
    $('pathResults').hidden = true;
    return;
  }
  app.pathfind.result = result;
  app.pathfind.sig = pathfindSignature();
  app.pathfind.target = `${target.cell}|${target.face}`;
  renderPathResults(result);
}

function renderPathResults(result) {
  const status = $('pathStatus');
  const box = $('pathResults');
  box.innerHTML = '';
  if (!result.solved) {
    box.hidden = true;
    status.className = 'hint path-status-err';
    if (result.reason === 'no_solution') {
      status.textContent = `无解：${result.message}`;
    } else {
      status.textContent = `搜索超限：${result.message}`;
    }
    return;
  }
  box.hidden = false;
  status.className = 'hint path-status-ok';
  const faceName = result.solutions[0].coverFace === 'front' ? '正面' : '反面';
  status.textContent =
    `找到 ${result.solutions.length} 条等长最短方案：各需 ${result.depth} 个后续步骤` +
    `，封面 = 原格(${result.solutions[0].topPanel}) 的${faceName}朝上（共枚举 ${result.searched.states} 个状态）。`;

  result.solutions.forEach((sol, i) => {
    const card = document.createElement('div');
    card.className = 'path-sol';
    const head = document.createElement('div');
    head.className = 'path-sol-head';
    const title = document.createElement('b');
    title.textContent = `方案 ${i + 1}（${sol.steps.length} 步）`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `收成于格(${sol.finalCell})`;
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = '追加到当前步骤并回放';
    addBtn.addEventListener('click', () => appendPathSolution(sol));
    head.append(title, meta, addBtn);
    card.appendChild(head);

    const ol = document.createElement('ol');
    ol.className = 'path-step-list';
    sol.steps.forEach((st, j) => {
      const li = document.createElement('li');
      li.textContent = `第 ${app.plan.steps.length + j + 1} 步：${E.describeStep(st)}`;
      ol.appendChild(li);
    });
    card.appendChild(ol);
    box.appendChild(card);
  });
}

/** 把任一搜索方案追加为后续步骤，进入既有回放流程（末态）。 */
function appendPathSolution(sol) {
  if (reviewBlocked()) return;
  if (!app.pathfind.result || app.pathfind.sig !== pathfindSignature()) return;
  for (const st of sol.steps) {
    const base = E.replay(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps).state;
    if (E.validateFold(base, st)) return;   // 理论上不会发生（方案由合法路径给出）
    app.plan.steps.push({ axis: st.axis, line: st.line, dir: st.dir });
  }
  app.pathfind.result = null;   // 末态已变，旧结果作废
  clearFoldError();
  setUpto(app.plan.steps.length, true);
  $('saveMsg').textContent = '已把自动寻路方案追加到当前步骤，可继续编辑或保存。';
}

// ---------- 面片轨迹 ----------
/** 重建“原始纸格”下拉（仅网格尺寸变化时重建，尽量保留选择）。 */
function refreshTrackCells() {
  const key = `${app.plan.rows}x${app.plan.cols}`;
  if (app.track.gridKey === key) return;
  app.track.gridKey = key;
  const sel = $('trackCell');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!app.plan.rows) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（先创建网格）';
    sel.appendChild(o);
    return;
  }
  for (let y = 0; y < app.plan.rows; y++) {
    for (let x = 0; x < app.plan.cols; x++) {
      const id = `${x},${y}`;
      const lab = app.plan.labels[id] || {};
      const f = lab.front || '', b = lab.back || '';
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `原格(${id})` + (f || b ? `  正:${f || '空'} / 反:${b || '空'}` : '');
      sel.appendChild(o);
    }
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/**
 * 渲染面片轨迹卡片。
 * 网格、标注或步骤变化后由 render() 自动调用，重新计算时间线。
 * @param forceCell/forceFace 下拉 change 时显式指定选择
 */
function renderTrack(forceCell, forceFace) {
  refreshTrackCells();
  const status = $('trackStatus');
  const box = $('trackTimeline');
  if (!app.plan.rows) {
    app.track.result = null;
    app.track.target = null;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    box.hidden = true;
    box.innerHTML = '';
    draw();
    return;
  }
  const cell = forceCell != null ? forceCell : $('trackCell').value;
  const face = forceFace != null ? forceFace : $('trackFace').value;
  if (forceCell != null) $('trackCell').value = cell;
  if (forceFace != null) $('trackFace').value = face;
  if (!cell) {
    app.track.result = null;
    app.track.target = null;
    status.className = 'hint';
    status.textContent = '请选择一个原始纸格与其正/反面。';
    box.hidden = true;
    draw();
    return;
  }

  const result = E.trackPanel(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps,
    { cell, face: face === 'back' ? 'back' : 'front' });
  if (!result.ok) {
    app.track.result = null;
    app.track.target = null;
    status.className = 'hint track-status-err';
    status.textContent = result.message;
    box.hidden = true;
    draw();
    return;
  }

  app.track.result = result;
  app.track.target = { cell, face: result.target.face };

  status.className = 'hint' + (result.interrupted ? ' track-status-err' : ' track-status-ok');
  const faceName = result.target.face === 'front' ? '正面' : '反面';
  status.innerHTML = result.interrupted
    ? `追踪原格(${cell}) 的${faceName}：第 ${result.interrupted.stepIndex + 1} 步非法` +
      `（${result.interrupted.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}），` +
      `时间线在第 ${result.points.length - 1} 步后中断。`
    : `追踪原格(${cell}) 的${faceName}：共 ${result.points.length - 1} 步，` +
      `当前末态位于格(${result.points[result.points.length - 1].cell})。`;

  renderTrackTimeline(result);
  draw();
}

function renderTrackTimeline(result) {
  const box = $('trackTimeline');
  box.innerHTML = '';
  box.hidden = false;
  const lastValidStep = result.points[result.points.length - 1].step;
  const currentStep = app.upto <= lastValidStep ? app.upto : lastValidStep;
  const stalled = app.upto > lastValidStep;   // 回放停在中断步（非法）上

  result.points.forEach((p, i) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'track-node'
      + (p.step === currentStep ? ' current' : '')
      + (stalled && p.step === lastValidStep ? ' stalled' : '')
      + (p.step > currentStep ? ' future' : '');
    const up = p.faceUp ? '朝上' : '朝下';
    const upright = p.upright
      ? '正立'
      : '<span class="track-inv">倒置</span>';
    const labelTxt = p.label == null ? '空白' : escapeHtml(p.label);
    node.innerHTML =
      `<span class="track-step">第 ${p.step} 步</span>` +
      `<span class="track-cell">格(${p.cell})</span>` +
      `<span class="track-meta">层 <b>${p.layer}/${p.depth}</b></span>` +
      `<span class="track-meta ${p.faceUp ? 'track-up' : 'track-down'}">` +
        `${result.target.face === 'front' ? '正' : '反'}${up}</span>` +
      `<span class="track-meta">${upright}</span>` +
      `<span class="track-label">${labelTxt}</span>`;
    node.title = `定位到第 ${p.step} 步回放，并高亮原格(${result.target.cell})`;
    node.addEventListener('click', () => jumpTrackPoint(p.step));
    box.appendChild(node);

    if (i < result.points.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'track-arrow';
      arrow.textContent = '→';
      box.appendChild(arrow);
    }
  });

  if (result.interrupted) {
    const it = result.interrupted;
    const arrow = document.createElement('span');
    arrow.className = 'track-arrow';
    arrow.textContent = '→';
    box.appendChild(arrow);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'track-node break' + (stalled ? ' current' : ' future');
    stop.innerHTML =
      `<span class="track-step">第 ${it.stepIndex + 1} 步</span>` +
      `<span class="track-stop">⛔ 中断</span>` +
      `<span class="track-reason">${it.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}</span>` +
      (it.conflicts.length ? `<span class="track-reason">冲突 ${it.conflicts.slice(0, 4).map(escapeHtml).join('、')}${
        it.conflicts.length > 4 ? '…' : ''}</span>` : '');
    stop.title = escapeHtml(it.message) + '\n点击定位到中断前的最后一步。';
    stop.addEventListener('click', () => jumpTrackPoint(lastValidStep));
    box.appendChild(stop);
  }
}

/** 点击时间线节点：联动既有回放定位到该步（节点面板由 draw 按目标身份高亮）。 */
function jumpTrackPoint(step) {
  setUpto(step, true);
}

// ---------- 双面印刷版预览 ----------
/** 渲染右侧卡片：可用性、禁用原因。 */
function renderDuplex() {
  const btn = $('duplexOpenBtn');
  const status = $('duplexStatus');
  if (!app.plan.rows) {
    app.duplex.eligible = null;
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格并完成折叠。';
    syncDuplexOverlay();
    return;
  }
  const elig = E.duplexEligibility(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.duplex.eligible = elig;
  if (elig.ok) {
    btn.disabled = false;
    status.className = 'hint duplex-status-ok';
    status.textContent = `可生成双面版：当前方案合法且已收成单叠（容量 ${elig.capacity} 面）。`;
  } else {
    btn.disabled = true;
    status.className = 'hint duplex-status-err';
    status.textContent = elig.code === 'not_single_stack'
      ? `禁用预览：尚未收成单叠（${elig.message}）`
      : `禁用预览：${elig.message}`;
  }
  syncDuplexOverlay();
}

/** 打开覆盖层并生成两版。 */
function openDuplex() {
  if (!app.duplex.eligible || !app.duplex.eligible.ok) return;
  app.duplex.flip = $('duplexFlip').value === 'short' ? 'short' : 'long';
  $('duplexFlipOverlay').value = app.duplex.flip;
  app.duplex.open = true;
  $('duplexOverlay').hidden = false;
  renderDuplexPreview();
}

function closeDuplex() {
  app.duplex.open = false;
  $('duplexOverlay').hidden = true;
  app.duplex.result = null;
  app.duplex.sig = null;
}

/**
 * 覆盖层打开期间方案被改动（回放/编辑/存取都会触发 render）：
 * 若几何签名变化则即时重算；变得不可用时自动关闭并给出原因。
 */
function syncDuplexOverlay() {
  if (!app.duplex.open) return;
  if (!app.duplex.eligible || !app.duplex.eligible.ok) {
    closeDuplex();
    return;
  }
  if (!app.duplex.result || app.duplex.sig !== planSignature()
      || app.duplex.result.flip !== app.duplex.flip) {
    renderDuplexPreview();
  }
}

/** 依据当前方案与翻面方式生成两版并填充 DOM。 */
function renderDuplexPreview() {
  if (!app.duplex.open) return;
  const result = E.buildDuplexPlates(
    app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, app.duplex.flip);
  if (!result.ok) { closeDuplex(); return; }
  app.duplex.result = result;
  app.duplex.sig = planSignature();

  const flipText = result.flip === 'long'
    ? '长边翻转：沿纸张<b>竖边</b>左右翻面（打印机选“双面 / 沿长边翻页”）'
    : '短边翻转：沿纸张<b>横边</b>上下翻面（打印机选“双面 / 沿短边翻页 / 翻转”）';
  $('duplexScreenNote').innerHTML = flipText;

  const mirrorText = result.flip === 'long' ? '背面版须左右镜像' : '背面版须上下镜像';
  $('plateFrontMeta').textContent =
    `${result.rows} 行 × ${result.cols} 列 · 纸格按原始行列位置排列 · 坐标为“列,行”（0 基）`;
  $('plateBackMeta').textContent =
    `${result.rows} 行 × ${result.cols} 列 · ${mirrorText} · 坐标为“列,行”（0 基）`;

  renderPlateSheet($('plateFrontSheet'), result.front, result);
  renderPlateSheet($('plateBackSheet'), result.back, result);
}

function renderPlateSheet(sheetEl, plate, result) {
  sheetEl.innerHTML = '';
  sheetEl.style.gridTemplateColumns = `repeat(${result.cols}, minmax(0, 1fr))`;
  sheetEl.style.setProperty('--plate-rows', String(result.rows));
  // 屏幕上行高不指定：交由格内 aspect-ratio:1/1 推出，避免 fr 行在 auto 高度容器中塌陷；
  // 打印样式改为等分行铺满一页（见 styles.css @media print）。

  for (const row of plate.grid) {
    for (const c of row) {
      const cell = document.createElement('div');
      cell.className = 'plate-cell face-' + c.face + (c.blank ? ' blank-cell' : '');
      cell.dataset.origin = c.origin;
      cell.dataset.face = c.face;

      const origin = document.createElement('span');
      origin.className = 'cell-origin';
      origin.textContent = `原格(${c.origin})`;

      const face = document.createElement('span');
      face.className = 'cell-face';
      face.textContent = c.face === 'front' ? '正面' : '反面';

      const rot = document.createElement('span');
      rot.className = 'cell-rot ' + (c.rotate ? 'r180' : 'r0');
      rot.textContent = c.rotate ? '⟲ 旋转 180°' : '0° 不转';
      rot.title = c.rotate
        ? '制版时把该面整体旋转 180°（倒置补偿，折叠后阅读正立）'
        : '制版时保持原朝向';

      const glyph = document.createElement('span');
      glyph.className = 'glyph' + (c.rotate ? ' rot180' : '') + (c.blank ? ' blank' : '');
      glyph.textContent = c.blank ? '空白面（占位）' : c.label;

      cell.append(origin, face, glyph, rot);
      sheetEl.appendChild(cell);
    }
  }

  // 翻转边标识（彩条）：长边=竖边，短边=横边；背面在镜像后的对边
  const edge = document.createElement('div');
  edge.className = 'flip-edge';
  const bar = document.createElement('span');
  bar.className = 'edge-bar' + (result.flip === 'short' ? ' short-edge' : '');
  const txt = document.createElement('span');
  const sideName = { left: '左竖边', right: '右竖边', top: '上横边', bottom: '下横边' }[plate.edge];
  txt.innerHTML = `翻面装订边：<b>${sideName}</b>` +
    (plate.mirrored
      ? `（背面视图；该边即印刷后沿之翻面的${result.flip === 'long' ? '长边' : '短边'}）`
      : `（正面视图；与背面版${result.flip === 'long' ? '左' : '下'}边为同一条${result.flip === 'long' ? '长' : '短'}边）`);
  edge.append(bar, txt);
  sheetEl.parentElement?.querySelectorAll('.flip-edge').forEach((n) => n.remove());
  sheetEl.parentElement?.appendChild(edge);
}

// ---------- 书帖爬移补偿 ----------
/**
 * 卡片始终基于“全部步骤回放末态”实时重算（与回放停在第几步无关），
 * 网格、折叠步骤或参数（纸厚/出血）变化后 render() 自动调用。
 * 应用（“应用补偿”）后才把参数与逐面偏移写入 plan.creepCompensation 独立字段。
 */
function creepBasisSignature() {
  return JSON.stringify({ r: app.plan.rows, c: app.plan.cols, s: app.plan.steps });
}

function fmtNum(n) {
  return String(Math.round(n * 1000) / 1000);
}

/** 用当前末态 + 输入参数计算爬移补偿（参数非法时给出引擎错误对象）。 */
function computeCreep() {
  const t = Number($('creepThickness').value);
  const b = Number($('creepBleed').value);
  return {
    t, b,
    result: E.creepCompensation(
      app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps, t, b)
  };
}

/** 已应用方案与当前几何/参数是否仍一致（current 为非法结果时只判几何签名）。 */
function creepSchemeStale(scheme, result) {
  if (!scheme) return false;
  if (scheme.basis && scheme.basis.stepsSignature !== creepBasisSignature()) return true;
  if (!result) return true;
  const p = scheme.params || {};
  return Number(p.paperThickness) !== result.paperThickness || Number(p.bleed) !== result.bleed;
}

function renderCreep() {
  const btn = $('creepApplyBtn');
  const clearBtn = $('creepClearBtn');
  const status = $('creepStatus');
  const summary = $('creepSummary');
  const appliedBox = $('creepApplied');
  const wrap = $('creepTableWrap');
  const tbody = $('creepRows');
  const scheme = app.plan.creepCompensation || null;
  clearBtn.hidden = !scheme;

  if (!app.plan.rows) {
    app.creep.eligible = null;
    app.creep.result = null;
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格并完成折叠。';
    summary.hidden = true;
    appliedBox.hidden = true;
    wrap.hidden = true;
    tbody.innerHTML = '';
    return;
  }

  const { result } = computeCreep();
  app.creep.result = result;

  if (!result.ok) {
    app.creep.eligible = result;
    btn.disabled = true;
    status.className = 'hint creep-status-err';
    if (result.code === 'bad_thickness' || result.code === 'bad_bleed') {
      status.textContent = '禁用应用：' + result.message;
    } else if (result.code === 'not_single_stack') {
      status.textContent = `禁用应用：尚未收成单叠（${result.message}）`;
    } else {
      status.textContent = `禁用应用：存在非法折叠${
        result.stepIndex != null ? `（第 ${result.stepIndex + 1} 步）` : ''}：${result.message}`;
    }
    summary.hidden = true;
    wrap.hidden = true;
    tbody.innerHTML = '';
    renderCreepApplied(scheme, null);
    return;
  }

  app.creep.eligible = { ok: true };
  renderCreepTable(result);
  renderCreepSummary(result);
  btn.disabled = !result.canApply;
  status.className = 'hint ' + (result.canApply ? 'creep-status-ok' : 'creep-status-err');
  if (result.canApply) {
    status.textContent = `可应用：最大补偿 ${fmtNum(result.maxCompensation)}（${
      result.leafCount} 叶），所有偏移均在可用出血 ${fmtNum(result.bleed)} 以内。`;
  } else {
    status.textContent =
      `禁用应用：${result.overBleedCount} 个面的偏移绝对值超过可用出血 ${fmtNum(result.bleed)}` +
      '（下表红色行），请加大出血或改用更薄纸张。';
  }
  renderCreepApplied(scheme, result);
}

function renderCreepSummary(result) {
  const box = $('creepSummary');
  const spineName = { left: '左缘（竖折脊）', right: '右缘（竖折脊）', top: '上缘（横折脊）', bottom: '下缘（横折脊）' }[result.spineSide];
  box.hidden = false;
  box.innerHTML =
    `书脊位置：<b>${spineName || '未折叠（无书脊）'}</b>；内容沿前口→书脊方向逐叶内移。` +
    `共 <b>${result.leafCount}</b> 叶，最外叶补偿 0，<b>最大补偿 = 纸厚 ${
      fmtNum(result.paperThickness)} × ${Math.max(0, result.leafCount - 1)} = ${
      fmtNum(result.maxCompensation)}</b>。偏移单位与输入一致（如 mm）。`;
}

function renderCreepTable(result) {
  const wrap = $('creepTableWrap');
  const tbody = $('creepRows');
  wrap.hidden = false;
  tbody.innerHTML = '';
  result.leaves.forEach((lf) => {
    const over = lf.front.overBleed || lf.back.overBleed;
    const tr = document.createElement('tr');
    tr.className = (over ? 'creep-over ' : '')
      + (lf.leafIndex === 0 ? 'leaf-cover' : '')
      + (lf.leafIndex === result.leaves.length - 1 ? ' leaf-center' : '');

    const layerName = lf.leafIndex === 0 ? `${lf.leafIndex}（最外叶·封面）`
      : lf.leafIndex === result.leaves.length - 1 ? `${lf.leafIndex}（最内叶·中缝）`
      : String(lf.leafIndex);
    const axisName = lf.axis === 'x' ? '横' : '纵';
    const faceCell = (f) => {
      const sign = f.offset > 0 ? '+' : '';
      return `<span title="${f.dx === 0 ? '' : '原格 dx=' + fmtNum(f.dx) + '；'}${f.dy === 0 ? '' : '原格 dy=' + fmtNum(f.dy)}">` +
        `${sign}${fmtNum(f.offset)} <span class="creep-axis">${axisName}</span>${f.overBleed ? ' ⚠超出血' : ''}</span>`;
    };
    tr.innerHTML =
      `<td>${layerName}</td>` +
      `<td>格(${lf.origin})</td>` +
      `<td class="num">${lf.outsideCount}</td>` +
      `<td class="num">${fmtNum(lf.creep)}</td>` +
      `<td class="num creep-off">${faceCell(lf.front)}</td>` +
      `<td class="num creep-off">${faceCell(lf.back)}</td>`;
    tbody.appendChild(tr);
  });
}

/** 已应用方案提示：保留时显示参数与状态；几何/参数已变时标黄提示需重新应用。 */
function renderCreepApplied(scheme, current) {
  const box = $('creepApplied');
  if (!scheme) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  const stale = creepSchemeStale(scheme, current);
  box.className = 'creep-applied' + (stale ? ' stale' : '');
  const faceCount = Object.keys(scheme.faces || {}).length;
  box.innerHTML = stale
    ? `⚠ 已应用的爬移补偿（纸厚 ${scheme.params.paperThickness}、出血 ${scheme.params.bleed}，` +
      `${faceCount} 个原始纸格）与当前网格/步骤/参数不一致：字段仍随方案保留，` +
      '请在参数修正后重新“应用补偿”，或“清除已应用”。'
    : `✓ 已应用爬移补偿：纸厚 ${scheme.params.paperThickness}、出血 ${scheme.params.bleed}，` +
      `最大补偿 ${scheme.maxCompensation != null ? scheme.maxCompensation : '—'}，` +
      `逐面偏移已写入方案独立字段（${faceCount} 个原始纸格），保存/导入/服务端载入均保留。`;
}

/** 应用：把当前参数与逐面偏移固化到 plan.creepCompensation 独立字段。 */
function applyCreep() {
  if (reviewBlocked()) return;
  const { result } = computeCreep();
  if (!result.ok || !result.canApply) return;
  const faces = {};
  for (const lf of result.leaves) {
    faces[lf.origin] = {
      front: lf.front.offset,
      back: lf.back.offset,
      axis: lf.axis,
      creep: lf.creep
    };
  }
  app.plan.creepCompensation = {
    params: { paperThickness: result.paperThickness, bleed: result.bleed },
    spineAxis: result.spineAxis,
    spineSide: result.spineSide,
    maxCompensation: result.maxCompensation,
    faces,
    basis: {
      rows: result.rows,
      cols: result.cols,
      stepsSignature: creepBasisSignature()
    },
    appliedAt: new Date().toISOString()
  };
  renderCreep();
  $('saveMsg').textContent =
    `已应用书帖爬移补偿（${result.leaves.length} 叶，最大补偿 ${fmtNum(result.maxCompensation)}），记得保存方案。`;
}

/** 清除已应用字段（实时明细表仍按当前参数展示）。 */
function clearCreep() {
  if (reviewBlocked()) return;
  delete app.plan.creepCompensation;
  renderCreep();
  $('saveMsg').textContent = '已清除爬移补偿独立字段（需保存方案后生效）。';
}

// ---------- 生产质量审计 ----------
/**
 * 渲染审计卡片：始终对“全部步骤”完整重放（与回放停在第几步无关），
 * 结果只读；方案含非法步骤时仅报告首个错误，不展示后续检查结论。
 * 网格、标注或步骤变化后由 render() 自动重算。
 */
function renderAudit() {
  const verdictEl = $('auditVerdict');
  const status = $('auditStatus');
  const list = $('auditFindings');
  const clusterList = $('auditClusters');
  const toolbar = $('auditToolbar');
  const exportBtn = $('auditExportBtn');
  if (!app.plan.rows) {
    app.audit.result = null;
    resetAuditClusters();
    verdictEl.className = 'audit-verdict idle';
    verdictEl.textContent = '未审计';
    status.className = 'hint';
    status.textContent = '先在左侧创建行列纸格。';
    list.hidden = true;
    list.innerHTML = '';
    clusterList.hidden = true;
    clusterList.innerHTML = '';
    toolbar.hidden = true;
    exportBtn.disabled = true;
    return;
  }
  const result = E.auditPlan(app.plan.rows, app.plan.cols, app.plan.labels, app.plan.steps);
  app.audit.result = result;
  exportBtn.disabled = false;

  if (!result.ok) {
    verdictEl.className = 'audit-verdict blocked';
    verdictEl.textContent = '⛔ 审计中止';
    status.className = 'hint audit-status-err';
    status.textContent = `第 ${result.stepIndex + 1} 步非法（${
      result.code === 'thickness' ? '厚度不一致' : '折线不在外轮廓'}）：` +
      '仅报告首个错误，不伪造后续检查结论；修正非法步骤后自动重新审计。';
    list.hidden = true;
    list.innerHTML = '';
    resetAuditClusters();
    clusterList.hidden = true;
    clusterList.innerHTML = '';
    toolbar.hidden = true;
    draw();
    return;
  }

  // 只读派生视图：问题簇按稳定成员 key 重算并复用既有簇编号；
  // 正在只读查看历史快照时以快照内随版本保存的簇为谱系（历史身份不重排），
  // 否则沿用上一次重算的簇（草稿编辑过程中编号稳定）。
  const snapshotSeed = isReviewing() && app.review.view && app.review.view.snapshot
    ? (Array.isArray(app.review.view.snapshot.auditClusters)
      ? app.review.view.snapshot.auditClusters : null)
    : null;
  recomputeAuditClusters(snapshotSeed);

  const s = result.summary;
  verdictEl.className = 'audit-verdict ' + (result.verdict === 'pass' ? 'pass' : 'fail');
  verdictEl.textContent = result.verdict === 'pass' ? '✓ 可发布' : '✗ 需修订';
  status.className = 'hint ' + (result.verdict === 'pass' ? 'audit-status-ok' : 'audit-status-err');
  const cs = app.audit.clusters;
  const clusterText = cs.length
    ? `聚类为 ${cs.length} 个问题簇（${cs.filter((c) => c.severity === 'error').length} 错误簇 / ` +
      `${cs.filter((c) => c.severity === 'warning').length} 警告簇，点簇可在画布联动高亮）。`
    : '未形成问题簇。';
  status.textContent =
    `完整重放 ${result.stats.steps} 步：错误 ${s.errors} 条、警告 ${s.warnings} 条` +
    `（容量 ${result.stats.capacity} 面，已标注 ${result.stats.labeledFaces} 面）。` +
    (result.verdict === 'pass' ? ' 结论：可发布。' : ' 结论：需修订后再交付。') + ' ' + clusterText;

  toolbar.hidden = false;
  renderAuditFindingsList();
  renderAuditClusters();
  draw();
}

/** 逐条问题列表（既有视图，内容仍直接来自只读审计结果）。 */
function renderAuditFindingsList() {
  const result = app.audit.result;
  const list = $('auditFindings');
  list.innerHTML = '';
  list.hidden = app.audit.view !== 'findings';
  if (!result || !result.ok) { list.hidden = true; return; }
  if (!result.findings.length) {
    const li = document.createElement('li');
    li.className = 'audit-item info';
    li.innerHTML = '<span class="audit-msg">全部检查通过：未发现空白 / 重复 / 倒置页码、' +
      '分离叠层、未覆盖纸格或容量异常。</span>';
    list.appendChild(li);
    return;
  }
  const sevName = { error: '错误', warning: '警告', info: '提示' };
  for (const f of result.findings) {
    const li = document.createElement('li');
    li.className = 'audit-item ' + f.severity;
    const head = document.createElement('div');
    head.className = 'audit-head';
    head.innerHTML = `<span class="sev ${f.severity}">${sevName[f.severity] || f.severity}</span>` +
      `<span class="audit-title">${escapeHtml(f.title)}</span>`;
    li.appendChild(head);
    const msg = document.createElement('div');
    msg.className = 'audit-msg';
    msg.textContent = f.message;
    li.appendChild(msg);
    if (f.cells && f.cells.length) {
      const cells = document.createElement('div');
      cells.className = 'audit-cells';
      const shown = f.cells.slice(0, 8);
      for (const c of shown) {
        const chip = document.createElement('span');
        chip.className = 'cell-chip';
        chip.textContent = `原格(${c})`;
        cells.appendChild(chip);
      }
      if (f.cells.length > shown.length) {
        const more = document.createElement('span');
        more.className = 'cell-chip';
        more.textContent = `+${f.cells.length - shown.length}`;
        cells.appendChild(more);
      }
      li.appendChild(cells);
    }
    list.appendChild(li);
  }
}

/**
 * 重算簇并按成员 key 复用编号：客户端始终用本地产出的成员内容，
 * prev 只提供 id 与可能已消失成员的说明（快照数据仅用于身份复用，不展示）。
 * @param forcedSeed 非空时强制作为复用基线（查看历史快照 / 新载入方案）；
 *                   不传则沿用上一次重算的簇，保证草稿连续编辑时编号稳定。
 */
function recomputeAuditClusters(forcedSeed) {
  const result = app.audit.result;
  if (!result || !result.ok) { resetAuditClusters(); return; }
  const fresh = E.buildAuditClusters(result);
  const prev = forcedSeed || app.audit.clusters;
  app.audit.clusters = E.reconcileAuditClusters(fresh, prev, app.audit.nextClusterId || 1);
  if (app.audit.clusters.length) {
    app.audit.nextClusterId = Math.max(
      ...app.audit.clusters.map((c) => Number(String(c.id).slice(1)) || 0)) + 1;
  }
  if (app.audit.selectedClusterId &&
      !app.audit.clusters.some((c) => c.id === app.audit.selectedClusterId)) {
    app.audit.selectedClusterId = null;
  }
}

function resetAuditClusters() {
  app.audit.clusters = [];
  app.audit.selectedClusterId = null;
}

function setAuditView(view) {
  app.audit.view = view;
  $('auditViewFindings').classList.toggle('active', view === 'findings');
  $('auditViewClusters').classList.toggle('active', view === 'clusters');
  if (app.audit.result && app.audit.result.ok) {
    renderAuditFindingsList();
    renderAuditClusters();
  }
}

function clusterPassesFilter(c) {
  switch (app.audit.severityFilter) {
    case 'error': return c.severity === 'error';
    case 'warning': return c.severity === 'warning';
    case 'error-warning': return c.severity === 'error' || c.severity === 'warning';
    default: return true;
  }
}

/** 渲染问题簇视图：严重级别筛选 + 成员（含本次重算新增/移除）+ 点选联动。 */
function renderAuditClusters() {
  const clusterList = $('auditClusters');
  clusterList.innerHTML = '';
  const show = app.audit.view === 'clusters' && app.audit.result && app.audit.result.ok;
  clusterList.hidden = !show;
  $('auditClusterSeverity').value = app.audit.severityFilter;
  if (!show) return;
  const clusters = app.audit.clusters.filter(clusterPassesFilter);
  if (!app.audit.clusters.length) {
    const li = document.createElement('li');
    li.className = 'audit-item info';
    li.innerHTML = '<span class="audit-msg">当前审计没有问题，因此没有问题簇。</span>';
    clusterList.appendChild(li);
    return;
  }
  if (!clusters.length) {
    const li = document.createElement('li');
    li.className = 'audit-item info';
    li.innerHTML = '<span class="audit-msg">当前严重级别筛选下没有问题簇。</span>';
    clusterList.appendChild(li);
    return;
  }
  const sevName = { error: '错误簇', warning: '警告簇', info: '提示簇' };
  const slotText = (m) => {
    if (!m.slots || !m.slots.length) return m.cell ? `原格(${m.cell})` : '全局';
    return `槽位 ${m.slots.join('、')}` + (m.stack != null ? `（叠层 ${m.stack}）` : '')
      + (m.cell ? ` · 原格(${m.cell})` : '');
  };
  for (const c of clusters) {
    const li = document.createElement('li');
    li.className = `cluster-item ${c.severity}` +
      (app.audit.selectedClusterId === c.id ? ' selected' : '');
    li.dataset.clusterId = c.id;

    const head = document.createElement('div');
    head.className = 'cluster-head';
    head.innerHTML = `<span class="cluster-id">${escapeHtml(c.id)}</span>` +
      `<span class="sev ${c.severity}">${sevName[c.severity] || c.severity}</span>` +
      `<span class="cluster-title">${escapeHtml(c.title)}</span>` +
      `<span class="cluster-count">${c.memberCount} 个成员 · ${c.cells.length} 个原格</span>`;
    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'cluster-meta';
    const parts = [];
    if (c.slots.length) parts.push(`阅读槽位：${c.slots.join('、')}`);
    if (c.cells.length) parts.push(`受影响原格：${c.cells.join('、')}`);
    if (c.stacks.length > 1) parts.push(`跨叠层：${c.stacks.join('、')}`);
    meta.textContent = parts.join('　');
    li.appendChild(meta);

    const ul = document.createElement('ul');
    ul.className = 'cluster-members';
    const addMember = (m, cls) => {
      const mi = document.createElement('li');
      if (cls) mi.className = cls;
      mi.textContent = `${slotText(m)} — ${m.message || c.title}`;
      ul.appendChild(mi);
    };
    for (const m of c.members) {
      addMember(m, c.added.some((a) => a.key === m.key) ? 'member-add' : '');
    }
    for (const m of c.removed) addMember(m, 'member-remove');
    li.appendChild(ul);

    if (c.added.length || c.removed.length) {
      const hint = document.createElement('div');
      hint.className = 'cluster-change-hint';
      hint.textContent = `相对上次重算：新增 ${c.added.length}、移除 ${c.removed.length} 个成员` +
        '（簇编号按稳定成员身份复用，未误合并）。';
      li.appendChild(hint);
    }

    li.addEventListener('click', () => selectAuditCluster(c.id));
    clusterList.appendChild(li);
  }
}

/** 点簇：画布联动高亮簇内全部受影响原始纸格（再次点击同簇取消）。 */
function selectAuditCluster(id) {
  app.audit.selectedClusterId = app.audit.selectedClusterId === id ? null : id;
  renderAuditClusters();
  draw();
}

/** 当前选中簇引用（供画布高亮）。 */
function selectedAuditCluster() {
  const id = app.audit.selectedClusterId;
  return id ? app.audit.clusters.find((c) => c.id === id) || null : null;
}

/**
 * 审计簇画布定位：把簇内受影响原始纸格按身份映射到当前回放状态，
 * 返回 Map<当前格位key, { origins:Set<原始纸格> }>，与差异高亮机制一致。
 */
function currentAuditClusterMap(state) {
  const map = new Map();
  const c = selectedAuditCluster();
  if (!c || !state || !c.cells.length) return map;
  for (const origin of c.cells) {
    const p = state.panels[origin];
    if (!p) continue;
    const at = p.cx + ',' + p.cy;
    if (!state.stacks[at]) continue;
    if (!map.has(at)) map.set(at, { origins: new Set() });
    map.get(at).origins.add(origin);
  }
  return map;
}

/** 导出审计报告 JSON（方案 + 审计结果，只读不改动方案）。 */
function exportAudit() {
  const result = app.audit.result;
  if (!result) return;
  const report = {
    name: $('planName').value || '未命名方案',
    generatedAt: new Date().toISOString(),
    plan: planPayload(),
    annotations: planPayload().annotations,
    annotationSummary: E.annotationStats(planPayload().annotations),
    audit: result,
    auditClusters: app.audit.clusters
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fold-audit-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('saveMsg').textContent = '已导出生产质量审计报告 JSON。';
}

// ---------- 错误提示 ----------
function showFoldError(err) {
  const box = $('foldError');
  box.hidden = false;
  box.textContent =
    (err.code === 'thickness' ? '⛔ 拒绝执行：两侧厚度不一致。' : '⛔ 拒绝执行：折线不在当前外轮廓。')
    + '\n' + err.message
    + (err.conflicts.length ? `\n冲突纸格：${[...new Set(err.conflicts)].join('、')}（画布中红底标出）` : '');
}
function clearFoldError() { $('foldError').hidden = true; }

// ---------- 标签 / 备注 ----------
/** 添加单个标签：先在前端按服务端同一份规则预校验/规范化（去重、限量、限长、禁字符）。 */
function addTag(raw) {
  if (reviewBlocked()) return false;
  const tag = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!tag) { $('saveMsg').textContent = '标签不能为空。'; return false; }
  if ([...tag].length > E.META_LIMITS.MAX_TAG_LEN) {
    $('saveMsg').textContent = `单个标签最多 ${E.META_LIMITS.MAX_TAG_LEN} 字符。`;
    return false;
  }
  if (/[\p{C},;|]/u.test(tag)) {
    $('saveMsg').textContent = '标签不能包含控制字符或 , ; | 等分隔符。';
    return false;
  }
  if (app.plan.tags.includes(tag)) { $('saveMsg').textContent = `标签“${tag}”已存在。`; return false; }
  if (app.plan.tags.length >= E.META_LIMITS.MAX_TAGS) {
    $('saveMsg').textContent = `每个方案最多 ${E.META_LIMITS.MAX_TAGS} 个标签。`;
    return false;
  }
  app.plan.tags.push(tag);
  renderTagChips();
  return true;
}

function addTagFromInput() {
  const input = $('tagInput');
  if (addTag(input.value)) input.value = '';
  input.focus();
}

function removeTag(tag) {
  if (reviewBlocked()) return;
  app.plan.tags = app.plan.tags.filter((t) => t !== tag);
  renderTagChips();
}

function clearTags() {
  if (reviewBlocked()) return;
  if (!app.plan.tags.length) return;
  app.plan.tags = [];
  renderTagChips();
  $('saveMsg').textContent = '已清除全部标签（保存方案后生效）。';
}

function renderTagChips() {
  const box = $('tagChips');
  box.innerHTML = '';
  app.plan.tags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const txt = document.createElement('span');
    txt.className = 'tag-chip-name';
    txt.textContent = tag;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tag-chip-x';
    x.title = '删除该标签';
    x.textContent = '×';
    x.addEventListener('click', () => removeTag(tag));
    chip.append(txt, x);
    box.appendChild(chip);
  });
  if (!app.plan.tags.length) {
    const empty = document.createElement('span');
    empty.className = 'muted tag-empty';
    empty.textContent = '尚无标签（可添加 0～8 个）';
    box.appendChild(empty);
  }
  $('tagCountHint').textContent = `${app.plan.tags.length} / ${E.META_LIMITS.MAX_TAGS} 个标签`;
}

// ---------- 存取 ----------
function planPayload() {
  const p = {
    name: $('planName').value || '未命名方案',
    rows: app.plan.rows,
    cols: app.plan.cols,
    labels: app.plan.labels,
    steps: app.plan.steps,
    tags: app.plan.tags,
    note: $('planNote').value,
    annotations: Array.isArray(app.plan.annotations) ? app.plan.annotations : []
  };
  // 爬移补偿独立方案字段：应用后随保存/导出保留
  if (app.plan.creepCompensation) p.creepCompensation = app.plan.creepCompensation;
  // 从历史版本恢复后首次保存：记录新版本派生自哪个历史版本（仅元信息）
  if (app.restoredFrom) p.restoredFrom = app.restoredFrom;
  return p;
}

function applyPlan(plan, id) {
  const p = E.normalizePlan(plan);
  app.plan = p;
  app.loadedId = id || null;
  app.annotation.editing = null;
  app.annotation.selectedId = null;
  app.audit.clusters = [];              // 新载入方案：簇谱系从全新编号开始
  app.audit.selectedClusterId = null;
  app.audit.nextClusterId = 1;
  $('annoOpenOnly').checked = false;
  $('annoSeverityFilter').value = '';
  $('annoFaceFilter').value = '';
  $('planName').value = p.name;
  $('rowsInput').value = p.rows;
  $('colsInput').value = p.cols;
  $('planNote').value = p.note || '';
  renderTagChips();
  // 载入已应用的爬移补偿方案：回填参数输入框（逐面偏移在独立字段中保留）
  if (p.creepCompensation && p.creepCompensation.params) {
    $('creepThickness').value = p.creepCompensation.params.paperThickness;
    $('creepBleed').value = p.creepCompensation.params.bleed;
  }
  refreshLineSelect();
  setUpto(p.steps.length, true);
  $('deletePlanBtn').hidden = !id;
  $('reviewVersionsBtn').disabled = !id;   // 仅服务器存档有不可变版本历史
  app.restoredFrom = null;
  $('saveMsg').textContent = id
    ? `已载入服务器存档 ${id}（批注 ${p.annotations.length} 条${
      snapshotHasVersion(p) ? `，当前为版本 v${p.version}` : ''}）`
    : `已载入 JSON 文件（批注 ${p.annotations.length} 条）`;
}

function snapshotHasVersion(p) {
  return Number.isInteger(p && p.version) && p.version >= 1;
}

async function savePlan() {
  if (reviewBlocked()) return;
  if (!app.plan.rows) { $('saveMsg').textContent = '请先创建网格。'; return; }
  // 与服务端同一份严格校验：非法标签/过长输入在本地即被拦下，请求也不会改动旧存档
  try {
    E.normalizePlanMeta(planPayload());
  } catch (e) {
    $('saveMsg').textContent = '保存被拒绝：' + e.message;
    return;
  }
  // 批注同样走严格校验（任一条非法都整请求拒绝）
  try {
    E.normalizeAnnotations(planPayload().annotations, {
      rows: app.plan.rows, cols: app.plan.cols, steps: app.plan.steps
    });
  } catch (e) {
    $('saveMsg').textContent = '保存被拒绝：' + e.message;
    return;
  }
  try {
    const resp = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...planPayload(), id: app.loadedId || undefined })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error.message);
    app.loadedId = data.id;
    app.restoredFrom = null;   // 已作为新版本落盘，恢复来源仅记录在该版本元信息上
    app.plan.tags = data.plan.tags;
    if (Array.isArray(data.plan.annotations)) app.plan.annotations = data.plan.annotations;
    // 审计簇编号以服务端落盘快照为准（下次重算沿该谱系复用）
    if (Array.isArray(data.plan.auditClusters)) {
      app.audit.clusters = data.plan.auditClusters;
      app.audit.nextClusterId = Math.max(1,
        ...data.plan.auditClusters.map((c) => Number(String(c.id).slice(1)) || 0)) + 1;
    }
    $('deletePlanBtn').hidden = false;
    $('reviewVersionsBtn').disabled = false;
    $('saveMsg').textContent = `已保存：${data.id}（版本 v${data.version}，${new Date().toLocaleTimeString()}）`;
    // 列表若处于打开状态则自动刷新（沿用当前筛选）
    if (!$('planList').hidden) loadList();
  } catch (e) {
    $('saveMsg').textContent = '保存失败：' + e.message;
  }
}

function exportPlan() {
  if (!app.plan.rows) { $('saveMsg').textContent = '请先创建网格。'; return; }
  const blob = new Blob([JSON.stringify(planPayload(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fold-plan-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importPlan(e) {
  if (reviewBlocked()) return;
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyPlan(JSON.parse(reader.result), null);
    } catch (err) {
      alert('方案 JSON 无法载入：\n' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/** 按当前筛选条件拉取存档列表（标签交集 / 名称关键词 / 最近更新时间）。 */
async function loadList() {
  const ul = $('planList');
  ul.hidden = false;
  $('planFilter').hidden = false;
  ul.innerHTML = '<li class="muted">加载中…</li>';
  const params = new URLSearchParams();
  if (app.listFilter.tags) params.set('tags', app.listFilter.tags);
  if (app.listFilter.q) params.set('q', app.listFilter.q);
  if (app.listFilter.since) {
    params.set('since', String(Date.now() - Number(app.listFilter.since)));
  }
  const qs = params.toString();
  try {
    const resp = await fetch('/api/plans' + (qs ? `?${qs}` : ''));
    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
    renderPlanList(data);
  } catch (e) {
    ul.innerHTML = `<li class="muted">读取失败：${escapeHtml(e.message)}</li>`;
  }
}

function renderPlanList(data) {
  const ul = $('planList');
  ul.innerHTML = '';
  const filtering = app.listFilter.tags || app.listFilter.q || app.listFilter.since;
  $('planFilterMsg').textContent = filtering
    ? `筛选命中 ${data.matched} / ${data.total} 个存档（按最近更新时间排序）`
    : `共 ${data.total} 个存档（按最近更新时间排序）`;
  if (!data.items.length) {
    ul.innerHTML = `<li class="muted">${filtering ? '没有符合筛选条件的存档' : '服务器上还没有存档'}</li>`;
    return;
  }
  data.items.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'plan-list-item';

    const main = document.createElement('div');
    main.className = 'plan-item-main';
    const info = document.createElement('div');
    info.className = 'plan-item-info';
    const annoPart = it.annotations
      ? ` · 批注 ${it.openAnnotations != null ? it.openAnnotations + ' 未解决 / ' : ''}${it.annotations}`
      : '';
    info.textContent = `${it.name}（${it.rows}×${it.cols}，${it.steps} 步${annoPart}）`;
    const meta = document.createElement('div');
    meta.className = 'plan-item-meta muted';
    meta.textContent = `更新于 ${new Date(it.updatedAt).toLocaleString()}`;

    const tagBox = document.createElement('div');
    tagBox.className = 'plan-item-tags';
    (it.tags || []).forEach((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip tag-chip-link';
      chip.title = `按标签“${tag}”筛选`;
      chip.textContent = '#' + tag;
      chip.addEventListener('click', () => {
        const cur = $('filterTags').value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!cur.includes(tag)) cur.push(tag);
        $('filterTags').value = cur.join(',');
        $('filterApplyBtn').click();
      });
      tagBox.appendChild(chip);
    });
    if (it.note) {
      const note = document.createElement('div');
      note.className = 'plan-item-note muted';
      note.textContent = it.note;
      note.title = it.note;
      main.append(info, tagBox, note, meta);
    } else {
      main.append(info, tagBox, meta);
    }

    const btn = document.createElement('button');
    btn.textContent = '载入';
    btn.addEventListener('click', async () => {
      const r = await fetch(`/api/plans/${it.id}`);
      applyPlan(await r.json(), it.id);
    });
    li.append(main, btn);
    ul.appendChild(li);
  });
}

async function deleteLoaded() {
  if (reviewBlocked()) return;
  if (!app.loadedId) return;
  if (!confirm('确定删除服务器上的该存档？')) return;
  await fetch(`/api/plans/${app.loadedId}`, { method: 'DELETE' });
  app.loadedId = null;
  app.restoredFrom = null;
  $('deletePlanBtn').hidden = true;
  $('reviewVersionsBtn').disabled = true;
  $('saveMsg').textContent = '已删除存档及其全部版本历史（本地方案仍保留）';
  if (!$('planList').hidden) loadList();
}

// ---------- 版本差异审阅 ----------
const KIND_NAME = { add: '新增', remove: '删除', modify: '修改' };
const FIELD_NAME = {
  name: '方案名称', note: '备注', tag: '标签',
  cell: '原始纸格', face: '面别', severity: '严重级别',
  text: '批注正文', step: '回放步', resolved: '解决状态'
};

/** 打开审阅覆盖层：拉取当前存档的版本列表（仅有服务端存档时可用）。 */
async function openReview() {
  if (!app.loadedId) { $('saveMsg').textContent = '请先保存方案到服务器，再进行版本差异审阅。'; return; }
  const msg = $('reviewMsg');
  msg.textContent = '加载版本列表…';
  $('reviewOverlay').hidden = false;
  app.review.open = true;
  try {
    const data = await fetchJson(`/api/plans/${encodeURIComponent(app.loadedId)}/versions`);
    app.review.versions = data.items || [];
    populateVersionSelects();
    if (app.review.versions.length < 2) {
      msg.textContent = '该存档目前只有 1 个版本：再次“保存到服务器”后即可比较不同版本。';
      $('reviewDiffList').innerHTML = '';
      $('reviewSummary').textContent = '';
    } else {
      msg.textContent = `共 ${app.review.versions.length} 个不可变版本，选择两个版本进行比较。`;
      await computeReviewDiff();
    }
  } catch (e) {
    msg.textContent = '加载版本列表失败：' + e.message;
  }
}

function closeReview() {
  if (isReviewing()) exitVersionView();
  app.review.open = false;
  app.review.versions = [];
  app.review.fromV = app.review.toV = null;
  app.review.diff = null;
  app.review.highlightCells = [];
  app.review.highlightCell = null;
  $('reviewOverlay').hidden = true;
  draw();
}

/** 用版本摘要填充两个下拉（A 默认倒数第二版、B 默认最新版）。 */
function populateVersionSelects() {
  const versions = app.review.versions;
  const fill = (sel, selected) => {
    sel.innerHTML = '';
    versions.forEach((v) => {
      const o = document.createElement('option');
      o.value = String(v.version);
      o.textContent = versionOptionText(v);
      sel.appendChild(o);
    });
    sel.value = String(selected);
  };
  const latest = versions[versions.length - 1].version;
  const prev = versions.length >= 2 ? versions[versions.length - 2].version : latest;
  fill($('reviewFromSel'), app.review.fromV || prev);
  fill($('reviewToSel'), app.review.toV || latest);
  app.review.fromV = Number($('reviewFromSel').value);
  app.review.toV = Number($('reviewToSel').value);
}

function versionOptionText(v) {
  const t = v.savedAt ? new Date(v.savedAt).toLocaleString() : '时间未知';
  const restore = v.restoredFrom ? `（恢复自 v${v.restoredFrom}）` : '';
  return `v${v.version} · ${t}${restore} · ${v.steps} 步`;
}

function onReviewSelectChange() {
  // 切换比较版本前先退出只读查看，回到草稿视图再重算差异
  if (isReviewing()) exitVersionView();
  app.review.fromV = Number($('reviewFromSel').value);
  app.review.toV = Number($('reviewToSel').value);
  computeReviewDiff();
}

function swapReviewSides() {
  const f = $('reviewFromSel'), t = $('reviewToSel');
  const fv = f.value; f.value = t.value; t.value = fv;
  onReviewSelectChange();
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
  return data;
}

/** 请求服务端比较两个版本，并渲染差异列表 + 画布高亮。 */
async function computeReviewDiff() {
  if (!app.review.fromV || !app.review.toV || app.review.fromV === app.review.toV) {
    $('reviewMsg').textContent = '请选择两个<b>不同</b>的版本进行比较。';
    $('reviewDiffList').innerHTML = '';
    $('reviewSummary').textContent = '';
    return;
  }
  $('reviewMsg').textContent = '计算差异…';
  try {
    const data = await fetchJson(
      `/api/plans/${encodeURIComponent(app.loadedId)}/versions/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: app.review.fromV, to: app.review.toV })
      });
    app.review.diff = data.diff;
    app.review.highlightCells = data.diff.affectedCells || [];
    app.review.highlightCell = null;
    renderReviewDiff(data.diff);
    draw();
  } catch (e) {
    $('reviewMsg').textContent = '差异计算失败：' + e.message;
  }
}

/** 渲染分组差异列表（元信息 / 正反页码 / 折叠步骤 / 校样批注）。 */
function renderReviewDiff(diff) {
  const list = $('reviewDiffList');
  list.innerHTML = '';
  const s = diff.summary;
  const parts = [];
  const part = (label, c) => {
    const n = c.add + c.remove + c.modify;
    if (n) parts.push(`${label} ${n}（+${c.add} / −${c.remove} / 改${c.modify}）`);
  };
  part('页码面', s.labels); part('折叠步', s.steps); part('批注', s.annotations);
  if (s.meta) parts.push(`元信息 ${s.meta}`);
  if (diff.grid) parts.push('网格尺寸 1');
  $('reviewSummary').textContent = parts.length ? parts.join('　') : '两版本完全相同';
  $('reviewMsg').textContent =
    `点击任一差异项可只读查看该版本并联动回放；紫色虚线圈出受影响原始纸格。`;

  if (!s.total && !diff.grid) {
    const empty = document.createElement('div');
    empty.className = 'review-empty';
    empty.textContent = '两个版本之间没有差异。';
    list.appendChild(empty);
    return;
  }

  const addGroup = (title, count, entries) => {
    if (!entries.length) return;
    const h = document.createElement('div');
    h.className = 'review-group-title';
    h.textContent = title;
    const chip = document.createElement('span');
    chip.className = 'review-count-chip';
    chip.textContent = String(entries.length);
    h.appendChild(chip);
    list.appendChild(h);
    entries.forEach((entry) => list.appendChild(renderReviewItem(entry)));
  };

  if (diff.grid) {
    addGroup('网格尺寸', 1, [{
      kind: 'modify', section: 'meta',
      head: '网格尺寸',
      bodyHtml: `${diff.grid.from.rows}×${diff.grid.from.cols} → ` +
        `<span class="new">${diff.grid.to.rows}×${diff.grid.to.cols}</span>`,
      cells: []
    }]);
  }
  addGroup('元信息（名称 / 备注 / 标签）', diff.meta.length, diff.meta.map(metaReviewEntry));
  addGroup('正反页码（按原始纸格）', diff.labels.length, diff.labels.map(labelReviewEntry));
  addGroup('折叠步骤（按步骤序号）', diff.steps.length, diff.steps.map(stepReviewEntry));
  addGroup('校样批注', diff.annotations.length, diff.annotations.map(annotationReviewEntry));
}

function reviewBadge(kind) {
  return `<span class="review-badge k-${kind}">${KIND_NAME[kind] || kind}</span>`;
}

function valueHtml(v) {
  const s = v == null || v === '' ? null : escapeHtml(String(v));
  return s == null ? '<span class="blank">空白</span>' : s;
}

function metaReviewEntry(e) {
  let body = '';
  if (e.field === 'tag') {
    body = `${FIELD_NAME.tag}：${e.kind === 'add' ? '<span class="new">#' : '<span class="old">#'}` +
      `${escapeHtml(e.value)}</span>`;
  } else if (e.field === 'name' || e.field === 'note') {
    body = `${FIELD_NAME[e.field]}：${valueHtml(e.from)} → ${valueHtml(e.to)}`;
  }
  return {
    kind: e.kind, section: 'meta',
    head: FIELD_NAME[e.field] || '元信息',
    bodyHtml: body, cells: []
  };
}

function labelReviewEntry(e) {
  const faceName = e.face === 'front' ? '正面' : '反面';
  let body;
  if (e.kind === 'add') body = `${faceName}页码：${valueHtml('')} → ${valueHtml(e.to)}`;
  else if (e.kind === 'remove') body = `${faceName}页码：${valueHtml(e.from)} → ${valueHtml(e.to)}`;
  else body = `${faceName}页码：<span class="old">${valueHtml(e.from)}</span> → <span class="new">${valueHtml(e.to)}</span>`;
  return {
    kind: e.kind, section: 'labels', entry: e,
    head: `原格(${e.cell}) · ${faceName}`,
    bodyHtml: body,
    cells: [e.cell]
  };
}

function stepReviewEntry(e) {
  const text = (side) => e[side] && e[side + 'Text'] ? escapeHtml(e[side + 'Text'])
    : e[side] ? `${e[side].axis || '?'} 线 ${e[side].line} ${e[side].dir || '?'}` : '<span class="blank">（无此步）</span>';
  const body = e.kind === 'add'
    ? `新增步骤：${text('to')}`
    : e.kind === 'remove'
      ? `删除步骤：${text('from')}`
      : `${text('from')} → <span class="new">${text('to')}</span>`;
  const cells = [...new Set([...(e.fromCells || []), ...(e.toCells || [])])];
  return {
    kind: e.kind, section: 'steps', entry: e,
    head: `第 ${e.index + 1} 步`,
    bodyHtml: body,
    cells
  };
}

function annotationReviewEntry(e) {
  const title = `原格(${e.cell || '?'}) · ${e.face === 'front' ? '正面' : e.face === 'back' ? '反面' : '?'}`;
  let body;
  if (e.kind === 'add' || e.kind === 'remove') {
    const rec = e.to || e.from || {};
    body = `${SEVERITY_NAME[rec.severity] || ''}批注：${escapeHtml(String(rec.text || ''))}` +
      (rec.step != null ? `（创建于第 ${rec.step} 步${rec.resolved ? '，已解决' : ''}）` : '');
  } else {
    body = e.fields.map((f) => {
      const fmt = (v) => f.field === 'resolved' ? (v ? '已解决' : '未解决')
        : f.field === 'severity' ? (SEVERITY_NAME[v] || v) : valueHtml(v);
      return `${FIELD_NAME[f.field] || f.field}：<span class="old">${fmt(f.from)}</span> → <span class="new">${fmt(f.to)}</span>`;
    }).join('<br>');
  }
  return {
    kind: e.kind, section: 'annotations', entry: e,
    head: title,
    bodyHtml: body,
    cells: e.cell ? [e.cell] : []
  };
}

/** 构造单个差异列表项并绑定“点击 → 只读查看对应版本并联动回放”。 */
function renderReviewItem(view) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `review-item k-${view.kind}`;
  item.innerHTML =
    `<div class="review-item-head">${reviewBadge(view.kind)}<span>${escapeHtml(view.head)}</span></div>` +
    `<div class="review-item-body">${view.bodyHtml}</div>` +
    (view.cells && view.cells.length
      ? `<div class="review-item-cells">受影响纸格：${view.cells.map((c) => `(${c})`).join('、')}</div>`
      : '');
  item.title = '点击：只读查看该版本（差异侧），并联动回放/定位到对应位置';
  item.addEventListener('click', () => {
    document.querySelectorAll('.review-item.active').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    focusReviewEntry(view);
  });
  return item;
}

/**
 * 点击差异项：进入（或切换）只读版本查看。
 * 纸格类差异（页码/批注/步骤）查看“新版本 B”，回放定位到相关步并高亮具体纸格；
 * 纯元信息/网格差异同样打开 B 版本查看（无单步可定位）。
 */
async function focusReviewEntry(view) {
  const section = view.section;
  // 删除类差异：要看的内容在旧版本 A；其余看新版本 B
  const targetVersion = view.kind === 'remove' ? app.review.fromV : app.review.toV;
  try {
    await enterVersionView(targetVersion);
  } catch (e) {
    $('reviewBanner').hidden = true;
    $('reviewMsg').textContent = '版本载入失败：' + e.message;
    return;
  }

  const e = view.entry || {};
  let step = null;
  let cell = null;
  if (section === 'labels') {
    step = app.plan.steps.length;
    cell = e.cell;
  } else if (section === 'annotations') {
    // 定位到批注创建时所在回放步；删除类查看 A 版本时用 from 记录
    const rec = view.kind === 'remove' ? e.from : e.to;
    step = Math.min(Number(rec && rec.step) || 0, app.plan.steps.length);
    cell = e.cell;
  } else if (section === 'steps') {
    step = Math.min(e.index + (view.kind === 'add' ? 0 : 1), app.plan.steps.length);
    app.review.highlightCells = view.cells || [];
  } else {
    app.review.highlightCells = app.review.diff.affectedCells || [];
  }
  if (section === 'labels' || section === 'annotations') {
    app.review.highlightCells = app.review.diff.affectedCells || [];
    app.review.highlightCell = cell && (app.review.highlightCells || []).includes(cell) ? cell : null;
  } else if (section === 'steps') {
    app.review.highlightCell = null;
  }
  if (step != null) setUpto(step, true);
  else draw();
}

/** 拉取指定版本快照，暂存当前草稿并把画布切换为该版本的只读视图。 */
async function enterVersionView(version) {
  const bannerText = $('reviewBannerText');
  $('reviewBanner').hidden = false;
  bannerText.textContent = `正在载入版本 v${version}…`;
  const data = await fetchJson(
    `/api/plans/${encodeURIComponent(app.loadedId)}/versions/${version}`);
  const snapshot = data.snapshot;

  // 首次进入查看：暂存当前草稿（同一轮审阅中只暂存一次，反复点差异项不会丢草稿）
  if (!app.review.view) {
    app.review.draft = {
      plan: JSON.parse(JSON.stringify(app.plan)),
      upto: app.upto,
      loadedId: app.loadedId,
      name: $('planName').value,
      note: $('planNote').value
    };
  }
  const p = E.normalizePlan(snapshot);
  app.plan = p;
  app.annotation.editing = null;
  app.annotation.selectedId = null;
  $('planName').value = p.name;
  $('rowsInput').value = p.rows;
  $('colsInput').value = p.cols;
  $('planNote').value = p.note || '';
  renderTagChips();
  if (p.creepCompensation && p.creepCompensation.params) {
    $('creepThickness').value = p.creepCompensation.params.paperThickness;
    $('creepBleed').value = p.creepCompensation.params.bleed;
  }
  refreshLineSelect();
  // 切到历史快照：审计簇谱系改以快照内保存的簇为基线（见 renderAudit）
  app.audit.clusters = [];
  app.audit.selectedClusterId = null;
  app.audit.nextClusterId = 1;
  app.review.view = { version, snapshot };
  const v = app.review.versions.find((x) => x.version === version) || {};
  bannerText.innerHTML =
    `只读查看 <b>v${version}</b>（${v.savedAt ? new Date(v.savedAt).toLocaleString() : ''}）` +
    ` · ${escapeHtml(p.name)} · ${p.rows}×${p.cols} · ${p.steps.length} 步` +
    ` · 批注 ${p.annotations.length} 条。<br>此为<b>不可变历史快照</b>，画布可回放但不能编辑；` +
    '恢复为草稿不影响任何历史版本。';
  setUpto(p.steps.length, true);
}

/** 退出只读查看：恢复进入审阅前的草稿与回放步。 */
function exitVersionView() {
  const d = app.review.draft;
  if (d) {
    app.plan = d.plan;
    app.loadedId = d.loadedId;
    $('planName').value = d.name;
    $('rowsInput').value = d.plan.rows;
    $('colsInput').value = d.plan.cols;
    $('planNote').value = d.note;
    renderTagChips();
    if (d.plan.creepCompensation && d.plan.creepCompensation.params) {
      $('creepThickness').value = d.plan.creepCompensation.params.paperThickness;
      $('creepBleed').value = d.plan.creepCompensation.params.bleed;
    }
    refreshLineSelect();
    setUpto(Math.min(d.upto, d.plan.steps.length), true);
  }
  app.review.view = null;
  app.review.draft = null;
  // 回到草稿：放弃快照簇谱系，按当前草稿重算（强制重新编号，避免与草稿谱系串号）
  app.audit.clusters = [];
  app.audit.selectedClusterId = null;
  app.audit.nextClusterId = 1;
  app.review.highlightCell = null;
  app.review.highlightCells = app.review.diff ? app.review.diff.affectedCells : [];
  $('reviewBanner').hidden = true;
  document.querySelectorAll('.review-item.active').forEach((n) => n.classList.remove('active'));
  draw();
}

/** 点击“恢复此版本为当前草稿”：先弹确认（草稿有未保存改动会额外警示），不直接覆盖历史。 */
function askRestoreVersion() {
  if (!app.review.view) return;
  const v = app.review.view.version;
  $('restoreConfirmText').innerHTML =
    `将把历史版本 <b>v${v}</b> 的完整内容（网格、正反页码、折叠步骤、标签备注、校样批注）` +
    '复制为当前<b>草稿</b>，并退出只读查看。<br>' +
    '历史版本<b>不会被改动或删除</b>；恢复后的草稿在你再次“保存到服务器”时才会成为一个新版本。';
  const warn = $('restoreConfirmWarn');
  // 当前草稿相对服务器 head 可能有未保存修改：恢复会丢弃这些本地改动
  const headVersion = app.review.versions.length ? app.review.versions[app.review.versions.length - 1].version : null;
  if (app.review.draft) {
    warn.hidden = false;
    warn.textContent = '注意：你进入审阅前正在编辑的草稿尚未作为新版本保存，恢复后这些本地改动将被替换' +
      (headVersion ? '（服务器上的历史版本不受影响）。' : '。');
  } else {
    warn.hidden = true;
  }
  $('restoreConfirm').hidden = false;
}

/** 确认恢复：用当前查看的快照内容覆盖工作区草稿（历史只读、不受影响），沿用既有保存流程。 */
function confirmRestoreVersion() {
  if (!app.review.view) return;
  const snapshot = app.review.view.snapshot;
  const version = app.review.view.version;
  // 清掉只读暂存：exitVersionView 不再恢复旧草稿；loadedId 保留以延续版本谱系
  const keepId = app.loadedId;
  app.review.draft = null;
  app.review.view = null;
  $('restoreConfirm').hidden = true;
  $('reviewBanner').hidden = true;
  app.review.highlightCell = null;
  app.review.highlightCells = app.review.diff ? app.review.diff.affectedCells : [];
  document.querySelectorAll('.review-item.active').forEach((n) => n.classList.remove('active'));

  applyPlan(snapshot, keepId);
  app.restoredFrom = version;
  app.review.highlightCells = [];
  app.review.highlightCell = null;
  app.review.diff = null;
  app.review.fromV = app.review.toV = null;
  draw();
  $('saveMsg').textContent =
    `已把历史版本 v${version} 恢复为当前草稿（历史版本保持不变）；检查/回放后点“保存到服务器”即生成新版本。`;
}

init();

// 暴露给自动化检查（浏览器中无害）
if (typeof window !== 'undefined') {
  window.__foldApp = Object.assign(app, {
    requestStep, setUpto, createGrid, render, getFoldError: () => $('foldError'),
    applyPlan, planPayload,
    addTag, removeTag, clearTags, renderTagChips,
    loadList, renderPlanList,
    previewImposition, confirmImposition, closeImposition, renderImposition,
    readImposeInputs, runPathfind, doPathfindSearch, appendPathSolution, renderPathfind,
    renderTrack, refreshTrackCells, jumpTrackPoint, currentTrackInfo,
    openDuplex, closeDuplex, renderDuplex, renderDuplexPreview,
    renderCreep, computeCreep, applyCreep, clearCreep, creepSchemeStale,
    renderAudit, exportAudit,
    renderAuditClusters, selectAuditCluster, setAuditView,
    selectedAuditCluster, currentAuditClusterMap,
    recomputeAuditClusters, resetAuditClusters,
    openAnnotationEditor, closeAnnotationEditor, commitAnnotation,
    deleteEditingAnnotation, setAnnotationResolved, deleteAnnotation,
    locateAnnotation, renderAnnotations, annotationLocations, currentAnnotationMarks,
    annotations,
    // 版本差异审阅
    openReview, closeReview, swapReviewSides, onReviewSelectChange,
    computeReviewDiff, renderReviewDiff, focusReviewEntry,
    enterVersionView, exitVersionView, askRestoreVersion, confirmRestoreVersion,
    isReviewing, reviewBlocked, currentDiffCellMap, diffPlans: E.diffPlans
  });
}
