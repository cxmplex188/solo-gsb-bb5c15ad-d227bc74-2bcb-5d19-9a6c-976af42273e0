'use strict';
/**
 * foldEngine.js —— 纯逻辑折叠模拟引擎（无 DOM 依赖，可独立单元测试）
 *
 * 模型约定
 * --------
 * 1. 一张 rows × cols 的行列纸格，每格(leaf)为一片纸：
 *      front: 正面页码（纸张的 +z 面）
 *      back : 反面页码（纸张的 -z 面）
 *    页码均为字符串，空串表示该面空白。
 *
 * 2. 每个状态中，被占用的格位(cell)上叠放若干面片(panel，即折后叶子)。
 *    stack[cell] 自上而下排列：index 0 = 最上层。
 *
 * 3. 每个面片带一个 3×3 朝向标架 {x, y, n}，均为单位向量：
 *      x：面片自身“右”方向在世界坐标中的投影
 *      y：面片自身“下”方向在世界坐标中的投影
 *      n：面片正面法线
 *    初始为 {x:(1,0,0), y:(0,1,0), n:(0,0,1)}。
 *
 * 4. 折叠步骤 { axis:'v'|'h', line:number, dir:'l'|'r'|'u'|'d' }
 *      line=k：位于第 k-1 与第 k 列/行之间的网格线（1 ≤ k < 列数/行数）。
 *      dir：纸瓣翻转后“落向”的一侧——
 *      axis='v'：dir='r' 左瓣向右翻过竖线（移动 cx<line 的格），dir='l' 右瓣向左翻；
 *      axis='h'：dir='d' 上瓣向下翻（移动 cy<line 的格），dir='u' 下瓣向上翻。
 *    每次折叠都是 180°，移动侧格位镜像到另一侧并叠放。
 *
 * 拒绝规则（两类冲突，不执行折叠）
 *  --------
 *    contour   折线不在当前外轮廓上：移动侧为空，或移动侧镜像后出现悬空
 *              （目标格在当前外轮廓之外 / 折线跨度上没有成对的格位）。
 *    thickness 两侧厚度不一致：镜像落点的静止侧层数与移动侧层数不相等
 *              （包折、不等厚折法被拒绝，这正是印张折手要排查的情况）。
 */

// ---------- 小工具 ----------
function key(x, y) { return `${x},${y}`; }
function neg(a) {
  const nz = (v) => (v === 0 ? 0 : -v);   // 避免出现 -0
  return { x: nz(a.x), y: nz(a.y), z: nz(a.z) };
}

function initialState(rows, cols, labels) {
  rows = Math.max(1, Math.floor(rows));
  cols = Math.max(1, Math.floor(cols));
  const panels = {};
  const stacks = {};
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const id = key(x, y);
      const lab = (labels && labels[id]) || {};
      panels[id] = {
        id,
        ox: x, oy: y,
        cx: x, cy: y,                 // 当前所在格位
        front: lab.front != null ? String(lab.front) : '',
        back: lab.back != null ? String(lab.back) : '',
        frame: {
          x: { x: 1, y: 0, z: 0 },
          y: { x: 0, y: 1, z: 0 },
          n: { x: 0, y: 0, z: 1 }
        }
      };
      stacks[key(x, y)] = [id];
    }
  }
  return { rows, cols, panels, stacks };
}

function cloneState(s) {
  return {
    rows: s.rows,
    cols: s.cols,
    panels: Object.fromEntries(Object.entries(s.panels).map(([id, p]) =>
      [id, { ...p, frame: { x: { ...p.frame.x }, y: { ...p.frame.y }, n: { ...p.frame.n } } }])),
    stacks: Object.fromEntries(Object.entries(s.stacks).map(([k, arr]) => [k, arr.slice()]))
  };
}

/**
 * 坐标约定：格位使用 0 基索引，折线 line=k 是第 k-1 与第 k 列/行之间的网格线，
 * 因此关于该线的镜像为 i' = 2k - 1 - i（0→1，2→1，依此类推）。
 */
function reflectIndex(i, line) { return 2 * line - 1 - i; }

/**
 * 校验一次折叠。
 * @returns null 表示可执行；否则 { code:'contour'|'thickness', message, conflicts:[cellKey,...] }
 */
function validateFold(state, step) {
  const { axis, line, dir } = step;
  const dirOk = axis === 'v' ? (dir === 'l' || dir === 'r') : (dir === 'u' || dir === 'd');
  if (!dirOk) {
    return { code: 'contour', message: '折叠方向与折线方向不匹配', conflicts: [] };
  }
  if (axis === 'v' && (line <= 0 || line >= state.cols || !Number.isInteger(line))) {
    return { code: 'contour', message: `竖直折线 x=${line} 超出当前网格 [0, ${state.cols}]`, conflicts: [] };
  }
  if (axis === 'h' && (line <= 0 || line >= state.rows || !Number.isInteger(line))) {
    return { code: 'contour', message: `水平折线 y=${line} 超出当前网格 [0, ${state.rows}]`, conflicts: [] };
  }

  // 方向 = 纸瓣翻动后落向的一侧：
  //   dir='r'（向右折）移动左瓣(cx<line)；dir='l' 移动右瓣(cx>line)；
  //   dir='d'（向下折）移动上瓣(cy<line)；dir='u' 移动下瓣(cy>line)。
  const sideByDir = { r: 'l', l: 'r', d: 'u', u: 'd' };
  const movingSide = sideByDir[dir];
  const occupied = new Set(Object.keys(state.stacks));
  const moving = [];
  for (const cell of occupied) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r')
                              : (cy < line ? 'u' : 'd');
    if (side !== movingSide) continue;
    const tx = axis === 'v' ? reflectIndex(cx, line) : cx;
    const ty = axis === 'h' ? reflectIndex(cy, line) : cy;
    moving.push({ from: cell, fx: cx, fy: cy, to: key(tx, ty), tx, ty, depth: state.stacks[cell].length });
  }

  if (moving.length === 0) {
    return { code: 'contour', message: '折线该侧没有面片，折线不在当前外轮廓上', conflicts: [] };
  }

  // —— 外轮廓检查 ——
  // 每个移动格镜像后的落点必须是当前已占用格位：要么压到静止瓣格位，
  // 要么与另一移动格配对（等宽对折时瓣内两列镜像到同一格列）。
  // 只要有移动格镜像到空格位，就是越过当前外轮廓的悬空折（包含宽瓣
  // 越过静止块边缘、折线位于纸片内部缝隙等情况）。
  const contourConflicts = new Set();
  const movingFrom = new Set(moving.map((m) => m.from));
  for (const m of moving) {
    const targetIsMoving = movingFrom.has(m.to);
    const targetIsStill = occupied.has(m.to) && !targetIsMoving;
    if (!targetIsMoving && !targetIsStill) {
      contourConflicts.add(m.from);
      contourConflicts.add(m.to);
    }
  }
  if (contourConflicts.size) {
    return {
      code: 'contour',
      message: '折线不在当前外轮廓上：移动纸格镜像后落到轮廓之外（悬空纸格）',
      conflicts: [...contourConflicts]
    };
  }

  // —— 厚度一致性检查 ——
  // 移动格压到静止格位时，两侧层数必须相等（等厚折帖）；
  // 落点只是另一移动格（瓣内配对）时，配对两侧都是同一移动瓣，不做对比。
  const thicknessConflicts = new Set();
  let mismatch = false;
  for (const m of moving) {
    if (movingFrom.has(m.to)) continue;
    const stillDepth = state.stacks[m.to].length;
    if (stillDepth !== m.depth) {
      mismatch = true;
      thicknessConflicts.add(m.from);
      thicknessConflicts.add(m.to);
    }
  }
  if (mismatch) {
    return {
      code: 'thickness',
      message: '折线两侧厚度不一致：目标格层数与移动格层数不相等（疑似包折/不等厚折）',
      conflicts: [...thicknessConflicts]
    };
  }
  return null;
}

/** 执行折叠（调用前先 validateFold）。返回新状态。 */
function applyFold(state, step) {
  const bad = validateFold(state, step);
  if (bad) {
    const e = new Error(bad.message);
    e.code = bad.code;
    e.conflicts = bad.conflicts;
    throw e;
  }
  const { axis, line, dir } = step;
  const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[dir];
  const next = cloneState(state);

  // 收集移动侧
  const movers = [];
  for (const cell of Object.keys(next.stacks)) {
    const [cx, cy] = cell.split(',').map(Number);
    const side = axis === 'v' ? (cx < line ? 'l' : 'r')
                              : (cy < line ? 'u' : 'd');
    if (side !== movingSide) continue;
    movers.push({ cell, cx, cy });
  }

  for (const m of movers) {
    const ids = next.stacks[m.cell];
    const tx = axis === 'v' ? reflectIndex(m.cx, line) : m.cx;
    const ty = axis === 'h' ? reflectIndex(m.cy, line) : m.cy;
    const toCell = key(tx, ty);

    // 翻转 180°：面片标架分量取负
    for (const id of ids) {
      const p = next.panels[id];
      if (axis === 'v') {
        p.frame.x = neg(p.frame.x);
        p.frame.n = neg(p.frame.n);
      } else {
        p.frame.y = neg(p.frame.y);
        p.frame.n = neg(p.frame.n);
      }
      p.cx = tx; p.cy = ty;
    }
    delete next.stacks[m.cell];

    // 翻面后整个移动叠自身倒序，再整体压到静止叠上方
    const flipped = ids.slice().reverse();
    const still = next.stacks[toCell] || [];
    next.stacks[toCell] = flipped.concat(still);
  }
  return next;
}

/**
 * 重放方案到指定步数。
 * @returns { state, error:null | {stepIndex, code, message, conflicts} }
 */
function replay(rows, cols, labels, steps, upto) {
  let state = initialState(rows, cols, labels);
  if (upto == null) upto = steps.length;
  for (let i = 0; i < upto; i++) {
    const err = validateFold(state, steps[i]);
    if (err) return { state, error: { stepIndex: i, ...err } };
    state = applyFold(state, steps[i]);
  }
  return { state, error: null };
}

/**
 * 取某面片“朝上”（法线朝向观察者，世界 +z）的面及正立信息。
 * @returns { side:'front'|'back', upright:boolean }
 *   印刷约定：正反面按书页长边翻转排版（上下边对齐），两面字形的
 *   “下”方向都随面片标架 frame.y 走；从上方阅读时 frame.y 指向屏幕下方为正立。
 */
function visibleFace(p) {
  const nUp = p.frame.n.z > 0;                 // 正面法线朝观察者
  const side = nUp ? 'front' : 'back';
  return { side, upright: p.frame.y.y > 0 };
}

/**
 * 判定某面从纸张外侧正视（世界 +y 为页首方向）时是否正立。
 * 正反面上下边对齐排版，字形“下”方向都随 frame.y：投影指向屏幕下方即正立，
 * 反向即页码倒置 180°（典型的水平折朝向错误可被检出）。
 */
function faceUpright(p) {
  return p.frame.y.y > 0;
}

/**
 * 输出叠层“从封面到封底”的页码序列。
 * 折帖为骑马钉式嵌套叶序：自上而下逐片取朝上页面，到达最内片后
 * 再自下而上取各片朝下页面。
 *   序列 = [leaf1上, leaf2上, …, leafN上, leafN下, …, leaf2下, leaf1下]
 *
 * @returns {
 *   stacks: [{ cell, leaves:[{panelId, upper, lower}], sequence:[...] }],
 *   folded: boolean   // 是否已收成单叠
 * }
 */
