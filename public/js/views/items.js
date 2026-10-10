import { api } from '../api.js';
import { store, isAdmin, refreshItems, patchItem, reasonLabel, statusLabel } from '../store.js';
import {
  h, icon, fa, fmtDateTime, itemTitle, normSearch, emptyState, thumb, codeTag, field, toast, openSheet, confirmDialog, latinDigits, promptDialog,
} from '../ui.js';
import { navigate } from '../app.js';

const isLow = (i) => i.active && i.min_stock > 0 && i.stock <= i.min_stock;

// ---------------- list ----------------
export async function itemsView({ query }) {
  let filter = ['low', 'zero', 'inactive', 'stock'].includes(query.filter) ? query.filter : 'all';
  let term = '';
  let inactive = [];
  if (isAdmin()) {
    const r = await api.get('/api/items?inactive=1');
    inactive = r.items.filter((i) => !i.active);
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'جستجوی نام یا کد قطعه…', autocomplete: 'off',
    onInput: (e) => { term = e.target.value; draw(); } });
  const tabsBox = h('div', { class: 'tabs' });
  const listBox = h('div', { class: 'list' });
  const countBox = h('div', { class: 'muted small' });

  function pool() {
    if (filter === 'inactive') return inactive;
    let all = store.items;
    if (filter === 'low') all = all.filter(isLow);
    if (filter === 'zero') all = all.filter((i) => i.stock === 0);
    if (filter === 'stock') all = all.filter((i) => i.stock > 0);
    return all;
  }

  function draw() {
    const tabs = [['all', 'همه'], ['stock', 'موجود'], ['low', 'کم‌موجود'], ['zero', 'ناموجود']];
    if (isAdmin()) tabs.push(['inactive', 'غیرفعال']);
    tabsBox.replaceChildren(...tabs.map(([k, label]) => h('button', { class: filter === k ? 'active' : '', onClick: () => { filter = k; draw(); } }, label)));
    const q = normSearch(term);
    const rows = pool().filter((i) => !q || normSearch(`${i.name} ${i.variant} ${i.code} ${i.sepidar_code ?? ''} ${i.part_no ?? ''} ${i.material}`).includes(q));
    countBox.textContent = `${fa(rows.length)} قلم`;
    listBox.replaceChildren(...(rows.length ? rows.slice(0, 200).map(itemRow) : [emptyState('قطعه‌ای پیدا نشد.', 'box')]));
    if (rows.length > 200) listBox.append(h('div', { class: 'muted center small' }, 'برای دیدن موارد بیشتر جستجو را دقیق‌تر کنید.'));
  }

  function itemRow(i) {
    const cls = i.stock === 0 ? 'zero' : isLow(i) ? 'low' : '';
    return h('a', { class: 'card item-card', href: `#/items/${i.id}`, style: { color: 'inherit' } },
      thumb(i.image),
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, i.name),
        i.variant ? h('div', { class: 'small' }, i.variant) : null,
        h('div', { class: 'codeline' }, codeTag(i.code), i.material ? h('span', null, i.material) : null,
          !i.active ? h('span', { class: 'chip' }, 'غیرفعال') : null)),
      h('div', { class: `stock ${cls}` }, h('b', null, fa(i.stock)), h('span', null, i.unit)));
  }

  draw();
  const actions = isAdmin()
    ? [h('a', { class: 'btn sm', href: '#/items/new' }, icon('plus'), 'قطعه جدید')]
    : [];
  return {
    title: 'قطعات',
    actions,
    body: h('div', { class: 'stack' },
      h('div', { class: 'searchbox' }, icon('search'), search), tabsBox, countBox, listBox),
  };
}

