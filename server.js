'use strict';
/**
 * server.js —— 折页阅读顺序校样 Web 服务
 *  - 静态托管 public/（原生 HTML/CSS/Canvas 前端）
 *  - /api/simulate：服务端重放方案（与浏览器共用同一份 foldEngine.js）
 *  - /api/audit：生产质量审计（只读，不改动方案）
 *  - /api/creep-compensation：书帖爬移补偿逐叶偏移（只读计算）
 *  - /api/annotations/locate：校样批注按原始面片身份定位到指定回放步（只读）
 *  - /api/plans* ：方案 JSON 持久化到 DATA_DIR（容器卷，含标签/备注/校样批注）
 *    每次成功保存在 DATA_DIR/<id>.versions/ 追加不可变版本快照，
 *    支持 GET 版本列表/快照与 POST 两版本差异比较（diffPlans 与浏览器共用）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/foldEngine.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ---------- 方案标签 / 备注约束（与浏览器共用 foldEngine 中的严格规整） ----------
const { MAX_TAGS, MAX_TAG_LEN, MAX_NOTE_LEN, MAX_NAME_LEN } = E.META_LIMITS;
const TAG_FORBIDDEN_RE = /[\p{C},;|]/u;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 模拟 ----------
app.post('/api/simulate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const upto = req.body && Number.isInteger(req.body.upto)
      ? Math.max(0, Math.min(req.body.upto, plan.steps.length))
      : plan.steps.length;
    const { state, error } = E.replay(plan.rows, plan.cols, plan.labels, plan.steps, upto);
    res.json({
      ok: !error,
      upto,
      error: error || null,
      stacks: E.pageSequence(state).stacks,
      folded: E.pageSequence(state).folded,
      occupied: Object.keys(state.stacks).map((k) => {
        const [x, y] = k.split(',').map(Number);
        return {
          x, y, depth: state.stacks[k].length,
          panels: state.stacks[k].map((id) => {
            const p = state.panels[id];
            return {
              id, ox: p.ox, oy: p.oy, cx: p.cx, cy: p.cy,
              frame: p.frame,
              front: p.front, back: p.back
            };
          })
        };
      })
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 自动拼版 ----------
app.post('/api/impose', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.autoImpose(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.startPage,
      req.body && req.body.pageCount
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json({
      ok: true,
      startPage: result.startPage,
      pageCount: result.pageCount,
      capacity: result.capacity,
      blankTrailing: result.blankTrailing,
      labels: result.labels,
      slots: result.slots,
      overwrites: E.impositionOverwrite(plan.labels, result)
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 双面印刷版预览 ----------
app.post('/api/duplex-plate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.buildDuplexPlates(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.flip
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 折手自动寻路 ----------
app.post('/api/find-path', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const optsRaw = req.body && req.body.options && typeof req.body.options === 'object'
      ? req.body.options : {};
    const result = E.findFoldPath(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.target,
      {
        // 服务端硬性兜底：最多 8 步、2 秒
        maxDepth: Math.min(8, Math.max(0, Number(optsRaw.maxDepth) || 8)),
        timeoutMs: Math.min(2000, Math.max(1, Number(optsRaw.timeoutMs) || 2000))
      }
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          rows: result.rows, cols: result.cols,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 面片轨迹 ----------
app.post('/api/trajectory', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.trackPanel(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.target
    );
    if (!result.ok) {
      return res.json({ ok: false, error: { code: result.code, message: result.message } });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 生产质量审计（只读） ----------
app.post('/api/audit', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.auditPlan(plan.rows, plan.cols, plan.labels, plan.steps);
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 书帖爬移补偿 ----------
app.post('/api/creep-compensation', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const result = E.creepCompensation(
      plan.rows, plan.cols, plan.labels, plan.steps,
      req.body && req.body.paperThickness,
      req.body && req.body.bleed
    );
    if (!result.ok) {
      return res.json({
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          capacity: result.capacity,
          stepIndex: result.stepIndex,
          conflicts: result.conflicts,
          stackCount: result.stackCount
        }
      });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 校样批注定位（只读） ----------
app.post('/api/annotations/locate', (req, res) => {
  try {
    const plan = E.normalizePlan(req.body || {});
    const rawAnnos = (req.body && Array.isArray(req.body.annotations))
      ? req.body.annotations : plan.annotations;
    // 定位接口只读：批注做宽容规整即可，绝不因外部 JSON 的坏条目整体失败
    const annotations = E.coerceAnnotations(rawAnnos, plan.rows, plan.cols, plan.steps);
    const upto = req.body && Number.isInteger(req.body.upto)
      ? Math.max(0, Math.min(req.body.upto, plan.steps.length))
      : plan.steps.length;
    const result = E.locateAnnotations(
      plan.rows, plan.cols, plan.labels, plan.steps, upto, annotations);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
});

// ---------- 版本快照（不可变历史） ----------
/**
 * 每次成功保存都在 DATA_DIR/<id>.versions/ 下追加一个只写一次的快照文件，
 * 快照内容即当时的完整方案 JSON（外加 version/savedAt 元字段）。
 * 命名 `<6 位序号>-<短哈希>.json`：序号单调递增、全局唯一，写入用
 * 临时文件 + rename；快照文件此后只读，不再被任何接口改写或删除
 * （删除整个存档时才随目录一起移除）。
 */