function pageSequence(state) {
  const out = [];
  for (const [cell, ids] of Object.entries(state.stacks)) {
    const leaves = [];
    for (const id of ids) {
      const p = state.panels[id];
      const upperSide = p.frame.n.z > 0 ? 'front' : 'back';
      const lowerSide = upperSide === 'front' ? 'back' : 'front';
      const mk = (side) => {
        const label = p[side] === '' ? null : p[side];
        return { face: side, label, upright: faceUpright(p) };
      };
      leaves.push({ panelId: id, upper: mk(upperSide), lower: mk(lowerSide) });
    }
    const sequence = leaves.map((l) => l.upper.label)
      .concat(leaves.slice().reverse().map((l) => l.lower.label));
    out.push({ cell, leaves, sequence, depth: ids.length });
  }
  out.sort((a, b) => b.depth - a.depth || a.cell.localeCompare(b.cell));
  return { stacks: out, folded: out.length === 1 };
}

/**
 * 自动拼版
 * --------
 * 仅当方案“全部步骤可合法回放且收成单叠”时才可用：
 * 按最终封面→封底的阅读槽位（pageSequence 单叠序列）依次写入连续页码，
 * 再反向映射到每个原始纸格（ox,oy）的正面/反面，得到一份新的 labels。
 *
 * - startPage：成品起始页码（≥1 整数）；
 * - pageCount：成品页数（≥1 且不超过纸格总面数 2×rows×cols）；
 * - 序列末尾的剩余槽位留空白（pageCount < 容量时），
 *   空白槽位仍会在 slots 中返回，并标明所属原始纸格与面。
 */

/** 计算自动拼版前置状态：网格合法 + 全步回放无冲突 + 收成单叠。 */
function impositionEligibility(rows, cols, labels, steps) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return {
      ok: false,
      code: 'bad_grid',
      message: '尚未创建合法的行列纸格（行数、列数都须为正整数）。',
      capacity: 0
    };
  }
  const r = replay(rows, cols, labels || {}, Array.isArray(steps) ? steps : []);
  if (r.error) {
    const e = r.error;
    return {
      ok: false,
      code: e.code === 'thickness' ? 'thickness' : 'contour',
      stepIndex: e.stepIndex,
      conflicts: e.conflicts,
      message: `存在非法折叠（第 ${e.stepIndex + 1} 步：${e.message}），无法自动拼版。`,
      capacity: 2 * rows * cols
    };
  }
  const info = pageSequence(r.state);
  if (!info.folded) {
    return {
      ok: false,
      code: 'not_single_stack',
      message: `折叠后仍有 ${info.stacks.length} 个分离叠层，尚未收成单叠，无法确定唯一阅读顺序。`,
      stackCount: info.stacks.length,
      capacity: 2 * rows * cols
    };
  }
  return { ok: true, state: r.state, info, capacity: 2 * rows * cols };
}

/**
 * 生成自动拼版结果（不改写任何现有标注）。
 * @returns 成功 {
 *   ok:true, startPage, pageCount, capacity, blankTrailing,
 *   labels: { "x,y": {front,back} },   // 两面皆空的纸格被省略
 *   slots: [{ slot, panelId, origin:"x,y", face:'front'|'back',
 *             page:String|null, blank, upright, position:'upper'|'lower' }]
 * }
 * 失败 { ok:false, code, message, ... }
 */
function autoImpose(rows, cols, labels, steps, startPage, pageCount) {
  const elig = impositionEligibility(rows, cols, labels, steps);
  if (!elig.ok) return elig;

  startPage = Number(startPage);
  pageCount = Number(pageCount);
  if (!Number.isInteger(startPage) || startPage < 1) {
    return { ok: false, code: 'bad_start', message: '起始页码须为不小于 1 的整数。', capacity: elig.capacity };
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { ok: false, code: 'bad_count', message: '成品页数须为不小于 1 的整数。', capacity: elig.capacity };
  }
  if (pageCount > elig.capacity) {
    return {
      ok: false,
      code: 'too_many_pages',
      message: `成品页数 ${pageCount} 超出纸格总面数（容量 ${elig.capacity} 面 = ${rows}×${cols} 格 × 正反 2 面）。`,
      capacity: elig.capacity
    };
  }

  const grp = elig.info.stacks[0];
  const leafCount = grp.leaves.length;
  const slots = [];
  // 正向：封面起自上而下各叶“朝上”面；到达最内片后反向取各叶“朝下”面
  for (let i = 0; i < leafCount; i++) {
    const leaf = grp.leaves[i];
    slots.push({
      slot: slots.length, leafIndex: i, position: 'upper',
      panelId: leaf.panelId, face: leaf.upper.face,
      upright: !!leaf.upper.upright
    });
  }
  for (let i = leafCount - 1; i >= 0; i--) {
    const leaf = grp.leaves[i];
    slots.push({
      slot: slots.length, leafIndex: i, position: 'lower',
      panelId: leaf.panelId, face: leaf.lower.face,
      upright: !!leaf.lower.upright
    });
  }

  // 生成连续页码，超出成品页数的末尾槽位留空白
  slots.forEach((s) => {
    if (s.slot < pageCount) {
      s.page = String(startPage + s.slot);
      s.blank = false;
    } else {
      s.page = null;
      s.blank = true;
    }
  });

  // 反向映射到原始纸格正面/反面
  const next = {};
  const panels = elig.state.panels;
  for (const s of slots) {
    const p = panels[s.panelId];
    const origin = key(p.ox, p.oy);
    s.origin = origin;
    if (!next[origin]) next[origin] = { front: '', back: '' };
    next[origin][s.face] = s.blank ? '' : s.page;
  }

  // 与现有标注惯例一致：两面皆空的纸格不写入 labels
  const labelsOut = {};
  for (const [k, v] of Object.entries(next)) {
    if (v.front !== '' || v.back !== '') labelsOut[k] = { front: v.front, back: v.back };
  }

  return {
    ok: true,
    startPage,
    pageCount,
    capacity: elig.capacity,
    blankTrailing: Math.max(0, elig.capacity - pageCount),
    labels: labelsOut,
    slots
  };
}

/**
 * 双面印刷版预览
 * --------------
 * 方案“全部步骤合法且收成单叠”后，按当前纸格标注生成两张印版：
 *
 *   - 正面版（第 1 印刷面）：纸格按原始行列位置排列；
 *   - 背面版（第 2 印刷面）：纸格位置按所选翻转边镜像——
 *       flip='long'  长边翻转（沿竖边左右翻，duplex 沿长边装订）：左右镜像；
 *       flip='short' 短边翻转（沿横边上下翻，tumble）：上下镜像。
 *
 * 格内页码再依据该面片在折叠末态的朝向（frame.y）决定制版旋转：
 *   - 正面字形初始沿世界 +y（向下）排版，末态 frame.y.y<0 即倒置，制版旋转 180°；
 *   - 反面字形按印刷惯例排版（沿翻转边翻面后字头仍朝上）：
 *       长边翻转 = 关于竖边翻面，反面字形初始沿 +y（与正面上下对齐），
 *                  故同样 frame.y.y<0 时制版旋转 180°；
 *       短边翻转 = 关于横边翻面（tumble），反面字形初始沿 -y（上下对调），
 *                  故 frame.y.y>0 时制版旋转 180°。
 * 无论哪种翻面方式，补偿后折叠阅读时各页码都正立，顺序与当前回放一致。
 *
 * 输出仅为只读预览，不改写 labels / steps。
 */

/** 双面版前置条件，与自动拼版相同：网格合法 + 全部折叠合法 + 收成单叠。 */
function duplexEligibility(rows, cols, labels, steps) {
  return impositionEligibility(rows, cols, labels, steps);
}

/**
 * 构造双面印版。
 * @param flip 'long'（长边翻转）| 'short'（短边翻转）
 * @returns 成功
 *   { ok:true, rows, cols, flip, flipAxis:'vertical'|'horizontal', capacity,
 *     front: { face:'front', edge:'right'|'top', grid:[[cellView...] ].slice(rows) },
 *     back:  { face:'back',  edge:'left'|'bottom', mirrored:true, grid:[[...]] } }
 *   cellView = {
 *     x, y,                 // 印版视图格位（0 基，列,行）
 *     origin:'ox,oy',       // 对应的原始纸格
 *     face:'front'|'back',  // 该格印的是哪一面
 *     label:string|null,    // 页码（null = 空白面，保留占位）
 *     blank:boolean,
 *     rotate:0|180,         // 制版旋转角（°）
 *     upright:boolean       // 折叠后按回放阅读是否正立（补偿后恒为 true）
 *   }
 * 失败透传 impositionEligibility 的 { ok:false, code, message, ... }。
 */
function buildDuplexPlates(rows, cols, labels, steps, flip) {
  const elig = impositionEligibility(rows, cols, labels, steps);
  if (!elig.ok) return elig;
  if (flip !== 'long' && flip !== 'short') {
    return {
      ok: false,
      code: 'bad_flip',
      message: "翻面方式须为 'long'（长边翻转）或 'short'（短边翻转）。",
      capacity: 2 * rows * cols
    };
  }

  const panels = elig.state.panels;

  // 某原格某面的制版旋转：frame.y 始终为 (0,±1,0)，y 分量决定倒置与否。
  // 返回 { rotate, upright }（印刷补偿后 upright 恒为 true，即折叠后阅读正立）。
  const plateCell = (id, face, vx, vy) => {
    const p = panels[id];
    const dy = p.frame.y.y;                 // 折叠末态自身“下”方向的世界 y 投影
    let rotate180;
    if (face === 'front') rotate180 = dy < 0;
    else if (flip === 'long') rotate180 = dy < 0;   // 反面长边版：初始字形沿 +y
    else rotate180 = dy > 0;                        // 反面短边版：初始字形沿 -y（tumble）
    return {
      x: vx, y: vy,
      origin: id,
      face,
      label: p[face] === '' ? null : p[face],
      blank: p[face] === '',
      rotate: rotate180 ? 180 : 0,
      upright: true
    };
  };

  const buildGrid = (face) => {
    const grid = [];
    for (let vy = 0; vy < rows; vy++) {
      const rowArr = [];
      for (let vx = 0; vx < cols; vx++) {
        // 正面版：视图格位 = 原格位；
        // 背面版：沿翻转边镜像（关于中线翻转 180° 观察背面）
        const ox = face === 'back' && flip === 'long' ? cols - 1 - vx : vx;
        const oy = face === 'back' && flip === 'short' ? rows - 1 - vy : vy;
        rowArr.push(plateCell(key(ox, oy), face, vx, vy));
      }
      grid.push(rowArr);
    }
    return grid;
  };

  return {
    ok: true,
    rows, cols, flip,
    flipAxis: flip === 'long' ? 'vertical' : 'horizontal',
    capacity: 2 * rows * cols,
    front: { face: 'front', edge: flip === 'long' ? 'right' : 'top', grid: buildGrid('front') },
    back: {
      face: 'back',
      edge: flip === 'long' ? 'left' : 'bottom',
      mirrored: true,
      grid: buildGrid('back')
    }
  };
}

/**
 * 书帖爬移补偿（creep / shingling compensation）
 * ------------------------------------------------
 * 折帖收成骑马钉式单叠后，内层叶被外层叶包裹：前口（fore-edge）一侧
 * 内层叶逐叶向外“爬出”。成品裁切后为让各叶内容相对前口对齐，需把内层
 * 叶内容沿“前口 → 书脊”方向逐叶内移：
 *
 *   以最外叶（叠顶，封面叶）为第 0 层；某叶补偿量
 *     creep(i) = paperThickness × i
 *   （i = 该叶外侧叶数，即叠内自上而下的层序）。
 *
 * 书脊由<b>最后一步折叠</b>的折线确定（末折即装订脊折）：
 *   axis='v' dir='r' 终叠位于折线右侧 → 书脊在终叠左缘，移动方向为世界 −x；
 *   axis='v' dir='l' 终叠位于折线左侧 → 书脊在终叠右缘，移动方向为世界 +x；
 *   axis='h' dir='d' 终叠位于折线下侧 → 书脊在终叠上缘，移动方向为世界 −y；
 *   axis='h' dir='u' 终叠位于折线上侧 → 书脊在终叠下缘，移动方向为世界 +y。
 *
 * 世界内移量经各叶末态标架换算回原始纸格坐标（标架为正交反射，
 * 平面分量点积即逆映射）：
 *   Lx = W·frame.x，Ly = W·frame.y
 * 正面版坐标 = 原始纸格坐标；反面按长边翻面排版惯例左右镜像
 * （与双面印刷版一致），故反面版偏移 U = (−Lx, Ly)。
 * 每个叶恰有一个分量非零（axis: 'x' 横向 / 'y' 纵向），其带符号值即
 * “原始纸格正/反面的带符号横向（面内）偏移”。
 *
 * 偏移绝对值超过可用出血时该面 overBleed=true，方案不可应用。
 *
 * 前置条件与自动拼版/双面版相同：网格合法 + 全部步骤合法 + 收成单叠。
 */

