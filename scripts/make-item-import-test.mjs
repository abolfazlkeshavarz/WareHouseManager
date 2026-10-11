// Builds Sepidar item-master (کالا) import test files (.xls, BIFF8) from our parts, using NEW item codes
// that do not exist in Sepidar, so the import can be tried without touching real items.
//
//   node scripts/make-item-import-test.mjs "<path>/الگو كالا.xls" [outDir] [count]
//
// The header row is copied from the template that Sepidar exported, so the 21 columns always match.
// Two files are written: boolean columns as True/False (the template's own style) and as 1/0.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const [tpl, outDir = 'samples/sepidar-item-test', countArg = '20'] = process.argv.slice(2);
if (!tpl) {
  console.error('usage: node scripts/make-item-import-test.mjs <template.xls> [outDir] [count]');
  process.exit(1);
}
const COUNT = Math.max(1, Math.min(200, Number(countArg) || 20));
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
  tracking: col('عامل رديابي'), taxFree: col('معاف'), sellable: col('قابل فروش'), serial: col('ثبت سريال'),
};

// Sepidar stores Arabic ي / ك; our names use Persian ی / ک.
const arabic = (s) => String(s).replace(/ی/g, 'ي').replace(/ک/g, 'ك');

const parts = JSON.parse(fs.readFileSync(new URL('../server/seed/parts.json', import.meta.url), 'utf8'));
// spread the picks over the whole list so different parts/variants are covered
const step = parts.length / COUNT;
const picks = Array.from({ length: COUNT }, (_, i) => parts[Math.floor(i * step)]);

function build(bool) {
  const T = bool ? 'True' : '1';
  const F = bool ? 'False' : '0';
  const rows = [header];
  picks.forEach((p, i) => {
    const r = new Array(header.length).fill('');
    const code = String(FIRST_CODE + i);
    r[C.kind] = '2';
    r[C.code] = code;
    r[C.title] = arabic(`تست - ${p.name}${p.variant ? ' / ' + p.variant : ''}`);
    r[C.barcode] = code;
    r[C.unit] = 'عدد';
    r[C.fixedRatio] = T;
    r[C.tracking] = F;
    r[C.taxFree] = F;
    r[C.sellable] = T;
    r[C.serial] = F;
    rows.push(r);
  });
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), wb.SheetNames[0]);
  return XLSX.write(out, { type: 'buffer', bookType: 'biff8' });
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'kala-test-A-true-false.xls'), build(true));
fs.writeFileSync(path.join(outDir, 'kala-test-B-1-0.xls'), build(false));
const last = FIRST_CODE + COUNT - 1;
console.log(`wrote ${COUNT} items (codes ${FIRST_CODE}..${last}) to ${outDir}`);
