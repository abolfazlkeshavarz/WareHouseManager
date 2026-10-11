// Writes sample Sepidar import files (.xls), one per document type, through the SAME code the app's export uses.
// Numbers start at 901, far above the existing document numbers, so they cannot overwrite real documents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// use a throw-away database: importing the server modules opens one
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-samples-'));

const { sepidarGroupInfo, sepidarTable, renderSepidar } = await import('../server/services/exports.js');
const { setSetting } = await import('../server/db.js');

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'sepidar');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(path.join(out, 'date-tests'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'layout-tests'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'items-txt'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'items-xls'), { recursive: true, force: true });
for (const f of fs.readdirSync(out)) {
  const p = path.join(out, f);
  if (fs.statSync(p).isFile()) fs.unlinkSync(p); // keep hand-made test folders (key-test, own-export-test)
}

const ROWS = [
  { item_code: '31400', item_title: 'کاور موتور (بالا)', qty: 100 },
  { item_code: '32800', item_title: 'نگهدارنده کیسه', qty: 50 },
  { item_code: '33700', item_title: 'بدنه داخلی فلنچ', qty: 20 },
];
const DATE = '1405/07/18';

const files = [
  ['1-رسید-خرید-داخلی.xls', 'purchase', 901],
  ['2-رسید-تولید.xls', 'production', 902],
  ['3-رسید-سایر.xls', 'other_in', 903],
  ['4-خروج-مصرف.xls', 'consumption', 904],
  ['5-خروج-فروش.xls', 'sale', 905],
  ['6-خروج-سایر.xls', 'other_out', 906, '60034'],
  ['7-خروج-انتقال-به-ضایعات-1004.xls', 'transfer:1004', 907],
];

for (const [name, group, no, party] of files) {
  const info = sepidarGroupInfo(group, party);
  const table = sepidarTable(info, ROWS, { docNo: no, date: DATE });
  fs.writeFileSync(path.join(out, name), await renderSepidar(table, 'xls'));
  console.log(name, '→ number', no, ',', ROWS.length, 'items,', table[0].length, 'columns');
}

// The same خروج file with each date format, to find the one Sepidar's importer accepts.
const variants = [['A-with-time-1405-07-18-12-00-00', 'with_time'], ['B-slash-1405-07-18', 'slash'], ['C-digits-14050718', 'digits'], ['D-dash-1405-07-18', 'dash']];
fs.mkdirSync(path.join(out, 'date-tests'), { recursive: true });
for (const [name, mode] of variants) {
  setSetting('sepidar_date_format', mode);
  const info = sepidarGroupInfo('consumption');
  const table = sepidarTable(info, ROWS, { docNo: 950, date: DATE });
  fs.writeFileSync(path.join(out, 'date-tests', `خروج-مصرف-${name}.xls`), await renderSepidar(table, 'xls'));
  console.log('date-tests', name, '→', JSON.stringify(table[1].slice(0, 3)));
}
setSetting('sepidar_date_format', 'with_time');

// The same 3-item خروج document in each layout: which one does Sepidar's importer turn into ONE document?
fs.mkdirSync(path.join(out, 'layout-tests'), { recursive: true });
const layouts = [
  ['L1-header-row-then-items-blank', 'header_row_blank', 961],
  ['L2-header-row-then-items-repeated', 'header_row_repeat', 962],
  ['L3-header-on-first-item-only', 'first_row_only', 963],
  ['L4-one-document-per-row', 'per_row', 971],
];
for (const [name, layout, no] of layouts) {
  setSetting('sepidar_layout', layout);
  const info = sepidarGroupInfo('consumption');
  const table = sepidarTable(info, ROWS, { docNo: no, date: DATE });
  fs.writeFileSync(path.join(out, 'layout-tests', `خروج-مصرف-${name}.xls`), await renderSepidar(table, 'xls'));
  console.log('layout-tests', name, '->', table.length - 1, 'rows');
}
setSetting('sepidar_layout', 'flat');

// Items-only Excel files (.xls) for adding items to a document that already exists (no header).
const { itemsTable } = await import('../server/services/exports.js');
fs.mkdirSync(path.join(out, 'items-xls'), { recursive: true });
{
  const XLSX = (await import('xlsx')).default;
  const write = (name, table) => {
    const ws = XLSX.utils.aoa_to_sheet(table.map((r) => r.map((v) => (typeof v === 'number' ? v : String(v)))));
    ws['!cols'] = table[0].map((h) => ({ wch: Math.max(12, String(h).length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    fs.writeFileSync(path.join(out, 'items-xls', name), XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
    console.log('items-xls', name, table.length - 1, 'items');
  };
  const full = itemsTable(ROWS, sepidarGroupInfo('consumption'));
  write('I1-اقلام-خروج-مصرف.xls', full);
  write('I2-فقط-کد-و-مقدار.xls', full.map((r) => [r[1], r[3]]));
  write('I3-ردیف-کد-مقدار.xls', full.map((r) => [r[0], r[1], r[3]]));
}

// Items-only comma-separated text files, for importing items INTO an existing document.
const { itemsText } = await import('../server/services/exports.js');
fs.mkdirSync(path.join(out, 'items-txt'), { recursive: true });
for (const [name, mode] of [['T1-code-qty.txt', 'none'], ['T2-header-Code-Quantity.txt', 'latin'], ['T3-row-code-qty.txt', 'row']]) {
  fs.writeFileSync(path.join(out, 'items-txt', name), itemsText(ROWS, mode));
  console.log('items-txt', name);
}
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* the DB file is still open on Windows; the OS temp cleaner removes it */ }
