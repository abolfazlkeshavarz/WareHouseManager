import ExcelJS from 'exceljs';
import { db, tx, nowISO, audit, getSettings, setSetting } from '../db.js';
import { HttpError } from '../auth.js';
import XLSX from 'xlsx';
import { REASONS, DIRECTIONS, STATUSES, SEPIDAR_GROUPS, SEPIDAR_COLUMN_DEFAULTS, SEPIDAR_KNOWN_PARTIES } from '../constants.js';
import { parseJalali, latinDigits } from '../../public/js/lib/jalali.js';
import { jalaliDate, clockTime } from '../../public/js/lib/jalali.js';
import { queryMovements } from './movements.js';

const itemLabel = (r) => (r.variant ? `${r.name} (${r.variant})` : r.name);

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

/** Complete export: stock snapshot + every movement (all statuses) + documents + audit trail. */
export async function buildFullExport({ from, to, fromLabel, toLabel }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'انبار قطعات';
  wb.created = new Date();

  // 1) stock
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

  // 2) movements
  const mv = queryMovements({ from, to }, { limit: null, order: 'ASC' }).rows;
  const ws2 = sheet(wb, 'تاریخچه حرکات', [
    { header: 'شماره سند', key: 'doc_no', width: 11 }, { header: 'تاریخ', key: 'date', width: 12 },
    { header: 'ساعت', key: 'time', width: 8 }, { header: 'نوع', key: 'dir', width: 8 },
    { header: 'علت', key: 'reason', width: 26 }, { header: 'کد', key: 'code', width: 12 },
    { header: 'نام قطعه', key: 'name', width: 34 }, { header: 'تعداد', key: 'qty', width: 9 },
    { header: 'موجودی قبل', key: 'before', width: 11 }, { header: 'موجودی بعد', key: 'after', width: 11 },
    { header: 'کارگر / طرف مقابل', key: 'worker', width: 18 }, { header: 'توضیح سند', key: 'doc_note', width: 28 },
    { header: 'توضیح ردیف', key: 'line_note', width: 24 }, { header: 'ثبت‌کننده', key: 'creator', width: 14 },
    { header: 'وضعیت', key: 'status', width: 14 }, { header: 'تاییدکننده', key: 'decider', width: 14 },
    { header: 'تاریخ ثبت', key: 'created', width: 18 }, { header: 'یادداشت تصمیم', key: 'decision', width: 24 },
    { header: 'ارسال به سپیدار', key: 'sepidar', width: 14 },
  ]);
  for (const r of mv) {
    const row = ws2.addRow({
      doc_no: r.doc_no, date: jalaliDate(r.effective_at), time: clockTime(r.effective_at), dir: DIRECTIONS[r.direction],
      reason: REASONS[r.reason]?.label ?? r.reason, code: r.code, name: itemLabel(r), qty: r.qty,
      before: r.stock_before, after: r.stock_after, worker: r.worker_name, doc_note: r.doc_note, line_note: r.line_note,
      creator: r.created_by_name, status: STATUSES[r.status], decider: r.decided_by_name ?? '',
      created: `${jalaliDate(r.created_at)} ${clockTime(r.created_at)}`, decision: r.decision_note,
      sepidar: r.sepidar_batch_id ? `دسته ${r.sepidar_batch_id}` : '',
    });
    row.getCell('dir').font = { color: { argb: r.direction === 'in' ? 'FF1B7F3B' : 'FFC2410C' }, bold: true };
  }
  finish(ws2);

  // 3) documents
  const docs = db.prepare(`
    SELECT d.*, cu.display_name AS creator, du.display_name AS decider,
           (SELECT COUNT(*) FROM document_lines l WHERE l.document_id = d.id) AS lines,
           (SELECT COALESCE(SUM(qty),0) FROM document_lines l WHERE l.document_id = d.id) AS total
    FROM documents d JOIN users cu ON cu.id = d.created_by LEFT JOIN users du ON du.id = d.decided_by
    WHERE (? IS NULL OR COALESCE(d.decided_at, d.created_at) >= ?) AND (? IS NULL OR COALESCE(d.decided_at, d.created_at) < ?)
    ORDER BY d.id`).all(from ?? null, from ?? null, to ?? null, to ?? null);
  const ws3 = sheet(wb, 'اسناد', [
    { header: 'شماره سند', key: 'no', width: 11 }, { header: 'تاریخ ثبت', key: 'created', width: 18 },
    { header: 'نوع', key: 'dir', width: 8 }, { header: 'علت', key: 'reason', width: 26 },
    { header: 'کارگر / طرف مقابل', key: 'worker', width: 18 }, { header: 'انبار مقصد', key: 'dest', width: 12 },
    { header: 'تعداد ردیف', key: 'lines', width: 10 },
    { header: 'جمع تعداد', key: 'total', width: 10 }, { header: 'توضیح', key: 'note', width: 30 },
    { header: 'ثبت‌کننده', key: 'creator', width: 14 }, { header: 'وضعیت', key: 'status', width: 14 },
    { header: 'تاییدکننده', key: 'decider', width: 14 }, { header: 'تاریخ تصمیم', key: 'decided', width: 18 },
    { header: 'یادداشت تصمیم', key: 'dnote', width: 26 },
  ]);
  for (const d of docs) {
    ws3.addRow({
      no: d.doc_no, created: `${jalaliDate(d.created_at)} ${clockTime(d.created_at)}`, dir: DIRECTIONS[d.direction],
      reason: REASONS[d.reason]?.label ?? d.reason, worker: d.worker_name, dest: d.dest_warehouse, lines: d.lines, total: d.total, note: d.note,
      creator: d.creator, status: STATUSES[d.status], decider: d.decider ?? '',
      decided: d.decided_at ? `${jalaliDate(d.decided_at)} ${clockTime(d.decided_at)}` : '', dnote: d.decision_note,
    });
  }
  finish(ws3);

  // 4) audit
  const logs = db.prepare(`SELECT * FROM audit_log WHERE (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?) ORDER BY id`)
    .all(from ?? null, from ?? null, to ?? null, to ?? null);
  const ws4 = sheet(wb, 'گزارش ممیزی', [
    { header: 'تاریخ', key: 'date', width: 12 }, { header: 'ساعت', key: 'time', width: 8 },
    { header: 'کاربر', key: 'user', width: 14 }, { header: 'عملیات', key: 'action', width: 26 },
    { header: 'موجودیت', key: 'entity', width: 12 }, { header: 'شناسه', key: 'id', width: 10 },
    { header: 'جزئیات', key: 'detail', width: 60 },
  ]);
  for (const l of logs) {
    ws4.addRow({ date: jalaliDate(l.at), time: clockTime(l.at), user: l.username, action: l.action, entity: l.entity, id: l.entity_id, detail: l.detail });
  }
  finish(ws4);

  // cover info
  const info = wb.addWorksheet('اطلاعات گزارش', { views: [{ rightToLeft: true }] });
  info.columns = [{ width: 24 }, { width: 50 }];
  info.addRows([
    ['شرکت', getSettings().company_name],
    ['تاریخ تهیه گزارش', `${jalaliDate(new Date())} ${clockTime(new Date())}`],
    ['بازه گزارش', `${fromLabel || 'از ابتدا'} تا ${toLabel || 'اکنون'}`],
    ['تعداد ردیف حرکات', mv.length],
  ]);
  info.getColumn(1).font = { bold: true };

  return wb.xlsx.writeBuffer();
}

