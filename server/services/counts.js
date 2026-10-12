import { db, tx, nowISO, audit, getSettings } from '../db.js';
import { HttpError } from '../auth.js';
import { createDocument } from './documents.js';

// Stock count (انبارگردانی): people count shelves part by part; an admin reviews the differences and applies them as
// ordinary «اصلاح شمارش» documents, so every correction lands in the normal history.
const MAX_COUNTED = 10_000_000;
const ACTIVE = ['open', 'submitted'];

const HEAD = `
  SELECT c.*, cu.display_name AS created_by_name, du.display_name AS decided_by_name, su.display_name AS submitted_by_name,
         (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) AS counted_items
  FROM stock_counts c
  JOIN users cu ON cu.id = c.created_by
  LEFT JOIN users du ON du.id = c.decided_by
  LEFT JOIN users su ON su.id = c.submitted_by`;

function head(id) {
  const c = db.prepare(`${HEAD} WHERE c.id = ?`).get(id);
  if (!c) throw new HttpError(404, 'شمارش پیدا نشد.');
  try { c.result = c.result ? JSON.parse(c.result) : null; } catch { c.result = null; }
  return c;
}

/** While counting, the system quantity is hidden from non-admins when «شمارش کور» is on, so the count stays honest. */
function seesExpected(user, c) {
  return user.role === 'admin' || c.status === 'applied' || getSettings().count_blind === false;
}

export function listCounts() {
  const rows = db.prepare(`${HEAD} ORDER BY c.id DESC LIMIT 100`).all();
  for (const c of rows) { try { c.result = c.result ? JSON.parse(c.result) : null; } catch { c.result = null; } }
  return rows;
}

export function getCount(user, id) {
  const c = head(id);
  const show = seesExpected(user, c);
  const applied = c.status === 'applied';
  const lines = db.prepare(`
    SELECT l.item_id, l.counted, l.counted_at, l.expected AS stored_expected, u.display_name AS counted_by_name,
           i.code, i.name, i.variant, i.unit, i.image, i.location, i.stock
    FROM stock_count_lines l JOIN items i ON i.id = l.item_id JOIN users u ON u.id = l.counted_by
    WHERE l.count_id = ? ORDER BY l.counted_at DESC, l.id DESC`).all(id)
    .map((l) => {
      const { stock, stored_expected, ...rest } = l;
      if (!show) return rest;
      const expected = applied && stored_expected !== null ? stored_expected : stock;
      return { ...rest, expected, diff: l.counted - expected };
    });
  const uncounted = ACTIVE.includes(c.status)
    ? db.prepare(`SELECT i.id AS item_id, i.code, i.name, i.variant, i.unit, i.image, i.location FROM items i
                  WHERE i.active = 1 AND NOT EXISTS (SELECT 1 FROM stock_count_lines l WHERE l.count_id = ? AND l.item_id = i.id)
                  ORDER BY i.row_no, i.code`).all(id)
    : [];
  const totalItems = db.prepare('SELECT COUNT(*) AS c FROM items WHERE active = 1').get().c;
  return { count: c, lines, uncounted, total_items: totalItems, shows_expected: show };
}

export function startCount(user, title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return tx(() => {
    const running = db.prepare("SELECT id FROM stock_counts WHERE status IN ('open','submitted') ORDER BY id DESC").get();
    if (running) throw new HttpError(409, 'یک شمارش باز وجود دارد. ابتدا آن را تمام یا لغو کنید.', { code: 'count_running', id: running.id });
    const id = Number(db.prepare('INSERT INTO stock_counts(title, status, created_by, created_at) VALUES(?, ?, ?, ?)')
      .run(t, 'open', user.id, nowISO()).lastInsertRowid);
    audit(user, 'count.start', 'count', id, { title: t });
    return id;
  });
}

function openCount(id) {
  const c = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'شمارش پیدا نشد.');
  if (c.status !== 'open') throw new HttpError(409, 'این شمارش بسته شده و قابل تغییر نیست.');
  return c;
}

export function setCountLine(user, id, itemId, counted) {
  const n = Number(counted);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNTED) throw new HttpError(400, 'تعداد شمارش‌شده باید عدد صحیح و نامنفی باشد.');
  return tx(() => {
    openCount(id);
    const it = db.prepare('SELECT id, active FROM items WHERE id = ?').get(Number(itemId));
    if (!it) throw new HttpError(404, 'قطعه پیدا نشد.');
    if (!it.active) throw new HttpError(400, 'این قطعه غیرفعال است.');
    db.prepare(`INSERT INTO stock_count_lines(count_id, item_id, counted, counted_by, counted_at) VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(count_id, item_id) DO UPDATE SET counted = excluded.counted, counted_by = excluded.counted_by, counted_at = excluded.counted_at`)
      .run(id, it.id, n, user.id, nowISO());
  });
}

