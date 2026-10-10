import { api, qs } from '../api.js';
import { store, reasonLabel, statusLabel, refreshPending } from '../store.js';
import {
  h, icon, fa, faId, fmtDateTime, itemTitle, emptyState, field, toast, downloadBlob, normSearch, confirmDialog,
} from '../ui.js';
import { navigate } from '../app.js';
import { toJalali, toGregorian, todayJalali, parseJalali, latinDigits, JALALI_MONTHS } from '../lib/jalali.js';

const pad = (n) => String(n).padStart(2, '0');
const fmtJ = (j) => `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`;

function addDays(j, n) {
  const g = toGregorian(j.jy, j.jm, j.jd);
  const d = new Date(Date.UTC(g.gy, g.gm - 1, g.gd + n));
  return toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function quickRanges() {
  const t = todayJalali();
  const monthStart = { jy: t.jy, jm: t.jm, jd: 1 };
  const prevEnd = addDays(monthStart, -1);
  const prevStart = { jy: prevEnd.jy, jm: prevEnd.jm, jd: 1 };
  return [
    ['امروز', t, t],
    ['دیروز', addDays(t, -1), addDays(t, -1)],
    ['۷ روز اخیر', addDays(t, -6), t],
    [`${JALALI_MONTHS[t.jm - 1]} (این ماه)`, monthStart, t],
    ['ماه قبل', prevStart, prevEnd],
  ];
}

function filenameOf(res, fallback) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : fallback;
}