// ---------- Sepidar ----------
// Sepidar documents are created one by one (رسید انبار with type خرید/تولید/سایر, or خروج انبار), so the export is
// one file per group; each file holds the item lines (code, title, unit, quantity) to import into that document.

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

function groupInfo(key, partyOverride) {
  const [base, dest] = String(key).split(':');
  const def = SEPIDAR_GROUPS[base];
  if (!def) return null;
  const s = getSettings();
  const main = s.sepidar_warehouses.find((w) => w.code === s.sepidar_main_warehouse);
  const party = String(partyOverride ?? s.sepidar_party_codes?.[base] ?? def.party ?? '').trim();
  const parts = [`انبار: ${main?.title ?? 'انبار'} (${s.sepidar_main_warehouse})`];
  if (base === 'transfer') {
    const d = s.sepidar_warehouses.find((w) => w.code === dest);
    parts.push(`انبار مقصد: ${d?.title ?? dest} (${dest})`);
  } else if (party) {
    parts.push(`${def.doc === 'receipt' ? 'کد تحویل‌دهنده' : 'کد تحویل‌گیرنده'}: ${party}`);
  }
  return {
    key, doc: def.doc, kind: def.kind, type: def.type, dest: dest || '', party, base,
    warehouse: s.sepidar_main_warehouse, hint: parts.join(' • '),
    next_no: s.sepidar_next_no?.[`${def.doc}:${s.sepidar_main_warehouse}`] ?? '',
  };
}

export function sepidarPreview(range) {
  const docs = sepidarCandidates({ ...range, includeExported: false });
  const keys = [...Object.keys(SEPIDAR_GROUPS).filter((k) => k !== 'transfer'), ...new Set(docs.filter((d) => d.group.startsWith('transfer')).map((d) => d.group))];
  const groups = keys.map((key) => {
    const def = groupInfo(key);
    const ds = docs.filter((d) => d.group === key);
    const sums = ds.length
      ? db.prepare(`SELECT COUNT(DISTINCT item_id) AS c, COALESCE(SUM(qty),0) AS q FROM document_lines
                    WHERE document_id IN (${ds.map(() => '?').join(',')})`).get(...ds.map((d) => d.id))
      : { c: 0, q: 0 };
    return { ...def, doc_count: ds.length, item_count: sums.c, total_qty: sums.q };
  });
  const batches = db.prepare(`SELECT b.*, u.display_name AS by_name FROM sepidar_batches b JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 15`).all();
  return { groups, batches };
}