function versionsDir(id) { return path.join(DATA_DIR, `${id}.versions`); }
function versionFile(id, version) {
  return path.join(versionsDir(id), `${String(version).padStart(6, '0')}.json`);
}
const VERSION_FILE_RE = /^(\d{6})\.json$/;
const VERSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 计算下一个版本序号（扫描现存快照，取最大 +1；无快照为 1）。 */
function nextVersionNumber(dir) {
  if (!fs.existsSync(dir)) return 1;
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = VERSION_FILE_RE.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** 版本摘要（用于版本列表；损坏文件跳过）。 */
function versionSummary(id, f) {
  const m = VERSION_FILE_RE.exec(f);
  const version = m ? Number(m[1]) : null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(versionsDir(id), f), 'utf8'));
    const annos = Array.isArray(p.annotations) ? p.annotations : [];
    return {
      version,
      savedAt: typeof p.savedAt === 'string' ? p.savedAt
        : typeof p.updatedAt === 'string' ? p.updatedAt : null,
      name: p.name || '未命名方案',
      rows: p.rows, cols: p.cols,
      steps: Array.isArray(p.steps) ? p.steps.length : 0,
      tags: Array.isArray(p.tags) ? p.tags : [],
      note: typeof p.note === 'string' ? p.note : '',
      annotations: annos.length,
      openAnnotations: annos.reduce((n, a) => n + (a && a.resolved !== true ? 1 : 0), 0),
      restoredFrom: p.restoredFrom || null
    };
  } catch { return null; }
}

/** 列出某存档的全部版本摘要（按序号升序）。 */
function readVersions(id) {
  const dir = versionsDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => VERSION_FILE_RE.test(f))
    .sort()
    .map((f) => versionSummary(id, f))
    .filter(Boolean);
}

