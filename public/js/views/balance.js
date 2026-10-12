import { api } from '../api.js';
import { h, icon, fa, fmtDate, thumb, emptyState, normSearch } from '../ui.js';

function statRow(given, returned, holding) {
  return h('div', { class: 'stat-grid three' },
    h('div', { class: 'card stat out' }, h('b', null, fa(given)), h('span', null, 'تحویل گرفته')),
    h('div', { class: 'card stat in' }, h('b', null, fa(returned)), h('span', null, 'برگردانده')),
    h('div', { class: 'card stat' }, h('b', null, fa(holding)), h('span', null, 'مانده نزد کارگر')));
}

function partCard(p) {
  const showVariants = p.variants.length > 1 || p.variants[0].variant;
  return h('div', { class: 'card item-card', style: { alignItems: 'flex-start' } },
    thumb(p.image),
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, p.name),
      h('div', { class: 'muted small num' }, `گرفته ${fa(p.given)} · برگردانده ${fa(p.returned)}`),
      showVariants
        ? h('div', { class: 'muted small', style: { marginTop: '4px' } },
          ...p.variants.map((v) => h('div', { class: 'num' },
            `${v.variant || 'ساده'} (${v.code}): گرفته ${fa(v.given)}، برگردانده ${fa(v.returned)}`)))
        : null),
    h('div', { class: `stock ${p.balance > 0 ? 'low' : ''}` },
      h('b', null, fa(Math.abs(p.balance))),
      h('span', null, p.balance < 0 ? 'اضافه برگشته' : p.unit)));
}

function workerDetail(w, name) {
  const body = h('div', { class: 'stack' });
  if (!w) {
    body.append(emptyState('برای این کارگر تحویل یا بازگشتی ثبت نشده است.', 'user'));
    return { title: name, back: '/worker-balance', body };
  }
  const q = encodeURIComponent(w.name);
  body.append(statRow(w.given, w.returned, w.holding),
    h('div', { class: 'row', style: { gap: '10px' } },
      h('a', { class: 'btn in grow', href: `#/scan?mode=in&worker=${q}` }, icon('inbox'), 'ثبت بازگشت'),
      h('a', { class: 'btn out grow', href: `#/scan?mode=out&worker=${q}` }, icon('outbox'), 'تحویل جدید')));

  const holding = w.parts.filter((p) => p.balance > 0);
  const rest = w.parts.filter((p) => p.balance <= 0);
  body.append(h('div', { class: 'section-title' }, `نزد کارگر مانده (${fa(holding.length)} قطعه)`));
  body.append(holding.length ? h('div', { class: 'list' }, ...holding.map(partCard)) : emptyState('چیزی نزد این کارگر نمانده است.', 'user'));
  if (rest.length) {
    body.append(h('div', { class: 'section-title' }, 'تسویه‌شده'));
    body.append(h('div', { class: 'list' }, ...rest.map(partCard)));
  }
  body.append(h('div', { class: 'hint' },
    'مانده = جمع «تحویل به کارگر» منهای جمع «بازگشت از کارگر» در اسناد تاییدشده. حالت‌های مختلف یک قطعه (مثل خام و مونتاژشده) با هم حساب می‌شوند.'));
  return { title: w.name, back: '/worker-balance', body };
}

// What each worker still holds: delivered (تحویل به کارگر) minus returned (بازگشت از کارگر), per part.
export async function balanceView({ query }) {
  const { workers } = await api.get('/api/worker-balance');
  if (query.name) return workerDetail(workers.find((x) => x.name === query.name), query.name);

  const search = h('input', { class: 'input', placeholder: 'جستجوی نام کارگر', autocomplete: 'off' });
  const box = h('div', { class: 'list' });
  const render = () => {
    const q = normSearch(search.value);
    const rows = workers.filter((w) => !q || normSearch(w.name).includes(q));
    box.replaceChildren(...(rows.length
      ? rows.map((w) => h('a', { class: 'card item-card', href: `#/worker-balance?name=${encodeURIComponent(w.name)}`, style: { color: 'inherit' } },
        h('div', { class: 'thumb' }, icon('user')),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, w.name),
          h('div', { class: 'muted small num' }, `گرفته ${fa(w.given)} · برگردانده ${fa(w.returned)} · آخرین: ${fmtDate(w.last_at)}`)),
        h('div', { class: `stock ${w.holding > 0 ? 'low' : ''}` }, h('b', null, fa(w.holding)), h('span', null, 'مانده')),
        icon('chevron', 18)))
      : [emptyState(workers.length ? 'کارگری با این نام پیدا نشد.' : 'هنوز تحویلی به کارگران ثبت نشده است.', 'user')]));
  };
  search.addEventListener('input', render);
  render();
  const total = workers.reduce((s, w) => s + w.holding, 0);
  const body = h('div', { class: 'stack' },
    h('div', { class: 'card stat' }, h('b', null, fa(total)), h('span', null, `جمع مانده نزد ${fa(workers.filter((w) => w.holding > 0).length)} کارگر`)),
    workers.length > 5 ? search : null, box);
  return { title: 'مانده نزد کارگران', back: '/more', body };
}
