// Loads demo data into a DEPLOYED (or local) instance through its public API, the same way a browser would:
// opening stock for some parts, a few ins/outs, and (if a storekeeper account is given) pending requests so the
// approval screen has something to show.
//
// Refuses to run when the warehouse already has documents, unless FORCE=1 — so it cannot pollute real data.
//
//   API_URL=https://warehouse.example.com ADMIN_USER=mokhtar ADMIN_PASSWORD=... \
//   [KEEPER_USER=anbardar KEEPER_PASSWORD=...] ./scripts/demo-data.sh
const API = (process.env.API_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const { ADMIN_USER, ADMIN_PASSWORD, KEEPER_USER, KEEPER_PASSWORD, FORCE } = process.env;

class Abort extends Error {}
const abort = (msg) => { throw new Abort(msg); };


class Session {
  constructor() { this.cookie = ''; }
  async call(method, url, body) {
    const res = await fetch(API + url, {
      method,
      headers: { 'x-wh': '1', 'content-type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${data.error || ''}`);
    return data;
  }
  login(username, password) { return this.call('POST', '/api/auth/login', { username, password }); }
}

async function main() {
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    abort('ADMIN_USER and ADMIN_PASSWORD are required (an admin account that has already changed its temporary password).');
  }
  const admin = new Session();
  const { user } = await admin.login(ADMIN_USER, ADMIN_PASSWORD);
  if (user.must_change_password) abort('This account still has a temporary password; log in once in the browser and change it first.');
  if (user.role !== 'admin') abort('ADMIN_USER must be an admin account.');

  const existing = await admin.call('GET', '/api/documents?limit=1');
  if (existing.total > 0 && FORCE !== '1') {
    abort(`This warehouse already has ${existing.total} document(s). Refusing to add demo data (set FORCE=1 to override).`);
  }

  const { items } = await admin.call('GET', '/api/items');
  const byCode = new Map(items.map((i) => [i.code, i]));
  const pick = (code) => {
    const it = byCode.get(code);
    if (!it) throw new Error(`Demo item ${code} not found — was the original parts list changed?`);
    return it;
  };

  const stock = [
    ['30700', 240], ['307001', 60], ['30801', 180], ['30900', 520], ['31100', 14], ['31400', 310],
    ['32000', 900], ['32800', 120], ['33000', 8], ['33700', 75], ['34600', 400], ['366', 75],
  ];

  console.log('==> Opening stock');
  await admin.call('POST', '/api/documents', {
    direction: 'in', reason: 'opening', note: 'موجودی اولیه (داده‌ی آزمایشی)',
    lines: stock.map(([c, q]) => ({ item_id: pick(c).id, qty: q })),
  });

  console.log('==> Minimum-stock thresholds (so the low-stock alerts have something to show)');
  for (const [code, min] of [['31100', 20], ['33000', 10], ['30700', 100]]) {
    await admin.call('PUT', `/api/items/${pick(code).id}`, { min_stock: min });
  }

  console.log('==> A purchase, a worker hand-out and a return');
  await admin.call('POST', '/api/documents', {
    direction: 'in', reason: 'recharge', note: 'خرید آزمایشی', lines: [{ item_id: pick('31100').id, qty: 30 }],
  });
  await admin.call('POST', '/api/documents', {
    direction: 'out', reason: 'to_worker', worker_name: 'حسین کریمی', note: 'شیفت صبح',
    lines: [{ item_id: pick('30700').id, qty: 60, note: 'خط ۱' }, { item_id: pick('32000').id, qty: 120 }],
  });
  await admin.call('POST', '/api/documents', {
    direction: 'in', reason: 'return_from_worker', worker_name: 'حسین کریمی',
    lines: [{ item_id: pick('30700').id, qty: 5 }],
  });
  await admin.call('POST', '/api/documents', {
    direction: 'out', reason: 'scrap', note: 'ضایعات آزمایشی', lines: [{ item_id: pick('33000').id, qty: 2 }],
  });

  if (KEEPER_USER && KEEPER_PASSWORD) {
    console.log('==> Pending requests from the storekeeper (waiting for approval)');
    const keeper = new Session();
    const k = await keeper.login(KEEPER_USER, KEEPER_PASSWORD);
    if (k.user.must_change_password) {
      console.warn('    storekeeper still has a temporary password — skipping pending requests');
    } else {
      await keeper.call('POST', '/api/documents', {
        direction: 'out', reason: 'to_worker', worker_name: 'رضا احمدی', note: 'شیفت عصر',
        lines: [{ item_id: pick('31400').id, qty: 40 }, { item_id: pick('32800').id, qty: 15 }],
      });
      await keeper.call('POST', '/api/documents', {
        direction: 'out', reason: 'to_worker', worker_name: 'مریم صادقی',
        lines: [{ item_id: pick('34600').id, qty: 50 }],
      });
    }
  }

  console.log('');
  console.log('Demo data loaded. In the app: Home (stats, low stock), Items, Documents (pending approvals),');
  console.log('Reports (filters + export), an item\'s page (history with before/after counts).');

}

main().catch((e) => {
  console.error(e instanceof Abort ? e.message : e);
  process.exitCode = 1;
});