/** 原子写文件（非目标名临时文件 + rename）。 */
function atomicWrite(filePath, content) {
  const tmp = path.join(path.dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ---------- 方案持久化 ----------
function planFile(id) { return path.join(DATA_DIR, `${id}.json`); }

/**
 * 方案元信息严格校验：直接委托浏览器/服务端共用的 E.normalizePlanMeta，
 * 错误带 code（bad_name/name_too_long/bad_tags/tag_too_long/tag_forbidden/
 * too_many_tags/bad_note/note_too_long），由 POST 处理器整请求拒绝。
 */
function normalizePlanMeta(body) {
  try {
    return E.normalizePlanMeta(body);
  } catch (e) {
    if (e instanceof E.MetaError) {
      const err = new Error(e.message);
      err.code = e.code;
      throw err;
    }
    throw e;
  }
}

/**
 * 校样批注严格校验：委托 foldEngine.normalizeAnnotations，
 * 错误带 code（bad_annotations/bad_annotation/bad_annotation_id/
 * duplicate_annotation_id/bad_annotation_cell/bad_annotation_face/
 * bad_annotation_severity/bad_annotation_text/annotation_too_long/
 * annotation_control_chars/bad_annotation_step/bad_annotation_resolved/
 * too_many_annotations），由 POST 处理器整请求拒绝。
 */
function normalizeAnnotations(body, plan) {
  try {
    return E.normalizeAnnotations(body.annotations, {
      rows: plan.rows, cols: plan.cols, steps: plan.steps
    });
  } catch (e) {
    if (e instanceof E.AnnotationError) {
      const err = new Error(e.message);
      err.code = e.code;
      throw err;
    }
    throw e;
  }
}

/** 解析标签交集查询参数：英文逗号（或分号）分隔，逐项 trim，空项/重复忽略；非法项抛错。 */
function parseTagFilter(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string') throw badFilter('标签筛选参数格式非法。');
  const out = [];
  const seen = new Set();
  for (let part of raw.split(/[,;]/)) {
    part = part.trim();
    if (!part) continue;
    if ([...part].length > MAX_TAG_LEN || TAG_FORBIDDEN_RE.test(part)) {
      throw badFilter(`筛选标签非法：“${part}”。`);
    }
    if (!seen.has(part)) { seen.add(part); out.push(part); }
  }
  return out;
}

function badFilter(message) {
  const err = new Error(message);
  err.code = 'bad_tag_filter';
  return err;
}

/** 读取全部存档摘要（含标签/备注/时间戳）；损坏文件跳过。 */
function readAllPlans() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const filePath = path.join(DATA_DIR, f);
        const p = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const st = fs.statSync(filePath);
        const id = f.replace(/\.json$/, '');
        const updatedAt = typeof p.updatedAt === 'string' ? p.updatedAt : new Date(st.mtimeMs).toISOString();
        const annos = Array.isArray(p.annotations) ? p.annotations : [];
        return {
          id,
          name: p.name || '未命名方案',
          rows: p.rows, cols: p.cols,
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          tags: Array.isArray(p.tags) ? p.tags : [],
          note: typeof p.note === 'string' ? p.note : '',
          version: Number.isInteger(p.version) ? p.version : null,
          annotations: annos.length,
          openAnnotations: annos.reduce((n, a) => n + (a && a.resolved !== true ? 1 : 0), 0),
          createdAt: typeof p.createdAt === 'string' ? p.createdAt : updatedAt,
          updatedAt
        };
      } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * GET /api/plans：方案存档列表，支持
 *  - tags：标签交集（英文逗号/分号分隔，须全部命中）
 *  - q：名称关键词（大小写不敏感子串）
 *  - since：仅返回该时间（ISO 字符串或毫秒数）之后更新的存档
 * 返回 { total, matched, items, allTags }；排序为更新时间倒序，同时间按 id 升序（稳定）。
 */
app.get('/api/plans', (req, res) => {
  let tagFilter, q, since;
  try {
    // express 默认 qs 查询解析会把纯数字值解析成 number，统一转字符串处理
    const tagsRaw = req.query.tags == null ? '' : String(req.query.tags);
    const sinceRaw = req.query.since == null ? '' : String(req.query.since);
    tagFilter = parseTagFilter(tagsRaw);
    q = typeof req.query.q === 'string' ? req.query.q.trim() : String(req.query.q || '').trim();
    if (sinceRaw !== '') {
      const n = Number(sinceRaw);
      since = Number.isFinite(n) ? new Date(n) : new Date(sinceRaw);
      if (isNaN(since.getTime())) {
        return res.status(400).json({
          ok: false, error: { code: 'bad_since', message: 'since 必须为合法时间（ISO 字符串或毫秒数）。' }
        });
      }
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: e.code || 'bad_filter', message: e.message } });
  }

  const all = readAllPlans();
  const total = all.length;

  // 全部存档的标签聚合（不受筛选影响）：按出现次数倒序、同次数按标签升序
  const tagCounts = new Map();
  for (const it of all) for (const t of it.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const allTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }));

  const ql = q.toLowerCase();
  const sinceMs = since ? since.getTime() : null;
  const items = all
    .filter((it) => tagFilter.every((t) => it.tags.includes(t)))
    .filter((it) => !ql || it.name.toLowerCase().includes(ql))
    .filter((it) => sinceMs == null || new Date(it.updatedAt).getTime() >= sinceMs)
    .sort((a, b) => {
      const dt = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return dt !== 0 ? dt : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

  res.json({ total, matched: items.length, items, allTags });
});

