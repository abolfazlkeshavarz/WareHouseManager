import express from 'express';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, audit, hashPassword, verifyPassword, getSettings, setSetting, QR_PREFIX, nowISO } from './db.js';
import {
  HttpError, login, logout, publicUser, requireAuth, requireAdmin, destroyUserSessions, currentToken,
} from './auth.js';
import { ROLES, REASONS, DIRECTIONS, STATUSES, SEPIDAR_COLUMN_DEFAULTS, SEPIDAR_GROUPS } from './constants.js';
import {
  createDocument, approveDocument, rejectDocument, cancelDocument, adjustStock, getDocument, listDocuments, pendingCount,
} from './services/documents.js';
import {
  listItems, getItem, lookupItem, createItem, updateItem, setItemActive, saveItemImage, importItems, itemTemplate, itemWithStats,
} from './services/items.js';
import { queryMovements } from './services/movements.js';
import { buildFullExport, sepidarPreview, createSepidarExport, regenerateSepidarBatch, sepidarGroupInfo } from './services/exports.js';
import {
  parseJalali, jalaliDayStartISO, jalaliDayEndISO, jalaliDate, todayJalali,
} from '../public/js/lib/jalali.js';

export const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME = { xls: 'application/vnd.ms-excel', xlsx: XLSX_MIME, csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=us-ascii' };

/** Reads ?from=1405/07/01&to=1405/07/30 (Jalali, inclusive) into [fromISO, toISO). */
function dateRange(q) {
  const out = {};
  if (q.from) {
    const j = parseJalali(q.from);
    if (!j) throw new HttpError(400, 'تاریخ شروع نامعتبر است. قالب صحیح: 1405/07/18');
    out.from = jalaliDayStartISO(j);
    out.fromLabel = q.from;
  }
  if (q.to) {
    const j = parseJalali(q.to);
    if (!j) throw new HttpError(400, 'تاریخ پایان نامعتبر است. قالب صحیح: 1405/07/18');
    out.to = jalaliDayEndISO(j);
    out.toLabel = q.to;
  }
  return out;
}

function attachment(res, filename, mime, buf) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="export.${filename.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(buf));
}

