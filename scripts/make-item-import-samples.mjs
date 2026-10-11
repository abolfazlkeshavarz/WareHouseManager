// Builds test files for Sepidar's «الگوی دریافت کالا» (item master import), copying the layout of your own item-pattern
// export. Two files:
//   A) 10 NEW test items (new codes 880001..880010, barcode = code): safe, nothing existing is touched.
//   Yes/no columns are written as 1/0 (variant 1) or left blank (variant 2): "True" made the importer fail.
//   B) 10 REAL items already in Sepidar, with their CURRENT title / unit / minimum stock copied from your stock report and
//      the barcode set to the item code: for filling «بار کد کالا». Test with ONE row first (see the README of the repo).
//
// Usage: node scripts/make-item-import-samples.mjs <item-pattern.xls> <stock-report.xls (Sepidar XML)>
//
// The output goes to samples/sepidar/items-master/ which is git-ignored: it contains your real item data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const [patternFile, reportFile] = process.argv.slice(2);
if (!patternFile || !reportFile) {
  console.error('Usage: node scripts/make-item-import-samples.mjs <item-pattern.xls> <stock-report.xls>');
  process.exit(1);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'samples', 'sepidar', 'items-master');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---- the pattern: header row + one example row (to copy value types / defaults)
const pat = XLSX.read(fs.readFileSync(patternFile), { type: 'buffer' });
const patRows = XLSX.utils.sheet_to_json(pat.Sheets[pat.SheetNames[0]], { header: 1, defval: '', raw: true });
const header = patRows[0];
const example = patRows[1];
const col = (needle) => {
  const i = header.findIndex((h) => String(h).includes(needle));
  if (i < 0) throw new Error(`column "${needle}" not found in the pattern`);
  return i;
};
const C = {
  kind: 0,
  type: col('نوع'),            // first "نوع" after نوع قلم
  code: header.findIndex((h) => /كد$/.test(String(h)) && String(h).startsWith('كالا/خدمت')),
  title: header.findIndex((h) => String(h) === 'كالا/خدمت عنوان'),
  title2: header.findIndex((h) => String(h) === 'كالا/خدمت عنوان (2)'),
  barcode: col('بار كد'),
  unit: col('واحد اصلي'),
  warehouse: col('انبارهاي مرتبط كالا كد انبار'),
  min: col('حداقل موجودي'),
  defWh: col('كد انبار پيش فرض'),
};
// the second "نوع" would match "نوع قلم"; the real one is the second column
C.type = header.findIndex((h, i) => i > 0 && String(h) === 'كالا/خدمت نوع');

// ---- the stock report (Sepidar "Excel 2003 XML"): code, title, barcode, unit, minimum stock
const xml = fs.readFileSync(reportFile, 'utf8').replace(/^﻿/, '');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const report = new Map();
for (const row of xml.matchAll(/<Row[^>]*>([\s\S]*?)<\/Row>/g)) {
  const cells = [...row[1].matchAll(/<Cell[^>]*?(?:\/>|>([\s\S]*?)<\/Cell>)/g)].map((c) => {
    const d = c[1] && /<Data[^>]*?(?:\/>|>([\s\S]*?)<\/Data>)/.exec(c[1]);
    return d ? unesc(d[1] ?? '') : '';
  });
  const code = (cells[0] || '').trim();
  if (!code || code === 'كد كالا') continue;
  report.set(code, { title: cells[1] ?? '', barcode: (cells[2] || '').trim(), unit: (cells[21] || 'عدد').trim(), min: cells[18] });
}

const parts = JSON.parse(fs.readFileSync(path.join(root, 'server', 'seed', 'parts.json'), 'utf8'));
const arabic = (t) => String(t ?? '').replace(/ی/g, 'ي').replace(/ک/g, 'ك');

// Yes/no columns. The item importer converts them with Convert.ToDouble, so Sepidar's own "True"/"False" text fails
// ("Input string was not in a correct format"); they must be 1/0 — or left blank.
const BOOL_COLS = ['نسبت واحدها ثابت است', 'عامل رديابي دارد', 'معاف از ماليات (فروش)', 'قابل فروش', 'ثبت سريال']
  .map((n) => header.findIndex((h) => String(h).includes(n)));
if (BOOL_COLS.some((i) => i < 0)) throw new Error('a yes/no column is missing in the pattern');
let boolStyle = 'numeric'; // 'numeric' (1/0) | 'blank'

function makeRow({ code, title, unit, min, barcode }) {
  const r = [...example];
  r[C.kind] = 'ItemStock';
  r[C.type] = '1';
  r[C.code] = String(code);
  r[C.title] = title;
  r[C.title2] = title;
  r[C.barcode] = String(barcode);
  r[C.unit] = unit || 'عدد';
  r[C.warehouse] = '1001';
  r[C.defWh] = '1001';
  r[C.min] = min === '' || min == null || Number.isNaN(Number(min)) ? '' : Number(min);
  for (const i of BOOL_COLS) {
    const on = /true/i.test(String(example[i]));
    r[i] = boolStyle === 'blank' ? '' : on ? '1' : '0';
  }
  return r;
}

function write(name, rows) {
  const table = [header, ...rows].map((r) => r.map((v) => (typeof v === 'number' ? v : String(v ?? ''))));
  const ws = XLSX.utils.aoa_to_sheet(table);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(12, Math.min(String(h).length + 2, 34)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Test');
  fs.writeFileSync(path.join(out, name), XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
}

// builds the A (new test items) and B (real items) row sets with the current boolStyle
function sets() {
  const A = parts.slice(0, 10).map((p, i) => makeRow({
    code: 880001 + i,
    title: arabic(`تست باركد ${i + 1} - ${p.name}${p.variant ? ` ${p.variant}` : ''}`),
    unit: 'عدد',
    min: '',
    barcode: 880001 + i,
  }));
  // B) 10 real items that exist in both lists and have no barcode yet; current values copied from the report
  const real = parts
    .filter((p, i, a) => a.findIndex((q) => q.code === p.code) === i)
    .filter((p) => report.has(p.code) && !report.get(p.code).barcode && !/^\d{6,}$/.test(p.code))
    .slice(0, 10);
  const B = real.map((p) => {
    const r = report.get(p.code);
    return makeRow({ code: p.code, title: r.title, unit: r.unit, min: r.min, barcode: p.code });
  });
  return { A, B };
}

boolStyle = 'numeric';
const num = sets();
write('A1-ده-کالای-تستی-جدید-بولین-1-و-0.xls', num.A);
write('B1-یک-کالای-واقعی-بولین-1-و-0.xls', num.B.slice(0, 1));
write('B-ده-کالای-واقعی-بولین-1-و-0.xls', num.B);
boolStyle = 'blank';
const blank = sets();
write('A2-ده-کالای-تستی-جدید-بولین-خالی.xls', blank.A);
write('B2-یک-کالای-واقعی-بولین-خالی.xls', blank.B.slice(0, 1));
const A = num.A;
const B = num.B;

const list = [
  'A: new test items', ...A.map((r) => `  ${r[C.code]}\t${r[C.title]}`),
  '', 'B: real items (barcode := code), current values from your stock report',
  ...B.map((r) => `  ${r[C.code]}\t${r[C.title]}\tmin=${r[C.min]}`),
].join('\n');
fs.writeFileSync(path.join(out, 'فهرست.txt'), list + '\n', 'utf8');
console.log(list);
