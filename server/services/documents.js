import { db, tx, nowISO, audit, getSettings } from '../db.js';
import { HttpError } from '../auth.js';
import { REASONS } from '../constants.js';

const ADMIN_ONLY_REASONS = new Set(['opening', 'adjust_in', 'adjust_out']);
const MAX_LINES = 200;
const MAX_QTY = 1_000_000;

const clean = (s, max = 500) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function itemLabel(i) {
  return i.variant ? `${i.name} (${i.variant})` : i.name;
}

function upsertWorker(name) {
  if (!name) return null;
  const row = db.prepare('SELECT id FROM workers WHERE name = ?').get(name);
  if (row) return row.id;
  return Number(db.prepare('INSERT INTO workers(name) VALUES(?)').run(name).lastInsertRowid);
}

function validateLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new HttpError(400, 'حداقل یک قطعه باید در سند باشد.');
  if (rawLines.length > MAX_LINES) throw new HttpError(400, `حداکثر ${MAX_LINES} ردیف در هر سند مجاز است.`);
  const merged = new Map();
  for (const l of rawLines) {
    const itemId = Number(l?.item_id);
    const qty = Number(l?.qty);
    if (!Number.isInteger(itemId)) throw new HttpError(400, 'قطعه نامعتبر است.');
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new HttpError(400, 'تعداد باید یک عدد صحیح مثبت باشد.');
    const m = merged.get(itemId);
    if (m) {
      m.qty += qty;
      if (l.note) m.note = clean([m.note, l.note].filter(Boolean).join(' | '), 300);
    } else {
      merged.set(itemId, { item_id: itemId, qty, note: clean(l.note, 300) });
    }
  }
  const lines = [...merged.values()];
  const getItem = db.prepare('SELECT id, active FROM items WHERE id = ?');
  for (const l of lines) {
    const it = getItem.get(l.item_id);
    if (!it) throw new HttpError(400, 'قطعه‌ای که انتخاب کرده‌اید وجود ندارد.');
    if (!it.active) throw new HttpError(400, 'یکی از قطعات غیرفعال شده است.');
  }
  return lines;
}

/** Moves stock for an already-inserted pending document. Must run inside tx(). */
function applyDocument(docId, decider, decisionNote) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  const lines = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY id').all(docId);
  const getItem = db.prepare('SELECT id, code, name, variant, stock FROM items WHERE id = ?');
  const setStock = db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?');
  const setLine = db.prepare('UPDATE document_lines SET stock_before = ?, stock_after = ? WHERE id = ?');
  const t = nowISO();
  const short = [];
  const checkStock = getSettings().check_stock !== false;
  for (const l of lines) {
    const it = getItem.get(l.item_id);
    const after = doc.direction === 'in' ? it.stock + l.qty : it.stock - l.qty;
    if (after < 0 && checkStock) short.push({ item_id: it.id, code: it.code, name: itemLabel(it), stock: it.stock, qty: l.qty });
    else {
      setStock.run(after, t, it.id);
      setLine.run(it.stock, after, l.id);
    }
  }
  if (short.length) {
    const first = short[0];
    throw new HttpError(409, `موجودی کافی نیست: «${first.name}» موجودی ${first.stock}، درخواست ${first.qty}.`, { code: 'insufficient_stock', short });
  }
  db.prepare("UPDATE documents SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
    .run(decider.id, t, decisionNote, docId);
}

