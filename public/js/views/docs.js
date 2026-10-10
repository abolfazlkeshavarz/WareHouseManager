import { api, qs } from '../api.js';
import { store, isAdmin, refreshItems, refreshPending, reasonLabel, statusLabel } from '../store.js';
import { h, icon, fa, faId, fmtDateTime, itemTitle, emptyState, thumb, codeTag, toast, confirmDialog, promptDialog, normSearch } from '../ui.js';
import { navigate } from '../app.js';
import { docCard } from './home.js';

export async function docsView({ query }) {
  const admin = isAdmin();
  let status = query.status || (admin ? 'pending' : '');
  let mine = query.mine === '1' || (!admin && query.mine !== '0');
  let term = '';
  let offset = 0;
  const PAGE = 30;

  const tabsBox = h('div', { class: 'tabs' });
  const listBox = h('div', { class: 'list' });
  const moreBox = h('div');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'جستجو: شماره سند، کارگر، قطعه…', autocomplete: 'off' });
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { term = search.value; load(true); }, 250); });

  async function load(reset) {
    if (reset) { offset = 0; listBox.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }))); }
    try {
      const r = await api.get('/api/documents' + qs({ status, mine: mine ? '1' : '', q: normSearch(term), limit: PAGE, offset }));
      if (reset) listBox.replaceChildren();
      if (!r.rows.length && reset) listBox.append(emptyState(status === 'pending' ? 'درخواست در انتظار تاییدی وجود ندارد 🎉' : 'سندی پیدا نشد.', 'file'));
      for (const d of r.rows) listBox.append(docCard(d));
      offset += r.rows.length;
      moreBox.replaceChildren(offset < r.total ? h('button', { class: 'btn secondary block', onClick: () => load(false) }, `نمایش بیشتر (${fa(r.total - offset)})`) : '');
    } catch (e) { toast(e.message, 'err'); }
  }

  function drawTabs() {
    const defs = [['pending', 'در انتظار تایید'], ['approved', 'تایید شده'], ['rejected', 'رد شده'], ['', 'همه']];
    tabsBox.replaceChildren(...[
      ...defs.map(([k, label]) => h('button', { class: status === k ? 'active' : '', onClick: () => { status = k; drawTabs(); load(true); } },
        label, k === 'pending' && store.pending ? h('span', { class: 'count' }, fa(store.pending)) : null)),
      admin ? h('button', { class: mine ? 'active' : '', onClick: () => { mine = !mine; drawTabs(); load(true); } }, 'فقط ثبت‌های من') : null,
    ].filter(Boolean));
  }

  drawTabs();
  load(true);
  return {
    title: admin ? 'درخواست‌ها و اسناد' : 'اسناد من',
    body: h('div', { class: 'stack' }, tabsBox, h('div', { class: 'searchbox' }, icon('search'), search), listBox, moreBox),
  };
}

