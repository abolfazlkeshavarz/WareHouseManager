import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { db, nowISO, audit, tx, newQrToken, QR_PREFIX, UPLOAD_DIR } from '../db.js';
import { HttpError } from '../auth.js';
import { latinDigits } from '../../public/js/lib/jalali.js';
import { createDocument } from './documents.js';

const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function listItems({ includeInactive = false } = {}) {
  return db.prepare(`SELECT * FROM items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY COALESCE(row_no, 9999), id`).all();
}

export function getItem(id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

/** Resolves a scanned QR payload ("WH:XXXXXXXX") or a typed/other-barcode code to an item. */
export function lookupItem(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.toUpperCase().startsWith(QR_PREFIX)) {
    return db.prepare('SELECT * FROM items WHERE qr_token = ?').get(text.slice(QR_PREFIX.length).toUpperCase()) || null;
  }
  const code = latinDigits(text);
  return db.prepare('SELECT * FROM items WHERE code = ? OR sepidar_code = ? OR qr_token = ?').get(code, code, code.toUpperCase()) || null;
}

function parseFields(body, { partial = false } = {}) {
  const out = {};
  const str = (k, max) => { if (body[k] !== undefined || !partial) out[k] = clean(body[k], max); };
  str('code', 40); str('sepidar_code', 40); str('part_no', 40); str('name', 120); str('variant', 120);
  str('material', 60); str('unit', 20); str('location', 80); str('note', 500);
  if (out.code !== undefined) out.code = latinDigits(out.code);
  if (out.sepidar_code !== undefined) out.sepidar_code = latinDigits(out.sepidar_code);
  if (body.weight_g !== undefined || !partial) {
    const raw = latinDigits(body.weight_g ?? '').trim();
    out.weight_g = raw === '' ? null : Number(raw);
    if (out.weight_g !== null && (!Number.isFinite(out.weight_g) || out.weight_g < 0)) throw new HttpError(400, 'وزن نامعتبر است.');
  }
  if (body.min_stock !== undefined || !partial) {
    const m = Number(latinDigits(body.min_stock ?? 0) || 0);
    if (!Number.isInteger(m) || m < 0) throw new HttpError(400, 'حداقل موجودی باید عدد صحیح و نامنفی باشد.');
    out.min_stock = m;
  }
  if (!partial || 'name' in out) if (!out.name) throw new HttpError(400, 'نام قطعه الزامی است.');
  if (!partial || 'code' in out) if (!out.code) throw new HttpError(400, 'کد قطعه الزامی است.');
  if (out.unit === '') out.unit = 'عدد';
  return out;
}

function assertCodeFree(code, exceptId = null) {
  const row = db.prepare('SELECT id FROM items WHERE code = ?').get(code);
  if (row && row.id !== exceptId) throw new HttpError(409, `کد «${code}» قبلاً برای قطعه دیگری ثبت شده است.`);
}