export function removeCountLine(user, id, itemId) {
  return tx(() => {
    openCount(id);
    db.prepare('DELETE FROM stock_count_lines WHERE count_id = ? AND item_id = ?').run(id, Number(itemId));
  });
}

export function submitCount(user, id) {
  return tx(() => {
    openCount(id);
    const n = db.prepare('SELECT COUNT(*) AS c FROM stock_count_lines WHERE count_id = ?').get(id).c;
    if (!n) throw new HttpError(400, 'هنوز قطعه‌ای شمرده نشده است.');
    db.prepare("UPDATE stock_counts SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?").run(user.id, nowISO(), id);
    audit(user, 'count.submit', 'count', id, { lines: n });
  });
}

export function reopenCount(admin, id) {
  return tx(() => {
    const c = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'شمارش پیدا نشد.');
    if (c.status !== 'submitted') throw new HttpError(409, 'فقط شمارشِ ارسال‌شده را می‌توان برای شمارش مجدد برگرداند.');
    db.prepare("UPDATE stock_counts SET status = 'open', submitted_by = NULL, submitted_at = NULL WHERE id = ?").run(id);
    audit(admin, 'count.reopen', 'count', id);
  });
}

export function cancelCount(user, id) {
  return tx(() => {
    const c = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'شمارش پیدا نشد.');
    if (!ACTIVE.includes(c.status)) throw new HttpError(409, 'این شمارش قبلاً بسته شده است.');
    if (user.role !== 'admin' && c.created_by !== user.id) throw new HttpError(403, 'فقط شروع‌کننده یا مدیر می‌تواند شمارش را لغو کند.');
    db.prepare("UPDATE stock_counts SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ?").run(user.id, nowISO(), id);
    audit(user, 'count.cancel', 'count', id);
  });
}

/**
 * Sets every counted part to its counted quantity. Parts that were not counted are left alone.
 * Differences become «اصلاح شمارش» documents (one for increases, one for decreases), applied immediately.
 */
export function applyCount(admin, id) {
  const c = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'شمارش پیدا نشد.');
  if (!ACTIVE.includes(c.status)) throw new HttpError(409, 'این شمارش قبلاً بسته شده است.');
  const lines = db.prepare(`SELECT l.id, l.item_id, l.counted, i.stock FROM stock_count_lines l JOIN items i ON i.id = l.item_id
                            WHERE l.count_id = ? ORDER BY l.id`).all(id);
  if (!lines.length) throw new HttpError(400, 'هنوز قطعه‌ای شمرده نشده است.');

  // remember what the system showed before the correction (kept if a previous attempt already stored it)
  tx(() => {
    const keep = db.prepare('UPDATE stock_count_lines SET expected = ? WHERE id = ? AND expected IS NULL');
    for (const l of lines) keep.run(l.stock, l.id);
  });

  const note = `انبارگردانی شماره ${id}${c.title ? ' - ' + c.title : ''}`;
  const plus = lines.filter((l) => l.counted > l.stock).map((l) => ({ item_id: l.item_id, qty: l.counted - l.stock }));
  const minus = lines.filter((l) => l.counted < l.stock).map((l) => ({ item_id: l.item_id, qty: l.stock - l.counted }));
  const docs = [];
  const post = (direction, reason, list) => {
    for (let i = 0; i < list.length; i += 200) {
      docs.push(createDocument(admin, { direction, reason, note, lines: list.slice(i, i + 200) }).id);
    }
  };
  post('in', 'adjust_in', plus);
  post('out', 'adjust_out', minus);

  const result = {
    counted: lines.length, changed: plus.length + minus.length, same: lines.length - plus.length - minus.length,
    plus_qty: plus.reduce((s, l) => s + l.qty, 0), minus_qty: minus.reduce((s, l) => s + l.qty, 0), docs,
  };
  tx(() => {
    db.prepare("UPDATE stock_counts SET status = 'applied', decided_by = ?, decided_at = ?, result = ? WHERE id = ?")
      .run(admin.id, nowISO(), JSON.stringify(result), id);
    audit(admin, 'count.apply', 'count', id, result);
  });
  return result;
}
