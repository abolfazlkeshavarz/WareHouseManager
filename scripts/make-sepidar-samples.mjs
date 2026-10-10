// Writes sample Sepidar import files (.xls), one per document type, in the layout the app's export produces.
// Numbers start at 901, far above the existing document numbers, so they cannot overwrite real documents.
import XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEPIDAR_COLUMN_DEFAULTS } from '../server/constants.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'sepidar');
fs.mkdirSync(out, { recursive: true });
const DATE = '1405/07/18';

function write(name, doc, header, lines) {
  const cols = SEPIDAR_COLUMN_DEFAULTS[doc].filter((c) => c.enabled);
  const rows = lines.map(([code, qty]) => cols.map((c) => (c.key in header ? header[c.key] : { item_code: code, qty }[c.key])));
  const table = [cols.map((c) => c.header), ...rows.map((r) => r.map((v) => (typeof v === 'number' ? v : String(v ?? ''))))];
  const ws = XLSX.utils.aoa_to_sheet(table);
  ws['!cols'] = table[0].map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, path.join(out, name), { bookType: 'biff8' });
  console.log(name, '→ number', header.number, ',', lines.length, 'lines');
}

const LINES = [['31400', 100], ['32800', 50], ['33700', 20]];
const R = { number: 0, date: DATE, warehouse: '1001', account: '211001', purchase_kind: '' };
const I = { date: DATE, warehouse: '1001', dest: '' };

write('1-رسید-خرید-داخلی.xls', 'receipt', { ...R, number: 901, type: 'خرید (داخلی)', purchase_kind: 'داخلی', party: '60031' }, LINES);
write('2-رسید-تولید.xls', 'receipt', { ...R, number: 902, type: 'تولید', party: '1001' }, LINES);
write('3-رسید-سایر.xls', 'receipt', { ...R, number: 903, type: 'سایر', party: '60029' }, LINES);
write('4-خروج-مصرف.xls', 'issue', { ...I, number: 904, type: 'مصرف', party: '1001' }, LINES);
write('5-خروج-فروش.xls', 'issue', { ...I, number: 905, type: 'فروش', party: '' }, LINES);
write('6-خروج-سایر.xls', 'issue', { ...I, number: 906, type: 'سایر', party: '' }, LINES);
write('7-خروج-انتقال-به-ضایعات-1004.xls', 'issue', { ...I, number: 907, type: 'انتقال بین انبار', party: '', dest: '1004' }, LINES);
