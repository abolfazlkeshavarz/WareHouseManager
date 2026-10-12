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