app.post('/api/plans', (req, res) => {
  // 先完成全部校验，再触碰文件系统：非法请求绝不改动任何已有存档与历史
  let plan, meta, annotations;
  try {
    plan = E.normalizePlan(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: 'bad_plan', message: e.message } });
  }
  try {
    meta = normalizePlanMeta(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: e.code, message: e.message } });
  }
  try {
    // 批注严格校验基于<b>原始提交</b>的数据（而非宽容规整后的 plan），
    // 任何坏条目都让整请求被拒绝，不静默改写用户内容。
    annotations = normalizeAnnotations(req.body || {}, plan);
  } catch (e) {
    return res.status(400).json({ ok: false, error: { code: e.code, message: e.message } });
  }

  const id = (req.body && typeof req.body.id === 'string' && VERSION_ID_RE.test(req.body.id))
    ? req.body.id : crypto.randomBytes(6).toString('hex');
  const now = new Date().toISOString();
  const existingPath = planFile(id);
  const dir = versionsDir(id);
  let createdAt = now;
  let oldHead = null;
  if (fs.existsSync(existingPath)) {
    try {
      oldHead = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      if (typeof oldHead.createdAt === 'string') createdAt = oldHead.createdAt;
    } catch { /* 损坏旧档：以新时间为准，不把损坏内容写入历史 */ }
  }

  // 恢复操作由客户端完成（载入历史快照内容后作为新草稿保存）；
  // restoredFrom 透传记录本次保存派生自哪个历史版本，仅作元信息，不影响校验。
  const restoredFrom = req.body && typeof req.body.restoredFrom === 'number'
    && Number.isInteger(req.body.restoredFrom) && req.body.restoredFrom >= 1
    ? req.body.restoredFrom : null;

  let body = {
    name: meta.name, rows: plan.rows, cols: plan.cols,
    labels: plan.labels, steps: plan.steps,
    tags: meta.tags, note: meta.note,
    annotations,
    version: null,
    restoredFrom,
    createdAt, updatedAt: now,
    savedAt: now
  };
  // 爬移补偿独立方案字段：存在则随存档保留（GET /api/plans/:id 原样返回）
  if (plan.creepCompensation) body.creepCompensation = plan.creepCompensation;

  // 旧 head 此前未入历史（首次升级到版本功能）时先补存为 v1，
  // 新方案从 v1 开始；版本号一旦落盘不可变。
  // 全部写入均为“临时文件 + rename”：先追加历史快照，再替换 head，
  // 失败不会留下半截存档或半截历史。
  fs.mkdirSync(dir, { recursive: true });
  if (oldHead && typeof oldHead.version !== 'number' && fs.readdirSync(dir).length === 0) {
    atomicWrite(versionFile(id, 1), JSON.stringify({
      ...oldHead,
      version: 1,
      savedAt: typeof oldHead.updatedAt === 'string' ? oldHead.updatedAt : now
    }, null, 2));
  }
  // 新版本号在现存历史之后递增（含上面可能补存的 v1），保证序号单调、无空洞复用
  body.version = nextVersionNumber(dir);
  const serialized = JSON.stringify(body, null, 2);
  atomicWrite(versionFile(id, body.version), serialized);
  atomicWrite(existingPath, serialized);
  res.json({ ok: true, id, version: body.version, plan: body });
});

app.get('/api/plans/:id', (req, res) => {
  const { id } = req.params;
  if (!VERSION_ID_RE.test(id)) return res.status(400).json({ ok: false, error: { message: '非法 id' } });
  const f = planFile(id);
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false, error: { message: '方案不存在' } });
  res.type('application/json').send(fs.readFileSync(f, 'utf8'));
});

