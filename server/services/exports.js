import ExcelJS from 'exceljs';
import { db, tx, nowISO, audit, getSettings } from '../db.js';
import { HttpError } from '../auth.js';
import { REASONS, DIRECTIONS, STATUSES, SEPIDAR_GROUPS } from '../constants.js';
import { jalaliDate, clockTime } from '../../public/js/lib/jalali.js';
import { queryMovements } from './movements.js';

const itemLabel = (r) => (r.variant ? `${r.name} (${r.variant})` : r.name);
const weekdayFmt = new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: 'Asia/Tehran' });
const weekday = (iso) => weekdayFmt.format(new Date(iso));

function sheet(wb, title, columns) {
  const ws = wb.addWorksheet(title, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4B9B' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 24;
  return ws;
}

function finish(ws) {
  if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'middle', wrapText: true }; });
}

const GREEN = { color: { argb: 'FF1B7F3B' }, bold: true };
const ORANGE = { color: { argb: 'FFC2410C' }, bold: true };

/**
 * The complete export (for ourselves). Every sheet answers "who added / dropped which part, when, how many, and what
 * was left" — per movement, per part per day, and per person per day.
 */
export async function buildFullExport({ from, to, fromLabel, toLabel }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'انبار قطعات';
  wb.created = new Date();

  // 1) current stock
  const items = db.prepare('SELECT * FROM items ORDER BY COALESCE(row_no, 9999), id').all();
  const ws1 = sheet(wb, 'موجودی فعلی', [
    { header: 'ردیف', key: 'n', width: 7 }, { header: 'کد', key: 'code', width: 12 },
    { header: 'کد سپیدار', key: 'sepidar', width: 12 }, { header: 'کد قطعه', key: 'part_no', width: 10 },
    { header: 'نام قطعه', key: 'name', width: 32 }, { header: 'نوع / حالت', key: 'variant', width: 24 },
    { header: 'جنس', key: 'material', width: 12 }, { header: 'وزن (گرم)', key: 'weight', width: 10 },
    { header: 'واحد', key: 'unit', width: 8 }, { header: 'موجودی', key: 'stock', width: 10 },
    { header: 'حداقل موجودی', key: 'min', width: 12 }, { header: 'وضعیت', key: 'state', width: 14 },
    { header: 'محل', key: 'location', width: 14 }, { header: 'فعال', key: 'active', width: 8 },
  ]);
  items.forEach((i, n) => {
    const low = i.active && i.min_stock > 0 && i.stock <= i.min_stock;
    const row = ws1.addRow({
      n: n + 1, code: i.code, sepidar: i.sepidar_code, part_no: i.part_no, name: i.name, variant: i.variant,
      material: i.material, weight: i.weight_g, unit: i.unit, stock: i.stock, min: i.min_stock,
      state: low ? 'کمتر از حداقل' : '', location: i.location, active: i.active ? 'بله' : 'خیر',
    });
    if (low) row.getCell('state').font = { color: { argb: 'FFC92A2A' }, bold: true };
  });
  finish(ws1);

  // every movement line, oldest first
  const mv = queryMovements({ from, to }, { limit: null, order: 'ASC' }).rows;

  // 2) day by day, part by part: who added / dropped, at what time
  const detail = [...mv].sort((a, b) => {
    const da = jalaliDate(a.effective_at); const db_ = jalaliDate(b.effective_at);
    if (da !== db_) return a.effective_at < b.effective_at ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.effective_at < b.effective_at ? -1 : a.effective_at > b.effective_at ? 1 : a.line_id - b.line_id;
  });
  const ws2 = sheet(wb, 'ریز حرکات روزانه', [
    { header: 'تاریخ', key: 'date', width: 12 }, { header: 'روز هفته', key: 'wd', width: 11 },
    { header: 'ساعت اعمال', key: 'time', width: 10 }, { header: 'ساعت ثبت', key: 'ctime', width: 10 },
    { header: 'کد', key: 'code', width: 12 }, { header: 'نام قطعه', key: 'name', width: 34 },
    { header: 'نوع', key: 'dir', width: 8 }, { header: 'ورود', key: 'in', width: 9 }, { header: 'خروج', key: 'out', width: 9 },
    { header: 'موجودی قبل', key: 'before', width: 11 }, { header: 'موجودی بعد', key: 'after', width: 11 },
    { header: 'ثبت‌کننده', key: 'creator', width: 14 }, { header: 'تاییدکننده', key: 'decider', width: 14 },
    { header: 'کارگر / طرف مقابل', key: 'worker', width: 18 }, { header: 'علت', key: 'reason', width: 26 },
    { header: 'شماره سند', key: 'doc_no', width: 11 }, { header: 'وضعیت', key: 'status', width: 14 },
    { header: 'توضیح ردیف', key: 'line_note', width: 24 }, { header: 'توضیح سند', key: 'doc_note', width: 28 },
    { header: 'انبار مقصد', key: 'dest', width: 11 }, { header: 'ارسال به سپیدار', key: 'sepidar', width: 14 },
  ]);
  const destByDoc = new Map(db.prepare('SELECT id, dest_warehouse FROM documents').all().map((r) => [r.id, r.dest_warehouse]));
  for (const r of detail) {
    const row = ws2.addRow({
      date: jalaliDate(r.effective_at), wd: weekday(r.effective_at), time: clockTime(r.effective_at), ctime: clockTime(r.created_at),
      code: r.code, name: itemLabel(r), dir: DIRECTIONS[r.direction],
      in: r.direction === 'in' ? r.qty : null, out: r.direction === 'out' ? r.qty : null,
      before: r.stock_before, after: r.stock_after,
      creator: r.created_by_name, decider: r.decided_by_name ?? '',
      worker: r.worker_name, reason: REASONS[r.reason]?.label ?? r.reason, doc_no: r.doc_no, status: STATUSES[r.status],
      line_note: r.line_note, doc_note: r.doc_note, dest: destByDoc.get(r.doc_id) || '',
      sepidar: r.sepidar_batch_id ? `دسته ${r.sepidar_batch_id}` : '',
    });
    row.getCell('in').font = GREEN;
    row.getCell('out').font = ORANGE;
  }
  finish(ws2);

  // 3) per day per part: opening, in, out, closing (approved movements only)
  const applied = detail.filter((r) => r.status === 'approved');
  const byDayItem = new Map();
  for (const r of applied) {
    const key = `${jalaliDate(r.effective_at)}|${r.item_id}`;
    let g = byDayItem.get(key);
    if (!g) {
      g = { date: jalaliDate(r.effective_at), at: r.effective_at, code: r.code, name: itemLabel(r), opening: r.stock_before,
        in: 0, out: 0, closing: r.stock_after, moves: 0, first: r.effective_at, last: r.effective_at, users: new Set(), workers: new Set() };
      byDayItem.set(key, g);
    }
    if (r.direction === 'in') g.in += r.qty; else g.out += r.qty;
    g.closing = r.stock_after;
    g.moves += 1;
    g.last = r.effective_at;
    g.users.add(r.created_by_name);
    if (r.worker_name) g.workers.add(r.worker_name);
  }
  const ws3 = sheet(wb, 'خلاصه روزانه قطعات', [
    { header: 'تاریخ', key: 'date', width: 12 }, { header: 'روز هفته', key: 'wd', width: 11 },
    { header: 'کد', key: 'code', width: 12 }, { header: 'نام قطعه', key: 'name', width: 34 },
    { header: 'موجودی اول روز', key: 'opening', width: 14 }, { header: 'جمع ورود', key: 'in', width: 10 },
    { header: 'جمع خروج', key: 'out', width: 10 }, { header: 'موجودی آخر روز', key: 'closing', width: 14 },
    { header: 'تعداد حرکت', key: 'moves', width: 10 }, { header: 'اولین ساعت', key: 'first', width: 11 },
    { header: 'آخرین ساعت', key: 'last', width: 11 }, { header: 'ثبت‌کنندگان', key: 'users', width: 24 },
    { header: 'کارگران', key: 'workers', width: 28 },
  ]);
  for (const g of [...byDayItem.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.code < b.code ? -1 : 1))) {
    ws3.addRow({
      date: g.date, wd: weekday(g.at), code: g.code, name: g.name, opening: g.opening, in: g.in, out: g.out, closing: g.closing,
      moves: g.moves, first: clockTime(g.first), last: clockTime(g.last), users: [...g.users].join('، '), workers: [...g.workers].join('، '),
    });
  }
  finish(ws3);

  // 4) per day per person
  const docs = db.prepare(`
    SELECT d.*, cu.display_name AS creator, du.display_name AS decider,
           (SELECT COUNT(*) FROM document_lines l WHERE l.document_id = d.id) AS lines,
           (SELECT COALESCE(SUM(qty),0) FROM document_lines l WHERE l.document_id = d.id) AS total
    FROM documents d JOIN users cu ON cu.id = d.created_by LEFT JOIN users du ON du.id = d.decided_by
    WHERE (? IS NULL OR COALESCE(d.decided_at, d.created_at) >= ?) AND (? IS NULL OR COALESCE(d.decided_at, d.created_at) < ?)
    ORDER BY d.id`).all(from ?? null, from ?? null, to ?? null, to ?? null);
  const byDayUser = new Map();
  const bucket = (date, at, user) => {
    const key = `${date}|${user}`;
    let g = byDayUser.get(key);
    if (!g) { g = { date, at, user, created: 0, lines: 0, in: 0, out: 0, approved: 0, rejected: 0 }; byDayUser.set(key, g); }
    return g;
  };
  for (const d of docs) {
    const g = bucket(jalaliDate(d.created_at), d.created_at, d.creator);
    g.created += 1;
    g.lines += d.lines;
    if (d.status === 'approved') { if (d.direction === 'in') g.in += d.total; else g.out += d.total; }
    if (d.decided_by && d.decider && d.decided_by !== d.created_by && d.decided_at) {
      const a = bucket(jalaliDate(d.decided_at), d.decided_at, d.decider);
      if (d.status === 'approved') a.approved += 1; else if (d.status === 'rejected') a.rejected += 1;
    }
  }
  const ws4 = sheet(wb, 'خلاصه روزانه کاربران', [
    { header: 'تاریخ', key: 'date', width: 12 }, { header: 'روز هفته', key: 'wd', width: 11 },
    { header: 'کاربر', key: 'user', width: 16 }, { header: 'اسناد ثبت‌شده', key: 'created', width: 13 },
    { header: 'ردیف‌ها', key: 'lines', width: 9 }, { header: 'جمع ورود (تاییدشده)', key: 'in', width: 17 },
    { header: 'جمع خروج (تاییدشده)', key: 'out', width: 17 }, { header: 'تاییدهای او', key: 'approved', width: 11 },
    { header: 'ردهای او', key: 'rejected', width: 10 },
  ]);
  for (const g of [...byDayUser.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.user < b.user ? -1 : 1))) {
    ws4.addRow({ date: g.date, wd: weekday(g.at), user: g.user, created: g.created, lines: g.lines, in: g.in, out: g.out, approved: g.approved, rejected: g.rejected });
  }
  finish(ws4);

  // 5) documents
  const ws5 = sheet(wb, 'اسناد', [
    { header: 'شماره سند', key: 'no', width: 11 }, { header: 'تاریخ ثبت', key: 'created', width: 18 },
    { header: 'نوع', key: 'dir', width: 8 }, { header: 'علت', key: 'reason', width: 26 },
    { header: 'کارگر / طرف مقابل', key: 'worker', width: 18 }, { header: 'انبار مقصد', key: 'dest', width: 12 },
    { header: 'تعداد ردیف', key: 'lines', width: 10 }, { header: 'جمع تعداد', key: 'total', width: 10 },
    { header: 'توضیح', key: 'note', width: 30 }, { header: 'ثبت‌کننده', key: 'creator', width: 14 },
    { header: 'وضعیت', key: 'status', width: 14 }, { header: 'تاییدکننده', key: 'decider', width: 14 },
    { header: 'تاریخ تصمیم', key: 'decided', width: 18 }, { header: 'یادداشت تصمیم', key: 'dnote', width: 26 },
  ]);
  for (const d of docs) {
    ws5.addRow({
      no: d.doc_no, created: `${jalaliDate(d.created_at)} ${clockTime(d.created_at)}`, dir: DIRECTIONS[d.direction],
      reason: REASONS[d.reason]?.label ?? d.reason, worker: d.worker_name, dest: d.dest_warehouse, lines: d.lines, total: d.total,
      note: d.note, creator: d.creator, status: STATUSES[d.status], decider: d.decider ?? '',
      decided: d.decided_at ? `${jalaliDate(d.decided_at)} ${clockTime(d.decided_at)}` : '', dnote: d.decision_note,
    });
  }
  finish(ws5);

  // 6) audit trail
  const logs = db.prepare('SELECT * FROM audit_log WHERE (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?) ORDER BY id')
    .all(from ?? null, from ?? null, to ?? null, to ?? null);
  const ws6 = sheet(wb, 'گزارش ممیزی', [
    { header: 'تاریخ', key: 'date', width: 12 }, { header: 'ساعت', key: 'time', width: 8 },
    { header: 'کاربر', key: 'user', width: 14 }, { header: 'عملیات', key: 'action', width: 26 },
    { header: 'موجودیت', key: 'entity', width: 12 }, { header: 'شناسه', key: 'id', width: 10 },
    { header: 'جزئیات', key: 'detail', width: 60 },
  ]);
  for (const l of logs) {
    ws6.addRow({ date: jalaliDate(l.at), time: clockTime(l.at), user: l.username, action: l.action, entity: l.entity, id: l.entity_id, detail: l.detail });
  }
  finish(ws6);

  const info = wb.addWorksheet('اطلاعات گزارش', { views: [{ rightToLeft: true }] });
  info.columns = [{ width: 28 }, { width: 60 }];
  info.addRows([
    ['شرکت', getSettings().company_name],
    ['تاریخ تهیه گزارش', `${jalaliDate(new Date())} ${clockTime(new Date())}`],
    ['بازه گزارش', `${fromLabel || 'از ابتدا'} تا ${toLabel || 'اکنون'}`],
    ['تعداد ردیف حرکات', mv.length],
    ['شرح برگه‌ها', 'ریز حرکات روزانه: هر ورود و خروج با ساعت و نام ثبت‌کننده/تاییدکننده • خلاصه روزانه قطعات: اول روز، ورود، خروج، آخر روز • خلاصه روزانه کاربران: فعالیت هر نفر در هر روز'],
    ['«ساعت اعمال»', 'لحظه‌ای که موجودی واقعاً تغییر کرده (برای خروج‌ها لحظه‌ی تایید مدیر)'],
    ['«ساعت ثبت»', 'لحظه‌ای که انباردار درخواست را ثبت کرده'],
  ]);
  info.getColumn(1).font = { bold: true };

  return wb.xlsx.writeBuffer();
}

