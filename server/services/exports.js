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
  const body = rows.map((r, idx) => {
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
  });
  return [cols.map((c) => c.header), ...applyLayout(body, cols, s.sepidar_layout || 'flat', docNo)];
}

/**
 * How a multi-item document is laid out in the file. Sepidar's importer creates one document per row, so which
 * layout it accepts as ONE document is found by testing (switchable in settings):
 *  flat              header repeated on every item row (what its own export looks like)
 *  first_row_only    header on the first item row, blank on the following item rows
 *  header_row_blank  a header-only row, then item rows with blank header fields
 *  header_row_repeat a header-only row, then item rows that repeat the header
 *  per_row           one document per item row (numbers docNo, docNo+1, ...)
 */
const ITEM_KEYS = new Set(['item_kind', 'row_no', 'base', 'item_code', 'item_title', 'qty', 'price', 'line_total', 'amount',
  'line_account', 'line_account_title', 'line_notes']);

function applyLayout(rows, cols, layout, docNo) {
  const isItem = cols.map((c) => ITEM_KEYS.has(c.key));
  const blankHeader = (r) => r.map((v, i) => (isItem[i] ? v : ''));
  const headerOnly = (r) => r.map((v, i) => (isItem[i] ? '' : v));
  const numIdx = cols.findIndex((c) => c.key === 'number');
  switch (layout) {
    case 'first_row_only':
      return rows.map((r, i) => (i === 0 ? r : blankHeader(r)));
    case 'header_row_blank':
      return rows.length ? [headerOnly(rows[0]), ...rows.map(blankHeader)] : rows;
    case 'header_row_repeat':
      return rows.length ? [headerOnly(rows[0]), ...rows] : rows;
    case 'per_row':
      return numIdx < 0 ? rows : rows.map((r, i) => r.map((v, j) => (j === numIdx ? String(docNo + i) : v)));
    default:
      return rows;
  }
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
    const advance = getSettings().sepidar_layout === 'per_row' ? rows.length : 1; // per_row uses one number per item row
    const next = { ...(getSettings().sepidar_next_no || {}), [`${info.doc}:${info.warehouse}`]: docNo + advance };
    setSetting('sepidar_next_no', next);
    audit(user, 'export.sepidar', 'sepidar_batch', id, { group, docs: docs.length, lines: rows.length, doc_no: docNo });
    return { id, rows };
  });
  if (format === 'bundle') return { batchId: batch.id, buffer: await buildBundle(info, batch.rows, { docNo, date: docDate }) };
  return { batchId: batch.id, buffer: await renderSepidar(sepidarTable(info, batch.rows, { docNo, date: docDate }), format, batch.rows, info) };
}

/** Re-download a past batch (does not change any state). */
export async function regenerateSepidarBatch(id, format) {
  const b = db.prepare('SELECT * FROM sepidar_batches WHERE id = ?').get(id);
  if (!b) throw new HttpError(404, 'دسته پیدا نشد.');
  const info = groupInfo(b.group_key, b.party ?? undefined);
  if (!info || !b.doc_no) throw new HttpError(409, 'این دسته مربوط به نسخه قدیمی است و قابل بازسازی نیست.');
  const ids = db.prepare('SELECT id FROM documents WHERE sepidar_batch_id = ? ORDER BY decided_at, id').all(id).map((r) => r.id);
  const rows = sepidarRows(ids);
  if (format === 'bundle') return buildBundle(info, rows, { docNo: b.doc_no, date: b.doc_date });
  return renderSepidar(sepidarTable(info, rows, { docNo: b.doc_no, date: b.doc_date }), format, rows, info);
}

/**
 * Plain comma-separated items file (code,quantity), for importing the items INTO an already created document.
 * ASCII only and no BOM: a BOM would become part of the first item code and break its parsing.
 *   mode 'none'  -> 31400,100
 *   mode 'latin' -> first line "Code,Quantity"
 *   mode 'row'   -> row number first: 1,31400,100
 *   mode 'repeat' -> the code once per unit (what a barcode scanner log looks like)
 *   mode 'tab' / 'space' / 'semicolon' -> other separators
 */