export async function reportsView({ query }) {
  const users = (await api.get('/api/users')).users;
  const f = {
    from: query.from || '', to: query.to || '', direction: '', reason: '', status: 'approved', user_id: '', q: '', worker: '',
    item_id: query.item_id || '',
  };
  let offset = 0;
  const PAGE = 50;

  const body = h('div', { class: 'stack' });
  const filtersBox = h('div', { class: 'card' });
  const resultBox = h('div', { class: 'stack' });
  const exportBox = h('div', { class: 'stack' });

  // ----- filters -----
  const inFrom = h('input', { class: 'input code', placeholder: '1405/07/01', value: f.from, inputmode: 'numeric', maxlength: 10 });
  const inTo = h('input', { class: 'input code', placeholder: '1405/07/30', value: f.to, inputmode: 'numeric', maxlength: 10 });
  const inQ = h('input', { class: 'input', placeholder: 'نام/کد قطعه، کارگر، توضیحات…', type: 'search' });
  const inWorker = h('input', { class: 'input', placeholder: 'نام کارگر' });
  const sel = (opts, value) => h('select', { class: 'input' }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const selDir = sel([['', 'همه'], ['in', 'ورود'], ['out', 'خروج']], f.direction);
  const selReason = sel([['', 'همه'], ...Object.entries(store.meta.reasons).map(([k, v]) => [k, v.label])], f.reason);
  const selStatus = sel([['', 'همه'], ...Object.entries(store.meta.statuses)], f.status);
  const selUser = sel([['', 'همه'], ...users.map((u) => [String(u.id), u.display_name])], f.user_id);
  const itemChip = h('div');

  function readFilters() {
    f.from = latinDigits(inFrom.value).trim();
    f.to = latinDigits(inTo.value).trim();
    f.q = normSearch(inQ.value);
    f.worker = inWorker.value.trim();
    f.direction = selDir.value;
    f.reason = selReason.value;
    f.status = selStatus.value;
    f.user_id = selUser.value;
  }

  function validDates() {
    for (const [v, label] of [[f.from, 'تاریخ شروع'], [f.to, 'تاریخ پایان']]) {
      if (v && !parseJalali(v)) { toast(`${label} نامعتبر است (مثال: 1405/07/18)`, 'err'); return false; }
    }
    return true;
  }

  const quick = h('div', { class: 'tabs' }, ...quickRanges().map(([label, a, b]) =>
    h('button', { onClick: () => { inFrom.value = fmtJ(a); inTo.value = fmtJ(b); run(true); } }, label)));

  filtersBox.append(
    h('h2', null, 'فیلترها'),
    quick,
    h('div', { class: 'form-grid two', style: { marginTop: '10px' } },
      field('از تاریخ (شمسی)', inFrom), field('تا تاریخ (شمسی)', inTo),
      field('نوع', selDir), field('علت', selReason),
      field('وضعیت', selStatus), field('ثبت‌کننده', selUser),
      field('کارگر', inWorker), field('جستجو', inQ)),
    itemChip,
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn grow', onClick: () => run(true) }, icon('search'), 'اعمال فیلتر'),
      h('button', { class: 'btn secondary', onClick: () => {
        inFrom.value = ''; inTo.value = ''; inQ.value = ''; inWorker.value = '';
        selDir.value = ''; selReason.value = ''; selStatus.value = 'approved'; selUser.value = ''; f.item_id = '';
        run(true);
      } }, 'پاک کردن')));

  // ----- results -----
  async function run(reset) {
    readFilters();
    if (!validDates()) return;
    if (reset) offset = 0;
    itemChip.replaceChildren(f.item_id && store.itemsById.get(Number(f.item_id))
      ? h('div', { class: 'row', style: { marginTop: '10px' } },
        h('span', { class: 'chip primary' }, `قطعه: ${itemTitle(store.itemsById.get(Number(f.item_id)))}`),
        h('button', { class: 'btn sm ghost', onClick: () => { f.item_id = ''; run(true); } }, 'حذف فیلتر قطعه'))
      : '');
    resultBox.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
    try {
      const r = await api.get('/api/movements' + qs({ ...f, limit: PAGE, offset }));
      const rows = r.rows.map((m) => h('tr', { class: 'clickable', onClick: () => navigate(`/docs/${m.doc_id}`) },
        h('td', { class: 'num' }, faId(m.doc_no)),
        h('td', { class: 'num' }, fmtDateTime(m.effective_at)),
        h('td', null, h('span', { class: `chip ${m.direction}` }, m.direction === 'in' ? 'ورود' : 'خروج')),
        h('td', null, h('div', null, itemTitle(m)), h('div', { class: 'muted small ltr' }, m.code)),
        h('td', { class: `num ${m.direction === 'in' ? 'qty-in' : 'qty-out'}` }, fa(m.qty)),
        h('td', { class: 'num' }, m.status === 'approved' ? `${fa(m.stock_before)} ← ${fa(m.stock_after)}` : '—'),
        h('td', null, reasonLabel(m.reason), m.worker_name ? h('div', { class: 'muted small' }, m.worker_name) : null),
        h('td', null, m.created_by_name, m.decided_by_name && m.decided_by_name !== m.created_by_name ? h('div', { class: 'muted small' }, `تایید: ${m.decided_by_name}`) : null),
        h('td', null, statusLabel(m.status))));
      resultBox.replaceChildren(
        h('div', { class: 'stat-grid' },
          h('div', { class: 'card stat' }, h('b', null, fa(r.total)), h('span', null, 'تعداد ردیف')),
          h('div', { class: 'card stat in' }, h('b', null, fa(r.summary.qty_in)), h('span', null, 'جمع ورودی (تاییدشده)')),
          h('div', { class: 'card stat out' }, h('b', null, fa(r.summary.qty_out)), h('span', null, 'جمع خروجی (تاییدشده)'))),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, ...['سند', 'تاریخ', 'نوع', 'قطعه', 'تعداد', 'موجودی', 'علت / کارگر', 'ثبت‌کننده', 'وضعیت'].map((t) => h('th', null, t)))),
            h('tbody', null, ...rows)))
          : emptyState('رکوردی با این فیلترها پیدا نشد.', 'list'),
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary grow', disabled: offset === 0, onClick: () => { offset = Math.max(0, offset - PAGE); run(false); } }, 'قبلی'),
          h('span', { class: 'muted small num' }, r.total ? `${fa(offset + 1)}–${fa(Math.min(offset + PAGE, r.total))} از ${fa(r.total)}` : ''),
          h('button', { class: 'btn secondary grow', disabled: offset + PAGE >= r.total, onClick: () => { offset += PAGE; run(false); } }, 'بعدی')));
    } catch (e) {
      resultBox.replaceChildren(h('div', { class: 'banner danger' }, icon('alert'), e.message));
    }
  }

  // ----- exports -----
  async function drawExports() {
    const full = h('div', { class: 'card' },
      h('h2', null, 'خروجی کامل (Excel)'),
      h('p', { class: 'muted small', style: { margin: '0 0 10px' } },
        'شامل موجودی فعلی، تاریخچه همه حرکات (با موجودی قبل/بعد، ثبت‌کننده و تاییدکننده)، اسناد و گزارش ممیزی. بازه تاریخ همان فیلتر بالا (از/تا) است.'),
      h('button', { class: 'btn block', onClick: async (e) => {
        readFilters();
        if (!validDates()) return;
        e.currentTarget.disabled = true;
        try {
          const res = await api.blob('GET', '/api/export/full' + qs({ from: f.from, to: f.to }));
          downloadBlob(await res.blob(), filenameOf(res, 'full-report.xlsx'));
          toast('فایل خروجی کامل آماده شد.', 'ok');
        } catch (ex) { toast(ex.message, 'err'); } finally { e.target.disabled = false; }
      } }, icon('download'), 'دریافت خروجی کامل'));

    const sep = h('div', { class: 'card' }, h('h2', null, 'خروجی سپیدار'), h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
    if (!store.meta.sepidar_enabled) {
      exportBox.replaceChildren(full, h('div', { class: 'card' }, h('h2', null, 'خروجی سپیدار'),
        h('p', { class: 'muted', style: { margin: 0 } }, 'این بخش هنوز فعال نشده است و بعداً تکمیل می‌شود. فعلاً از «خروجی کامل» استفاده کنید.')));
      return;
    }
    exportBox.replaceChildren(full, sep);
    try {
      readFilters();
      const pv = await api.get('/api/export/sepidar/preview' + qs({ from: validDatesQuiet(f.from), to: validDatesQuiet(f.to) }));
      const format = 'xls';
      const t = todayJalali();
      const groupRow = (g) => {
        const noIn = h('input', { class: 'input code num', inputmode: 'numeric', placeholder: 'شماره سند', value: g.next_no || '', maxlength: 9 });
        const dateIn = h('input', { class: 'input code', inputmode: 'numeric', value: fmtJ(t), maxlength: 10 });
        return h('div', { class: 'card flat stack', style: { gap: '8px' } },
        h('div', { class: 'row wrap' },
          h('b', null, g.kind), g.type ? h('span', { class: 'chip primary' }, `نوع: ${g.type}`) : null),
        h('div', { class: 'small' }, `در سپیدار: ${g.hint}`),
        h('div', { class: 'muted small num' }, g.doc_count
          ? `${fa(g.doc_count)} سند جدید • ${fa(g.item_count)} قلم کالا • جمع ${fa(g.total_qty)} عدد`
          : 'سند جدیدی وجود ندارد'),
        g.doc_count ? h('div', { class: 'form-grid two' },
          field('شماره سند در سپیدار *', noIn, 'اولین شماره‌ی آزاد انبار در سپیدار؛ اگر شماره‌ی موجود را بدهید سند قبلی به‌روزرسانی می‌شود!'),
          field('تاریخ سند', dateIn)) : null,
        h('button', { class: 'btn block', disabled: g.doc_count === 0, onClick: async () => {
          readFilters();
          if (!validDates()) return;
          if (!/^\d+$/.test(latinDigits(noIn.value).trim())) { toast('شماره سند سپیدار را وارد کنید.', 'err'); return; }
          if (!parseJalali(dateIn.value)) { toast('تاریخ سند نامعتبر است.', 'err'); return; }
          const ok = await confirmDialog({
            title: `فایل ${g.kind}${g.type ? ' - ' + g.type : ''}`,
            message: `${fa(g.doc_count)} سند به‌عنوان «ارسال‌شده به سپیدار» علامت می‌خورد و دوباره در فایل بعدی نمی‌آید. ادامه می‌دهید؟`,
            confirmText: 'ایجاد و دانلود',
          });
          if (!ok) return;
          try {
            const res = await api.blob('POST', '/api/export/sepidar', { from: f.from, to: f.to, format, group: g.key, doc_no: latinDigits(noIn.value).trim(), date: latinDigits(dateIn.value).trim() });
            downloadBlob(await res.blob(), filenameOf(res, `sepidar.${format}`));
            toast('فایل آماده شد.', 'ok');
            drawExports();
          } catch (ex) { toast(ex.message, 'err'); }
        } }, icon('download'), 'دریافت فایل .xls'));
      };

      const batches = pv.batches.length
        ? h('div', { class: 'stack', style: { marginTop: '12px' } }, h('div', { class: 'muted small' }, 'دانلود مجدد فایل‌های قبلی'),
          ...pv.batches.map((b) => h('div', { class: 'row', style: { gap: '8px' } },
            h('div', { class: 'grow small num' }, `دسته ${fa(b.id)} • ${fmtDateTime(b.created_at)} • ${fa(b.doc_count)} سند`),
            h('button', { class: 'btn sm secondary', onClick: async () => {
              try {
                const res = await api.blob('GET', `/api/export/sepidar/batches/${b.id}?format=xls`);
                downloadBlob(await res.blob(), filenameOf(res, `sepidar-${b.id}.xls`));
              } catch (ex) { toast(ex.message, 'err'); }
            } }, 'XLS'))))
        : null;

      sep.replaceChildren(...[
        h('h2', null, 'خروجی سپیدار'),
        h('p', { class: 'muted small', style: { margin: '0 0 10px' } },
          'برای هر نوع سند سپیدار یک فایل ساخته می‌شود که سربرگ سند (نوع، شماره، تاریخ، انبار، طرف مقابل) و اقلام را با هم دارد. در سپیدار: فهرست رسید/خروج انبار › «دریافت اطلاعات» (الگوی دریافت). هر سند فقط یک‌بار صادر می‌شود.'),
        ...pv.groups.map(groupRow),
        batches,
      ].filter(Boolean));
    } catch (e) {
      sep.replaceChildren(h('h2', null, 'خروجی سپیدار'), h('div', { class: 'err-text' }, e.message));
    }
  }

  const validDatesQuiet = (v) => (v && parseJalali(v) ? v : '');

  body.append(exportBox, filtersBox, resultBox);
  run(true);
  drawExports();
  refreshPending();
  return { title: 'گزارش‌ها و خروجی', body };
}