/** 爬移补偿前置条件：复用 impositionEligibility（合法全步回放 + 单叠）。 */
function creepEligibility(rows, cols, labels, steps) {
  return impositionEligibility(rows, cols, labels, steps);
}

/**
 * 计算逐叶爬移补偿。
 * @param paperThickness 纸张厚度（与出血同单位，≥0 有限数）
 * @param bleed 可用出血（≥0 有限数）
 * @returns 成功
 *   { ok:true, rows, cols, paperThickness, bleed, leafCount, capacity,
 *     spineAxis:'vertical'|'horizontal'|'none', spineSide:'left'|'right'|'top'|'bottom'|null,
 *     worldDir:{x,y}, maxCompensation, overBleedCount, canApply,
 *     leaves:[{ leafIndex, outsideCount, panelId, origin, creep, axis:'x'|'y',
 *               front:{offset, dx, dy, overBleed},
 *               back:{offset, dx, dy, overBleed} }] }
 *   前置失败透传 eligibility 的 { ok:false, code, ... }；
 *   参数非法 { ok:false, code:'bad_thickness'|'bad_bleed', message }。
 */
function creepCompensation(rows, cols, labels, steps, paperThickness, bleed) {
  const elig = impositionEligibility(rows, cols, labels, steps);
  if (!elig.ok) return elig;

  const t = Number(paperThickness);
  if (paperThickness == null || !Number.isFinite(t) || t < 0) {
    return { ok: false, code: 'bad_thickness',
      message: '纸张厚度须为不小于 0 的数字（与出血同单位，如 mm）。', capacity: elig.capacity };
  }
  const b = Number(bleed);
  if (bleed == null || !Number.isFinite(b) || b < 0) {
    return { ok: false, code: 'bad_bleed',
      message: '可用出血须为不小于 0 的数字（与纸厚同单位，如 mm）。', capacity: elig.capacity };
  }

  const list = Array.isArray(steps) ? steps : [];
  const last = list.length ? list[list.length - 1] : null;
  let spineAxis = 'none';
  let spineSide = null;
  let worldDir = { x: 0, y: 0 };
  if (last) {
    if (last.axis === 'v') {
      spineAxis = 'vertical';
      // dir='r' 左瓣折向右 → 终叠在右、书脊在左；dir='l' 反之
      spineSide = last.dir === 'r' ? 'left' : 'right';
      worldDir = last.dir === 'r' ? { x: -1, y: 0 } : { x: 1, y: 0 };
    } else {
      spineAxis = 'horizontal';
      spineSide = last.dir === 'd' ? 'top' : 'bottom';
      worldDir = last.dir === 'd' ? { x: 0, y: -1 } : { x: 0, y: 1 };
    }
  }

  const grp = elig.info.stacks[0];
  const panels = elig.state.panels;
  const outLeaves = [];
  let overBleedLeaves = 0;
  grp.leaves.forEach((leaf, i) => {
    const p = panels[leaf.panelId];
    const creep = roundNum(t * i);
    // 世界移动向量 W = worldDir × creep，经标架逆映射到原始纸格平面坐标
    const wx = worldDir.x * creep;
    const wy = worldDir.y * creep;
    const lx = roundNum(dot2(wx, wy, p.frame.x));
    const ly = roundNum(dot2(wx, wy, p.frame.y));
    // 承载轴由书脊方向决定（竖折脊 -> 面内横向 x，横折脊 -> 纵向 y；
    // 未折叠时退化取 x），零补偿叶也保持一致
    const axis = spineAxis === 'horizontal' ? 'y' : 'x';
    // 同一叶正/反两面承载同一物理内移量，|offset| 相同（反面版 x 镜像）
    const over = (axis === 'x' ? Math.abs(lx) : Math.abs(ly)) > b + 1e-9;
    if (over) overBleedLeaves++;
    const faceView = (dx, dy) => ({ offset: axis === 'x' ? dx : dy, dx, dy, overBleed: over });
    outLeaves.push({
      leafIndex: i,
      outsideCount: i,
      panelId: leaf.panelId,
      origin: leaf.panelId,
      creep,
      axis,
      front: faceView(lx, ly),
      back: faceView(roundNum(-lx), ly)
    });
  });

  return {
    ok: true,
    rows, cols,
    paperThickness: t,
    bleed: b,
    capacity: elig.capacity,
    leafCount: outLeaves.length,
    spineAxis,
    spineSide,
    worldDir,
    maxCompensation: roundNum(t * Math.max(0, outLeaves.length - 1)),
    overBleedLeaves,
    overBleedCount: overBleedLeaves * 2,   // 每叶正、反两面同超限
    canApply: overBleedLeaves === 0,
    leaves: outLeaves
  };
}

function dot2(wx, wy, v) {
  return wx * (v.x || 0) + wy * (v.y || 0);
}
function roundNum(n) {
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6;
}

/**
 * 规整已应用的爬移补偿方案字段（载入 JSON / 存档时使用）。
 * 与 normalizePlan 的严格抛错不同：该字段为附加独立方案，结构非法时
 * 整体丢弃（返回 null），不影响方案其余部分载入。
 * @param raw plan.creepCompensation
 */
function normalizeCreepScheme(raw, rows, cols) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawT = raw.params && raw.params.paperThickness;
  const rawB = raw.params && raw.params.bleed;
  const t = Number(rawT);
  const b = Number(rawB);
  if (rawT == null || rawB == null || !Number.isFinite(t) || t < 0
      || !Number.isFinite(b) || b < 0) return null;
  if (!raw.faces || typeof raw.faces !== 'object' || Array.isArray(raw.faces)) return null;
  const faces = {};
  for (const [k, v] of Object.entries(raw.faces)) {
    const m = /^(\d+),(\d+)$/.exec(k);
    if (!m || !v || typeof v !== 'object') continue;
    const x = Number(m[1]), y = Number(m[2]);
    if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
    const fo = Number(v.front), bo = Number(v.back);
    if (!Number.isFinite(fo) || !Number.isFinite(bo)) continue;
    const face = { front: roundNum(fo), back: roundNum(bo) };
    if (v.axis === 'x' || v.axis === 'y') face.axis = v.axis;
    if (Number.isFinite(Number(v.creep)) && Number(v.creep) >= 0) {
      face.creep = roundNum(Number(v.creep));
    }
    faces[k] = face;
  }
  const out = { params: { paperThickness: t, bleed: b }, faces };
  if (raw.basis && typeof raw.basis === 'object') {
    const br = Number(raw.basis.rows), bc = Number(raw.basis.cols);
    if (Number.isInteger(br) && br > 0 && Number.isInteger(bc) && bc > 0
        && typeof raw.basis.stepsSignature === 'string') {
      out.basis = { rows: br, cols: bc, stepsSignature: raw.basis.stepsSignature };
    }
  }
  if (raw.spineAxis === 'vertical' || raw.spineAxis === 'horizontal' || raw.spineAxis === 'none') {
    out.spineAxis = raw.spineAxis;
  }
  if (['left', 'right', 'top', 'bottom'].includes(raw.spineSide)) {
    out.spineSide = raw.spineSide;
  }
  if (Number.isFinite(Number(raw.maxCompensation)) && Number(raw.maxCompensation) >= 0) {
    out.maxCompensation = roundNum(Number(raw.maxCompensation));
  }
  if (typeof raw.appliedAt === 'string') out.appliedAt = raw.appliedAt;
  return out;
}

/**
 * 汇总“现有标注 → 自动拼版结果”之间会被覆盖/清空的位置。
 * @returns [{ cell, face, from:string, to:string, blanked:boolean }]
 *   仅包含现有标注非空、且写入后内容发生变化的面。
 */
function impositionOverwrite(labels, result) {
  const out = [];
  if (!result || !result.ok) return out;
  const next = result.labels;
  for (const [cell, v] of Object.entries(labels || {})) {
    for (const face of ['front', 'back']) {
      const from = v && v[face] != null ? String(v[face]) : '';
      if (from === '') continue;
      const to = (next[cell] && next[cell][face]) || '';
      if (from !== to) {
        out.push({ cell, face, from, to, blanked: to === '' });
      }
    }
  }
  return out;
}

/**
 * 折手自动寻路
 * ------------
 * 从给定方案“全部步骤合法回放后的末态”出发，枚举当前引擎允许的折叠
 * （validateFold 判为合法的折线 + 方向），BFS 搜索“收成单叠、且指定原始
 * 纸格的指定面（正面/反面）位于该叠最上方作为封面”的最短后续折法。
 *
 * 限制（超出即返回对应错误码，不执行搜索）：
 *   - 仅支持不超过 4×4 的网格；
 *   - 后续步骤上限 maxDepth（默认 8）；
 *   - 墙上时间上限 timeoutMs（默认 2000ms）。
 *
 * 状态键 stateKey 完整包含：
 *   - 各格位（相对位置）；
 *   - 每格叠层内面片自上而下的顺序；
 *   - 每个面片的朝向标架（x/y/n）。
 * 因此“面片排布相同但最终朝向/层序不同”的状态不会被误合并。
 */

/** 折叠方向的中文描述（界面与逐步折法展示共用）。 */
function describeStep(st) {
  const dirText = { l: '◀ 向左折', r: '▶ 向右折', u: '▲ 向上折', d: '▼ 向下折' };
  const pos = st.axis === 'v' ? `竖线 ${st.line}` : `横线 ${st.line}`;
  return `${pos}，${dirText[st.dir] || st.dir}`;
}

/** 枚举一个网格内全部候选折叠（合法性再由 validateFold 过滤）。 */
function candidateSteps(rows, cols) {
  const out = [];
  for (let k = 1; k < cols; k++) {
    out.push({ axis: 'v', line: k, dir: 'r' });   // 左瓣向右落
    out.push({ axis: 'v', line: k, dir: 'l' });   // 右瓣向左落
  }
  for (let k = 1; k < rows; k++) {
    out.push({ axis: 'h', line: k, dir: 'd' });   // 上瓣向下落
    out.push({ axis: 'h', line: k, dir: 'u' });   // 下瓣向上落
  }
  return out;
}

function frameKey(f) {
  // 各分量只可能是 -1/0/1，逐分量拼接即可完整刻画朝向
  return [f.x.x, f.x.y, f.x.z, f.y.x, f.y.y, f.y.z, f.n.x, f.n.y, f.n.z].join(',');
}

/**
 * 完整状态键：格位相对位置 + 叠层顺序 + 面片朝向。
 * 面板按原始格 id 排序后拼接，保证同一物理状态键唯一。
 */
function stateKey(state) {
  const cells = Object.keys(state.stacks).sort();
  return cells.map((cell) => {
    const ids = state.stacks[cell];
    return `${cell}|${ids.map((id) => `${id}@${frameKey(state.panels[id].frame)}`).join('>')}`;
  }).join(';');
}

/** 目标判定：已收成单叠，且叠顶面片是目标原始纸格、其朝上的面为目标面。 */
function matchCoverGoal(state, targetId, targetFace) {
  const cells = Object.keys(state.stacks);
  if (cells.length !== 1) return false;
  const ids = state.stacks[cells[0]];
  const top = state.panels[ids[0]];
  if (top.ox + ',' + top.oy !== targetId) return false;
  const face = top.frame.n.z > 0 ? 'front' : 'back';
  return face === targetFace;
}

function failSearch(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}