export function itemsText(rows, mode = 'none', cap = 5000) {
  const lines = [];
  if (mode === 'latin') lines.push('Code,Quantity');
  rows.forEach((r, i) => {
    switch (mode) {
      case 'repeat': // barcode-scanner style: one line per unit (capped, a scanner log is never huge)
        for (let k = 0; k < Math.min(r.qty, cap); k++) lines.push(String(r.item_code));
        break;
      case 'tab': lines.push(`${r.item_code}\t${r.qty}`); break;
      case 'space': lines.push(`${r.item_code} ${r.qty}`); break;
      case 'semicolon': lines.push(`${r.item_code};${r.qty}`); break;
      case 'row': lines.push(`${i + 1},${r.item_code},${r.qty}`); break;
      default: lines.push(`${r.item_code},${r.qty}`);
    }
  });
  return Buffer.from(lines.join('\r\n') + '\r\n', 'ascii');
}

/**
 * Items-only Excel (.xls) for the "add items from Excel" import INSIDE an already created document: no document header,
 * exactly the columns of the document's item grid (seen in the خروج / رسید form):
 *   خروج: ردیف، کد، عنوان، واحد اصلی، کد حساب معین، عنوان (حساب)، فی، مبلغ، توضیحات
 *   رسید: ردیف، مبنا، کد، عنوان، واحد اصلی، فی، کل، توضیحات
 * titles: 'native' = "قلم خروج انبار رديف" (what Sepidar's export writes), 'short' = the grid's own captions.
 * The item/account titles are display-only, so they stay blank unless titles are switched on in settings.
 */
const ITEM_GRID = {
  issue: {
    keys: ['row_no', 'item_code', 'item_title', 'qty', 'line_account', 'line_account_title', 'price', 'amount', 'line_notes'],
    native: ['قلم خروج انبار رديف', 'قلم خروج انبار كد', 'قلم خروج انبار عنوان', 'قلم خروج انبار واحد اصلي', 'قلم خروج انبار كد حساب معين',
      'قلم خروج انبار عنوان1', 'قلم خروج انبار في', 'قلم خروج انبار مبلغ', 'قلم خروج انبار توضيحات'],
    // the second "عنوان" is "عنوان1", as in Sepidar's own export: the importer builds a DataTable from the header
    // row and rejects two columns with the same name (DuplicateNameException)
    short: ['رديف', 'كد', 'عنوان', 'واحد اصلي', 'كد حساب معين', 'عنوان1', 'في', 'مبلغ', 'توضيحات'],
  },
  receipt: {
    keys: ['row_no', 'base', 'item_code', 'item_title', 'qty', 'price', 'line_total', 'line_notes'],
    native: ['قلم رسيد انبار رديف', 'قلم رسيد انبار مبنا', 'قلم رسيد انبار كد', 'قلم رسيد انبار عنوان', 'قلم رسيد انبار واحد اصلي',
      'قلم رسيد انبار في', 'قلم رسيد انبار كل', 'قلم رسيد انبار توضيحات'],
    short: ['رديف', 'مبنا', 'كد', 'عنوان', 'واحد اصلي', 'في', 'كل', 'توضيحات'],
  },
};

export function itemsTable(rows, info, opts = {}) {
  const s = getSettings();
  const g = SEPIDAR_GROUPS[info?.base] ?? {};
  const grid = ITEM_GRID[g.doc === 'receipt' ? 'receipt' : 'issue'];
  const titles = opts.titles ?? !!s.sepidar_titles;
  const style = opts.style ?? (s.sepidar_items_titles || 'short');
  const account = s.sepidar_accounts?.[info?.base] ?? g.line_account ?? '';
  const body = rows.map((r, i) => {
    const v = {
      row_no: String(i + 1),
      base: '',
      item_code: String(r.item_code),
      item_title: titles ? arabic(r.item_title) : '',
      qty: r.qty,
      line_account: account,
      line_account_title: titles && account ? arabic(g.line_account_title ?? '') : '',
      price: '',
      amount: '',
      line_total: '',
      line_notes: '',
    };
    return grid.keys.map((k) => v[k]);
  });
  return [grid[style] ?? grid.native, ...body];
}