// ---------- Sepidar: barcode file ----------
// Sepidar's document form has a barcode input that reads one barcode per line and adds ONE unit of the matching item
// per line (verified with your Sepidar). The barcode of an item is its code, so a document's file is its item codes,
// each repeated once per unit.

const MAX_LINES_PER_ITEM = 50000;

/** "31400" repeated qty times, CRLF, no BOM. */
export function barcodeText(rows) {
  const lines = [];
  let capped = false;
  for (const r of rows) {
    const n = Math.min(r.qty, MAX_LINES_PER_ITEM);
    if (r.qty > MAX_LINES_PER_ITEM) capped = true;
    for (let k = 0; k < n; k++) lines.push(String(r.item_code));
  }
  return { buffer: Buffer.from(lines.length ? lines.join('\r\n') + '\r\n' : '', 'utf8'), lines: lines.length, capped };
}

function sepidarRows(docIds) {
  if (!docIds.length) return [];
  const rows = db.prepare(`
    SELECT l.qty, i.code, i.sepidar_code, i.name, i.variant, i.id AS item_id
    FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN items i ON i.id = l.item_id
    WHERE d.id IN (${docIds.map(() => '?').join(',')}) ORDER BY d.decided_at, d.id, l.id`).all(...docIds);
  const byItem = new Map();
  for (const r of rows) {
    const e = byItem.get(r.item_id) || { item_code: r.sepidar_code || r.code, name: itemLabel(r), qty: 0 };
    e.qty += r.qty;
    byItem.set(r.item_id, e);
  }
  return [...byItem.values()];
}