export function createDocument(user, body) {
  const direction = body?.direction;
  const reason = body?.reason;
  const def = REASONS[reason];
  if (!def || def.direction !== direction) throw new HttpError(400, 'نوع یا علت سند نامعتبر است.');
  if (user.role !== 'admin' && ADMIN_ONLY_REASONS.has(reason)) throw new HttpError(403, 'ثبت این نوع سند فقط برای مدیر سیستم مجاز است.');

  const workerName = clean(body.worker_name, 80);
  if (reason === 'to_worker' && !workerName) throw new HttpError(400, 'نام کارگر تحویل‌گیرنده را وارد کنید.');
  const note = clean(body.note, 500);
  const lines = validateLines(body.lines);
  const clientRef = body.client_ref ? clean(body.client_ref, 64) : null;
  const settings0 = getSettings();
  let destWarehouse = '';
  if (def.needs_dest) {
    destWarehouse = clean(body.dest_warehouse, 20);
    const ok = settings0.sepidar_warehouses.some((w) => w.code === destWarehouse) && destWarehouse !== settings0.sepidar_main_warehouse;
    if (!ok) throw new HttpError(400, 'انبار مقصد را انتخاب کنید.');
  } else if (def.dest_default) {
    destWarehouse = def.dest_default;
  }

  return tx(() => {
    if (clientRef) {
      const dup = db.prepare('SELECT id FROM documents WHERE client_ref = ? AND created_by = ?').get(clientRef, user.id);
      if (dup) return { id: dup.id, duplicate: true };
    }
    if (direction === 'out' && getSettings().check_stock !== false) {
      const getStock = db.prepare('SELECT name, variant, stock FROM items WHERE id = ?');
      for (const l of lines) {
        const it = getStock.get(l.item_id);
        if (l.qty > it.stock) {
          throw new HttpError(409, `موجودی کافی نیست: «${itemLabel(it)}» موجودی ${it.stock}، درخواست ${l.qty}.`, { code: 'insufficient_stock' });
        }
      }
    }
    const settings = getSettings();
    const needsApproval = user.role !== 'admin' &&
      (direction === 'out' ? settings.approval_required_out : settings.approval_required_in);
    const workerId = upsertWorker(workerName);
    const t = nowISO();
    const id = Number(db.prepare(`INSERT INTO documents(direction,reason,worker_id,worker_name,note,status,created_by,created_at,client_ref,dest_warehouse)
                                  VALUES(?,?,?,?,?,'pending',?,?,?,?)`)
      .run(direction, reason, workerId, workerName, note, user.id, t, clientRef, destWarehouse).lastInsertRowid);
    db.prepare('UPDATE documents SET doc_no = ? WHERE id = ?').run(1000 + id, id);
    const insLine = db.prepare('INSERT INTO document_lines(document_id,item_id,qty,note) VALUES(?,?,?,?)');
    for (const l of lines) insLine.run(id, l.item_id, l.qty, l.note);
    if (!needsApproval) {
      applyDocument(id, user, user.role === 'admin' ? 'ثبت مستقیم توسط مدیر' : 'تایید خودکار (طبق تنظیمات)');
    }
    audit(user, needsApproval ? 'document.create_pending' : 'document.create_applied', 'document', id, { reason, lines: lines.length });
    return { id, duplicate: false };
  });
}

export function approveDocument(admin, id) {
  return tx(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!doc) throw new HttpError(404, 'سند پیدا نشد.');
    if (doc.status !== 'pending') throw new HttpError(409, 'این سند قبلاً بررسی شده است.');
    applyDocument(id, admin, '');
    audit(admin, 'document.approve', 'document', id);
  });
}

export function rejectDocument(admin, id, reason) {
  const note = clean(reason, 300);
  if (note.length < 2) throw new HttpError(400, 'دلیل رد درخواست را بنویسید.');
  return tx(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!doc) throw new HttpError(404, 'سند پیدا نشد.');
    if (doc.status !== 'pending') throw new HttpError(409, 'این سند قبلاً بررسی شده است.');
    db.prepare("UPDATE documents SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
      .run(admin.id, nowISO(), note, id);
    audit(admin, 'document.reject', 'document', id, note);
  });
}

export function cancelDocument(user, id) {
  return tx(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!doc) throw new HttpError(404, 'سند پیدا نشد.');
    if (doc.status !== 'pending') throw new HttpError(409, 'فقط درخواست‌های در انتظار تایید قابل لغو هستند.');
    if (doc.created_by !== user.id && user.role !== 'admin') throw new HttpError(403, 'فقط ثبت‌کننده یا مدیر می‌تواند درخواست را لغو کند.');
    db.prepare("UPDATE documents SET status = 'cancelled', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
      .run(user.id, nowISO(), 'لغو توسط ' + (user.role === 'admin' ? 'مدیر' : 'ثبت‌کننده'), id);
    audit(user, 'document.cancel', 'document', id);
  });
}

/**
 * Admin delete. The row is kept (history is never erased) but the document disappears from lists, reports and exports:
 * an applied document gets its stock effect reversed, then it is marked deleted with who / when / why.
 */
export function deleteDocument(admin, id, reason) {
  const note = String(reason ?? '').trim().slice(0, 300);
  return tx(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!doc) throw new HttpError(404, 'سند پیدا نشد.');
    if (doc.deleted_at) throw new HttpError(409, 'این سند قبلاً حذف شده است.');
    const t = nowISO();
    const reversed = [];
    if (doc.status === 'approved') {
      const checkStock = getSettings().check_stock !== false;
      const lines = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY id').all(id);
      const getItem = db.prepare('SELECT id, code, name, variant, stock FROM items WHERE id = ?');
      const setStock = db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?');
      for (const l of lines) {
        const it = getItem.get(l.item_id);
        const after = doc.direction === 'in' ? it.stock - l.qty : it.stock + l.qty;
        if (after < 0 && checkStock) {
          throw new HttpError(409, `حذف این سند موجودی «${itemLabel(it)}» را منفی می‌کند (موجودی ${it.stock}، ورودی این سند ${l.qty}). ابتدا خروج‌های بعدی را اصلاح کنید.`, { code: 'insufficient_stock' });
        }
        setStock.run(after, t, it.id);
        reversed.push({ code: it.code, before: it.stock, after });
      }
    }
    db.prepare("UPDATE documents SET deleted_status = status, status = 'cancelled', deleted_at = ?, deleted_by = ?, delete_note = ? WHERE id = ?")
      .run(t, admin.id, note, id);
    audit(admin, 'document.delete', 'document', id, { doc_no: doc.doc_no, was: doc.status, reason: note, reversed });
    return { reversed: reversed.length };
  });
}

