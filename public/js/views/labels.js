import { api } from '../api.js';
import { store, refreshItems } from '../store.js';
import { h, icon, fa, toast, normSearch, itemTitle, field, emptyState } from '../ui.js';

const SIZES = {
  small: { label: 'کوچک (۵۰×۲۵ میلی‌متر)', w: '50mm', h: '25mm' },
  medium: { label: 'متوسط (۷۰×۳۵ میلی‌متر)', w: '70mm', h: '35mm' },
  large: { label: 'بزرگ (۱۰۰×۵۰ میلی‌متر)', w: '100mm', h: '50mm' },
};

export async function labelsView({ query }) {
  const preset = new Set(String(query.ids || '').split(',').filter(Boolean).map(Number));
  const selected = new Set(preset);
  let size = 'medium';
  let term = '';

  const grid = h('div', { class: 'labels' });
  const listBox = h('div', { class: 'list', style: { maxHeight: '340px', overflowY: 'auto', paddingInlineEnd: '2px' } });
  const countEl = h('b', { class: 'num' });

  function visibleItems() {
    const q = normSearch(term);
    return store.items.filter((i) => !q || normSearch(`${i.name} ${i.variant} ${i.code}`).includes(q));
  }

  function drawLabels() {
    const s = SIZES[size];
    grid.style.setProperty('--label-w', s.w);
    grid.style.setProperty('--label-h', s.h);
    const items = store.items.filter((i) => selected.has(i.id));
    countEl.textContent = fa(items.length);
    grid.replaceChildren(...items.map((i) => h('div', { class: 'label' },
      h('img', { src: `/api/qr/${i.qr_token}.svg`, alt: '' }),
      h('div', { class: 'l-text' }, h('div', { class: 'l-code' }, i.code), h('div', { class: 'l-name' }, i.name), i.variant ? h('div', { class: 'l-var' }, i.variant) : null))));
    if (!items.length) grid.replaceChildren(emptyState('قطعه‌ای برای چاپ انتخاب نشده است.', 'qr'));
  }

  function drawList() {
    const rows = visibleItems();
    listBox.replaceChildren(...rows.slice(0, 150).map((i) => h('label', { class: 'card row', style: { padding: '8px 12px', cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: selected.has(i.id), style: { width: '20px', height: '20px' }, onChange: (e) => {
        if (e.target.checked) selected.add(i.id); else selected.delete(i.id);
        drawLabels();
      } }),
      h('div', { class: 'grow' }, h('span', { class: 'name' }, itemTitle(i)), ' ', h('span', { class: 'code-tag' }, i.code)))));
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'جستجوی قطعه…', onInput: (e) => { term = e.target.value; drawList(); } });
  const sizeSel = h('select', { class: 'input', onChange: (e) => { size = e.target.value; drawLabels(); } },
    ...Object.entries(SIZES).map(([k, v]) => h('option', { value: k, selected: k === size }, v.label)));

  drawList();
  drawLabels();

  const body = h('div', { class: 'stack' },
    h('div', { class: 'card stack no-print' },
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn soft sm', onClick: () => { visibleItems().forEach((i) => selected.add(i.id)); drawList(); drawLabels(); } }, 'انتخاب همه نتایج'),
        h('button', { class: 'btn secondary sm', onClick: () => { selected.clear(); drawList(); drawLabels(); } }, 'پاک کردن انتخاب')),
      field('اندازه برچسب', sizeSel),
      h('div', { class: 'searchbox' }, icon('search'), search),
      listBox),
    h('div', { class: 'row no-print' },
      h('div', { class: 'grow' }, 'برچسب‌های انتخاب‌شده: ', countEl),
      h('button', { class: 'btn', onClick: () => window.print() }, icon('printer'), 'چاپ')),
    grid);
  return { title: 'چاپ برچسب QR', back: '/more', body };
}

// ---------------- Excel import ----------------
export async function importView() {
  const result = h('div');
  const file = h('input', { type: 'file', accept: '.xlsx', class: 'input' });
  const btn = h('button', { class: 'btn block', onClick: async () => {
    const f = file.files[0];
    if (!f) { toast('ابتدا فایل اکسل را انتخاب کنید.', 'err'); return; }
    btn.disabled = true;
    try {
      const r = await api.post('/api/items-import', f, { contentType: 'application/octet-stream' });
      await refreshItems();
      result.replaceChildren(h('div', { class: 'card stack' },
        h('div', { class: 'banner info' }, icon('check'), `${fa(r.created)} قطعه جدید ثبت شد.${r.opening_docs ? ' موجودی اولیه هم ثبت شد.' : ''}`),
        r.skipped.length ? h('div', null, h('b', null, `${fa(r.skipped.length)} ردیف نادیده گرفته شد (کد تکراری):`),
          h('ul', null, ...r.skipped.slice(0, 30).map((s) => h('li', { class: 'small' }, `ردیف ${fa(s.row)}: ${s.code}`)))) : null,
        r.errors.length ? h('div', null, h('b', null, `${fa(r.errors.length)} ردیف خطا داشت:`),
          h('ul', null, ...r.errors.slice(0, 30).map((s) => h('li', { class: 'small' }, `ردیف ${fa(s.row)}: ${s.reason}`)))) : null));
      toast('ورود اطلاعات انجام شد.', 'ok');
    } catch (e) {
      result.replaceChildren(h('div', { class: 'banner danger' }, icon('alert'), e.message));
    } finally { btn.disabled = false; }
  } }, icon('upload'), 'ورود اطلاعات');

  const body = h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('h2', null, 'ورود گروهی قطعات از اکسل'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'فایل xlsx با ردیف اول به‌عنوان عنوان ستون‌ها. ستون‌های «کد» و «نام قطعه» الزامی‌اند. قطعاتی که کدشان از قبل وجود دارد نادیده گرفته می‌شوند.'),
      h('a', { class: 'btn secondary', href: '/api/items/template', download: '' }, icon('download'), 'دانلود قالب نمونه'),
      file, btn),
    result);
  return { title: 'ورود قطعات از اکسل', back: '/more', body };
}