/**
 * GET /api/plans/:id/versions：不可变版本摘要列表（按版本号升序）。
 * 最新版本即当前 head；存档无任何版本（尚未保存过）时返回空数组。
 */
app.get('/api/plans/:id/versions', (req, res) => {
  const { id } = req.params;
  if (!VERSION_ID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: { code: 'bad_id', message: '非法 id' } });
  }
  if (!fs.existsSync(planFile(id))) {
    return res.status(404).json({ ok: false, error: { code: 'not_found', message: '方案不存在' } });
  }
  const items = readVersions(id);
  res.json({ ok: true, id, count: items.length, items });
});

/** 读取指定版本的完整快照；version 非法/越界/文件损坏给出明确错误码。 */
function readVersionSnapshot(id, versionRaw) {
  if (!VERSION_ID_RE.test(id)) return { error: { code: 'bad_id', message: '非法 id' }, status: 400 };
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    return { error: { code: 'bad_version', message: '版本号必须为不小于 1 的整数。' }, status: 400 };
  }
  if (!fs.existsSync(planFile(id))) {
    return { error: { code: 'not_found', message: '方案不存在' }, status: 404 };
  }
  const f = versionFile(id, version);
  if (!fs.existsSync(f)) {
    return { error: { code: 'version_not_found', message: `版本 ${version} 不存在` }, status: 404 };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { error: { code: 'version_corrupt', message: `版本 ${version} 快照损坏` }, status: 500 };
  }
  return { snapshot };
}

/** GET /api/plans/:id/versions/:version：返回单个不可变版本完整方案 JSON。 */
app.get('/api/plans/:id/versions/:version', (req, res) => {
  const result = readVersionSnapshot(req.params.id, req.params.version);
  if (result.error) return res.status(result.status).json({ ok: false, error: result.error });
  res.json({ ok: true, snapshot: result.snapshot });
});

/**
 * POST /api/plans/:id/versions/diff：比较同一方案的两个不可变版本（只读）。
 * body: { from:number, to:number }，差异计算与浏览器共用 foldEngine.diffPlans，
 * 以原始纸格坐标与步骤序号为稳定身份。
 */
app.post('/api/plans/:id/versions/diff', (req, res) => {
  const { id } = req.params;
  if (!VERSION_ID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: { code: 'bad_id', message: '非法 id' } });
  }
  const fromV = req.body && Number(req.body.from);
  const toV = req.body && Number(req.body.to);
  if (!Number.isInteger(fromV) || !Number.isInteger(toV) || fromV < 1 || toV < 1) {
    return res.status(400).json({
      ok: false,
      error: { code: 'bad_version', message: 'from / to 必须为不小于 1 的版本号整数。' }
    });
  }
  const ra = readVersionSnapshot(id, fromV);
  if (ra.error) return res.status(ra.status).json({ ok: false, error: ra.error });
  const rb = readVersionSnapshot(id, toV);
  if (rb.error) return res.status(rb.status).json({ ok: false, error: rb.error });
  const diff = E.diffPlans(ra.snapshot, rb.snapshot);
  res.json({ ok: true, id, from: fromV, to: toV, diff });
});

app.delete('/api/plans/:id', (req, res) => {
  const { id } = req.params;
  if (!VERSION_ID_RE.test(id)) return res.status(400).json({ ok: false, error: { message: '非法 id' } });
  const f = planFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  // 连带删除该存档的不可变版本历史（仅随整档删除，不提供单版本删除）
  fs.rmSync(versionsDir(id), { recursive: true, force: true });
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`折页阅读顺序校样应用已启动： http://localhost:${PORT}`);
  });
}

module.exports = app;
module.exports.normalizePlanMeta = normalizePlanMeta;
module.exports.normalizeAnnotations = normalizeAnnotations;
module.exports.parseTagFilter = parseTagFilter;
module.exports.limits = { MAX_TAGS, MAX_TAG_LEN, MAX_NOTE_LEN, MAX_NAME_LEN };
