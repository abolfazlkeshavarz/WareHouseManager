import { api } from '../api.js';
import { store, isAdmin, reasonLabel, statusLabel } from '../store.js';
import { h, icon, fa, faId, fmtDateTime, itemTitle, emptyState, thumb } from '../ui.js';

export function docCard(d) {
  const dirChip = h('span', { class: `chip ${d.direction}` }, icon(d.direction === 'in' ? 'inbox' : 'outbox'), d.direction === 'in' ? 'ورود' : 'خروج');
  const statusClass = { pending: 'warn', approved: 'in', rejected: 'danger', cancelled: '' }[d.status];
  return h('a', { class: 'card item-card', href: `#/docs/${d.id}`, style: { color: 'inherit' } },
    h('div', { class: 'grow' },
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        h('b', { class: 'num' }, `سند ${faId(d.doc_no)}`), dirChip,
        h('span', { class: `chip ${statusClass}` }, statusLabel(d.status))),
      h('div', { class: 'small', style: { marginTop: '4px' } },
        reasonLabel(d.reason), d.worker_name ? ` • ${d.worker_name}` : ''),
      h('div', { class: 'muted small' }, d.preview ? d.preview + (d.line_count > 3 ? ' …' : '') : ''),
      h('div', { class: 'muted small' }, `${d.created_by_name} • ${fmtDateTime(d.created_at)}`)),
    h('div', { class: 'stock' }, h('b', null, fa(d.total_qty)), h('span', null, `${fa(d.line_count)} ردیف`)),
  );
}

export async function homeView() {
  const s = await api.get('/api/summary');
  store.pending = s.pending;
  const admin = isAdmin();
  const body = h('div', { class: 'stack' });

  body.append(h('div', null,
    h('div', { class: 'muted small' }, store.meta?.company_name ?? ''),
    h('h2', { style: { fontSize: '20px' } }, `سلام ${store.user.display_name} 👋`)));

  if (admin && s.pending > 0) {
    body.append(h('a', { class: 'banner attn', href: '#/docs?status=pending', style: { color: 'var(--warn)' } },
      icon('clock'), h('span', { class: 'grow' }, `${fa(s.pending)} درخواست منتظر تایید شماست`), icon('chevron')));
  }
  if (!admin && s.my_pending > 0) {
    body.append(h('a', { class: 'banner info', href: '#/docs?mine=1&status=pending' },
      icon('clock'), h('span', { class: 'grow' }, `${fa(s.my_pending)} درخواست شما در انتظار تایید مدیر است`), icon('chevron')));
  }

  body.append(h('div', { class: 'row', style: { gap: '10px' } },
    h('a', { class: 'btn out grow', href: '#/scan?mode=out' }, icon('outbox'), 'ثبت خروج'),
    h('a', { class: 'btn in grow', href: '#/scan?mode=in' }, icon('inbox'), 'ثبت ورود')));
  body.append(h('a', { class: 'btn secondary block', href: '#/worker-balance' }, icon('users'), 'مانده نزد کارگران'));

  body.append(h('div', { class: 'stat-grid' },
    h('div', { class: 'card stat' }, h('b', null, fa(s.totals.items)), h('span', null, 'تعداد اقلام فعال')),
    h('div', { class: 'card stat' }, h('b', null, fa(s.totals.units)), h('span', null, 'جمع موجودی (عدد)')),
    h('div', { class: 'card stat in' }, h('b', null, fa(s.today.qty_in)), h('span', null, 'ورودی امروز')),
    h('div', { class: 'card stat out' }, h('b', null, fa(s.today.qty_out)), h('span', null, 'خروجی امروز'))));

  if (s.low_stock.length) {
    body.append(h('div', { class: 'section-title' }, `کم‌موجود (${fa(s.low_stock.length)})`));
    const list = h('div', { class: 'list' });
    for (const i of s.low_stock.slice(0, 6)) {
      list.append(h('a', { class: 'card item-card', href: `#/items/${i.id}`, style: { color: 'inherit' } },
        thumb(i.image), h('div', { class: 'grow' }, h('div', { class: 'name' }, itemTitle(i)),
          h('div', { class: 'muted small' }, `حداقل: ${fa(i.min_stock)}`)),
        h('div', { class: 'stock low' }, h('b', null, fa(i.stock)), h('span', null, i.unit))));
    }
    if (s.low_stock.length > 6) list.append(h('a', { class: 'btn secondary', href: '#/items?filter=low' }, `مشاهده همه ${fa(s.low_stock.length)} مورد`));
    body.append(list);
  }

  body.append(h('div', { class: 'section-title' }, 'آخرین اسناد'));
  if (!s.recent.length) body.append(emptyState('هنوز سندی ثبت نشده است.', 'file'));
  else body.append(h('div', { class: 'list' }, ...s.recent.map(docCard)));

  return { title: 'خانه', body };
}