/** 方案步骤的可复现排序串（同一最短层内多方案按它取前 3）。 */
function pathCanonical(steps) {
  return steps.map((s) => `${s.axis}:${String(s.line).padStart(3, '0')}:${s.dir}`).join('/');
}

/**
 * BFS 最短折法搜索。
 * @param target { cell:'x,y'(原始纸格), face:'front'|'back' }
 * @param options { maxDepth?:number≤8, timeoutMs?:number≤2000 }
 * @returns 成功
 *   { ok:true, solved:true, depth, solutions:[{steps, finalCell, topPanel, coverFace}],
 *     searched:{states, frontier} }
 *   无解（限步内可达状态穷尽）
 *   { ok:true, solved:false, reason:'no_solution', searched, maxDepth, message }
 *   超限（达到时间上限仍未穷尽/命中）
 *   { ok:true, solved:false, reason:'limit_exceeded', searched, depth, timeoutMs, message }
 *   其它前置错误 { ok:false, code:'bad_prefix'|'bad_target'|'grid_too_large'|'bad_limit', ... }
 */
function findFoldPath(rows, cols, labels, steps, target, options) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return failSearch('bad_grid', '尚未创建合法的行列纸格（行数、列数都须为正整数）。');
  }
  if (rows > 4 || cols > 4) {
    return failSearch('grid_too_large',
      `折手自动寻路仅支持不超过 4×4 的网格（当前为 ${rows}×${cols}）。`,
      { rows, cols, maxGrid: 4 });
  }
  const maxDepth = options && options.maxDepth != null ? Number(options.maxDepth) : 8;
  const timeoutMs = options && options.timeoutMs != null ? Number(options.timeoutMs) : 2000;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) {
    return failSearch('bad_limit', '后续步骤上限须为 0..8 的整数。');
  }
  if (!(timeoutMs > 0 && timeoutMs <= 2000)) {
    return failSearch('bad_limit', '搜索时间上限须为不超过 2000 毫秒的正数。');
  }

  const r = replay(rows, cols, labels || {}, Array.isArray(steps) ? steps : []);
  if (r.error) {
    return failSearch('bad_prefix',
      `当前方案存在非法折叠（第 ${r.error.stepIndex + 1} 步：${r.error.message}），请先修正后再寻路。`,
      { stepIndex: r.error.stepIndex, conflicts: r.error.conflicts });
  }

  target = target || {};
  const m = /^(\d+),(\d+)$/.exec(String(target.cell));
  if (!m) return failSearch('bad_target', '请选择一个原始纸格作为封面所在格。');
  const tx = Number(m[1]), ty = Number(m[2]);
  if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) {
    return failSearch('bad_target', `封面原格 (${target.cell}) 不在 ${cols}×${rows} 网格内。`);
  }
  if (target.face !== 'front' && target.face !== 'back') {
    return failSearch('bad_target', "封面朝向须为 'front'（正面）或 'back'（反面）。");
  }
  const targetId = `${tx},${ty}`;

  const start = r.state;
  const deadline = Date.now() + timeoutMs;
  const goals = [];
  const seen = new Set([stateKey(start)]);
  let frontier = [{ state: start, steps: [] }];
  let expanded = 0;
  let timedOut = false;

  const makeSolution = (node) => {
    const cell = Object.keys(node.state.stacks)[0];
    const topId = node.state.stacks[cell][0];
    const panel = node.state.panels[topId];
    return {
      steps: node.steps.map((s) => ({ ...s })),
      finalCell: cell,
      topPanel: panel.ox + ',' + panel.oy,
      coverFace: panel.frame.n.z > 0 ? 'front' : 'back'
    };
  };

  // 起点即目标：0 步方案
  if (matchCoverGoal(start, targetId, target.face)) {
    const node0 = { state: start, steps: [] };
    return {
      ok: true, solved: true, depth: 0,
      solutions: [makeSolution(node0)],
      searched: { states: seen.size, frontier: 0 }
    };
  }

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextLevel = [];
    let hitDeadline = false;
    for (const node of frontier) {
      expanded++;
      if ((expanded & 63) === 0 && Date.now() > deadline) { hitDeadline = true; break; }

      const st = node.state;
      const occupiedCount = Object.keys(st.stacks).length;
      // 合法折叠每次最多把占用格位数减半（移动格与静止格一一配对），
      // 剩余步数不足以把 k 个叠层收成 1 个时整枝剪去。
      if (Math.ceil(Math.log2(occupiedCount)) > maxDepth - depth) continue;

      for (const step of candidateSteps(st.rows, st.cols)) {
        if (validateFold(st, step)) continue;
        const ns = applyFold(st, step);
        const k = stateKey(ns);
        if (seen.has(k)) continue;
        seen.add(k);
        const child = { state: ns, steps: node.steps.concat([step]) };
        if (matchCoverGoal(ns, targetId, target.face)) {
          goals.push(makeSolution(child));
          if (goals.length >= 3) break;
        } else if (Object.keys(ns.stacks).length > 1) {
          // 单叠但封面不符即死局（不可能再有合法折），不入下一层
          nextLevel.push(child);
        }
      }
      if (goals.length >= 3) break;
    }

    if (goals.length) {
      goals.sort((a, b) => pathCanonical(a.steps) < pathCanonical(b.steps) ? -1 : 1);
      return {
        ok: true, solved: true, depth: depth + 1,
        solutions: goals.slice(0, 3),
        searched: { states: seen.size, frontier: frontier.length }
      };
    }
    if (hitDeadline) { timedOut = true; break; }
    frontier = nextLevel;
    if (!frontier.length) break;
  }

  if (timedOut) {
    return {
      ok: true, solved: false, reason: 'limit_exceeded',
      depth: undefined, timeoutMs,
      searched: { states: seen.size, expanded, frontier: frontier.length },
      message: `搜索超过 ${timeoutMs / 1000} 秒上限（已枚举 ${seen.size} 个状态），未能确认是否存在目标折法。`
    };
  }
  return {
    ok: true, solved: false, reason: 'no_solution',
    maxDepth,
    searched: { states: seen.size, expanded },
    message: `在 ${maxDepth} 个后续步骤内没有能收成目标单叠的合法折法（无解）。`
  };
}

/**
 * 面片轨迹
 * --------
 * 选定一个<b>原始纸格</b>（以其初始 id "ox,oy" 为身份）及其正/反面后，
 * 从第 0 步（未折叠）逐步重放，给出该面片在每一步后的：
 *   - 当前所在格位 cell；
 *   - 叠层中的层序 layer（1 = 最上层）与该叠总层数 depth；
 *   - 所选面朝上还是朝下 faceUp；
 *   - 页码正立还是倒置 180° upright。
 *
 * 身份追踪始终使用初始面板 id（applyFold 只移动/重排 id，不新建面片），
 * 因此叠层合并、瓣内倒序后轨迹依然准确。
 *
 * 遇到首个非法步骤时停止：已生成的此前节点全部保留，并在 interrupted 中
 * 标明中断步号、原因码与冲突纸格；steps 中该步及之后均无对应节点。
 *
 * @param target { cell:'x,y'(原始纸格), face:'front'|'back' }
 * @returns 成功（或在中途非法步被截断）
 *   { ok:true, target:{cell,face}, rows, cols,
 *     points:[{ step, cell:'x,y', layer, depth, faceUp, upright,
 *               face:'front'|'back', label:string|null }],
 *     interrupted:null | { stepIndex, code, message, conflicts },
 *     completed:boolean }   // true = 全部步骤均合法
 *   前置错误 { ok:false, code:'bad_grid'|'bad_target', message }
 */
function trackPanel(rows, cols, labels, steps, target) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return { ok: false, code: 'bad_grid', message: '尚未创建合法的行列纸格（行数、列数都须为正整数）。' };
  }
  const list = Array.isArray(steps) ? steps : [];
  target = target || {};
  const m = /^(\d+),(\d+)$/.exec(String(target.cell));
  if (!m) return { ok: false, code: 'bad_target', message: '请选择一个原始纸格作为追踪目标。' };
  const tx = Number(m[1]), ty = Number(m[2]);
  if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) {
    return { ok: false, code: 'bad_target', message: `目标原格 (${target.cell}) 不在 ${cols}×${rows} 网格内。` };
  }
  if (target.face !== 'front' && target.face !== 'back') {
    return { ok: false, code: 'bad_target', message: "追踪面须为 'front'（正面）或 'back'（反面）。" };
  }
  const panelId = key(tx, ty);

  const makePoint = (state, step) => {
    const p = state.panels[panelId];
    const ids = state.stacks[p.cx + ',' + p.cy];
    const layer = ids.indexOf(panelId) + 1;   // 1 = 叠顶；id 始终在自己所在格位的叠内
    const label = p[target.face] === '' ? null : p[target.face];
    return {
      step,
      cell: p.cx + ',' + p.cy,
      layer,
      depth: ids.length,
      face: target.face,
      faceUp: target.face === 'front' ? p.frame.n.z > 0 : p.frame.n.z < 0,
      upright: p.frame.y.y > 0,
      label
    };
  };

  let state = initialState(rows, cols, labels);
  const points = [makePoint(state, 0)];
  let interrupted = null;
  for (let i = 0; i < list.length; i++) {
    const err = validateFold(state, list[i]);
    if (err) {
      interrupted = { stepIndex: i, code: err.code, message: err.message, conflicts: err.conflicts };
      break;
    }
    state = applyFold(state, list[i]);
    points.push(makePoint(state, i + 1));
  }
  return {
    ok: true,
    target: { cell: panelId, face: target.face },
    rows, cols,
    points,
    interrupted,
    completed: !interrupted
  };
}

/**
 * 生产质量审计
 * ------------
 * 对方案做完整重放（始终重放全部步骤，与界面回放停在第几步无关），随后按
 * 印刷交付规则检查最终状态，逐条给出严重级别、对应原始纸格与可读说明：
 *
 *   duplicate_page     重复页码：同一页码标注在多个面上            —— error
 *   split_stacks       最终分离叠层：全部折叠后仍未收成单叠        —— error
 *   inverted_page      倒置页码：阅读序列中倒置 180° 的槽位
 *                      （含未标注的空白槽：空白面倒置同样无法交付，
 *                      文案不虚构页码）                            —— error
 *   capacity_mismatch  折叠后容量异常：叶子/阅读面总数与纸格容量
 *                      不一致（引擎守恒校验，正常方案不会触发）    —— error
 *   blank_page         空白页码：阅读序列中的空白槽位              —— warning
 *   uncovered_cell     未覆盖纸格：正反面皆空白、未承载页码        —— warning
 *   capacity_multiple  单叠总页数非 4 的倍数（骑马钉交付需确认）   —— warning
 *
 * 方案含非法折叠时只报告首个错误（contour/thickness + stepIndex + conflicts），
 * 不产出任何后续检查结论，避免在未知状态上伪造审计结果。
 *
 * 每条 finding：{ id, severity:'error'|'warning'|'info', title, message,
 *   cells:[原始纸格 id], step:null }（step 预留给可归因到具体步骤的检查；
 *   当前检查均针对最终状态，非法步骤的步号在 ok:false 的 stepIndex 中给出）。
 *
 * @returns
 *   网格非法   { ok:false, code:'bad_grid', message }
 *   非法折叠   { ok:false, code:'contour'|'thickness', stepIndex, conflicts, message }
 *   审计完成   { ok:true, verdict:'pass'|'fail',
 *               summary:{ errors, warnings, infos, total },
 *               stats:{ rows, cols, capacity, steps, folded, stacks, leaves,
 *                       labeledFaces, blankFaces },
 *               findings:[...] }
 *   verdict：无 error 级结果为 'pass'（可发布），否则 'fail'（需修订）。
 */
