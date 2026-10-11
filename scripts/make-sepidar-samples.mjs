// Writes sample Sepidar import files (.xls), one per document type, through the SAME code the app's export uses.
// Numbers start at 901, far above the existing document numbers, so they cannot overwrite real documents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// use a throw-away database: importing the server modules opens one
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-samples-'));

const { sepidarGroupInfo, sepidarTable, renderSepidar } = await import('../server/services/exports.js');

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'sepidar');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));

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
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* the DB file is still open on Windows; the OS temp cleaner removes it */ }
