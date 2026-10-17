import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-test-'));
process.env.DATA_DIR = dir;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const { server } = await import('../server/index.js');
const { db, hashPassword } = await import('../server/db.js');
const ExcelJS = (await import('exceljs')).default;
const jal = await import('../public/js/lib/jalali.js');

let base;
const PW = 'test-pass-1234';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const r = await fetch(base + url, {
      method,
      headers: { 'x-wh': '1', ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), cookie: this.cookie, ...headers },
      body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    if (raw) return r;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json };
  }
  async login(u) {
    const r = await this.req('POST', '/api/auth/login', { username: u, password: PW });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
}

before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0').run(hashPassword(PW));
});

after(() => { server.closeAllConnections?.(); server.close(); });

test('jalali conversion round-trips and matches known dates', () => {
  assert.deepEqual(jal.toJalali(2026, 10, 10), { jy: 1405, jm: 7, jd: 18 });
  assert.deepEqual(jal.toGregorian(1405, 1, 1), { gy: 2026, gm: 3, gd: 21 });
  assert.deepEqual(jal.toJalali(2025, 3, 20), { jy: 1403, jm: 12, jd: 30 }); // leap year end
  assert.equal(jal.jalaliDate('2026-10-10T08:00:00Z'), '1405/07/18');
  assert.equal(jal.latinDigits('۱۴۰۵/۰۷/۱۸'), '1405/07/18');
  const start = jal.jalaliDayStartISO({ jy: 1405, jm: 7, jd: 18 });
  assert.equal(jal.jalaliDate(start), '1405/07/18');
  assert.equal(jal.clockTime(start), '00:00');
});

test('seeded data is present', async () => {
  const c = new Client();
  await c.login('anbardar');
  const r = await c.req('GET', '/api/items');
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 114);
  assert.ok(r.json.items.every((i) => i.stock === 0 && /^[A-Z2-9]{8}$/.test(i.qr_token)));
});

test('auth: wrong password, role guard, csrf header', async () => {
  const c = new Client();
  assert.equal((await c.req('POST', '/api/auth/login', { username: 'mokhtar', password: 'nope' })).status, 401);
  assert.equal((await c.req('GET', '/api/items')).status, 401);
  await c.login('anbardar');
  assert.equal((await c.req('GET', '/api/users')).status, 403);
  const noHeader = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: c.cookie } });
  assert.equal(noHeader.status, 403);
});