function auditPlan(rows, cols, labels, steps) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return { ok: false, code: 'bad_grid', message: '尚未创建合法的行列纸格（行数、列数都须为正整数）。' };
  }
  const list = Array.isArray(steps) ? steps : [];
  const r = replay(rows, cols, labels || {}, list);
  if (r.error) {
    const e = r.error;
    return {
      ok: false,
      code: e.code === 'thickness' ? 'thickness' : 'contour',
      stepIndex: e.stepIndex,
      conflicts: e.conflicts,
      message: `存在非法折叠（第 ${e.stepIndex + 1} 步：${e.message}），` +
        '审计中止：仅报告首个错误，不伪造后续检查结论。'
    };
  }

  const state = r.state;
  const info = pageSequence(state);
  const capacity = 2 * rows * cols;
  const multi = info.stacks.length > 1;
  const faceName = { front: '正面', back: '反面' };
  const findings = [];
  const add = (id, severity, title, message, cells, details) => {
    findings.push({
      id, severity, title, message,
      cells: cells || [],
      step: null,
      ...(details ? { details } : {})
    });
  };

  // —— 容量守恒：折叠后叶子数与阅读面数必须等于纸格总面数 ——
  const leaves = info.stacks.reduce((n, g) => n + g.depth, 0);
  const sequenceLength = info.stacks.reduce((n, g) => n + g.sequence.length, 0);
  if (leaves !== rows * cols || sequenceLength !== capacity) {
    add('capacity_mismatch', 'error', '折叠后容量异常',
      `折叠后共 ${leaves} 片叶子、${sequenceLength} 个阅读面，与纸格容量 ` +
      `${rows}×${cols} 格 × 2 面 = ${capacity} 不一致（守恒校验失败）。`,
      []);
  }

  // —— 最终分离叠层 ——
  if (multi) {
    const details = info.stacks.map((g, i) => ({
      stack: i + 1, cell: g.cell, depth: g.depth,
      panels: g.leaves.map((l) => l.panelId)
    }));
    add('split_stacks', 'error', '最终分离叠层',
      `全部 ${list.length} 步折叠后仍有 ${info.stacks.length} 个分离叠层，无法作为单一折帖交付：` +
      details.map((d) => `叠层 ${d.stack} 位于格(${d.cell})、厚 ${d.depth} 片（原格 ${d.panels.join('、')}）`).join('；') + '。',
      details.flatMap((d) => d.panels),
      details);
  } else if (capacity % 4 !== 0) {
    // —— 骑马钉交付：单叠总页数须为 4 的倍数（如 1×1 未折叠的 2 页）——
    add('capacity_multiple', 'warning', '容量非 4 的倍数',
      `单叠共 ${capacity} 页（${info.stacks[0].depth} 片叶子），` +
      '骑马钉装订通常要求总页数为 4 的倍数，请确认交付规格。',
      []);
  }

  // —— 逐槽位检查：重复 / 空白 / 倒置（槽位序 = 封面→封底阅读序）——
  const occurrences = new Map();   // label -> [{ cell, face, slot, stack }]
  const blanks = [];
  const inverted = [];
  let labeledFaces = 0;
  info.stacks.forEach((grp, gi) => {
    const depth = grp.leaves.length;
    const slots = [];
    for (let i = 0; i < depth; i++) slots.push({ leaf: grp.leaves[i], part: 'upper' });
    for (let i = depth - 1; i >= 0; i--) slots.push({ leaf: grp.leaves[i], part: 'lower' });
    slots.forEach((s, si) => {
      const view = s.part === 'upper' ? s.leaf.upper : s.leaf.lower;
      const where = { cell: s.leaf.panelId, face: view.face, slot: si + 1, stack: gi + 1 };
      // 先独立记录朝向：倒置与是否标注无关，空白槽倒置同样是交付错误
      if (!view.upright) inverted.push({ ...where, label: view.label });
      // 再按有无标签分别统计：重复页码 / 空白页
      if (view.label == null) {
        blanks.push(where);
      } else {
        labeledFaces++;
        if (!occurrences.has(view.label)) occurrences.set(view.label, []);
        occurrences.get(view.label).push(where);
      }
    });
  });

  const slotText = (w) => `阅读序列第 ${w.slot} 槽` + (multi ? `（叠层 ${w.stack}）` : '');
  for (const [label, occ] of occurrences) {
    if (occ.length < 2) continue;
    add('duplicate_page', 'error', '重复页码',
      `页码 “${label}” 出现 ${occ.length} 次：` +
      occ.map((w) => `原格(${w.cell})·${faceName[w.face]}（${slotText(w)}）`).join('、') + '。',
      [...new Set(occ.map((w) => w.cell))],
      occ);
  }
  for (const w of inverted) {
    add('inverted_page', 'error', '倒置页码',
      w.label == null
        ? `原格(${w.cell})·${faceName[w.face]}（空白面，未标注页码）在${slotText(w)}倒置 180°。`
        : `原格(${w.cell})·${faceName[w.face]} 的页码 “${w.label}” 在${slotText(w)}倒置 180°。`,
      [w.cell], [w]);
  }
  for (const w of blanks) {
    add('blank_page', 'warning', '空白页码',
      `${slotText(w)}为空白页（原格(${w.cell})·${faceName[w.face]} 未标注页码）。`,
      [w.cell], [w]);
  }

  // —— 未覆盖纸格：正反面皆空白 ——
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const id = key(x, y);
      const p = state.panels[id];
      if (p.front === '' && p.back === '') {
        add('uncovered_cell', 'warning', '未覆盖纸格',
          `原始纸格 (${id}) 正、反面均为空白，未承载任何页码。`,
          [id]);
      }
    }
  }

  // 错误在前、警告其次（同级保持规则分组顺序）
  const rank = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  const errors = count('error');
  const clusterView = buildAuditClusters(findings);
  return {
    ok: true,
    verdict: errors > 0 ? 'fail' : 'pass',
    summary: { errors, warnings: count('warning'), infos: count('info'), total: findings.length },
    stats: {
      rows, cols, capacity,
      steps: list.length,
      folded: info.folded,
      stacks: info.stacks.length,
      leaves,
      labeledFaces,
      blankFaces: blanks.length
    },
    findings,
    // 问题聚类为只读视图：由 findings 确定性派生，绝不改动上述原始审计结论；
    // 同方案重算结果一致（可随版本快照复现），跨重算的簇身份复用见 reconcileAuditClusters。
    clusters: clusterView.clusters,
    clusterSummary: clusterView.summary
  };
}

// ---------- 审计问题聚类（只读视图） ----------
/**
 * 将“同一审计规则”的结果按空间邻接关系合并为问题簇：
 *   · 相邻阅读槽位：同一叠层内槽位号相差 1；
 *   · 共享原始纸格：成员涉及的原始纸格 id 有交集（可传递，经并查集）。
 * 不同规则（如倒置与空白）永不合并；聚类纯确定性，不依赖任何运行态/时间戳，
 * 因此同一方案任意时刻、任意端重算结果一致，可随方案版本快照复现。
 *
 * 成员稳定 key（与页码文案解耦：改页码不改身份，槽位/纸格才是身份）：
 *   槽位类   `${rule}|s${stack}:${slot}:${cell}:${face}`
 *   纸格类   `${rule}|c${cell}`
 *   全局类   `${rule}|g`（容量/分离叠层，无单一纸格身份）
 * 簇 key = 规则 + 成员 key 集合内容哈希，成员集合不变则簇身份不变。
 */
const SEV_RANK = { error: 0, warning: 1, info: 2 };
const AUDIT_FACE_NAME = { front: '正面', back: '反面' };

function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    // 代理对合并为码点（key 实际全 ASCII，这里仅做防御）
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    const bytes = c < 0x80 ? [c]
      : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 0x3f)]
        : c < 0x10000 ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)]
          : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return 'h' + h.toString(16).padStart(8, '0');
}

/**
 * 把一条审计 finding 展开为一个或多个簇成员。
 * 槽位类规则（倒置/空白/重复页码）按“每次出现”拆分，
 * 其余规则一条 finding 即一个成员；成员是只读投影，不回写 finding。
 */
function auditFindingMembers(f) {
  const mkSlot = (d, rule, note) => ({
    key: `${rule}|s${d.stack}:${d.slot}:${d.cell}:${d.face}`,
    rule, severity: f.severity, title: f.title,
    cells: [d.cell],
    slots: [{
      stack: d.stack, slot: d.slot, cell: d.cell, face: d.face,
      label: d.label == null ? null : String(d.label)
    }],
    note
  });
  switch (f.id) {
    case 'inverted_page':
    case 'blank_page':
      return [mkSlot(f.details[0], f.id, f.message)];
    case 'duplicate_page': {
      // details 为该页码的全部出现位置（{cell,face,slot,stack}）
      return (Array.isArray(f.details) ? f.details : []).map((d) => {
        const label = d.label == null ? '' : String(d.label);
        const slotText = `阅读序列第 ${d.slot} 槽`;
        const note = `页码 “${label}”：原格(${d.cell})·${AUDIT_FACE_NAME[d.face] || d.face}` +
          `（${slotText}）。`;
        return mkSlot({ ...d, label }, f.id, note);
      });
    }
    case 'uncovered_cell': {
      const cell = f.cells[0];
      return [{
        key: `${f.id}|c${cell}`, rule: f.id, severity: f.severity, title: f.title,
        cells: [cell], slots: [], note: f.message
      }];
    }
    default: {
      // split_stacks / capacity_mismatch / capacity_multiple：全局成员，
      // 不与任何具体槽位/纸格邻接（分离叠层各叠之间也不共享原格），
      // 故始终自成一簇；split_stacks 带上各叠槽位区间供展示。
      const slots = [];
      if (f.id === 'split_stacks' && Array.isArray(f.details)) {
        for (const d of f.details) {
          for (let n = 1; n <= 2 * d.depth; n++) {
            slots.push({ stack: d.stack, slot: n, cell: null, face: null, label: null });
          }
        }
      }
      return [{
        key: `${f.id}|g`, rule: f.id, severity: f.severity, title: f.title,
        cells: [...f.cells], slots, note: f.message
      }];
    }
  }
}

/**
 * 由审计 findings 构建确定性问题簇（无历史上下文时簇 cid 按排序规范编号 c1..cN；
 * 跨重算的身份复用见 reconcileAuditClusters）。
 * @returns {clusters:[], summary:{clusters,members,errors,warnings,infos}}
 */
function buildAuditClusters(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const members = [];
  for (const f of list) {
    if (!f || typeof f.id !== 'string') continue;
    for (const m of auditFindingMembers(f)) members.push(m);
  }
  // 稳定排序：规则 → 成员 key，保证并查集与输出顺序确定
  members.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const parent = members.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri === rj) return;
    // 根取较小下标，结果与遍历顺序无关
    if (ri < rj) parent[rj] = ri; else parent[ri] = rj;
  };
  const adjacentSlot = (a, b) => {
    const sa = a.slots[0], sb = b.slots[0];
    return !!sa && !!sb && sa.stack === sb.stack && Math.abs(sa.slot - sb.slot) === 1
      && sa.cell !== null && sb.cell !== null;
  };
  const sharesCell = (a, b) => {
    if (!a.cells.length || !b.cells.length) return false;
    const set = b.cells.length >= a.cells.length ? new Set(a.cells) : new Set(b.cells);
    const other = b.cells.length >= a.cells.length ? b.cells : a.cells;
    return other.some((c) => set.has(c));
  };
  // 仅同规则成员之间按“相邻槽位 / 共享原始纸格”连边（含并查集传递合并）
  let runStart = 0;
  for (let i = 0; i <= members.length; i++) {
    if (i < members.length && members[i].rule === members[runStart].rule) continue;
    for (let a = runStart; a < i; a++) {
      for (let b = a + 1; b < i; b++) {
        if (adjacentSlot(members[a], members[b]) || sharesCell(members[a], members[b])) union(a, b);
      }
    }
    runStart = i;
  }

  const groups = new Map();
  members.forEach((m, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  });

  const clusters = [];
  for (const groupMembers of groups.values()) {
    const keySet = groupMembers.map((m) => m.key).sort();
    const rule = groupMembers[0].rule;
    const cellSet = new Set();
    const slotIndex = new Map();
    const noteSet = new Set();
    let severity = groupMembers[0].severity;
    let title = groupMembers[0].title;
    for (const m of groupMembers) {
      if (SEV_RANK[m.severity] < SEV_RANK[severity]) severity = m.severity;
      for (const c of m.cells) cellSet.add(c);
      for (const s of m.slots) {
        slotIndex.set(`${s.stack}:${s.slot}`, s);
      }
      if (m.note) noteSet.add(m.note);
    }
    const cells = [...cellSet].sort();
    const slots = [...slotIndex.values()].sort((a, b) =>
      (a.stack - b.stack) || (a.slot - b.slot));
    clusters.push({
      cid: null,
      key: `${rule}|${fnv1aHex(keySet.join(';'))}`,
      rule, title, severity,
      cells,
      slots,
      memberCount: groupMembers.length,
      members: groupMembers.map((m) => ({
        key: m.key, severity: m.severity, rule: m.rule, title: m.title,
        cells: [...m.cells], slots: m.slots.map((s) => ({ ...s })), note: m.note
      })),
      notes: [...noteSet].sort()
    });
  }
  // 稳定排序：严重级别 → 规则 → 成员数（多在前）→ 簇 key
  clusters.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]
    || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
    || b.memberCount - a.memberCount
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  clusters.forEach((c, i) => { c.cid = `c${i + 1}`; });

  const count = (sev) => clusters.filter((c) => c.severity === sev).length;
  return {
    clusters,
    summary: {
      clusters: clusters.length,
      members: members.length,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info')
    }
  };
}