// ---------------- detail ----------------
export async function itemDetailView({ params }) {
  const id = Number(params.id);
  const { item, history, history_total: total } = await api.get(`/api/items/${id}`);
  patchItem(item);
  const admin = isAdmin();
  const body = h('div', { class: 'stack' });

  const low = isLow(item);
  body.append(h('div', { class: 'card' },
    h('div', { class: 'row', style: { alignItems: 'flex-start' } },
      thumb(item.image, 'lg'),
      h('div', { class: 'grow' },
        h('h2', { style: { fontSize: '18px' } }, item.name),
        item.variant ? h('div', null, item.variant) : null,
        h('div', { class: 'codeline', style: { marginTop: '6px' } }, codeTag(item.code),
          !item.active ? h('span', { class: 'chip danger' }, 'غیرفعال') : null)),
      h('div', { class: `stock ${low ? 'low' : ''}` }, h('b', { style: { fontSize: '32px' } }, fa(item.stock)), h('span', null, item.unit))),
    low ? h('div', { class: 'banner attn', style: { marginTop: '12px' } }, icon('alert'), `موجودی کمتر از حداقل (${fa(item.min_stock)}) است.`) : null,
    item.pending_out > 0 ? h('div', { class: 'banner info', style: { marginTop: '10px' } }, icon('clock'), `${fa(item.pending_out)} عدد در درخواست‌های خروج منتظر تایید است.`) : null,
  ));

  if (item.active) {
    body.append(h('div', { class: 'row' },
      h('a', { class: 'btn out grow', href: `#/scan?mode=out&item=${id}` }, icon('outbox'), 'خروج'),
      h('a', { class: 'btn in grow', href: `#/scan?mode=in&item=${id}` }, icon('inbox'), 'ورود')));
  }

  const kv = h('dl', { class: 'kv' });
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') kv.append(h('dt', null, k), h('dd', null, v)); };
  add('کد قطعه (اصلی)', item.part_no);
  add('کد سپیدار', item.sepidar_code);
  add('جنس', item.material);
  add('وزن (گرم)', item.weight_g != null ? fa(item.weight_g) : '');
  add('محل نگهداری', item.location);
  add('حداقل موجودی', item.min_stock ? fa(item.min_stock) : '');
  add('جمع ورودی‌ها', fa(item.total_in));
  add('جمع خروجی‌ها', fa(item.total_out));
  add('توضیحات', item.note);
  body.append(h('div', { class: 'card' }, h('h2', null, 'مشخصات'), kv));

  // QR
  const qrCard = h('div', { class: 'card' },
    h('h2', null, 'برچسب QR'),
    h('div', { class: 'row' },
      h('img', { src: `/api/qr/${item.qr_token}.svg`, alt: 'QR', width: 120, height: 120, style: { background: '#fff', borderRadius: '10px', padding: '4px', border: '1px solid var(--border)' } }),
      h('div', { class: 'grow hint' }, 'این QR فقط یک شناسه یکتا است؛ اگر کد قطعه را ویرایش کنید برچسب چاپ‌شده همچنان معتبر می‌ماند.')),
    admin ? h('a', { class: 'btn secondary block', style: { marginTop: '10px' }, href: `#/labels?ids=${id}` }, icon('printer'), 'چاپ برچسب') : null);
  body.append(qrCard);

  if (admin) {
    const imgInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onChange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        await api.post(`/api/items/${id}/image`, f, { contentType: f.type || 'application/octet-stream' });
        toast('تصویر ذخیره شد.', 'ok');
        navigate(`/items/${id}`, { replace: true });
      } catch (ex) { toast(ex.message, 'err'); }
    } });
    body.append(h('div', { class: 'card' }, h('h2', null, 'مدیریت'),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn secondary', href: `#/items/${id}/edit` }, icon('edit'), 'ویرایش'),
        h('button', { class: 'btn secondary', onClick: () => adjustDialog(item) }, icon('refresh'), 'اصلاح موجودی (شمارش)'),
        h('button', { class: 'btn secondary', onClick: () => imgInput.click() }, icon('image'), 'تصویر قطعه'),
        imgInput,
        h('button', { class: 'btn secondary', onClick: async () => {
          const next = !item.active;
          if (!next && !(await confirmDialog({ title: 'غیرفعال کردن قطعه', message: 'قطعه از فهرست و اسکن حذف می‌شود (سوابق آن می‌ماند).', confirmText: 'غیرفعال کن', danger: true }))) return;
          try {
            await api.post(`/api/items/${id}/active`, { active: next });
            await refreshItems();
            navigate(`/items/${id}`, { replace: true });
          } catch (ex) { toast(ex.message, 'err'); }
        } }, item.active ? 'غیرفعال کردن' : 'فعال کردن'))));
  }

  // history
  body.append(h('div', { class: 'section-title' }, `تاریخچه حرکات (${fa(total)})`));
  if (!history.length) body.append(emptyState('هنوز حرکتی برای این قطعه ثبت نشده است.', 'clock'));
  else {
    const rows = history.map((m) => h('tr', { class: 'clickable', onClick: () => navigate(`/docs/${m.doc_id}`) },
      h('td', { class: 'num' }, fmtDateTime(m.effective_at)),
      h('td', null, h('span', { class: `chip ${m.direction}` }, m.direction === 'in' ? 'ورود' : 'خروج')),
      h('td', { class: `num ${m.direction === 'in' ? 'qty-in' : 'qty-out'}` }, h('span', { class: 'ltr' }, `${m.direction === 'in' ? '+' : '−'}${fa(m.qty)}`)),
      h('td', { class: 'num' }, m.status === 'approved' ? `${fa(m.stock_before)} ← ${fa(m.stock_after)}` : '—'),
      h('td', null, reasonLabel(m.reason), m.worker_name ? ` • ${m.worker_name}` : ''),
      h('td', null, statusLabel(m.status)),
      h('td', null, m.created_by_name)));
    body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ...['تاریخ', 'نوع', 'تعداد', 'موجودی', 'علت', 'وضعیت', 'ثبت‌کننده'].map((t) => h('th', null, t)))),
      h('tbody', null, ...rows))));
    if (total > history.length) body.append(h('a', { class: 'btn secondary', href: `#/reports?item_id=${id}` }, 'مشاهده همه در گزارش‌ها'));
  }

  return { title: item.name, back: '/items', body };
}