export async function docDetailView({ params }) {
  const { document: d } = await api.get(`/api/documents/${params.id}`);
  const admin = isAdmin();
  const body = h('div', { class: 'stack' });
  const statusClass = { pending: 'warn', approved: 'in', rejected: 'danger', cancelled: '' }[d.status];

  async function act(fn, okMsg) {
    try {
      await fn();
      await Promise.all([refreshItems(), refreshPending()]);
      toast(okMsg, 'ok');
      navigate(`/docs/${d.id}`, { replace: true });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  body.append(h('div', { class: 'card' },
    h('div', { class: 'row wrap' },
      h('h2', { style: { fontSize: '18px' } }, `سند شماره ${faId(d.doc_no)}`),
      h('span', { class: `chip ${d.direction}` }, icon(d.direction === 'in' ? 'inbox' : 'outbox'), d.direction === 'in' ? 'ورود' : 'خروج'),
      h('span', { class: `chip ${statusClass}` }, statusLabel(d.status))),
    h('dl', { class: 'kv', style: { marginTop: '12px' } },
      h('dt', null, 'علت'), h('dd', null, reasonLabel(d.reason)),
      d.worker_name ? [h('dt', null, 'کارگر / طرف مقابل'), h('dd', null, d.worker_name)] : null,
      d.dest_warehouse ? [h('dt', null, 'انبار مقصد'), h('dd', null, (() => { const w = store.meta.warehouses.find((x) => x.code === d.dest_warehouse); return w ? `${w.title} (${w.code})` : d.dest_warehouse; })())] : null,
      h('dt', null, 'ثبت‌کننده'), h('dd', null, d.created_by_name),
      h('dt', null, 'زمان ثبت'), h('dd', { class: 'num' }, fmtDateTime(d.created_at)),
      d.note ? [h('dt', null, 'توضیحات'), h('dd', null, d.note)] : null)));

  // lines
  const lines = d.lines.map((l) => {
    const stockNote = d.status === 'approved'
      ? `موجودی: ${fa(l.stock_before)} ← ${fa(l.stock_after)}`
      : `موجودی فعلی: ${fa(l.current_stock)}`;
    const short = d.status === 'pending' && d.direction === 'out' && l.qty > l.current_stock;
    return h('div', { class: `card item-card ${short ? 'cart-line bad' : ''}`, style: short ? { borderColor: 'var(--danger)' } : null },
      thumb(l.image),
      h('a', { class: 'grow', href: `#/items/${l.item_id}`, style: { color: 'inherit' } },
        h('div', { class: 'name', style: { fontWeight: 700 } }, itemTitle(l)),
        h('div', { class: 'codeline' }, codeTag(l.code)),
        h('div', { class: 'muted small num' }, stockNote),
        l.note ? h('div', { class: 'small' }, `📝 ${l.note}`) : null,
        short ? h('div', { class: 'err-text' }, 'موجودی فعلی برای این درخواست کافی نیست.') : null),
      h('div', { class: 'stock' }, h('b', { class: d.direction === 'in' ? 'qty-in' : 'qty-out', style: { color: d.direction === 'in' ? 'var(--in)' : 'var(--out)' } },
        h('span', { class: 'ltr' }, `${d.direction === 'in' ? '+' : '−'}${fa(l.qty)}`)), h('span', null, l.unit)));
  });
  body.append(h('div', { class: 'section-title' }, `اقلام (${fa(d.lines.length)})`), h('div', { class: 'list' }, ...lines));

  // timeline
  const tl = h('div', { class: 'timeline' },
    h('div', { class: 'ev' }, h('b', null, 'ثبت درخواست'), h('div', { class: 'muted small' }, `${d.created_by_name} • ${fmtDateTime(d.created_at)}`)));
  if (d.status !== 'pending') {
    const who = d.decided_by_name || '—';
    const text = { approved: 'تایید و اعمال شد', rejected: 'رد شد', cancelled: 'لغو شد' }[d.status];
    tl.append(h('div', { class: `ev ${d.status === 'approved' ? 'ok' : 'bad'}` },
      h('b', null, text), h('div', { class: 'muted small' }, `${who} • ${fmtDateTime(d.decided_at)}`),
      d.decision_note ? h('div', { class: 'small' }, d.decision_note) : null));
  } else {
    tl.append(h('div', { class: 'ev' }, h('b', { style: { color: 'var(--warn)' } }, 'در انتظار تایید مدیر سیستم')));
  }
  body.append(h('div', { class: 'card' }, h('h2', null, 'وضعیت'), tl));

  // actions
  if (d.status === 'pending') {
    const bar = h('div', { class: 'row wrap' });
    if (admin) {
      bar.append(
        h('button', { class: 'btn in grow', onClick: async () => {
          if (await confirmDialog({ title: 'تایید درخواست', message: `با تایید، موجودی ${fa(d.lines.length)} قلم ${d.direction === 'out' ? 'کم' : 'زیاد'} می‌شود.`, confirmText: 'تایید و اعمال' })) {
            act(() => api.post(`/api/documents/${d.id}/approve`), 'درخواست تایید شد.');
          }
        } }, icon('check'), 'تایید'),
        h('button', { class: 'btn danger grow', onClick: async () => {
          const reason = await promptDialog({ title: 'رد درخواست', label: 'دلیل رد (برای انباردار نمایش داده می‌شود)', confirmText: 'رد درخواست' });
          if (reason) act(() => api.post(`/api/documents/${d.id}/reject`, { reason }), 'درخواست رد شد.');
        } }, icon('x'), 'رد'));
    }
    if (admin || d.created_by === store.user.id) {
      bar.append(h('button', { class: 'btn secondary', onClick: async () => {
        if (await confirmDialog({ title: 'لغو درخواست', message: 'این درخواست لغو شود؟', confirmText: 'لغو کن', danger: true })) {
          act(() => api.post(`/api/documents/${d.id}/cancel`), 'درخواست لغو شد.');
        }
      } }, 'لغو درخواست'));
    }
    body.append(bar);
  }

  return { title: `سند ${faId(d.doc_no)}`, back: '/docs', body };
}