/**
 * 重算后按稳定成员 key 复用簇身份（一对一贪心匹配，绝不把多个新簇误并到同一旧簇）：
 *   1. 成员集合完全相同（簇 key 相等）的优先原样复用；
 *   2. 其余按共享成员数从多到少配对（并列按旧 cid、新簇 key 确定顺序）；
 *   3. 未匹配上的新簇分配全新 cid（旧最大序号之后递增，永不复用已消失簇号）；
 * 复用成功的簇带 addedMemberKeys / removedMemberKeys（成员增删差异）；
 * 已消失的旧簇列入 removed（UI 可提示“已消失”，不参与新结果）。
 * @returns {{clusters, removed}}
 */
function reconcileAuditClusters(prevClusters, nextClusters) {
  const prev = Array.isArray(prevClusters) ? prevClusters.filter((c) => c && c.key) : [];
  const next = Array.isArray(nextClusters) ? nextClusters.filter((c) => c && c.key) : [];
  const cidNum = (cid) => {
    const m = /^c(\d+)$/.exec(String(cid || ''));
    return m ? Number(m[1]) : 0;
  };
  let maxCid = prev.reduce((n, c) => Math.max(n, cidNum(c.cid)), 0);

  const memberKeySet = (c) => new Set((c.members || []).map((m) => m.key));
  const result = new Map();   // next cluster object -> { cid, added, removed }
  const usedPrev = new Set();

  // 第一轮：成员集合完全一致（簇 key 相等）—— 无增删，直接复用
  for (const nc of next) {
    const exact = prev.find((pc) => !usedPrev.has(pc) && pc.key === nc.key);
    if (exact) {
      usedPrev.add(exact);
      result.set(nc, { cid: exact.cid, added: [], removed: [] });
    }
  }
  // 第二轮：按共享成员数贪心配对（只在有交集时）
  const pairs = [];
  for (const nc of next) {
    if (result.has(nc)) continue;
    const nset = memberKeySet(nc);
    for (const pc of prev) {
      if (usedPrev.has(pc)) continue;
      let overlap = 0;
      for (const m of pc.members || []) if (nset.has(m.key)) overlap++;
      if (overlap > 0) pairs.push({ nc, pc, overlap });
    }
  }
  pairs.sort((a, b) => (b.overlap - a.overlap)
    || (cidNum(a.pc.cid) - cidNum(b.pc.cid))
    || (a.nc.key < b.nc.key ? -1 : a.nc.key > b.nc.key ? 1 : 0));
  for (const { nc, pc } of pairs) {
    if (result.has(nc) || usedPrev.has(pc)) continue;
    usedPrev.add(pc);
    const oldKeys = new Set((pc.members || []).map((m) => m.key));
    const newKeys = memberKeySet(nc);
    result.set(nc, {
      cid: pc.cid,
      added: [...newKeys].filter((k) => !oldKeys.has(k)).sort(),
      removed: [...oldKeys].filter((k) => !newKeys.has(k)).sort()
    });
  }
  // 未匹配新簇：分配全新 cid（保持新簇既定排序）
  for (const nc of next) {
    if (result.has(nc)) continue;
    maxCid += 1;
    result.set(nc, {
      cid: `c${maxCid}`,
      added: (nc.members || []).map((m) => m.key).sort(),
      removed: []
    });
  }

  const clusters = next.map((nc) => {
    const match = result.get(nc);
    return {
      ...nc,
      cid: match.cid,
      addedMemberKeys: match.added,
      removedMemberKeys: match.removed
    };
  });
  const removed = prev.filter((pc) => !usedPrev.has(pc)).map((pc) => ({
    cid: pc.cid, key: pc.key, rule: pc.rule, title: pc.title,
    severity: pc.severity, cells: [...(pc.cells || [])],
    memberKeys: (pc.members || []).map((m) => m.key).sort()
  })).sort((a, b) => cidNum(a.cid) - cidNum(b.cid));
  return { clusters, removed };
}

/**
 * 方案元信息（名称 / 标签 / 备注）约束与严格校验（浏览器与服务端共用）。
 * tags：0..8 个，逐项 trim、折叠空白、去重、长度 1..20，
 *       不得含控制字符与查询分隔符（, ; |）；
 * note：trim 后至多 500 字符；name：trim 后 1..40 字符。
 * 非法时抛出带 code 的错误（bad_name/name_too_long/bad_tags/tag_too_long/
 * too_many_tags/bad_note/note_too_long），由调用方整请求拒绝。
 */
const META_LIMITS = Object.freeze({
  MAX_TAGS: 8, MAX_TAG_LEN: 20, MAX_NOTE_LEN: 500, MAX_NAME_LEN: 40
});
const TAG_FORBIDDEN_RE = /[\p{C},;|]/u;

class MetaError extends Error {
  constructor(code, message) { super(message); this.name = 'MetaError'; this.code = code; }
}

function strLen(s) { return [...String(s)].length; }

function normalizePlanMeta(body) {
  body = body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new MetaError('bad_name', '方案名称不能为空。');
  if (strLen(name) > META_LIMITS.MAX_NAME_LEN) {
    throw new MetaError('name_too_long', `方案名称最多 ${META_LIMITS.MAX_NAME_LEN} 字符。`);
  }

  const rawTags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(rawTags)) throw new MetaError('bad_tags', '标签必须为数组。');
  const tags = [];
  const seen = new Set();
  for (const raw of rawTags) {
    if (typeof raw !== 'string') throw new MetaError('bad_tags', '每个标签必须为字符串。');
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag) throw new MetaError('bad_tags', '标签不能为空。');
    if (strLen(tag) > META_LIMITS.MAX_TAG_LEN) {
      throw new MetaError('tag_too_long', `单个标签最多 ${META_LIMITS.MAX_TAG_LEN} 字符：“${tag}”。`);
    }
    if (TAG_FORBIDDEN_RE.test(tag)) {
      throw new MetaError('tag_forbidden', `标签含非法字符（控制字符或 , ; |）：“${tag}”。`);
    }
    if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
  }
  if (tags.length > META_LIMITS.MAX_TAGS) {
    throw new MetaError('too_many_tags',
      `每个方案最多 ${META_LIMITS.MAX_TAGS} 个标签（去重后 ${tags.length} 个）。`);
  }

  let note = '';
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw new MetaError('bad_note', '备注必须为字符串。');
    note = body.note.trim();
    if (strLen(note) > META_LIMITS.MAX_NOTE_LEN) {
      throw new MetaError('note_too_long',
        `备注最多 ${META_LIMITS.MAX_NOTE_LEN} 字符（当前 ${strLen(note)} 字符）。`);
    }
  }
  return { name, tags, note };
}

/**
 * 宽容版元信息规整（导入 JSON 时用）：任一字段非法都不抛错，
 * 名称退回“未命名方案”、标签逐项过滤、超长截断、去重限量，备注超长截断。
 */
function coercePlanMeta(body) {
  body = body || {};
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || strLen(name) > META_LIMITS.MAX_NAME_LEN) name = '未命名方案';

  const tags = [];
  const seen = new Set();
  if (Array.isArray(body.tags)) {
    for (const raw of body.tags) {
      if (typeof raw !== 'string') continue;
      const tag = raw.trim().replace(/\s+/g, ' ');
      if (!tag || TAG_FORBIDDEN_RE.test(tag)) continue;
      const clipped = [...tag].slice(0, META_LIMITS.MAX_TAG_LEN).join('');
      if (!seen.has(clipped)) { seen.add(clipped); tags.push(clipped); }
      if (tags.length >= META_LIMITS.MAX_TAGS) break;
    }
  }

  let note = typeof body.note === 'string' ? body.note.trim() : '';
  if (strLen(note) > META_LIMITS.MAX_NOTE_LEN) {
    note = [...note].slice(0, META_LIMITS.MAX_NOTE_LEN).join('');
  }
  return { name, tags, note };
}

/**
 * 校样批注（proof annotations）
 * * ----------------------------
 * 用户可在<b>任一回放步骤</b>为<b>原始纸格</b>的正/反面添加带严重级别的文字批注。
 * 批注的身份键是原始面片坐标 `cell`（"列,行"，0 基）+ `face`（front/back），
 * 与折叠过程无关：applyFold 只移动/重排面片 id，不新建面片，因此任意回放前缀、
 * 截断步骤或重排折叠后，都能用同一份批注数据经 replay 重新定位到当前格位与叠层。
 *
 * 批注记录：
 *   { id, cell:'x,y', face:'front'|'back',
 *     severity:'error'|'warning'|'info',   // 严重 / 警告 / 建议
 *     text:string,                          // trim 后 1..500 字符
 *     step:number,                          // 添加时所在回放步（0..steps.length）
 *     resolved:boolean, resolvedAt:string|null,
 *     createdAt:string }
 *
 * normalizeAnnotations 为保存路径的<b>严格</b>规整：任一条非法即抛
 * AnnotationError（带 code），由服务端整请求 400 拒绝；
 * coerceAnnotations 为导入路径的<b>宽容</b>规整：坏条目逐条丢弃/降级/截断，
 * 不影响方案其余部分（与 creepCompensation 的处理哲学一致）。
 */
const ANNO_LIMITS = Object.freeze({ MAX_ANNOTATIONS: 200, MAX_TEXT_LEN: 500 });
const ANNO_SEVERITIES = ['error', 'warning', 'info'];
const ANNO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const ANNO_CELL_RE = /^(\d+),(\d+)$/;
// 除水平制表/换行外的其它 Unicode 控制字符一律不允许进入批注正文
const ANNO_CONTROL_RE = /[\p{C}]/u;

class AnnotationError extends Error {
  constructor(code, message) { super(message); this.name = 'AnnotationError'; this.code = code; }
}

function newAnnotationId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function annoBadControl(text) {
  return ANNO_CONTROL_RE.test(String(text).replace(/[\t\n]/g, ''));
}

/**
 * 严格规整批注数组（保存到服务器前使用，浏览器与服务端共用）。
 * @param raw 批注数组；null/undefined 视为空数组
 * @param grid { rows, cols, steps } 当前方案几何，用于校验 cell 越界与 step 范围
 * @returns 规整后的批注数组（保持输入顺序）
 * @throws AnnotationError（bad_annotations / bad_annotation / bad_annotation_id /
 *   duplicate_annotation_id / bad_annotation_cell / bad_annotation_face /
 *   bad_annotation_severity / bad_annotation_text / annotation_too_long /
 *   annotation_control_chars / bad_annotation_step / bad_annotation_resolved /
 *   too_many_annotations）
 */
