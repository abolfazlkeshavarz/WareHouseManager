// Barcode-input test files: the SAME barcode (31400) with different ways of attaching a quantity / other values.
// Every variant uses a DIFFERENT quantity, so the grid after the import shows which form Sepidar understood.
// Usage: node scripts/make-barcode-param-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'sepidar', 'barcode-params');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const BC = '31400'; // the item whose «بارکد کالا» you set
const CRLF = '\r\n';

// [file name, lines, what a successful result looks like]
const variants = [
  ['P01-فقط-بارکد-یک-خط.txt', [BC], 'تعداد 1'],
  ['P02-فقط-بارکد-سه-خط.txt', [BC, BC, BC], 'تعداد 3 (یک خط = یک اسکن) یا سه ردیف'],
  ['P03-بارکد-کاما-تعداد-7.txt', [`${BC},7`], 'تعداد 7'],
  ['P04-بارکد-نقطه‌ویرگول-تعداد-8.txt', [`${BC};8`], 'تعداد 8'],
  ['P05-بارکد-تب-تعداد-9.txt', [`${BC}\t9`], 'تعداد 9'],
  ['P06-بارکد-فاصله-تعداد-11.txt', [`${BC} 11`], 'تعداد 11'],
  ['P07-بارکد-ستاره-تعداد-12.txt', [`${BC}*12`], 'تعداد 12'],
  ['P08-تعداد-ستاره-بارکد-13.txt', [`13*${BC}`], 'تعداد 13'],
  ['P09-بارکد-دونقطه-تعداد-14.txt', [`${BC}:14`], 'تعداد 14'],
  ['P10-با-عنوان-Barcode-Quantity-تعداد-15.txt', ['Barcode,Quantity', `${BC},15`], 'تعداد 15 (خط اول عنوان است)'],
  ['P11-در-گیومه-تعداد-16.txt', [`"${BC}","16"`], 'تعداد 16'],
  ['P12-اعشار-تعداد-2.5.txt', [`${BC},2.5`], 'تعداد 2.5'],
  ['P13-بارکد-تعداد-حساب-111601-تعداد-17.txt', [`${BC},17,111601`], 'تعداد 17 و حساب 111601'],
  ['P14-ردیف-بارکد-تعداد-18.txt', [`1,${BC},18`], 'تعداد 18'],
  ['P15-دو-خط-دو-مقدار-19-و-20.txt', [`${BC},19`, `${BC},20`], 'تعداد 39 یا دو ردیف (19 و 20) یا فقط آخرین'],
];

const index = [];
for (const [name, lines, expect] of variants) {
  fs.writeFileSync(path.join(out, name), lines.join(CRLF) + CRLF, 'ascii');
  index.push(`${name}\t${JSON.stringify(lines)}\t${expect}`);
}
// the same comma file with a .csv extension (some importers decide the format by the extension)
fs.writeFileSync(path.join(out, 'P16-بارکد-کاما-تعداد-21.csv'), `${BC},21${CRLF}`, 'ascii');
index.push(`P16-بارکد-کاما-تعداد-21.csv\t["${BC},21"]\tتعداد 21`);

fs.writeFileSync(path.join(out, 'فهرست-نتیجه-مورد-انتظار.tsv'), ['file\tlines\texpected', ...index].join('\n') + '\n', 'utf8');
console.log(`${variants.length + 1} files in ${out}`);