/** Admin stock-count correction: sets an item to the counted quantity via an auto-approved document. */
export function adjustStock(admin, itemId, counted, note) {
  const target = Number(counted);
  if (!Number.isInteger(target) || target < 0 || target > MAX_QTY * 10) throw new HttpError(400, 'تعداد شمارش‌شده نامعتبر است.');
  const item = db.prepare('SELECT id, stock FROM items WHERE id = ?').get(itemId);
  if (!item) throw new HttpError(404, 'قطعه پیدا نشد.');
  const diff = target - item.stock;
  if (diff === 0) throw new HttpError(400, 'تعداد شمارش‌شده با موجودی فعلی برابر است.');
  return createDocument(admin, {
    direction: diff > 0 ? 'in' : 'out',
    reason: diff > 0 ? 'adjust_in' : 'adjust_out',
    note: clean(note, 300) || 'اصلاح موجودی پس از شمارش',
    lines: [{ item_id: itemId, qty: Math.abs(diff) }],
  });
}

// ---------- reading ----------

const DOC_SELECT = `
  SELECT d.*, cu.display_name AS created_by_name, du.display_name AS decided_by_name,
         (SELECT COUNT(*) FROM document_lines l WHERE l.document_id = d.id) AS line_count,
         (SELECT COALESCE(SUM(qty),0) FROM document_lines l WHERE l.document_id = d.id) AS total_qty,
         (SELECT group_concat(i.name || CASE WHEN i.variant <> '' THEN ' (' || i.variant || ')' ELSE '' END, '، ')
            FROM (SELECT item_id FROM document_lines WHERE document_id = d.id ORDER BY id LIMIT 3) x
            JOIN items i ON i.id = x.item_id) AS preview
  FROM documents d
  JOIN users cu ON cu.id = d.created_by
  LEFT JOIN users du ON du.id = d.decided_by`;

// A deleted document is stored as 'cancelled' (so every stock query ignores it); readers see it as 'deleted'.
function present(doc) {
  if (doc?.deleted_at) {
    doc.status = 'deleted';
    doc.deleted_by_name = db.prepare('SELECT display_name FROM users WHERE id = ?').get(doc.deleted_by)?.display_name ?? '';
  }
  return doc;
}

export function getDocument(id) {
  const doc = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  if (!doc) return null;
  doc.lines = db.prepare(`SELECT l.id, l.item_id, l.qty, l.note, l.stock_before, l.stock_after,
                                 i.code, i.sepidar_code, i.name, i.variant, i.unit, i.image, i.stock AS current_stock
                          FROM document_lines l JOIN items i ON i.id = l.item_id
                          WHERE l.document_id = ? ORDER BY l.id`).all(id);
  return present(doc);
}

export function listDocuments(f = {}) {
  const where = [];
  const params = [];
  if (f.status === 'deleted') where.push('d.deleted_at IS NOT NULL');
  else {
    where.push('d.deleted_at IS NULL');
    if (f.status) { where.push('d.status = ?'); params.push(f.status); }
  }
  if (f.direction) { where.push('d.direction = ?'); params.push(f.direction); }
  if (f.reason) { where.push('d.reason = ?'); params.push(f.reason); }
  if (f.user_id) { where.push('d.created_by = ?'); params.push(Number(f.user_id)); }
  if (f.from) { where.push('COALESCE(d.decided_at, d.created_at) >= ?'); params.push(f.from); }
  if (f.to) { where.push('COALESCE(d.decided_at, d.created_at) < ?'); params.push(f.to); }
  if (f.item_id) { where.push('EXISTS (SELECT 1 FROM document_lines l WHERE l.document_id = d.id AND l.item_id = ?)'); params.push(Number(f.item_id)); }
  if (f.q) {
    where.push(`(CAST(d.doc_no AS TEXT) LIKE ? OR d.worker_name LIKE ? OR d.note LIKE ?
                 OR EXISTS (SELECT 1 FROM document_lines l JOIN items i ON i.id = l.item_id
                            WHERE l.document_id = d.id AND (i.name LIKE ? OR i.code LIKE ? OR i.variant LIKE ?)))`);
    const like = `%${String(f.q).trim()}%`;
    params.push(like, like, like, like, like, like);
  }
  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM documents d ${sqlWhere}`).get(...params).c;
  const rows = db.prepare(`${DOC_SELECT} ${sqlWhere} ORDER BY d.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows: rows.map(present) };
}

export function pendingCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM documents WHERE status = 'pending'").get().c;
}
