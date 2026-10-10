// Converts a Sepidar "Excel 2003 XML" export (.xls that is really XML) into a real .xlsx file.
// Usage: node scripts/sepidar-xml-to-xlsx.mjs <input.xls> <output.xlsx>
import fs from 'node:fs';
import ExcelJS from 'exceljs';

const [inp, out] = process.argv.slice(2);
const xml = fs.readFileSync(inp, 'utf8').replace(/^\uFEFF/, '');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Sheet', { views: [{ rightToLeft: true }] });
for (const row of xml.matchAll(/<Row[^>]*>([\s\S]*?)<\/Row>/g)) {
  const values = [];
  for (const cell of row[1].matchAll(/<Cell([^>]*?)(?:\/>|>([\s\S]*?)<\/Cell>)/g)) {
    const idx = /ss:Index="(\d+)"/.exec(cell[1]);
    if (idx) while (values.length < +idx[1] - 1) values.push(null);
    const d = cell[2] && /<Data ss:Type="(\w+)"[^>]*?(?:\/>|>([\s\S]*?)<\/Data>)/.exec(cell[2]);
    if (!d) { values.push(null); continue; }
    const text = unesc(d[2] ?? '');
    if (d[1] === 'Number' && text !== '' && !Number.isNaN(Number(text))) values.push(Number(text));
    else values.push(text === '' ? null : text);
  }
  ws.addRow(values);
}
ws.getRow(1).font = { bold: true };
await wb.xlsx.writeFile(out);
console.log(`${ws.rowCount} rows x ${ws.columnCount} columns -> ${out}`);