function normalizeAnnotations(raw, grid) {
  grid = grid || {};
  const rows = Number(grid.rows);
  const cols = Number(grid.cols);
  const stepCount = Array.isArray(grid.steps) ? grid.steps.length : 0;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new AnnotationError('bad_annotations', '批注必须为数组。');
  }
  if (raw.length > ANNO_LIMITS.MAX_ANNOTATIONS) {
    throw new AnnotationError('too_many_annotations',
      `每个方案最多 ${ANNO_LIMITS.MAX_ANNOTATIONS} 条批注（当前 ${raw.length} 条）。`);
  }
  const out = [];
  const ids = new Set();
  raw.forEach((a, i) => {
    const where = `第 ${i + 1} 条批注`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new AnnotationError('bad_annotation', `${where}格式非法（须为对象）。`);
    }
    let id = a.id;
    if (id == null || id === '') {
      id = newAnnotationId();
    } else if (typeof id !== 'string' || !ANNO_ID_RE.test(id)) {
      throw new AnnotationError('bad_annotation_id', `${where}的 id 非法。`);
    } else if (ids.has(id)) {
      throw new AnnotationError('duplicate_annotation_id', `${where}的 id 与其它批注重复。`);
    }
    ids.add(id);

    const m = ANNO_CELL_RE.exec(String(a.cell == null ? '' : a.cell));
    if (!m) throw new AnnotationError('bad_annotation_cell', `${where}缺少合法的原始纸格坐标（“列,行”）。`);
    const cx = Number(m[1]), cy = Number(m[2]);
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1
        || cx < 0 || cx >= cols || cy < 0 || cy >= rows) {
      throw new AnnotationError('bad_annotation_cell',
        `${where}的原始纸格 (${a.cell}) 不在 ${cols}×${rows} 网格内。`);
    }

    if (a.face !== 'front' && a.face !== 'back') {
      throw new AnnotationError('bad_annotation_face', `${where}的面别须为 front（正面）或 back（反面）。`);
    }
    if (!ANNO_SEVERITIES.includes(a.severity)) {
      throw new AnnotationError('bad_annotation_severity',
        `${where}的严重级别须为 error / warning / info 之一。`);
    }
    if (typeof a.text !== 'string') {
      throw new AnnotationError('bad_annotation_text', `${where}的批注正文必须为字符串。`);
    }
    const text = a.text.trim();
    if (!text) throw new AnnotationError('bad_annotation_text', `${where}的批注正文不能为空。`);
    if ([...text].length > ANNO_LIMITS.MAX_TEXT_LEN) {
      throw new AnnotationError('annotation_too_long',
        `${where}的批注正文最多 ${ANNO_LIMITS.MAX_TEXT_LEN} 字符。`);
    }
    if (annoBadControl(text)) {
      throw new AnnotationError('annotation_control_chars', `${where}的批注正文含非法控制字符。`);
    }

    let step = a.step == null ? 0 : Number(a.step);
    if (!Number.isInteger(step) || step < 0 || step > stepCount) {
      throw new AnnotationError('bad_annotation_step',
        `${where}的回放步须为 0..${stepCount} 之间的整数。`);
    }

    let resolved = false;
    if (a.resolved !== undefined) {
      if (typeof a.resolved !== 'boolean') {
        throw new AnnotationError('bad_annotation_resolved', `${where}的 resolved 必须为布尔值。`);
      }
      resolved = a.resolved;
    }

    const rec = {
      id, cell: `${cx},${cy}`, face: a.face, severity: a.severity,
      text, step, resolved,
      createdAt: typeof a.createdAt === 'string' && a.createdAt
        ? a.createdAt : new Date().toISOString()
    };
    if (resolved) {
      rec.resolvedAt = typeof a.resolvedAt === 'string' && a.resolvedAt
        ? a.resolvedAt : new Date().toISOString();
    }
    out.push(rec);
  });
  return out;
}

/**
 * 宽容版批注规整（导入 JSON / normalizePlan 时使用）：
 * 非数组→[]；坏条目整条丢弃；面别非法丢弃；严重级别非法降级为 info；
 * 正文 trim、去控制字符、按码点截断到 500；step 钳制到 0..steps.length；
 * id 缺失/非法/重复时重新生成；resolved 强制布尔；总量截断到 200。
 */
function coerceAnnotations(raw, rows, cols, steps) {
  if (!Array.isArray(raw)) return [];
  const stepCount = Array.isArray(steps) ? steps.length : 0;
  // Strip C0/DEL/C1 control chars except TAB and LF
  const stripControl = (s) => s.replace(
    new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u0080-\\u009F]', 'gu'), '');
  const out = [];
  const ids = new Set();
  for (const a of raw) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const m = ANNO_CELL_RE.exec(String(a.cell == null ? '' : a.cell));
    if (!m) continue;
    const cx = Number(m[1]), cy = Number(m[2]);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    if (a.face !== 'front' && a.face !== 'back') continue;
    const severity = ANNO_SEVERITIES.includes(a.severity) ? a.severity : 'info';
    if (typeof a.text !== 'string') continue;
    let text = stripControl(a.text).trim();
    if (!text) continue;
    text = [...text].slice(0, ANNO_LIMITS.MAX_TEXT_LEN).join('');
    let step = Number(a.step);
    if (!Number.isInteger(step) || step < 0) step = 0;
    if (step > stepCount) step = stepCount;

    let id = (typeof a.id === 'string' && ANNO_ID_RE.test(a.id) && !ids.has(a.id))
      ? a.id : newAnnotationId();
    ids.add(id);
    const resolved = a.resolved === true;
    const rec = {
      id, cell: `${cx},${cy}`, face: a.face, severity,
      text, step, resolved,
      createdAt: typeof a.createdAt === 'string' && a.createdAt
        ? a.createdAt : new Date().toISOString()
    };
    if (resolved) {
      rec.resolvedAt = typeof a.resolvedAt === 'string' && a.resolvedAt
        ? a.resolvedAt : new Date().toISOString();
    }
    out.push(rec);
    if (out.length >= ANNO_LIMITS.MAX_ANNOTATIONS) break;
  }
  return out;
}

/** 批注统计：总数 / 未解决 / 已解决，及按严重级别的两档计数。 */
function annotationStats(annotations) {
  const bySeverity = {};
  for (const sev of ANNO_SEVERITIES) bySeverity[sev] = { total: 0, open: 0 };
  let open = 0;
  const list = Array.isArray(annotations) ? annotations : [];
  for (const a of list) {
    const bucket = bySeverity[a.severity] || bySeverity.info;
    bucket.total++;
    if (!a.resolved) { bucket.open++; open++; }
  }
  return { total: list.length, open, resolved: list.length - open, bySeverity };
}

/**
 * 把批注按<b>原始面片身份</b>定位到指定回放步的状态上。
 * 与 trackPanel 同样直接从 replay 状态的 panels 取当前格位/层序：
 * 切换 upto、截断/重排折叠步骤后重新调用即可得到正确位置。
 * 回放前缀含非法步骤时使用截断态（interrupted 标明），此前格位仍可定位。
 *
 * @returns 网格非法 { ok:false, code:'bad_grid' }；否则
 *   { ok:true, upto, interrupted:null|{stepIndex,code,...},
 *     points:[{ id, cell, at, face, severity, resolved, layer, depth, faceUp, upright }] }
 *   cell 为原始纸格，at 为当前所在格位，layer/depth 为叠内层序（1=最上层）。
 */
function locateAnnotations(rows, cols, labels, steps, upto, annotations) {
  rows = Number(rows); cols = Number(cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    return { ok: false, code: 'bad_grid', message: '尚未创建合法的行列纸格（行数、列数都须为正整数）。' };
  }
  const list = Array.isArray(steps) ? steps : [];
  if (upto == null) upto = list.length;
  upto = Math.max(0, Math.min(Math.floor(Number(upto)) || 0, list.length));
  const r = replay(rows, cols, labels || {}, list, upto);
  const state = r.state;
  const points = [];
  for (const a of Array.isArray(annotations) ? annotations : []) {
    const p = state.panels[a && a.cell];
    if (!p) continue;
    const at = p.cx + ',' + p.cy;
    const ids = state.stacks[at];
    const layer = ids.indexOf(a.cell) + 1;
    if (layer <= 0) continue;
    points.push({
      id: a.id, cell: a.cell, at,
      face: a.face, severity: a.severity, resolved: a.resolved === true,
      layer, depth: ids.length,
      faceUp: a.face === 'front' ? p.frame.n.z > 0 : p.frame.n.z < 0,
      upright: p.frame.y.y > 0
    });
  }
  return { ok: true, upto, interrupted: r.error, points };
}

// ---------- 版本差异 ----------
/**
 * 版本差异审阅
 * ------------
 * 以两类<b>稳定身份</b>对齐同一方案的两个历史快照（见服务端版本快照）：
 *   - 原始纸格坐标 "x,y"：正反页码（labels）与校样批注的归属；
 *   - 步骤序号（0 基数组下标）：折叠步骤的身份。
 * 注意：在中间插入/删除步骤会使之后的序号整体平移，序号之后的步骤会如实
 * 显示为“改/增/删”——序号即约定身份，不做 LCS 模糊对齐。
 *
 * 批注以其 id 为身份，对比 cell/face/severity/text/step/resolved 六个字段
 * （createdAt/resolvedAt 为操作元数据，不参与差异）。
 *
 * @returns {
 *   ok:true,
 *   grid: null | { from:{rows,cols}, to:{rows,cols} },
 *   meta: [{ kind:'add'|'remove'|'modify', field:'name'|'note'|'tag', from?, to?, value? }],
 *   labels: [{ kind, cell, face:'front'|'back', from:string, to:string }],   // '' = 空白面
 *   steps: [{ kind, index, from:step|null, to:step|null,
 *             fromText?:string, toText?:string, fromCells:[origins], toCells:[origins] }],
 *   annotations: [{ kind, id, cell, face, fields:[{field,from,to}], from:rec|null, to:rec|null }],
 *   affectedCells: string[],   // 全部受影响原始纸格（用于画布高亮）
 *   removedCells: string[],    // 不在新版本网格内、无法在新画布上高亮的旧纸格
 *   summary: { labels:{add,remove,modify}, steps:{...}, annotations:{...}, meta:number, total:number }
 * }
 */