async function adjustDialog(item) {
  await openSheet((close) => {
    const counted = h('input', { class: 'input num', inputmode: 'numeric', placeholder: 'تعداد شمارش‌شده', autofocus: true });
    const note = h('input', { class: 'input', placeholder: 'توضیح (اختیاری)', maxlength: 300 });
    const err = h('div', { class: 'err-text' });
    return h('div', { class: 'stack' },
      h('h2', null, `اصلاح موجودی: ${itemTitle(item)}`),
      h('div', { class: 'muted' }, `موجودی فعلی در سیستم: ${fa(item.stock)} ${item.unit}`),
      field('تعداد واقعی (شمارش‌شده)', counted),
      field('توضیح', note),
      err,
      h('div', { class: 'hint' }, 'اختلاف به صورت یک سند ورود/خروج با علت «اصلاح شمارش» ثبت می‌شود و در تاریخچه می‌ماند.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn secondary', onClick: () => close() }, 'انصراف'),
        h('button', { class: 'btn', onClick: async () => {
          const n = parseInt(latinDigits(counted.value), 10);
          if (!Number.isInteger(n) || n < 0) { err.textContent = 'تعداد را به صورت عدد صحیح وارد کنید.'; return; }
          try {
            await api.post(`/api/items/${item.id}/adjust`, { counted: n, note: note.value });
            toast('موجودی اصلاح شد.', 'ok');
            close();
            await refreshItems();
            navigate(`/items/${item.id}`, { replace: true });
          } catch (e) { err.textContent = e.message; }
        } }, 'ثبت اصلاح')));
  });
}

// ---------------- create / edit ----------------
export async function itemFormView({ params }) {
  const editing = params.id ? Number(params.id) : null;
  let item = {};
  if (editing) item = (await api.get(`/api/items/${editing}`)).item;

  const inputs = {};
  const mk = (key, label, opts = {}) => {
    const el = h(opts.tag || 'input', { class: `input ${opts.code ? 'code' : ''}`, value: item[key] ?? '', placeholder: opts.placeholder || '',
      inputmode: opts.numeric ? 'decimal' : null, maxlength: opts.max || 120, name: key });
    inputs[key] = el;
    return field(label, el, opts.hint);
  };

  const err = h('div', { class: 'err-text', role: 'alert' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    try {
      const r = editing ? await api.put(`/api/items/${editing}`, body) : await api.post('/api/items', body);
      await refreshItems();
      toast(editing ? 'تغییرات ذخیره شد.' : 'قطعه جدید ثبت شد.', 'ok');
      navigate(`/items/${r.item.id}`);
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'form-grid two' },
    mk('code', 'کد قطعه *', { code: true, hint: 'کد یکتا برای شناسایی (مثلاً 30700)' }),
    mk('sepidar_code', 'کد کالا در سپیدار', { code: true, hint: 'اگر خالی بماند همان «کد قطعه» استفاده می‌شود' }),
    mk('name', 'نام قطعه *'),
    mk('variant', 'نوع / حالت', { placeholder: 'مثلاً خام، مونتاژ شده، تامپو خورده' }),
    mk('part_no', 'کد قطعه (در فهرست اصلی)', { code: true }),
    mk('material', 'جنس', { max: 60 }),
    mk('weight_g', 'وزن (گرم)', { numeric: true, max: 12 }),
    mk('unit', 'واحد شمارش', { placeholder: 'عدد', max: 20 }),
    mk('location', 'محل نگهداری', { placeholder: 'مثلاً قفسه A3', max: 80 }),
    mk('min_stock', 'حداقل موجودی (هشدار)', { numeric: true, max: 9 })),
  mk('note', 'توضیحات', { tag: 'textarea', max: 500 }),
  editing ? null : h('div', { class: 'hint' }, 'موجودی اولیه را پس از ثبت قطعه از طریق «اصلاح موجودی» یا اسکن با علت «موجودی اولیه» وارد کنید.'),
  err,
  h('div', { class: 'row' },
    h('button', { class: 'btn grow', type: 'submit' }, editing ? 'ذخیره تغییرات' : 'ثبت قطعه'),
    h('a', { class: 'btn secondary', href: editing ? `#/items/${editing}` : '#/items' }, 'انصراف')));

  if (!editing) inputs.unit.value = 'عدد';
  return { title: editing ? 'ویرایش قطعه' : 'قطعه جدید', back: editing ? `/items/${editing}` : '/items', body: h('div', { class: 'card' }, form) };
}