/** Approved documents that map to a Sepidar document type, optionally only not-yet-exported ones. */
function sepidarCandidates({ from, to, includeExported, group }) {
  const where = ["d.status = 'approved'"];
  const params = [];
  if (!includeExported) where.push('d.sepidar_batch_id IS NULL');
  if (from) { where.push('d.decided_at >= ?'); params.push(from); }
  if (to) { where.push('d.decided_at < ?'); params.push(to); }
  const docs = db.prepare(`SELECT d.* FROM documents d WHERE ${where.join(' AND ')} ORDER BY d.decided_at, d.id`).all(...params);
  return docs
    .filter((d) => REASONS[d.reason]?.sepidar)
    .map((d) => ({ ...d, group: groupKey(d) }))
    .filter((d) => !group || d.group === group);
}

/** "transfer:1004" for transfers (one file per destination warehouse), otherwise the plain group name. */
function groupKey(d) {
  const base = REASONS[d.reason].sepidar;
  return base === 'transfer' ? `transfer:${d.dest_warehouse || REASONS[d.reason].dest_default || ''}` : base;
}

export function sepidarGroupInfo(key) {
  const [base, dest] = String(key).split(':');
  const def = SEPIDAR_GROUPS[base];
  if (!def) return null;
  const s = getSettings();
  const main = s.sepidar_warehouses.find((w) => w.code === s.sepidar_main_warehouse);
  const parts = [`انبار: ${main?.title ?? 'انبار'} (${s.sepidar_main_warehouse})`];
  if (base === 'transfer') {
    const d = s.sepidar_warehouses.find((w) => w.code === dest);
    parts.push(`انبار مقصد: ${d?.title ?? dest} (${dest})`);
  }
  return { key, base, doc: def.doc, kind: def.kind, type: def.type, dest: dest || '', warehouse: s.sepidar_main_warehouse, hint: parts.join(' • ') };
}