function diffPlans(fromRaw, toRaw) {
  const a = (fromRaw && typeof fromRaw === 'object' && !Array.isArray(fromRaw)) ? fromRaw : {};
  const b = (toRaw && typeof toRaw === 'object' && !Array.isArray(toRaw)) ? toRaw : {};
  const rowsA = toIntOr(Number(a.rows), 0), colsA = toIntOr(Number(a.cols), 0);
  const rowsB = toIntOr(Number(b.rows), 0), colsB = toIntOr(Number(b.cols), 0);

  const labels = [];
  const affected = new Set();
  const removed = new Set();
  const la = labelMap(a.labels);
  const lb = labelMap(b.labels);
  const cells = [...new Set([...la.keys(), ...lb.keys()])]
    .sort((c1, c2) => cellSortCompare(c1, c2));
  for (const cell of cells) {
    for (const face of ['front', 'back']) {
      const va = la.has(cell) ? la.get(cell)[face] : null;
      const vb = lb.has(cell) ? lb.get(cell)[face] : null;
      if (va === vb) continue;
      // 任一侧缺失且另一侧为空白面（''）都视为“无标注”，不报告差异
      const kind = va == null ? (vb === '' ? null : 'add')
        : vb == null ? (va === '' ? null : 'remove')
        : va === '' || vb === '' ? (va === '' ? 'add' : 'remove') : 'modify';
      if (!kind) continue;
      labels.push({ kind, cell, face, from: va || '', to: vb || '' });
      affected.add(cell);
      if (!cellInGrid(cell, rowsB, colsB)) removed.add(cell);
    }
  }

  const steps = [];
  const sa = Array.isArray(a.steps) ? a.steps : [];
  const sb = Array.isArray(b.steps) ? b.steps : [];
  const stepCount = Math.max(sa.length, sb.length);
  for (let i = 0; i < stepCount; i++) {
    const sFrom = sanitizeStep(sa[i]);
    const sTo = sanitizeStep(sb[i]);
    let kind;
    if (!sFrom && sTo) kind = 'add';
    else if (sFrom && !sTo) kind = 'remove';
    else if (stepKey(sFrom) !== stepKey(sTo)) kind = 'modify';
    else continue;
    const entry = {
      kind, index: i,
      from: sFrom ? { ...sFrom } : null,
      to: sTo ? { ...sTo } : null,
      fromCells: sFrom ? stepMoveOriginCells(a, sFrom, i) : [],
      toCells: sTo ? stepMoveOriginCells(b, sTo, i) : []
    };
    if (sFrom && isValidStepShape(sFrom)) entry.fromText = describeStep(sFrom);
    if (sTo && isValidStepShape(sTo)) entry.toText = describeStep(sTo);
    steps.push(entry);
    for (const c of entry.fromCells) { affected.add(c); if (!cellInGrid(c, rowsB, colsB)) removed.add(c); }
    for (const c of entry.toCells) affected.add(c);
  }

  // 标签 / 备注 / 名称
  const meta = [];
  const nameA = typeof a.name === 'string' ? a.name : '';
  const nameB = typeof b.name === 'string' ? b.name : '';
  if (nameA !== nameB) meta.push({ kind: 'modify', field: 'name', from: nameA, to: nameB });
  const noteA = typeof a.note === 'string' ? a.note : '';
  const noteB = typeof b.note === 'string' ? b.note : '';
  if (noteA !== noteB) meta.push({ kind: 'modify', field: 'note', from: noteA, to: noteB });
  const tagsA = Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === 'string') : [];
  const tagsB = Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string') : [];
  const setA = new Set(tagsA), setB = new Set(tagsB);
  for (const t of tagsB) if (!setA.has(t)) meta.push({ kind: 'add', field: 'tag', value: t });
  for (const t of tagsA) if (!setB.has(t)) meta.push({ kind: 'remove', field: 'tag', value: t });

  // 校样批注（id 身份）
  const annotations = [];
  const annoA = new Map(), annoB = new Map();
  (Array.isArray(a.annotations) ? a.annotations : []).forEach((x, i) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) annoA.set(typeof x.id === 'string' && x.id ? x.id : `@${i}`, x);
  });
  (Array.isArray(b.annotations) ? b.annotations : []).forEach((x, i) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) annoB.set(typeof x.id === 'string' && x.id ? x.id : `@${i}`, x);
  });
  const annoIds = [...new Set([...annoA.keys(), ...annoB.keys()])].sort();
  const ANNO_FIELDS = ['cell', 'face', 'severity', 'text', 'step', 'resolved'];
  for (const id of annoIds) {
    const ra = annoA.get(id) || null, rb = annoB.get(id) || null;
    let kind;
    if (!ra && rb) kind = 'add';
    else if (ra && !rb) kind = 'remove';
    else {
      const fields = ANNO_FIELDS
        .filter((f) => annoFieldValue(ra, f) !== annoFieldValue(rb, f))
        .map((f) => ({ field: f, from: annoFieldValue(ra, f), to: annoFieldValue(rb, f) }));
      if (!fields.length) continue;
      kind = 'modify';
      annotations.push({
        kind, id,
        cell: rb.cell || ra.cell, face: rb.face || ra.face,
        fields, from: { ...ra }, to: { ...rb }
      });
      if (ra.cell) { affected.add(ra.cell); if (!cellInGrid(ra.cell, rowsB, colsB)) removed.add(ra.cell); }
      if (rb.cell) affected.add(rb.cell);
      continue;
    }
    const rec = rb || ra;
    annotations.push({ kind, id, cell: rec.cell || '', face: rec.face || '', fields: [], from: ra, to: rb });
    if (ra && ra.cell) { affected.add(ra.cell); if (!cellInGrid(ra.cell, rowsB, colsB)) removed.add(ra.cell); }
    if (rb && rb.cell) affected.add(rb.cell);
  }

  const countKinds = (list) => list.reduce((acc, e) => { acc[e.kind]++; return acc; },
    { add: 0, remove: 0, modify: 0 });
  const summary = {
    labels: countKinds(labels),
    steps: countKinds(steps),
    annotations: countKinds(annotations),
    meta: meta.length,
    total: labels.length + steps.length + annotations.length + meta.length
      + ((rowsA !== rowsB || colsA !== colsB) ? 1 : 0)
  };

  return {
    ok: true,
    grid: (rowsA !== rowsB || colsA !== colsB)
      ? { from: { rows: rowsA, cols: colsA }, to: { rows: rowsB, cols: colsB } } : null,
    meta, labels, steps, annotations,
    affectedCells: [...affected].filter((c) => cellInGrid(c, rowsB, colsB))
      .sort(cellSortCompare),
    removedCells: [...removed].sort(cellSortCompare),
    summary
  };
}

function toIntOr(n, dflt) { return Number.isInteger(n) ? n : dflt; }

function labelMap(raw) {
  const map = new Map();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!/^\d+,\d+$/.test(k) || !v || typeof v !== 'object') continue;
      map.set(k, {
        front: v.front != null ? String(v.front) : '',
        back: v.back != null ? String(v.back) : ''
      });
    }
  }
  return map;
}

function parseCell(k) {
  const m = /^(\d+),(\d+)$/.exec(k);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function cellInGrid(k, rows, cols) {
  const p = parseCell(k);
  return !!p && Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0
    && p[0] >= 0 && p[0] < cols && p[1] >= 0 && p[1] < rows;
}

function cellSortCompare(c1, c2) {
  const p1 = parseCell(c1), p2 = parseCell(c2);
  if (!p1 || !p2) return c1 < c2 ? -1 : c1 > c2 ? 1 : 0;
  return p1[1] - p2[1] || p1[0] - p2[0];
}

function isValidStepShape(s) {
  return s && (s.axis === 'v' || s.axis === 'h')
    && Number.isInteger(s.line) && ['l', 'r', 'u', 'd'].includes(s.dir);
}

function sanitizeStep(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const axis = s.axis === 'v' || s.axis === 'h' ? s.axis : String(s.axis);
  const line = Number(s.line);
  const dir = String(s.dir);
  return { axis, line, dir };
}

function stepKey(s) {
  return s ? `${s.axis}|${s.line}|${s.dir}` : '';
}

function annoFieldValue(rec, field) {
  if (!rec) return undefined;
  if (field === 'resolved') return rec.resolved === true;
  if (field === 'step') return Number(rec.step) || 0;
  return rec[field] == null ? '' : String(rec[field]);
}

/**
 * 某一步折叠在指定方案中会移动哪些<b>原始纸格</b>（差异画布高亮用）。
 * 优先取该步前缀回放态中移动侧各叠面片的原始坐标；
 * 前缀含非法步骤或网格非法时，退化为初始网格上按折线/方向取几何半区。
 */
function stepMoveOriginCells(plan, step, index) {
  const rows = Number(plan.rows), cols = Number(plan.cols);
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) return [];
  const list = Array.isArray(plan.steps) ? plan.steps : [];
  const upto = Math.max(0, Math.min(index, list.length));
  const out = new Set();
  const collectFromState = (state) => {
    const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[step.dir];
    if (!movingSide) return;
    for (const [cell, ids] of Object.entries(state.stacks)) {
      const [cx, cy] = cell.split(',').map(Number);
      const side = step.axis === 'v' ? (cx < step.line ? 'l' : 'r')
                                    : (cy < step.line ? 'u' : 'd');
      if (side !== movingSide) continue;
      for (const id of ids) {
        const p = state.panels[id];
        if (p) out.add(key(p.ox, p.oy));
      }
    }
  };
  const r = replay(rows, cols, plan.labels || {}, list, upto);
  collectFromState(r.state);
  if (!out.size) {
    // 几何兜底：初始网格上落在移动半区的纸格
    const movingSide = { r: 'l', l: 'r', d: 'u', u: 'd' }[step.dir];
    if (!movingSide) return [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const side = step.axis === 'v' ? (x < step.line ? 'l' : 'r')
                                      : (y < step.line ? 'u' : 'd');
        if (side === movingSide) out.add(key(x, y));
      }
    }
  }
  return [...out].sort(cellSortCompare);
}

/** 方案校验/规整（载入 JSON 时使用） */
function normalizePlan(plan) {
  const errors = [];
  const rows = Number(plan.rows);
  const cols = Number(plan.cols);
  if (!Number.isInteger(rows) || rows < 1 || rows > 20) errors.push('rows 必须为 1..20 的整数');
  if (!Number.isInteger(cols) || cols < 1 || cols > 20) errors.push('cols 必须为 1..20 的整数');
  const labels = {};
  if (plan.labels && typeof plan.labels === 'object') {
    for (const [k, v] of Object.entries(plan.labels)) {
      const m = /^(\d+),(\d+)$/.exec(k);
      if (!m) { errors.push(`标签键 "${k}" 非法`); continue; }
      const [x, y] = [Number(m[1]), Number(m[2])];
      if (x < 0 || x >= cols || y < 0 || y >= rows) { errors.push(`标签 ${k} 超出网格`); continue; }
      labels[k] = {
        front: v && v.front != null ? String(v.front) : '',
        back: v && v.back != null ? String(v.back) : ''
      };
    }
  }
  const steps = [];
  if (plan.steps != null && !Array.isArray(plan.steps)) errors.push('steps 必须为数组');
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((st, i) => {
      const axis = st && (st.axis === 'v' || st.axis === 'h') ? st.axis : null;
      const line = Number(st && st.line);
      const dir = st && ['l', 'r', 'u', 'd'].includes(st.dir) ? st.dir : null;
      if (!axis || !Number.isInteger(line) || !dir) {
        errors.push(`步骤 ${i + 1} 非法（需 axis:v/h, line:整数, dir:l/r/u/d）`);
        return;
      }
      steps.push({ axis, line, dir });
    });
  }
  if (errors.length) {
    const e = new Error('方案格式错误：\n - ' + errors.join('\n - '));
    e.errors = errors;
    throw e;
  }
  const normalized = {
    name: plan.name ? String(plan.name) : '未命名方案',
    rows, cols, labels, steps
  };
  // 标签 / 备注为宽松规整（导入含旧版/手改 JSON 不应失败），保存时再走严格校验
  const meta = coercePlanMeta(plan);
  normalized.name = meta.name;
  normalized.tags = meta.tags;
  normalized.note = meta.note;
  // 爬移补偿为独立方案字段：结构合法则保留（随方案保存/导入/服务端载入），
  // 非法则静默丢弃，不影响方案其余部分。
  const creep = normalizeCreepScheme(plan.creepCompensation, rows, cols);
  if (creep) normalized.creepCompensation = creep;
  // 校样批注为独立方案字段：宽容规整（坏条目逐条丢弃），保存时再走严格校验。
  normalized.annotations = coerceAnnotations(plan.annotations, rows, cols, steps);
  return normalized;
}

const api = {
  initialState, cloneState, validateFold, applyFold,
  replay, visibleFace, pageSequence, normalizePlan, key,
  impositionEligibility, autoImpose, impositionOverwrite,
  duplexEligibility, buildDuplexPlates,
  creepEligibility, creepCompensation, normalizeCreepScheme,
  findFoldPath, candidateSteps, stateKey, describeStep,
  trackPanel, auditPlan, buildAuditClusters, reconcileAuditClusters,
  normalizePlanMeta, coercePlanMeta, MetaError, META_LIMITS,
  normalizeAnnotations, coerceAnnotations, annotationStats, locateAnnotations,
  AnnotationError, ANNO_LIMITS, ANNO_SEVERITIES, newAnnotationId,
  diffPlans, stepMoveOriginCells
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FoldEngine = api;
