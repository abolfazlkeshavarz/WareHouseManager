// Builds Sepidar item-master (کالا) import test files (.xls, BIFF8) from our parts, using NEW item codes
// that do not exist in Sepidar, so the import can be tried without touching real items.
//
//   node scripts/make-item-import-test.mjs "<path>/الگو كالا.xls" [outDir] [count|all] [stock-report.xls]
//   "all" writes every part with its real code and barcode = code (titles of existing Sepidar items kept).
//
// The header row is copied from the template that Sepidar exported, so the 21 columns always match.
// Variants: item type 1 / 2 (کالا/خدمت نوع) with and without a barcode; each uses its own code range (8806xx … 8808xx).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const [tpl, outDir = 'samples/sepidar-item-test', countArg = '20', stockReport] = process.argv.slice(2);
const ALL = countArg === 'all';
if (!tpl) {
  console.error('usage: node scripts/make-item-import-test.mjs <template.xls> [outDir] [count]');
  process.exit(1);
}
const COUNT = ALL ? 0 : Math.max(1, Math.min(200, Number(countArg) || 20));
const FIRST_CODE = 880001;

const wb = XLSX.read(fs.readFileSync(tpl), { type: 'buffer' });
const header = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' })[0];
if (!header || header.length !== 21) throw new Error(`unexpected template header (${header ? header.length : 0} columns)`);
const col = (needle) => {
  const i = header.findIndex((h) => String(h).includes(needle));
  if (i < 0) throw new Error('column not found in template: ' + needle);
  return i;
};
const C = {
  type: col('نوع قلم'), kind: header.findIndex((h) => String(h).endsWith('نوع') && String(h).includes('كالا/خدمت')),
  code: header.findIndex((h) => String(h).endsWith('كد') && String(h).includes('كالا/خدمت') && !String(h).includes('گروه')),
  title: col('عنوان'), barcode: col('بار كد'), unit: col('واحد اصلي'), fixedRatio: col('نسبت واحدها ثابت'),
  tracking: col('عامل رديابي'), taxFree: col('معاف'), sellable: col('قابل فروش'), serial: col('ثبت سريال'), related: col('انبارهاي مرتبط'), defWh: col('انبار پيش فرض'),
};

// Sepidar stores Arabic ي / ك; our names use Persian ی / ک.
const arabic = (s) => String(s).replace(/ی/g, 'ي').replace(/ک/g, 'ك');

const parts = JSON.parse(fs.readFileSync(new URL('../server/seed/parts.json', import.meta.url), 'utf8'));
// spread the picks over the whole list so different parts/variants are covered
const step = parts.length / COUNT;
const picks = ALL ? parts : Array.from({ length: COUNT }, (_, i) => parts[Math.floor(i * step)]);

function build(kind, withBarcode, firstCode, barcodeOf = (c) => c) {
  const rows = [header];
  picks.forEach((p, i) => {
    const r = new Array(header.length).fill('');
    const code = String(firstCode + i);
    r[C.kind] = kind;
    r[C.code] = code;
    r[C.title] = arabic(`تست - ${p.name}${p.variant ? ' / ' + p.variant : ''}`);
    r[C.barcode] = withBarcode ? barcodeOf(code) : '';
    r[C.unit] = 'عدد';
    r[C.fixedRatio] = 'True';
    r[C.tracking] = 'False';
    r[C.taxFree] = 'False';
    r[C.sellable] = 'True';
    r[C.serial] = 'False';
    if (kind === '1') { r[C.related] = '1001'; r[C.defWh] = '1001'; } // goods need at least one warehouse
    rows.push(r);
  });
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), wb.SheetNames[0]);
  return XLSX.write(out, { type: 'buffer', bookType: 'biff8' });
}

fs.mkdirSync(outDir, { recursive: true });

if (ALL) {
  // real codes + barcode = code for every part. Titles/units of items that already exist in Sepidar are taken from its
  // stock report (first two columns = code, title; column "واحد اصلي"), so nothing gets renamed.
  const known = new Map();
  if (stockReport) {
    const w = XLSX.read(fs.readFileSync(stockReport), { type: 'buffer' });
    const rs = XLSX.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1, raw: false, defval: '' });
    const unitCol = rs[0].findIndex((h) => String(h).includes('واحد اصلي'));
    for (const r of rs.slice(1)) if (r[0]) known.set(String(r[0]).trim(), { title: String(r[1]).trim(), unit: unitCol >= 0 ? String(r[unitCol]).trim() : 'عدد' });
  }
  const mk = (list) => {
    const rows = [header];
    for (const p of list) {
      const r = new Array(header.length).fill('');
      const code = String(p.code);
      const k = known.get(code);
      r[C.kind] = '1';
      r[C.code] = code;
      r[C.title] = k ? k.title : arabic(`${p.name}${p.variant ? ' / ' + p.variant : ''}`);
      r[C.barcode] = code;
      r[C.unit] = (k && k.unit) || 'عدد';
      r[C.fixedRatio] = 'True';
      r[C.tracking] = 'False';
      r[C.taxFree] = 'False';
      r[C.sellable] = 'True';
      r[C.serial] = 'False';
      r[C.related] = '1001';
      r[C.defWh] = '1001';
      rows.push(r);
    }
    const out = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), wb.SheetNames[0]);
    return XLSX.write(out, { type: 'buffer', bookType: 'biff8' });
  };
  fs.writeFileSync(path.join(outDir, 'kala-ALL-parts-barcode-eq-code.xls'), mk(parts));
  const missing = stockReport ? parts.filter((p) => !known.has(String(p.code))) : [];
  if (stockReport) fs.writeFileSync(path.join(outDir, 'kala-only-missing-in-sepidar.xls'), mk(missing));
  console.log(`all: ${parts.length} parts; not in Sepidar yet: ${missing.length}`);
  for (const p of missing) console.log('  ', p.code, p.name, p.variant || '');
  process.exit(0);
}

// goods (type 1) with warehouse 1001 as related + default; type 2 is a service in Sepidar and cannot have a barcode
const files = [
  ['kala-H-goods-barcode-eq-code.xls', build('1', true, FIRST_CODE + 600)],
  ['kala-I-goods-barcode-different.xls', build('1', true, FIRST_CODE + 700, (c) => '77' + c)],
  ['kala-J-goods-no-barcode.xls', build('1', false, FIRST_CODE + 800)],
];
for (const [name, buf] of files) fs.writeFileSync(path.join(outDir, name), buf);
console.log(`wrote ${files.length} variants of ${COUNT} items to ${outDir}`);