/** Lines of a group, summed per item (a Sepidar document holds one line per item). */
function sepidarRows(docIds) {
  if (!docIds.length) return [];
  const rows = db.prepare(`
    SELECT l.qty, i.code, i.sepidar_code, i.name, i.variant, i.id AS item_id
    FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN items i ON i.id = l.item_id
    WHERE d.id IN (${docIds.map(() => '?').join(',')}) ORDER BY d.decided_at, d.id, l.id`).all(...docIds);
  const byItem = new Map();
  for (const r of rows) {
    const e = byItem.get(r.item_id) || { item_code: r.sepidar_code || r.code, item_title: itemLabel(r), qty: 0 };
    e.qty += r.qty;
    byItem.set(r.item_id, e);
  }
  return [...byItem.values()];
}

function columnsFor(doc) {
  const stored = getSettings().sepidar_columns_v2?.[doc];
  const defaults = SEPIDAR_COLUMN_DEFAULTS[doc];
  const known = new Set(defaults.map((c) => c.key));
  const cols = (Array.isArray(stored) ? stored : defaults).filter((c) => c.enabled && known.has(c.key));
  return cols.length ? cols : defaults;
}

/** "1405/07/18" in the format Sepidar's importer accepts (switchable in settings while we find which one it wants). */
export function formatSepidarDate(date, mode = 'with_time') {
  switch (mode) {
    case 'digits': return date.replace(/\//g, '');          // 14050718
    case 'dash': return date.replace(/\//g, '-');            // 1405-07-18
    case 'with_time': return `${date} 12:00:00 ق.ظ`;          // what Sepidar's own export prints
    case 'slash': return date;                               // 1405/07/18
    default: return `${date} 12:00:00 ق.ظ`;                  // what Sepidar's own export prints
  }
}

/** Sepidar stores Arabic letters; the app types Persian ones. Convert text values so they match its data. */
const arabic = (t) => String(t ?? '').replace(/ی/g, 'ي').replace(/ک/g, 'ك');

/**
 * One row per item; the document header is repeated on every row (that is how Sepidar's template export/import
 * works: rows with the same number + warehouse are one document). Cell types follow Sepidar's own file: text,
 * except the quantity and the zero totals, which are numbers.
 */
export function sepidarTable(info, rows, { docNo, date }) {
  const s = getSettings();
  const cols = columnsFor(info.doc);
  const wh = s.sepidar_warehouses.find((w) => w.code === info.warehouse);
  const dest = s.sepidar_warehouses.find((w) => w.code === info.dest);
  const g = SEPIDAR_GROUPS[info.base];
  const known = SEPIDAR_KNOWN_PARTIES[info.party] ?? {};
  const isPurchase = info.base === 'purchase';
  // "صادر کننده" is the Sepidar user: the name column is display-only and "(2)" is the user's numeric id (the
  // importer parses it as an integer), so both stay blank unless an id is configured.
  const issuerId = /^\d+$/.test(String(s.sepidar_issuer_id ?? '')) ? String(s.sepidar_issuer_id) : '';
  const acct = s.sepidar_accounts?.[info.base];
  const lineAccount = acct ?? g.line_account ?? '';
  // The "عنوان …" columns are display-only foreign keys: Sepidar's export prints a name there, but its importer
  // parses them as numbers ("Input string was not in a correct format"). Leave them blank — the code columns
  // identify warehouse / party / account / item — unless titles are switched on in settings.
  const titles = !!s.sepidar_titles;
  const header = {
    item_kind: info.doc === 'receipt' ? 'InventoryReceiptItem' : 'InventoryDeliveryItem',
    issuer: '',
    issuer2: issuerId,
    number: String(docNo),
    // Sepidar's EXPORT prints "1405/07/18 12:00:00 ق.ظ", but its importer splits the date on "/" and parses every
    // part as an integer, so the time suffix makes it fail ("Input string was not in a correct format").
    date: formatSepidarDate(date, s.sepidar_date_format),
    warehouse: info.warehouse,
    warehouse_title: titles ? arabic(wh?.title ?? '') : '',
    account: info.doc === 'receipt' ? (acct ?? g.account ?? '') : '',
    party: info.party,
    party_id: known.id ?? '',
    party_title: info.party ? (known.id ?? '') : '', // numeric id (or blank), never text
    src_wh: '',
    src_wh_title: '',
    transfer_no: '',
    proforma_no: '',
    type: g.type_code,
    acct_doc_no: '',
    acct_doc_date: '',
    net: 0,
    total: 0,
    by_invoice: 'False',
    carrier: isPurchase ? (known.id ?? '') : '',
    carrier_code: isPurchase ? info.party : '',
    notes: '',
    dest: info.dest,
    dest_title: titles ? arabic(dest?.title ?? '') : '',
  };
  return [cols.map((c) => c.header), ...rows.map((r, idx) => {
    const line = {
      row_no: String(idx + 1),
      base: '',
      item_code: String(r.item_code),
      item_title: titles ? arabic(r.item_title) : '',
      qty: r.qty,
      price: '',
      line_total: '',
      amount: '',
      line_account: lineAccount,
      line_account_title: titles && lineAccount ? arabic(g.line_account_title ?? '') : '',
      line_notes: '',
    };
    return cols.map((c) => (c.key in header ? header[c.key] : line[c.key]) ?? '');
  })];
}

function checkHeader({ doc_no, date }) {
  const docNo = Number(latinDigits(doc_no));
  if (!Number.isInteger(docNo) || docNo < 1 || docNo > 99999999) throw new HttpError(400, 'شماره سند را (به‌صورت عدد) وارد کنید.');
  const j = parseJalali(String(date ?? ''));
  if (!j) throw new HttpError(400, 'تاریخ سند نامعتبر است (مثال: 1405/07/18).');
  return { docNo, date: `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}` };
}

/** Creates a batch for one group (marking its documents as exported) and returns the file buffer. */
export async function createSepidarExport(user, { from, to, format, group, doc_no, date, party }) {
  const info = groupInfo(group, party);
  if (!info) throw new HttpError(400, 'نوع سند سپیدار نامعتبر است.');
  const { docNo, date: docDate } = checkHeader({ doc_no, date });
  const batch = tx(() => {
    const docs = sepidarCandidates({ from, to, includeExported: false, group });
    if (!docs.length) throw new HttpError(404, 'سند جدیدی برای این بخش وجود ندارد.');
    const rows = sepidarRows(docs.map((d) => d.id));
    const id = Number(db.prepare('INSERT INTO sepidar_batches(created_at,created_by,doc_count,line_count,from_at,to_at,group_key,doc_no,doc_date,party) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(nowISO(), user.id, docs.length, rows.length, from ?? null, to ?? null, group, docNo, docDate, info.party).lastInsertRowid);
    const mark = db.prepare('UPDATE documents SET sepidar_batch_id = ? WHERE id = ?');
    for (const d of docs) mark.run(id, d.id);
    const next = { ...(getSettings().sepidar_next_no || {}), [`${info.doc}:${info.warehouse}`]: docNo + 1 };
    setSetting('sepidar_next_no', next);
    audit(user, 'export.sepidar', 'sepidar_batch', id, { group, docs: docs.length, lines: rows.length, doc_no: docNo });
    return { id, rows };
  });
  return { batchId: batch.id, buffer: await renderSepidar(sepidarTable(info, batch.rows, { docNo, date: docDate }), format) };
}

/** Re-download a past batch (does not change any state). */
export async function regenerateSepidarBatch(id, format) {
  const b = db.prepare('SELECT * FROM sepidar_batches WHERE id = ?').get(id);
  if (!b) throw new HttpError(404, 'دسته پیدا نشد.');
  const info = groupInfo(b.group_key, b.party ?? undefined);
  if (!info || !b.doc_no) throw new HttpError(409, 'این دسته مربوط به نسخه قدیمی است و قابل بازسازی نیست.');
  const ids = db.prepare('SELECT id FROM documents WHERE sepidar_batch_id = ? ORDER BY decided_at, id').all(id).map((r) => r.id);
  return renderSepidar(sepidarTable(info, sepidarRows(ids), { docNo: b.doc_no, date: b.doc_date }), format);
}

export async function renderSepidar(table, format) {
  if (format === 'csv') {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return Buffer.from('\uFEFF' + table.map((r) => r.map(esc).join(',')).join('\r\n'), 'utf8'); // BOM so Excel reads Persian
  }
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1', { views: [{ rightToLeft: true }] });
    table.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    return wb.xlsx.writeBuffer();
  }
  // default: real Excel 97-2003 (.xls) — the only type Sepidar's file picker offers.
  // Dates and codes are written as text (so "1405/07/18" and "0123" are never reinterpreted).
  const ws = XLSX.utils.aoa_to_sheet(table.map((r) => r.map((v) => (typeof v === 'number' ? v : String(v)))));
  ws['!cols'] = table[0].map((h) => ({ wch: Math.max(12, Math.min(String(h).length + 2, 40)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
}

export function sepidarGroupInfo(key, party) { return groupInfo(key, party); }