export function createItem(user, body) {
  const f = parseFields(body);
  assertCodeFree(f.code);
  const t = nowISO();
  const id = Number(db.prepare(`INSERT INTO items(code,sepidar_code,part_no,name,variant,material,weight_g,unit,location,min_stock,note,qr_token,created_at,created_by,updated_at)
                                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.code, f.sepidar_code || f.code, f.part_no, f.name, f.variant, f.material, f.weight_g, f.unit, f.location,
      f.min_stock, f.note, newQrToken(), t, user.id, t).lastInsertRowid);
  audit(user, 'item.create', 'item', id, { code: f.code, name: f.name });
  return getItem(id);
}

export function updateItem(user, id, body) {
  const before = getItem(id);
  if (!before) throw new HttpError(404, 'قطعه پیدا نشد.');
  const f = parseFields(body, { partial: true });
  if (f.code !== undefined) assertCodeFree(f.code, id);
  const keys = Object.keys(f);
  if (!keys.length) return before;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE items SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), nowISO(), id);
  const changes = {};
  for (const k of keys) if (before[k] !== f[k]) changes[k] = [before[k], f[k]];
  if (Object.keys(changes).length) audit(user, 'item.update', 'item', id, changes);
  return getItem(id);
}

export function setItemActive(user, id, active) {
  const it = getItem(id);
  if (!it) throw new HttpError(404, 'قطعه پیدا نشد.');
  if (!active && it.stock > 0) throw new HttpError(409, 'قطعه‌ای که موجودی دارد را نمی‌توان غیرفعال کرد. ابتدا موجودی را صفر کنید.');
  db.prepare('UPDATE items SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowISO(), id);
  audit(user, active ? 'item.activate' : 'item.deactivate', 'item', id);
}

const IMAGE_TYPES = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
];

export function saveItemImage(user, id, buf) {
  const it = getItem(id);
  if (!it) throw new HttpError(404, 'قطعه پیدا نشد.');
  const type = Buffer.isBuffer(buf) && buf.length > 12 ? IMAGE_TYPES.find((t) => t.test(buf)) : null;
  if (!type) throw new HttpError(400, 'فقط تصویر JPG، PNG یا WebP پذیرفته می‌شود.');
  const name = `item-${id}-${crypto.randomBytes(5).toString('hex')}${type.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  db.prepare('UPDATE items SET image = ?, updated_at = ? WHERE id = ?').run('/uploads/' + name, nowISO(), id);
  audit(user, 'item.image', 'item', id);
  return '/uploads/' + name;
}

// ---------- Excel import / template ----------

const HEADER_MAP = {
  code: ['کد', 'کد کالا', 'کد جدید', 'code'],
  name: ['نام', 'نام قطعه', 'name'],
  variant: ['نوع', 'حالت', 'مدل', 'variant'],
  part_no: ['کد قطعه', 'part_no'],
  material: ['جنس', 'material'],
  weight_g: ['وزن', 'وزن (گرم)', 'weight', 'weight_g'],
  unit: ['واحد', 'unit'],
  location: ['محل', 'محل نگهداری', 'location'],
  min_stock: ['حداقل موجودی', 'حداقل', 'min_stock'],
  opening: ['موجودی اولیه', 'موجودی', 'opening'],
  sepidar_code: ['کد سپیدار', 'sepidar_code'],
};

function cellText(c) {
  const v = c?.value;
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? '');
  return String(v);
}

export async function importItems(user, buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new HttpError(400, 'فایل اکسل (xlsx) معتبر نیست.'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'فایل خالی است.');
  const cols = {};
  ws.getRow(1).eachCell((cell, n) => {
    const h = cellText(cell).trim().toLowerCase();
    for (const [key, names] of Object.entries(HEADER_MAP)) {
      if (names.some((x) => x.toLowerCase() === h)) cols[key] = n;
    }
  });
  if (!cols.code || !cols.name) throw new HttpError(400, 'ستون‌های «کد» و «نام» در ردیف اول فایل پیدا نشد.');

  const result = { created: 0, skipped: [], errors: [], opening_docs: 0 };
  const opening = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k) => (cols[k] ? cellText(row.getCell(cols[k])).trim() : '');
    if (!get('code') && !get('name')) continue;
    try {
      const it = createItem(user, {
        code: get('code'), name: get('name'), variant: get('variant'), part_no: get('part_no'), material: get('material'),
        weight_g: get('weight_g'), unit: get('unit'), location: get('location'), min_stock: get('min_stock'),
        sepidar_code: get('sepidar_code'),
      });
      result.created++;
      const op = Number(latinDigits(get('opening')) || 0);
      if (Number.isInteger(op) && op > 0) opening.push({ item_id: it.id, qty: op });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) result.skipped.push({ row: r, code: get('code'), reason: e.message });
      else if (e instanceof HttpError) result.errors.push({ row: r, code: get('code'), reason: e.message });
      else throw e;
    }
  }
  if (opening.length) {
    createDocument(user, { direction: 'in', reason: 'opening', note: 'موجودی اولیه از فایل اکسل', lines: opening });
    result.opening_docs = 1;
  }
  audit(user, 'item.import', 'items', '', { created: result.created, skipped: result.skipped.length, errors: result.errors.length });
  return result;
}

export async function itemTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('قطعات', { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: 'کد', width: 14 }, { header: 'نام قطعه', width: 32 }, { header: 'نوع', width: 22 },
    { header: 'کد قطعه', width: 12 }, { header: 'جنس', width: 12 }, { header: 'وزن (گرم)', width: 12 },
    { header: 'واحد', width: 10 }, { header: 'محل نگهداری', width: 16 }, { header: 'حداقل موجودی', width: 14 },
    { header: 'موجودی اولیه', width: 14 }, { header: 'کد سپیدار', width: 14 },
  ];
  ws.addRow(['40100', 'نمونه قطعه', 'خام', '401', 'PP', 12.5, 'عدد', 'قفسه A1', 50, 200, '40100']);
  ws.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

export function itemWithStats(id) {
  const it = getItem(id);
  if (!it) return null;
  const s = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN d.direction='in' AND d.status='approved' THEN l.qty END),0) AS total_in,
      COALESCE(SUM(CASE WHEN d.direction='out' AND d.status='approved' THEN l.qty END),0) AS total_out,
      COALESCE(SUM(CASE WHEN d.status='pending' AND d.direction='out' THEN l.qty END),0) AS pending_out
    FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.item_id = ?`).get(id);
  return { ...it, ...s };
}

export { tx };

/**
 * Renames item codes (old -> new) in an existing database. The item keeps its id, so QR labels, stock and the whole
 * history stay attached. Skips (and reports) anything missing or whose target code is already taken.
 */
export function recodeItems(user, map) {
  const changed = [];
  const skipped = [];
  tx(() => {
    for (const [from, to] of Object.entries(map)) {
      const it = db.prepare('SELECT * FROM items WHERE code = ?').get(from);
      if (!it) { skipped.push({ from, to, reason: 'قطعه‌ای با کد مبدأ نیست' }); continue; }
      if (db.prepare('SELECT 1 FROM items WHERE code = ?').get(to)) { skipped.push({ from, to, reason: 'کد مقصد قبلاً وجود دارد' }); continue; }
      db.prepare(`UPDATE items SET code = ?, sepidar_code = CASE WHEN sepidar_code IS NULL OR sepidar_code = ? THEN ? ELSE sepidar_code END,
                  updated_at = ? WHERE id = ?`).run(to, from, to, nowISO(), it.id);
      audit(user, 'item.recode', 'item', it.id, { from, to });
      changed.push({ from, to, name: it.name });
    }
  });
  return { changed, skipped };
}
