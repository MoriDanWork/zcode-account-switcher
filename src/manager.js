'use strict';
/**
 * 账号快照管理：list / capture / delete / rename / load
 *
 * 存储结构：
 *   accounts/
 *     <shortId>.meta.json   -> { id, shortId, provider, label, note, capturedAt, filename }
 *     <shortId>.snap.json    -> { credentials, config }  (完整登录态)
 */
const fs = require('fs');
const path = require('path');
const { STORE_DIR } = require('./paths');
const { extractFingerprint } = require('./fingerprint');
const { readSnapshot, switchTo, rollback } = require('./switcher');
const { validateSnapshot } = require('./accountHealth');

function ensureStore() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function metaPath(id) { return path.join(STORE_DIR, id + '.meta.json'); }
function snapPath(id) { return path.join(STORE_DIR, id + '.snap.json'); }

/**
 * 列出所有已保存账号
 * @returns {Array<{id, shortId, provider, label, note, capturedAt, sizeKb}>}
 */
function list() {
  ensureStore();
  const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.meta.json'));
  const result = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf8'));
      let sizeKb = 0;
      let health = {
        status: 'error',
        summary: '账号快照缺失或不可读',
        warnings: [],
        errors: ['账号快照缺失或不可读'],
        details: {},
      };
      try {
        const stat = fs.statSync(snapPath(meta.id));
        sizeKb = Math.round(stat.size / 1024);
        const snapshot = load(meta.id);
        health = validateSnapshot(snapshot, meta);
      } catch (_) {}
      result.push({ ...meta, sizeKb, health });
    } catch (_) {}
  }
  result.sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
  return result;
}

/**
 * 从当前登录态捕获一个新账号快照
 * @param {{label?:string, note?:string, overwrite?:boolean}} opts
 * @returns {{id, meta, created:boolean}}
 */
function capture(opts = {}) {
  const { label, note = '', overwrite = false } = opts;
  ensureStore();

  const fp = extractFingerprint();
  if (!fp) throw new Error('无法从当前登录态提取账号指纹（请先在 ZCode 里登录任意账号）');

  // 邮箱去重：id 优先用 emailShortId（同一邮箱覆盖更新），无邮箱回退 shortId
  const id = fp.emailShortId || fp.shortId;
  const exists = fs.existsSync(metaPath(id));

  if (exists && !overwrite) {
    // 已存在则跳过（同一邮箱视为同一账号）
    const oldMeta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    return { id, meta: oldMeta, created: false, skipped: true, message: '该账号已存在（' + oldMeta.label + '）' };
  }

  const snap = readSnapshot();
  fs.writeFileSync(snapPath(id), JSON.stringify(snap, null, 0), 'utf8');

  const meta = {
    id,
    shortId: fp.shortId,
    emailShortId: fp.emailShortId || fp.shortId,
    userId: fp.userId,
    provider: fp.provider,
    label: label || fp.label,
    email: fp.email,
    name: fp.name,
    avatar: fp.avatar,
    customerId: fp.customerId,
    userKey: fp.userKey,
    source: fp.source,
    note,
    capturedAt: Date.now(),
  };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');

  return { id, meta, created: true };
}

/** 读取一份账号快照（不切换） */
function load(id) {
  const p = snapPath(id);
  if (!fs.existsSync(p)) throw new Error('找不到账号快照: ' + id);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 切换到指定账号 */
async function use(id, opts = {}) {
  if (!fs.existsSync(snapPath(id))) throw new Error('找不到账号快照: ' + id);
  const snap = load(id);
  return switchTo(snap, opts);
}

/** 删除账号快照 */
function remove(id) {
  let removed = 0;
  for (const f of [metaPath(id), snapPath(id)]) {
    try { fs.unlinkSync(f); removed++; } catch (_) {}
  }
  return removed > 0;
}

/** 重命名账号（改 label/note） */
function rename(id, label, note) {
  if (!fs.existsSync(metaPath(id))) throw new Error('找不到账号: ' + id);
  const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  if (label) meta.label = label;
  if (note !== undefined) meta.note = note;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** 当前登录态指纹（用于 status） */
function current() {
  return extractFingerprint();
}

module.exports = { list, capture, load, use, remove, rename, current, metaPath, snapPath };