test('full flow: opening stock → storekeeper request → approve → history → exports', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const keeper = new Client();
  await keeper.login('anbardar');

  const items = (await keeper.req('GET', '/api/items')).json.items;
  const a = items.find((i) => i.code === '30700');
  const b = items.find((i) => i.code === '30801');

  // QR lookup (by payload and by plain code)
  const byQr = await keeper.req('GET', '/api/items/lookup?code=' + encodeURIComponent('WH:' + a.qr_token));
  assert.equal(byQr.json.item.id, a.id);
  const byCode = await keeper.req('GET', '/api/items/lookup?code=' + encodeURIComponent('۳۰۷۰۰'));
  assert.equal(byCode.json.item.id, a.id);

  // storekeeper may not set opening stock
  const denied = await keeper.req('POST', '/api/documents', {
    direction: 'in', reason: 'opening', lines: [{ item_id: a.id, qty: 5 }],
  });
  assert.equal(denied.status, 403);

  // admin opening stock applies immediately
  const open = await admin.req('POST', '/api/documents', {
    direction: 'in', reason: 'opening', lines: [{ item_id: a.id, qty: 100 }, { item_id: b.id, qty: 40 }],
  });
  assert.equal(open.status, 201);
  assert.equal(open.json.document.status, 'approved');
  assert.equal((await keeper.req('GET', '/api/items/' + a.id)).json.item.stock, 100);

  // out request by storekeeper → pending, stock untouched
  const ref = 'ref-' + Math.random();
  const outBody = {
    direction: 'out', reason: 'to_worker', worker_name: 'علی رضایی', note: 'شیفت صبح', client_ref: ref,
    lines: [{ item_id: a.id, qty: 30, note: 'برای خط ۱' }, { item_id: b.id, qty: 10 }],
  };
  const out = await keeper.req('POST', '/api/documents', outBody);
  assert.equal(out.status, 201);
  assert.equal(out.json.document.status, 'pending');
  assert.equal((await keeper.req('GET', '/api/items/' + a.id)).json.item.stock, 100);

  // idempotent resubmission does not create a second document
  const again = await keeper.req('POST', '/api/documents', outBody);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.document.id, out.json.document.id);

  // requesting more than available is rejected up-front
  const tooMany = await keeper.req('POST', '/api/documents', {
    direction: 'out', reason: 'to_worker', worker_name: 'x', lines: [{ item_id: b.id, qty: 9999 }],
  });
  assert.equal(tooMany.status, 409);

  // storekeeper cannot approve; admin can
  assert.equal((await keeper.req('POST', `/api/documents/${out.json.document.id}/approve`)).status, 403);
  const sum = await admin.req('GET', '/api/summary');
  assert.equal(sum.json.pending, 1);
  const ok = await admin.req('POST', `/api/documents/${out.json.document.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.document.status, 'approved');
  assert.equal(ok.json.document.decided_by_name, 'مختار');
  assert.deepEqual(ok.json.document.lines.map((l) => [l.stock_before, l.stock_after]), [[100, 70], [40, 30]]);
  assert.equal((await admin.req('POST', `/api/documents/${out.json.document.id}/approve`)).status, 409);

  // return from worker (no approval needed by default)
  const back = await keeper.req('POST', '/api/documents', {
    direction: 'in', reason: 'return_from_worker', worker_name: 'علی رضایی', lines: [{ item_id: a.id, qty: 5 }],
  });
  assert.equal(back.json.document.status, 'approved');

  // reject path needs a reason and leaves stock alone
  const out2 = await keeper.req('POST', '/api/documents', {
    direction: 'out', reason: 'scrap', lines: [{ item_id: a.id, qty: 1 }],
  });
  assert.equal((await admin.req('POST', `/api/documents/${out2.json.document.id}/reject`, {})).status, 400);
  const rej = await admin.req('POST', `/api/documents/${out2.json.document.id}/reject`, { reason: 'ضایعات نیست' });
  assert.equal(rej.json.document.status, 'rejected');

  // keeper cancels own pending
  const out3 = await keeper.req('POST', '/api/documents', {
    direction: 'out', reason: 'scrap', lines: [{ item_id: a.id, qty: 1 }],
  });
  assert.equal((await keeper.req('POST', `/api/documents/${out3.json.document.id}/cancel`)).json.document.status, 'cancelled');

  // admin stock-count correction
  const adj = await admin.req('POST', `/api/items/${a.id}/adjust`, { counted: 70, note: 'شمارش انبارگردانی' });
  assert.equal(adj.json.item.stock, 70);
  assert.equal(adj.json.document.reason, 'adjust_out');

  // history carries every line with before/after
  const hist = await keeper.req('GET', `/api/items/${a.id}`);
  assert.ok(hist.json.history.length >= 5);
  const stocks = hist.json.history.filter((h) => h.status === 'approved').map((h) => h.stock_after).reverse();
  assert.deepEqual(stocks, [100, 70, 75, 70]);

  // append-only guarantees at DB level
  assert.throws(() => db.prepare('DELETE FROM documents').run());
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run());

  // ---- Sepidar: barcode files — one item code per unit (the barcode input adds one unit per line) ----
  const pre = await admin.req('GET', '/api/export/sepidar/preview');
  const grp = Object.fromEntries(pre.json.groups.map((g) => [g.key, g]));
  assert.equal(grp.consumption.doc_count, 1);     // the approved to_worker document
  assert.equal(grp.consumption.item_count, 2);
  assert.equal(grp.consumption.total_qty, 40);    // 30 + 10 units = 40 barcode lines
  assert.equal(grp.consumption.type, 'مصرف');
  assert.equal(grp.production.doc_count, 1);      // return_from_worker
  assert.equal(grp.purchase.doc_count, 0);
  assert.equal((await keeper.req('POST', '/api/export/sepidar', { group: 'consumption' })).status, 403);
  assert.equal((await admin.req('POST', '/api/export/sepidar', { group: 'purchase' })).status, 404);
  assert.equal((await admin.req('POST', '/api/export/sepidar', { group: 'nope' })).status, 400);

  // one document's own file (admin only, approved only)
  const docFile = await admin.req('GET', `/api/documents/${out.json.document.id}/barcodes.txt`, null, { raw: true });
  assert.equal(docFile.status, 200);
  const expected = '30700\r\n'.repeat(30) + '30801\r\n'.repeat(10);
  assert.equal(await docFile.text(), expected);
  assert.equal(docFile.headers.get('x-lines'), '40');
  assert.equal((await keeper.req('GET', `/api/documents/${out.json.document.id}/barcodes.txt`)).status, 403);
  assert.equal((await admin.req('GET', `/api/documents/${out2.json.document.id}/barcodes.txt`)).status, 409); // rejected

  // the grouped file marks its documents as exported
  const exp = await admin.req('POST', '/api/export/sepidar', { group: 'consumption' }, { raw: true });
  assert.equal(exp.status, 200);
  assert.equal(exp.headers.get('x-lines'), '40');
  assert.equal(await exp.text(), expected);
  const pre2 = await admin.req('GET', '/api/export/sepidar/preview');
  assert.equal(pre2.json.groups.find((g) => g.key === 'consumption').doc_count, 0);
  assert.equal((await admin.req('POST', '/api/export/sepidar', { group: 'consumption' })).status, 404);
  const again2 = await admin.req('GET', '/api/export/sepidar/batches/1', null, { raw: true });
  assert.equal(again2.status, 200);
  assert.equal(await again2.text(), expected);

  // transfers & scrap: destination warehouse is required / defaulted, one Sepidar file per destination
  const tr0 = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'transfer', lines: [{ item_id: a.id, qty: 1 }] });
  assert.equal(tr0.status, 400);
  const trSame = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'transfer', dest_warehouse: '1001', lines: [{ item_id: a.id, qty: 1 }] });
  assert.equal(trSame.status, 400);
  const tr = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'transfer', dest_warehouse: '1002', lines: [{ item_id: a.id, qty: 2 }] });
  assert.equal(tr.status, 201);
  const sc = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'scrap', lines: [{ item_id: b.id, qty: 3 }] });
  assert.equal(sc.json.document.dest_warehouse, '1004');
  const sale = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'sale', lines: [{ item_id: b.id, qty: 1 }] });
  assert.equal(sale.status, 201);
  const pre3 = await admin.req('GET', '/api/export/sepidar/preview');
  const keys = pre3.json.groups.filter((g) => g.doc_count > 0).map((g) => g.key).sort();
  assert.deepEqual(keys, ['production', 'sale', 'transfer:1002', 'transfer:1004']);
  assert.match(pre3.json.groups.find((g) => g.key === 'transfer:1004').hint, /1004/);
  const t1004 = await admin.req('POST', '/api/export/sepidar', { group: 'transfer:1004' }, { raw: true });
  assert.equal(t1004.status, 200);
  assert.equal(await t1004.text(), '30801\r\n'.repeat(3));

  // ---- optional bundle: creating .xls (first item, full quantity) + barcode TXT of the rest ----
  {
    const XLSX = (await import('xlsx')).default;
    const unzip = (buf) => { // minimal reader for the stored ZIP we write
      const files = {};
      let p = 0;
      while (buf.readUInt32LE(p) === 0x04034b50) {
        const size = buf.readUInt32LE(p + 18);
        const nameLen = buf.readUInt16LE(p + 26);
        const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
        files[name] = buf.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
        p += 30 + nameLen + size;
      }
      return files;
    };
    // a fresh group for this test: sale of 2 different items
    const s1 = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'other_out', lines: [{ item_id: a.id, qty: 4 }, { item_id: b.id, qty: 2 }] });
    assert.equal(s1.status, 201);
    // validation happens before anything is marked as exported
    assert.equal((await admin.req('POST', '/api/export/sepidar', { group: 'other_out', bundle: true, date: '1405/07/18' })).status, 400);
    assert.equal((await admin.req('POST', '/api/export/sepidar', { group: 'other_out', bundle: true, doc_no: 61, date: 'x' })).status, 400);
    assert.equal((await keeper.req('POST', '/api/export/sepidar', { group: 'other_out', bundle: true, doc_no: 61, date: '1405/07/18' })).status, 403);
    const one = await admin.req('GET', `/api/documents/${s1.json.document.id}/bundle.zip?doc_no=61&date=1405/07/18&party=60034`, null, { raw: true });
    assert.equal(one.status, 200);
    const zip = unzip(Buffer.from(await one.arrayBuffer()));
    const names = Object.keys(zip);
    const xlsName = names.find((n) => n.endsWith('.xls'));
    const txtName = names.find((n) => n.startsWith('2-'));
    assert.ok(xlsName && txtName && names.some((n) => n.startsWith('0-')));
    assert.equal(zip[xlsName].subarray(0, 4).toString('hex'), 'd0cf11e0'); // genuine .xls
    const sheet = XLSX.read(zip[xlsName], { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(sheet.Sheets[sheet.SheetNames[0]], { header: 1 });
    assert.equal(aoa.length, 2);                       // header + the ONE creating line
    assert.equal(aoa[1][0], 'InventoryDeliveryItem');
    assert.equal(aoa[1][1], '61');
    assert.equal(aoa[1][2], '1405/07/18 12:00:00 ق.ظ');
    assert.equal(aoa[1][3], '1001');
    assert.equal(aoa[1][4], '60034');                  // the party typed in
    assert.equal(aoa[1][6], '3');                      // type code of «سایر»
    assert.equal(aoa[1][8], '30700');                  // the FIRST item …
    assert.equal(aoa[1][9], 4);                        // … with its FULL quantity
    assert.equal(aoa[1][10], '111304');
    assert.equal(zip[txtName].toString(), '30801\r\n30801\r\n');   // the rest, one line per unit
    // the grouped bundle marks documents as exported and remembers the next number
    const g = await admin.req('POST', '/api/export/sepidar', { group: 'other_out', bundle: true, doc_no: 61, date: '1405/07/18', party: '60034' }, { raw: true });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'application/zip');
    const pv = await admin.req('GET', '/api/export/sepidar/preview');
    assert.equal(pv.json.groups.find((x) => x.key === 'other_out').doc_count, 0);
    assert.equal(pv.json.groups.find((x) => x.key === 'other_out').next_no, 62);
  }

  // ---- the complete export: who added / dropped which part, at what time, per day ----
  const full = await admin.req('GET', '/api/export/full', null, { raw: true });
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(await full.arrayBuffer()));
  assert.deepEqual(wb2.worksheets.map((s) => s.name), [
    'موجودی فعلی', 'ریز حرکات روزانه', 'خلاصه روزانه قطعات', 'خلاصه روزانه کاربران', 'اسناد', 'گزارش ممیزی', 'اطلاعات گزارش']);
  assert.equal(wb2.getWorksheet('موجودی فعلی').rowCount, 1 + 114);

  const rowsOf = (ws) => {
    const head = ws.getRow(1).values.slice(1);
    const out = [];
    ws.eachRow((r, n) => { if (n > 1) out.push(Object.fromEntries(head.map((h, i) => [h, r.values[i + 1]]))); });
    return out;
  };
  const detail = rowsOf(wb2.getWorksheet('ریز حرکات روزانه'));
  assert.ok(detail.length >= 8);
  const firstOut = detail.find((r) => r['کد'] === '30700' && r['خروج'] === 30);
  assert.ok(firstOut, 'the 30-piece hand-out is listed');
  assert.match(firstOut['ساعت اعمال'], /^\d\d:\d\d$/);
  assert.match(firstOut['ساعت ثبت'], /^\d\d:\d\d$/);
  assert.equal(firstOut['ثبت‌کننده'], 'انباردار');
  assert.equal(firstOut['تاییدکننده'], 'مختار');
  assert.equal(firstOut['کارگر / طرف مقابل'], 'علی رضایی');
  assert.equal(firstOut['موجودی قبل'], 100);
  assert.equal(firstOut['موجودی بعد'], 70);
  assert.ok(firstOut['روز هفته']);
  // the same part's day summary: starts at 0, +105 in, -41 out, ends at 64
  const sumDay = rowsOf(wb2.getWorksheet('خلاصه روزانه قطعات')).find((r) => r['کد'] === '30700');
  assert.equal(sumDay['موجودی اول روز'], 0);
  assert.equal(sumDay['جمع ورود'], 105);
  assert.equal(sumDay['جمع خروج'], 41);
  assert.equal(sumDay['موجودی آخر روز'], 64);
  assert.equal(sumDay['تعداد حرکت'], 6);
  const people = rowsOf(wb2.getWorksheet('خلاصه روزانه کاربران'));
  const keeperRow = people.find((r) => r['کاربر'] === 'انباردار');
  assert.ok(keeperRow && keeperRow['اسناد ثبت‌شده'] >= 3);
  assert.ok(people.find((r) => r['کاربر'] === 'مختار' && r['تاییدهای او'] >= 1));

  // date filter parsing
  const today = jal.jalaliDate(new Date());
  const f = await admin.req('GET', `/api/movements?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`);
  assert.equal(f.status, 200);
  assert.ok(f.json.total > 0);
  assert.equal((await admin.req('GET', '/api/movements?from=garbage')).status, 400);
});

test('items: create, duplicate code, edit, import template round trip', async () => {
  const admin = new Client();
  await admin.login('sattar');
  const r = await admin.req('POST', '/api/items', { code: '99001', name: 'قطعه تست', variant: 'خام', min_stock: '۱۰', weight_g: '۱۲/۵'.replace('/', '.') });
  assert.equal(r.status, 201);
  assert.equal(r.json.item.min_stock, 10);
  assert.equal((await admin.req('POST', '/api/items', { code: '99001', name: 'تکراری' })).status, 409);
  const u = await admin.req('PUT', `/api/items/${r.json.item.id}`, { location: 'قفسه B2' });
  assert.equal(u.json.item.location, 'قفسه B2');
  assert.equal((await admin.req('POST', `/api/items/${r.json.item.id}/active`, { active: false })).json.item.active, 0);

  const tpl = await admin.req('GET', '/api/items/template', null, { raw: true });
  assert.equal(tpl.status, 200);
  const imp = await admin.req('POST', '/api/items-import', Buffer.from(await tpl.arrayBuffer()),
    { headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  assert.equal(imp.json.created, 1);
  assert.equal(imp.json.opening_docs, 1);
});

test('check_stock setting: off lets stock-out exceed the stock (negative), on refuses again', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const it = (await admin.req('GET', '/api/items')).json.items.find((i) => i.code === '31200');
  const out = (qty) => admin.req('POST', '/api/documents', { direction: 'out', reason: 'to_worker', worker_name: 'کارگر', lines: [{ item_id: it.id, qty }] });
  assert.equal((await admin.req('GET', '/api/meta')).json.check_stock, true);
  assert.equal((await out(5)).status, 409);

  assert.equal((await admin.req('PUT', '/api/settings', { check_stock: false })).status, 200);
  assert.equal((await admin.req('GET', '/api/meta')).json.check_stock, false);
  const r = await out(5);
  assert.equal(r.status, 201);
  assert.equal(r.json.document.lines[0].stock_after, -5);
  assert.equal((await admin.req('GET', '/api/items/' + it.id)).json.item.stock, -5);

  assert.equal((await admin.req('PUT', '/api/settings', { check_stock: true })).status, 200);
  assert.equal((await out(1)).status, 409);
  // put the stock back so later tests are unaffected
  assert.equal((await admin.req('POST', '/api/documents', { direction: 'in', reason: 'other_in', lines: [{ item_id: it.id, qty: 5 }] })).status, 201);
});

test('workers: delete removes from the list, documents keep the name', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const keeper = new Client();
  await keeper.login('anbardar');
  const it = (await admin.req('GET', '/api/items')).json.items.find((i) => i.code === '31300');
  await admin.req('POST', '/api/documents', { direction: 'in', reason: 'other_in', lines: [{ item_id: it.id, qty: 3 }] });
  const doc = await admin.req('POST', '/api/documents', { direction: 'out', reason: 'to_worker', worker_name: 'کارگر حذفی', lines: [{ item_id: it.id, qty: 1 }] });
  assert.equal(doc.status, 201);
  const w = (await admin.req('GET', '/api/workers')).json.workers.find((x) => x.name === 'کارگر حذفی');
  assert.ok(w);
  assert.equal((await keeper.req('POST', `/api/workers/${w.id}/delete`)).status, 403);
  const del = await admin.req('POST', `/api/workers/${w.id}/delete`);
  assert.equal(del.status, 200);
  assert.equal(del.json.documents, 1);
  assert.equal((await admin.req('GET', '/api/workers')).json.workers.some((x) => x.id === w.id), false);
  assert.equal((await admin.req('GET', '/api/documents/' + doc.json.document.id)).json.document.worker_name, 'کارگر حذفی');
  assert.equal((await admin.req('POST', `/api/workers/${w.id}/delete`)).status, 404);
});

test('worker balance: delivered minus returned per worker and part (variants together)', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const items = (await admin.req('GET', '/api/items')).json.items;
  const raw = items.find((i) => i.code === '30900');
  const sib = items.find((i) => i.part_no === raw.part_no && i.name === raw.name && i.id !== raw.id);
  const other = items.find((i) => i.code === '32000');
  const doc = (direction, reason, worker_name, lines) => admin.req('POST', '/api/documents', { direction, reason, worker_name, lines });
  assert.equal((await doc('in', 'other_in', '', [{ item_id: raw.id, qty: 50 }, { item_id: other.id, qty: 10 }])).status, 201);
  assert.equal((await doc('out', 'to_worker', 'کارگر مانده', [{ item_id: raw.id, qty: 20 }, { item_id: other.id, qty: 4 }])).status, 201);
  assert.equal((await doc('in', 'return_from_worker', 'کارگر مانده', [{ item_id: (sib || raw).id, qty: 15 }])).status, 201);
  assert.equal((await doc('in', 'return_from_worker', 'کارگر مانده', [{ item_id: other.id, qty: 4 }])).status, 201);
  const keeper = new Client();
  await keeper.login('anbardar');
  const w = (await keeper.req('GET', '/api/worker-balance')).json.workers.find((x) => x.name === 'کارگر مانده');
  assert.deepEqual([w.given, w.returned, w.holding], [24, 19, 5]);
  const part = w.parts.find((p) => p.name === raw.name);
  assert.deepEqual([part.given, part.returned, part.balance], [20, 15, 5]);
  assert.equal(w.parts.find((p) => p.name === other.name).balance, 0);
});

test('documents: admin delete reverses stock, hides the document, keeps a record', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const keeper = new Client();
  await keeper.login('anbardar');
  const it = (await admin.req('GET', '/api/items')).json.items.find((i) => i.code === '32100');
  const stock = async () => (await admin.req('GET', '/api/items/' + it.id)).json.item.stock;
  const post = (direction, reason, qty, extra = {}) => admin.req('POST', '/api/documents', { direction, reason, lines: [{ item_id: it.id, qty }], ...extra });
  const inDoc = (await post('in', 'other_in', 40)).json.document;
  const outDoc = (await post('out', 'to_worker', 30, { worker_name: 'کارگر سند' })).json.document;
  assert.equal(await stock(), 10);

  assert.equal((await keeper.req('POST', `/api/documents/${outDoc.id}/delete`, { reason: 'x' })).status, 403);
  // deleting the receipt first would leave -30
  const blocked = await admin.req('POST', `/api/documents/${inDoc.id}/delete`, { reason: 'اشتباه' });
  assert.equal(blocked.status, 409);
  assert.equal(await stock(), 10);

  const del = await admin.req('POST', `/api/documents/${outDoc.id}/delete`, { reason: 'ثبت اشتباه' });
  assert.equal(del.status, 200);
  assert.equal(del.json.document.status, 'deleted');
  assert.equal(del.json.document.delete_note, 'ثبت اشتباه');
  assert.equal(await stock(), 40);
  assert.equal((await admin.req('POST', `/api/documents/${outDoc.id}/delete`, { reason: 'x' })).status, 409);

  const all = (await admin.req('GET', '/api/documents?limit=500')).json.rows;
  assert.equal(all.some((d) => d.id === outDoc.id), false);
  const gone = (await admin.req('GET', '/api/documents?status=deleted')).json.rows;
  assert.equal(gone.some((d) => d.id === outDoc.id && d.status === 'deleted'), true);
  const hist = (await admin.req('GET', '/api/items/' + it.id)).json.history;
  assert.equal(hist.some((h) => h.document_id === outDoc.id || h.doc_no === outDoc.doc_no), false);
  assert.equal((await admin.req('GET', '/api/worker-balance')).json.workers.some((w) => w.name === 'کارگر سند'), false);
  assert.equal((await admin.req('GET', `/api/documents/${outDoc.id}/barcodes.txt`)).status, 409);

  // now the receipt can go too; a pending request is deleted without touching stock
  assert.equal((await admin.req('POST', `/api/documents/${inDoc.id}/delete`, { reason: 'اشتباه' })).status, 200);
  assert.equal(await stock(), 0);
});

test('stock count: storekeeper counts blind, admin applies the differences as adjustment documents', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const keeper = new Client();
  await keeper.login('anbardar');
  const items = (await admin.req('GET', '/api/items')).json.items;
  const [a, b, c] = ['32200', '32300', '32400'].map((code) => items.find((i) => i.code === code));
  await admin.req('POST', '/api/documents', { direction: 'in', reason: 'other_in', lines: [{ item_id: a.id, qty: 10 }, { item_id: b.id, qty: 10 }, { item_id: c.id, qty: 10 }] });
  const stock = async (it) => (await admin.req('GET', '/api/items/' + it.id)).json.item.stock;

  const start = await keeper.req('POST', '/api/counts', { title: 'پایان ماه' });
  assert.equal(start.status, 201);
  const id = start.json.id;
  assert.equal((await keeper.req('POST', '/api/counts', {})).status, 409); // only one at a time
  const line = (it, counted, who = keeper) => who.req('POST', `/api/counts/${id}/lines`, { item_id: it.id, counted });
  assert.equal((await line(a, 7)).status, 200);
  assert.equal((await line(b, 99)).status, 200);
  assert.equal((await line(b, 14)).status, 200); // recount replaces
  assert.equal((await line(c, 10)).status, 200);
  assert.equal((await line(c, -1)).status, 400);

  const blind = (await keeper.req('GET', `/api/counts/${id}`)).json;
  assert.equal(blind.shows_expected, false);
  assert.equal(blind.lines.length, 3);
  assert.equal(blind.lines.every((l) => l.expected === undefined && l.diff === undefined && l.stock === undefined), true);
  assert.equal(blind.uncounted.length, blind.total_items - 3);

  assert.equal((await keeper.req('POST', `/api/counts/${id}/apply`)).status, 403);
  assert.equal((await keeper.req('POST', `/api/counts/${id}/submit`)).status, 200);
  assert.equal((await line(a, 8)).status, 409); // closed for counting
  const review = (await admin.req('GET', `/api/counts/${id}`)).json;
  assert.deepEqual(review.lines.map((l) => [l.code, l.expected, l.counted, l.diff]).sort(), [['32200', 10, 7, -3], ['32300', 10, 14, 4], ['32400', 10, 10, 0]]);
  assert.deepEqual([await stock(a), await stock(b)], [10, 10]); // nothing moves before approval

  const done = await admin.req('POST', `/api/counts/${id}/apply`);
  assert.equal(done.status, 200);
  assert.deepEqual([done.json.result.changed, done.json.result.same, done.json.result.plus_qty, done.json.result.minus_qty], [2, 1, 4, 3]);
  assert.deepEqual([await stock(a), await stock(b), await stock(c)], [7, 14, 10]);
  const doc = (await admin.req('GET', '/api/documents/' + done.json.result.docs[0])).json.document;
  assert.equal(doc.reason, 'adjust_in');
  assert.equal(doc.status, 'approved');
  assert.equal((await admin.req('POST', `/api/counts/${id}/apply`)).status, 409);
  const after = (await keeper.req('GET', `/api/counts/${id}`)).json;
  assert.equal(after.count.status, 'applied');
  assert.equal(after.lines.find((l) => l.code === '32200').expected, 10); // what the system showed before, kept for the record

  // a cancelled count changes nothing and frees the slot
  const second = (await keeper.req('POST', '/api/counts', {})).json.id;
  await keeper.req('POST', `/api/counts/${second}/lines`, { item_id: a.id, counted: 0 });
  assert.equal((await keeper.req('POST', `/api/counts/${second}/cancel`)).status, 200);
  assert.equal(await stock(a), 7);
  assert.equal((await admin.req('POST', `/api/counts/${second}/apply`)).status, 409);
});

test('version + update requests: only admins, only when the host updater is alive', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DATA_DIR } = await import('../server/db.js');
  const dir = path.join(DATA_DIR, 'updater');
  fs.rmSync(dir, { recursive: true, force: true });
  const admin = new Client();
  await admin.login('mokhtar');
  const keeper = new Client();
  await keeper.login('anbardar');

  const meta = (await keeper.req('GET', '/api/meta')).json;
  assert.match(meta.app.version, /^\d+\.\d+\.\d+$/);
  assert.equal((await keeper.req('GET', '/api/update')).status, 403);
  assert.equal((await keeper.req('POST', '/api/update', { action: 'update' })).status, 403);

  let s = (await admin.req('GET', '/api/update')).json;
  assert.equal(s.updater.installed, false);
  assert.equal((await admin.req('POST', '/api/update', { action: 'check' })).status, 409); // no updater service

  const host = (extra = {}) => fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({
    heartbeat: new Date().toISOString(), branch: 'main', commit: 'aaaaaaa', previous: null, available: null, ...extra }));
  fs.mkdirSync(dir, { recursive: true });
  host();
  s = (await admin.req('GET', '/api/update')).json;
  assert.equal(s.updater.installed, true);
  assert.equal((await admin.req('POST', '/api/update', { action: 'rm -rf /' })).status, 400);
  assert.equal((await admin.req('POST', '/api/update', { action: 'update' })).status, 409);   // nothing newer
  assert.equal((await admin.req('POST', '/api/update', { action: 'rollback' })).status, 409); // nothing to go back to

  host({ available: { behind: 2, commit: 'bbbbbbb', version: '9.9.9', subject: 'x', date: '2026-01-01T00:00:00Z' }, previous: { commit: 'ccccccc', version: '1.0.0' } });
  const ok = await admin.req('POST', '/api/update', { action: 'update' });
  assert.equal(ok.status, 200);
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  assert.deepEqual([req.action, req.by], ['update', 'mokhtar']);
  assert.equal((await admin.req('POST', '/api/update', { action: 'rollback' })).status, 409); // one at a time
  fs.rmSync(path.join(dir, 'request.json'));

  // a stale heartbeat means the service died
  host({ heartbeat: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal((await admin.req('GET', '/api/update')).json.updater.installed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backups: daily schedule, verified copy, retention, admin-only download', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { BACKUP_DIR, backupDue, runBackup, listBackups } = await import('../server/services/backup.js');
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  const admin = new Client();
  await admin.login('mokhtar');
  const keeper = new Client();
  await keeper.login('anbardar');
  assert.equal((await keeper.req('GET', '/api/backups')).status, 403);
  assert.equal((await keeper.req('POST', '/api/backups')).status, 403);

  // due only after the configured hour, and only once a day
  const at = (h) => { const d = new Date(); d.setHours(h, 30, 0, 0); return d; };
  assert.equal((await admin.req('PUT', '/api/settings', { backup_hour: 5, backup_keep: 3 })).status, 200);
  assert.equal(backupDue(at(4)), false);
  assert.equal(backupDue(at(5)), true);
  assert.equal((await admin.req('PUT', '/api/settings', { backup_hour: 24 })).status, 400);

  const made = await admin.req('POST', '/api/backups');
  assert.equal(made.status, 201);
  assert.equal(made.json.last.ok, true);
  assert.ok(made.json.last.items >= 114 && made.json.last.size > 10000);
  assert.equal(backupDue(at(23)), false); // already done today
  assert.equal((await admin.req('PUT', '/api/settings', { backup_enabled: false })).status, 200);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  assert.equal(backupDue(at(23)), false); // switched off
  await admin.req('PUT', '/api/settings', { backup_enabled: true });

  // retention: only the newest `backup_keep` survive
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const day of ['20200101', '20200102', '20200103', '20200104']) fs.writeFileSync(path.join(BACKUP_DIR, `warehouse-${day}-0200.db`), 'old');
  runBackup(null, 'daily');
  const names = listBackups().map((f) => f.name);
  assert.equal(names.length, 3);
  assert.equal(names.includes('warehouse-20200101-0200.db'), false);
  assert.equal(names.includes('warehouse-20200102-0200.db'), false);

  const file = await admin.req('GET', '/api/backups/' + names[0]);
  assert.equal(file.status, 200);
  assert.equal((await keeper.req('GET', '/api/backups/' + names[0])).status, 403);
  assert.equal((await admin.req('GET', '/api/backups/' + encodeURIComponent('../warehouse.db'))).status, 400);
  const health = await admin.req('GET', '/health');
  assert.ok(health.json.last_backup_at);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

test('recode: item codes can be renamed to the Sepidar code, history stays attached', async () => {
  const { recodeItems } = await import('../server/services/items.js');
  const before = db.prepare("SELECT id, stock FROM items WHERE code = '31500'").get();
  assert.ok(before, 'fresh installs already use the Sepidar code for کاور موتور (پایین)');
  assert.equal(db.prepare("SELECT 1 FROM items WHERE code = '315'").get(), undefined);
  const mk = db.prepare("INSERT INTO items(code,sepidar_code,name,qr_token,created_at,updated_at) VALUES('RC-1','RC-1','تست','RCTOKEN1','2026-01-01','2026-01-01')");
  mk.run();
  const r = recodeItems(null, { 'RC-1': 'RC-2', 'NOPE': 'X', '30700': '30801' });
  assert.deepEqual(r.changed.map((c) => [c.from, c.to]), [['RC-1', 'RC-2']]);
  assert.equal(r.skipped.length, 2); // missing source, and a target that already exists
  const row = db.prepare("SELECT code, sepidar_code FROM items WHERE code = 'RC-2'").get();
  assert.equal(row.sepidar_code, 'RC-2');
});

test('users: «مدیر ارشد» sets any password; other admins cannot touch admins once he exists', async () => {
  const boss = new Client();
  await boss.login('mokhtar');
  const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  // no super admin yet: admins keep the old rights
  assert.equal((await boss.req('POST', `/api/users/${id('sattar')}/set-password`, { password: 'whatever-123' })).status, 403);
  db.prepare("UPDATE users SET super_admin = 1 WHERE username = 'mokhtar'").run();
  try {
    const me = (await boss.req('GET', '/api/auth/me')).json.user;
    assert.equal(me.super_admin, true);
    const sattar = new Client();
    await sattar.login('sattar');
    const keeperId = id('anbardar');

    // super admin sets another admin's password: old sessions die, new password works
    assert.equal((await boss.req('POST', `/api/users/${id('sattar')}/set-password`, { password: 'short' })).status, 400);
    const set = await boss.req('POST', `/api/users/${id('sattar')}/set-password`, { password: 'Sattar-new-pass-1' });
    assert.equal(set.status, 200);
    assert.equal(set.json.user.must_change_password, false);
    assert.equal((await sattar.req('GET', '/api/items')).status, 401);
    const back = new Client();
    assert.equal((await back.req('POST', '/api/auth/login', { username: 'sattar', password: 'Sattar-new-pass-1' })).status, 200);

    // ... and a storekeeper's, forcing a change at next login
    const k = await boss.req('POST', `/api/users/${keeperId}/set-password`, { password: 'Keeper-temp-123', must_change: true });
    assert.equal(k.json.user.must_change_password, true);

    // a normal admin may still manage storekeepers, but not other admins or the super admin
    assert.equal((await back.req('POST', `/api/users/${keeperId}/reset-password`)).status, 200);
    assert.equal((await back.req('POST', `/api/users/${id('mokhtar')}/reset-password`)).status, 403);
    assert.equal((await back.req('PUT', `/api/users/${id('mokhtar')}`, { active: false })).status, 403);
    assert.equal((await back.req('POST', `/api/users/${keeperId}/set-password`, { password: 'nope-nope-1' })).status, 403);
    const extra = await boss.req('POST', '/api/users', { username: 'admin3', display_name: 'مدیر ۳', role: 'admin' });
    assert.equal((await back.req('POST', `/api/users/${extra.json.user.id}/reset-password`)).status, 403);
    assert.equal((await boss.req('PUT', `/api/users/${id('mokhtar')}`, { role: 'storekeeper' })).status, 409);

    // the super admin can set his own password and stays logged in
    assert.equal((await boss.req('POST', `/api/users/${id('mokhtar')}/set-password`, { password: PW })).status, 200);
    assert.equal((await boss.req('GET', '/api/items')).status, 200);
  } finally {
    db.prepare('UPDATE users SET super_admin = 0').run();
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username IN ('sattar','anbardar')").run(hashPassword(PW));
  }
});

test('users: last admin protected, temp password forces change', async () => {
  const admin = new Client();
  await admin.login('mokhtar');
  const self = (await admin.req('GET', '/api/auth/me')).json.user;
  assert.equal((await admin.req('PUT', `/api/users/${self.id}`, { active: false })).status, 409);
  const mk = await admin.req('POST', '/api/users', { username: 'newkeeper', display_name: 'انباردار ۲', role: 'storekeeper' });
  assert.equal(mk.status, 201);
  const nk = new Client();
  const lg = await nk.req('POST', '/api/auth/login', { username: 'newkeeper', password: mk.json.temp_password });
  assert.equal(lg.status, 200);
  assert.equal(lg.json.user.must_change_password, true);
  assert.equal((await nk.req('GET', '/api/items')).status, 403);
  assert.equal((await nk.req('POST', '/api/auth/password', { current: mk.json.temp_password, next: 'short' })).status, 400);
  assert.equal((await nk.req('POST', '/api/auth/password', { current: mk.json.temp_password, next: 'a-long-new-pass' })).status, 200);
  assert.equal((await nk.req('GET', '/api/items')).status, 200);
});