export async function renderSepidar(table, format, rows, info) {
  if (format === 'itemsxls') return renderSepidar(itemsTable(rows ?? [], info), 'xls');
  if (format === 'txt') return itemsText(rows ?? [], getSettings().sepidar_txt_header || 'none');
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

// ---------- bundle: create the document (1 item) + add the rest by barcode ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (stored, UTF-8 names): enough to hand over a few small files as one download. */
export function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const MAX_BARCODE_LINES = 50000;

/**
 * The working Sepidar flow (verified with your Sepidar): a document needs one item to exist, and the barcode input
 * adds ONE unit per line. So the bundle holds
 *   1) an .xls that creates the document with its first item (template import: one row = one document),
 *   2) a TXT of barcodes (item codes) for every remaining unit, to be read by the document's barcode input.
 */
/**
 * Splits a document's items between the two files. Sepidar refuses a document without an item, so the creating .xls
 * must hold one line; by default that line is ONE unit of the first item ('one'), and everything else — including the
 * remaining units of that first item — goes into the barcode TXT. 'full' keeps the first item's whole quantity in the .xls.
 */
export function planBundle(rows, mode = 'one') {
  const [first, ...rest] = rows;
  const firstQty = mode === 'full' ? first.qty : 1;
  const remainder = first.qty - firstQty > 0 ? [{ ...first, qty: first.qty - firstQty }] : [];
  return { firstRow: { ...first, qty: firstQty }, txtRows: [...remainder, ...rest], first };
}

export async function buildBundle(info, rows, { docNo, date }) {
  if (!rows.length) throw new HttpError(404, 'قلمی برای این سند وجود ندارد.');
  const mode = getSettings().sepidar_bundle_first || 'one';
  const { firstRow, txtRows, first } = planBundle(rows, mode);
  const rest = txtRows;
  const xls = await renderSepidar(sepidarTable(info, [firstRow], { docNo, date }), 'xls');
  const units = rest.reduce((n, r) => n + r.qty, 0);
  const capped = rest.some((r) => r.qty > MAX_BARCODE_LINES);
  const name = (n) => `${n}-${info.kind}-${info.type}${info.dest ? `-${info.dest}` : ''}-شماره-${docNo}`;
  const guide = [
    `سند: ${info.kind} › ${info.type}${info.dest ? ` (انبار مقصد ${info.dest})` : ''}`,
    `شماره‌ی سند سپیدار: ${docNo}    تاریخ: ${date}    انبار: ${info.warehouse}`,
    '',
    'مرحله ۱ — ساخت سند',
    `  فهرست ${info.kind} › دریافت اطلاعات › الگوی دریافت، فایل «${name('1')}.xls» را وارد کنید.`,
    `  این فایل فقط سند را می‌سازد (سپیدار سند بدون قلم نمی‌پذیرد): کد ${first.item_code} × ${firstRow.qty}${mode === 'full' ? '' : ' (یک واحد؛ باقی با بارکد)'}.`,
    '',
    rest.length ? 'مرحله ۲ — افزودن بقیه‌ی اقلام با بارکد' : 'مرحله ۲ — لازم نیست (سند فقط یک قلم دارد)',
    ...(rest.length ? [
      `  سند ${docNo} را باز کنید، از «بارکد» زیر جدول اقلام فایل «${name('2')}.txt» را بخوانید.`,
      `  هر خط یک واحد از کالا است: ${rest.length} کالا، ${units} خط.`,
      '  شرط: «بارکد کالا» هر قلم در سپیدار برابر کد کالا باشد.',
      ...(capped ? [`  هشدار: برای کالایی که تعدادش بیش از ${MAX_BARCODE_LINES} است فقط ${MAX_BARCODE_LINES} خط نوشته شد.`] : []),
    ] : []),
    '',
    'بعد از ثبت، موجودی هر قلم را با گزارش «برگه‌ی ثبت در سپیدار» مقایسه کنید.',
  ].join('\r\n') + '\r\n';
  const files = [
    { name: `${name('1')}.xls`, data: xls },
    { name: `0-راهنما-شماره-${docNo}.txt`, data: Buffer.from('﻿' + guide, 'utf8') },
  ];
  if (rest.length) files.splice(1, 0, { name: `${name('2')}.txt`, data: itemsText(rest, 'repeat', MAX_BARCODE_LINES) });
  return zipStore(files);
}