const stamp = () => jalaliDate(new Date()).replace(/\//g, '-');

// ---------------- meta ----------------
api.get('/meta', requireAuth, (req, res) => {
  const s = getSettings();
  res.json({
    roles: ROLES, reasons: REASONS, directions: DIRECTIONS, statuses: STATUSES, qr_prefix: QR_PREFIX,
    sepidar_groups: SEPIDAR_GROUPS, company_name: s.company_name, sepidar_enabled: !!s.sepidar_enabled, warehouses: s.sepidar_warehouses, main_warehouse: s.sepidar_main_warehouse, approval_required_out: s.approval_required_out, approval_required_in: s.approval_required_in,
    today: todayJalali(),
  });
});

// ---------------- auth ----------------
api.post('/auth/login', wrap((req, res) => {
  const user = login(req, res, req.body?.username ?? '', req.body?.password ?? '');
  res.json({ user: publicUser(user) });
}));

api.post('/auth/logout', (req, res) => {
  logout(req, res);
  res.json({ ok: true });
});

api.get('/auth/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

api.post('/auth/password', requireAuth, wrap((req, res) => {
  const { current, next } = req.body ?? {};
  if (typeof next !== 'string' || next.length < 8) throw new HttpError(400, 'گذرواژه جدید باید حداقل ۸ نویسه باشد.');
  if (!verifyPassword(String(current ?? ''), req.user.password_hash)) throw new HttpError(400, 'گذرواژه فعلی نادرست است.');
  if (next === current) throw new HttpError(400, 'گذرواژه جدید باید با گذرواژه فعلی متفاوت باشد.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
  destroyUserSessions(req.user.id, currentToken(req));
  audit(req.user, 'auth.password_change', 'user', req.user.id);
  res.json({ ok: true });
}));

// everything below needs a session
api.use(requireAuth);

// ---------------- summary / dashboard ----------------
api.get('/summary', (req, res) => {
  const today = todayJalali();
  const startToday = jalaliDayStartISO(today);
  const endToday = jalaliDayEndISO(today);
  const totals = db.prepare(`SELECT COUNT(*) AS items, COALESCE(SUM(stock),0) AS units,
                                    SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END) AS empty
                             FROM items WHERE active = 1`).get();
  const low = db.prepare(`SELECT id, code, name, variant, stock, min_stock, unit, image FROM items
                          WHERE active = 1 AND min_stock > 0 AND stock <= min_stock ORDER BY (stock * 1.0 / min_stock), name LIMIT 30`).all();
  const todayMv = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN d.direction='in' THEN l.qty END),0) AS qty_in,
           COALESCE(SUM(CASE WHEN d.direction='out' THEN l.qty END),0) AS qty_out,
           COUNT(DISTINCT d.id) AS docs
    FROM documents d JOIN document_lines l ON l.document_id = d.id
    WHERE d.status = 'approved' AND d.decided_at >= ? AND d.decided_at < ?`).get(startToday, endToday);
  const mine = db.prepare("SELECT COUNT(*) AS c FROM documents WHERE status = 'pending' AND created_by = ?").get(req.user.id).c;
  res.json({
    totals, low_stock: low, today: todayMv, pending: pendingCount(), my_pending: mine,
    recent: listDocuments({ limit: 8 }).rows,
  });
});

// ---------------- items ----------------
api.get('/items', (req, res) => {
  const includeInactive = req.user.role === 'admin' && req.query.inactive === '1';
  res.json({ items: listItems({ includeInactive }) });
});

api.get('/items/template', requireAdmin, wrap(async (_req, res) => {
  attachment(res, 'قالب-ورود-قطعات.xlsx', XLSX_MIME, await itemTemplate());
}));

api.get('/items/lookup', (req, res) => {
  const it = lookupItem(req.query.code);
  if (!it) throw new HttpError(404, 'قطعه‌ای با این کد پیدا نشد.');
  if (!it.active) throw new HttpError(409, 'این قطعه غیرفعال شده است.');
  res.json({ item: it });
});

api.get('/items/:id', (req, res) => {
  const it = itemWithStats(Number(req.params.id));
  if (!it) throw new HttpError(404, 'قطعه پیدا نشد.');
  const { rows, total } = queryMovements({ item_id: it.id }, { limit: 100 });
  res.json({ item: it, history: rows, history_total: total });
});

api.post('/items', requireAdmin, (req, res) => {
  res.status(201).json({ item: createItem(req.user, req.body ?? {}) });
});

api.put('/items/:id', requireAdmin, (req, res) => {
  res.json({ item: updateItem(req.user, Number(req.params.id), req.body ?? {}) });
});

api.post('/items/:id/active', requireAdmin, (req, res) => {
  setItemActive(req.user, Number(req.params.id), !!req.body?.active);
  res.json({ item: getItem(Number(req.params.id)) });
});

api.post('/items/:id/adjust', requireAdmin, (req, res) => {
  const r = adjustStock(req.user, Number(req.params.id), req.body?.counted, req.body?.note);
  res.json({ document: getDocument(r.id), item: getItem(Number(req.params.id)) });
});

api.post('/items/:id/image', requireAdmin, express.raw({ type: ['image/*', 'application/octet-stream'], limit: '6mb' }), (req, res) => {
  res.json({ image: saveItemImage(req.user, Number(req.params.id), req.body) });
});

api.post('/items-import', requireAdmin, express.raw({ type: '*/*', limit: '8mb' }), wrap(async (req, res) => {
  res.json(await importItems(req.user, req.body));
}));

api.get('/qr/:token.svg', wrap(async (req, res) => {
  const token = String(req.params.token).toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(token)) throw new HttpError(400, 'کد نامعتبر است.');
  const svg = await QRCode.toString(QR_PREFIX + token, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(svg);
}));

// ---------------- documents ----------------
api.get('/documents', (req, res) => {
  const f = { ...req.query, ...dateRange(req.query) };
  delete f.fromLabel; delete f.toLabel;
  if (req.query.mine === '1') f.user_id = req.user.id;
  res.json(listDocuments(f));
});

api.get('/documents/:id', (req, res) => {
  const d = getDocument(Number(req.params.id));
  if (!d) throw new HttpError(404, 'سند پیدا نشد.');
  res.json({ document: d });
});

api.post('/documents', (req, res) => {
  const r = createDocument(req.user, req.body ?? {});
  res.status(r.duplicate ? 200 : 201).json({ document: getDocument(r.id), duplicate: r.duplicate });
});

api.post('/documents/:id/approve', requireAdmin, (req, res) => {
  approveDocument(req.user, Number(req.params.id));
  res.json({ document: getDocument(Number(req.params.id)) });
});

api.post('/documents/:id/reject', requireAdmin, (req, res) => {
  rejectDocument(req.user, Number(req.params.id), req.body?.reason);
  res.json({ document: getDocument(Number(req.params.id)) });
});

api.post('/documents/:id/cancel', (req, res) => {
  cancelDocument(req.user, Number(req.params.id));
  res.json({ document: getDocument(Number(req.params.id)) });
});

// ---------------- movements / reports ----------------
api.get('/movements', (req, res) => {
  const range = dateRange(req.query);
  const f = { ...req.query, from: range.from, to: range.to };
  const out = queryMovements(f, { limit: Math.min(Number(req.query.limit) || 100, 500), offset: Number(req.query.offset) || 0 });
  res.json(out);
});

// ---------------- workers ----------------
api.get('/workers', (_req, res) => {
  res.json({ workers: db.prepare('SELECT * FROM workers ORDER BY active DESC, name').all() });
});

api.post('/workers', requireAdmin, (req, res) => {
  const name = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'نام را وارد کنید.');
  try {
    db.prepare('INSERT INTO workers(name) VALUES(?)').run(name);
  } catch { throw new HttpError(409, 'این نام قبلاً ثبت شده است.'); }
  audit(req.user, 'worker.create', 'worker', name);
  res.status(201).json({ ok: true });
});

api.post('/workers/:id/active', requireAdmin, (req, res) => {
  db.prepare('UPDATE workers SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, Number(req.params.id));
  audit(req.user, 'worker.active', 'worker', req.params.id, { active: !!req.body?.active });
  res.json({ ok: true });
});

// ---------------- users (admin) ----------------
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

function activeAdminCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1").get().c;
}

api.get('/users', requireAdmin, (_req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY role, id').all().map(publicUser) });
});

api.post('/users', requireAdmin, (req, res) => {
  const { username, display_name, role } = req.body ?? {};
  if (!USERNAME_RE.test(String(username ?? ''))) throw new HttpError(400, 'نام کاربری باید ۳ تا ۳۰ نویسه انگلیسی/عدد باشد.');
  const name = String(display_name ?? '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'نام نمایشی را وارد کنید.');
  if (!ROLES[role]) throw new HttpError(400, 'نقش نامعتبر است.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'این نام کاربری قبلاً ثبت شده است.');
  const pw = randomPassword();
  const id = Number(db.prepare('INSERT INTO users(username,display_name,role,password_hash,must_change_password,created_at) VALUES(?,?,?,?,1,?)')
    .run(username, name, role, hashPassword(pw), nowISO()).lastInsertRowid);
  audit(req.user, 'user.create', 'user', id, { username, role });
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), temp_password: pw });
});

api.put('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'کاربر پیدا نشد.');
  const name = req.body?.display_name !== undefined ? String(req.body.display_name).trim().slice(0, 60) : u.display_name;
  const role = req.body?.role ?? u.role;
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : u.active;
  if (!name) throw new HttpError(400, 'نام نمایشی را وارد کنید.');
  if (!ROLES[role]) throw new HttpError(400, 'نقش نامعتبر است.');
  const losesAdmin = u.role === 'admin' && u.active && (role !== 'admin' || !active);
  if (losesAdmin && activeAdminCount() <= 1) throw new HttpError(409, 'حداقل یک مدیر فعال باید در سیستم باقی بماند.');
  if (id === req.user.id && (!active || role !== u.role)) throw new HttpError(409, 'نمی‌توانید نقش یا وضعیت حساب خودتان را تغییر دهید.');
  db.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, id);
  if (!active) destroyUserSessions(id);
  audit(req.user, 'user.update', 'user', id, { display_name: name, role, active });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

api.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'کاربر پیدا نشد.');
  const pw = randomPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(pw), id);
  destroyUserSessions(id);
  audit(req.user, 'user.reset_password', 'user', id);
  res.json({ temp_password: pw });
});

// ---------------- settings (admin) ----------------
api.get('/settings', requireAdmin, (_req, res) => {
  res.json({ settings: getSettings(), default_sepidar_columns: SEPIDAR_COLUMN_DEFAULTS, groups: SEPIDAR_GROUPS });
});

api.put('/settings', requireAdmin, (req, res) => {
  const b = req.body ?? {};
  const changes = {};
  const str = (k, max) => {
    if (b[k] === undefined) return;
    const v = String(b[k]).trim().slice(0, max);
    if (!v) throw new HttpError(400, 'مقدار خالی مجاز نیست.');
    setSetting(k, v); changes[k] = v;
  };
  const bool = (k) => { if (b[k] !== undefined) { setSetting(k, !!b[k]); changes[k] = !!b[k]; } };
  str('company_name', 100);
  bool('approval_required_out'); bool('approval_required_in'); bool('sepidar_enabled');
  if (b.sepidar_columns_v2 !== undefined) {
    const out = {};
    for (const doc of ['receipt', 'issue']) {
      const known = new Set(SEPIDAR_COLUMN_DEFAULTS[doc].map((c) => c.key));
      const seen = new Set();
      const cols = Array.isArray(b.sepidar_columns_v2?.[doc]) ? b.sepidar_columns_v2[doc] : [];
      out[doc] = cols.filter((c) => known.has(c?.key) && !seen.has(c.key) && seen.add(c.key))
        .map((c) => ({ key: c.key, header: String(c.header ?? '').trim().slice(0, 100) || c.key, enabled: !!c.enabled }));
      if (!out[doc].some((c) => c.enabled)) throw new HttpError(400, 'حداقل یک ستون باید فعال باشد.');
    }
    setSetting('sepidar_columns_v2', out); changes.sepidar_columns_v2 = out;
  }
  if (b.sepidar_party_codes !== undefined) {
    const codes = {};
    for (const k of Object.keys(SEPIDAR_GROUPS)) codes[k] = String(b.sepidar_party_codes?.[k] ?? '').trim().slice(0, 30);
    setSetting('sepidar_party_codes', codes); changes.sepidar_party_codes = codes;
  }
  if (b.sepidar_accounts !== undefined) {
    const acc = {};
    for (const [k, g] of Object.entries(SEPIDAR_GROUPS)) {
      acc[k] = String(b.sepidar_accounts?.[k] ?? '').trim().slice(0, 30);
    }
    setSetting('sepidar_accounts', acc); changes.sepidar_accounts = acc;
  }
  if (b.sepidar_txt_header !== undefined) {
    const v = String(b.sepidar_txt_header);
    if (!['none', 'latin', 'row'].includes(v)) throw new HttpError(400, 'قالب فایل متنی نامعتبر است.');
    setSetting('sepidar_txt_header', v); changes.sepidar_txt_header = v;
  }
  if (b.sepidar_layout !== undefined) {
    const v = String(b.sepidar_layout);
    if (!['flat', 'first_row_only', 'header_row_blank', 'header_row_repeat', 'per_row'].includes(v)) throw new HttpError(400, 'چیدمان نامعتبر است.');
    setSetting('sepidar_layout', v); changes.sepidar_layout = v;
  }
  if (b.sepidar_date_format !== undefined) {
    const v = String(b.sepidar_date_format);
    if (!['slash', 'digits', 'dash', 'with_time'].includes(v)) throw new HttpError(400, 'قالب تاریخ نامعتبر است.');
    setSetting('sepidar_date_format', v); changes.sepidar_date_format = v;
  }
  if (b.sepidar_titles !== undefined) { setSetting('sepidar_titles', !!b.sepidar_titles); changes.sepidar_titles = !!b.sepidar_titles; }
  if (b.sepidar_issuer_id !== undefined) {
    const v = String(b.sepidar_issuer_id).trim();
    if (v && !/^\d{1,9}$/.test(v)) throw new HttpError(400, 'شناسه‌ی کاربر باید عدد باشد.');
    setSetting('sepidar_issuer_id', v); changes.sepidar_issuer_id = v;
  }
  if (b.sepidar_warehouses !== undefined) {
    const list = (Array.isArray(b.sepidar_warehouses) ? b.sepidar_warehouses : [])
      .map((w) => ({ code: String(w?.code ?? '').trim().slice(0, 20), title: String(w?.title ?? '').trim().slice(0, 80) }))
      .filter((w) => w.code && w.title);
    if (!list.length) throw new HttpError(400, 'حداقل یک انبار لازم است.');
    if (new Set(list.map((w) => w.code)).size !== list.length) throw new HttpError(400, 'کد انبارها تکراری است.');
    setSetting('sepidar_warehouses', list); changes.sepidar_warehouses = list;
    const main = String(b.sepidar_main_warehouse ?? getSettings().sepidar_main_warehouse);
    if (!list.some((w) => w.code === main)) throw new HttpError(400, 'انبار اصلی باید یکی از انبارهای فهرست باشد.');
    setSetting('sepidar_main_warehouse', main); changes.sepidar_main_warehouse = main;
  }
  audit(req.user, 'settings.update', 'settings', '', changes);
  res.json({ settings: getSettings() });
});

api.get('/audit', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const q = req.query.q ? `%${req.query.q}%` : null;
  const where = q ? 'WHERE username LIKE ? OR action LIKE ? OR detail LIKE ?' : '';
  const args = q ? [q, q, q] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ total, rows });
});

// ---------------- exports (admin) ----------------
api.get('/export/full', requireAdmin, wrap(async (req, res) => {
  const range = dateRange(req.query);
  const buf = await buildFullExport(range);
  audit(req.user, 'export.full', 'export', '', { from: range.fromLabel, to: range.toLabel });
  attachment(res, `گزارش-کامل-انبار-${stamp()}.xlsx`, XLSX_MIME, buf);
}));

const sepidarOn = (_req, _res, next) => {
  if (!getSettings().sepidar_enabled) return next(new HttpError(403, 'خروجی سپیدار هنوز فعال نشده است.'));
  next();
};

api.get('/export/sepidar/preview', requireAdmin, sepidarOn, (req, res) => {
  res.json(sepidarPreview(dateRange(req.query)));
});

api.post('/export/sepidar', requireAdmin, sepidarOn, wrap(async (req, res) => {
  const range = dateRange(req.body ?? {});
  const format = ['csv', 'xlsx', 'txt'].includes(req.body?.format) ? req.body.format : 'xls';
  const { batchId, buffer } = await createSepidarExport(req.user, { from: range.from, to: range.to, format, group: req.body?.group, doc_no: req.body?.doc_no, date: req.body?.date, party: req.body?.party });
  res.setHeader('X-Batch-Id', String(batchId));
  res.setHeader('Access-Control-Expose-Headers', 'X-Batch-Id');
  const g = sepidarGroupInfo(req.body.group);
  attachment(res, `${g.kind}-${g.type}${g.dest ? '-' + g.dest : ''}-${stamp()}.${format}`, MIME[format], buffer);
}));

api.get('/export/sepidar/batches/:id', requireAdmin, sepidarOn, wrap(async (req, res) => {
  const format = ['csv', 'xlsx', 'txt'].includes(req.query.format) ? req.query.format : 'xls';
  const buf = await regenerateSepidarBatch(Number(req.params.id), format);
  attachment(res, `سپیدار-دسته-${req.params.id}.${format}`, MIME[format], buf);
}));