export function sepidarPreview(range) {
  const docs = sepidarCandidates({ ...range, includeExported: false });
  const keys = [...Object.keys(SEPIDAR_GROUPS).filter((k) => k !== 'transfer'),
    ...new Set(docs.filter((d) => d.group.startsWith('transfer')).map((d) => d.group))];
  const groups = keys.map((key) => {
    const ds = docs.filter((d) => d.group === key);
    const rows = sepidarRows(ds.map((d) => d.id));
    return { ...sepidarGroupInfo(key), doc_count: ds.length, item_count: rows.length, total_qty: rows.reduce((n, r) => n + r.qty, 0) };
  });
  const batches = db.prepare(`SELECT b.*, u.display_name AS by_name FROM sepidar_batches b JOIN users u ON u.id = b.created_by
                              ORDER BY b.id DESC LIMIT 15`).all();
  return { groups, batches };
}

/** One barcode file for all not-yet-exported approved documents of a Sepidar document type (marks them as exported). */
export function createSepidarExport(user, { from, to, group }) {
  const info = sepidarGroupInfo(group);
  if (!info) throw new HttpError(400, 'نوع سند سپیدار نامعتبر است.');
  return tx(() => {
    const docs = sepidarCandidates({ from, to, includeExported: false, group });
    if (!docs.length) throw new HttpError(404, 'سند جدیدی برای این بخش وجود ندارد.');
    const rows = sepidarRows(docs.map((d) => d.id));
    const id = Number(db.prepare('INSERT INTO sepidar_batches(created_at,created_by,doc_count,line_count,from_at,to_at,group_key) VALUES(?,?,?,?,?,?,?)')
      .run(nowISO(), user.id, docs.length, rows.length, from ?? null, to ?? null, group).lastInsertRowid);
    const mark = db.prepare('UPDATE documents SET sepidar_batch_id = ? WHERE id = ?');
    for (const d of docs) mark.run(id, d.id);
    audit(user, 'export.sepidar', 'sepidar_batch', id, { group, docs: docs.length, items: rows.length });
    const file = barcodeText(rows);
    return { batchId: id, info, ...file };
  });
}

/** Re-download a past batch (changes no state). */
export function regenerateSepidarBatch(id) {
  const b = db.prepare('SELECT * FROM sepidar_batches WHERE id = ?').get(id);
  if (!b) throw new HttpError(404, 'دسته پیدا نشد.');
  const ids = db.prepare('SELECT id FROM documents WHERE sepidar_batch_id = ? ORDER BY decided_at, id').all(id).map((r) => r.id);
  return { info: sepidarGroupInfo(b.group_key), ...barcodeText(sepidarRows(ids)) };
}

/** The barcode file of ONE document (any status that moved stock). */
export function documentBarcodeFile(docId) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!d) throw new HttpError(404, 'سند پیدا نشد.');
  if (d.status !== 'approved') throw new HttpError(409, 'فقط برای سندهای تاییدشده فایل ساخته می‌شود.');
  return { doc: d, ...barcodeText(sepidarRows([docId])) };
}
