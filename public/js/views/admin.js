import { api, qs } from '../api.js';
import { store } from '../store.js';
import {
  h, icon, fa, fmtDateTime, field, toast, openSheet, confirmDialog, copyText, emptyState,
} from '../ui.js';
import { navigate } from '../app.js';

// ---------------- users ----------------
function showTempPassword(title, username, password) {
  return openSheet((close) => h('div', { class: 'stack' },
    h('h2', null, title),
    h('div', { class: 'muted' }, 'گذرواژه موقت را به کاربر بدهید. کاربر در اولین ورود باید آن را تغییر دهد و این گذرواژه دوباره نمایش داده نمی‌شود.'),
    h('div', { class: 'card flat' },
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'نام کاربری:'), h('b', { class: 'ltr' }, username)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'گذرواژه موقت:'), h('b', { class: 'ltr', style: { fontSize: '18px', letterSpacing: '1px' } }, password))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn secondary', onClick: async () => { toast((await copyText(password)) ? 'کپی شد' : 'کپی انجام نشد', 'ok'); } }, 'کپی گذرواژه'),
      h('button', { class: 'btn', onClick: () => close() }, 'بستن'))), { dismissable: false });
}

export async function usersView() {
  const box = h('div', { class: 'list' });
  const body = h('div', { class: 'stack' }, box);

  async function load() {
    const { users } = await api.get('/api/users');
    box.replaceChildren(...users.map((u) => h('div', { class: 'card' },
      h('div', { class: 'row wrap' },
        h('b', null, u.display_name),
        h('span', { class: `chip ${u.role === 'admin' ? 'primary' : ''}` }, store.meta.roles[u.role]),
        !u.active ? h('span', { class: 'chip danger' }, 'غیرفعال') : null,
        u.must_change_password ? h('span', { class: 'chip warn' }, 'گذرواژه موقت') : null),
      h('div', { class: 'muted small' }, h('span', { class: 'ltr' }, u.username), ' • ',
        u.last_login_at ? `آخرین ورود: ${fmtDateTime(u.last_login_at)}` : 'هنوز وارد نشده'),
      h('div', { class: 'row wrap', style: { marginTop: '10px' } },
        h('button', { class: 'btn sm secondary', onClick: () => editUser(u) }, icon('edit'), 'ویرایش'),
        h('button', { class: 'btn sm secondary', onClick: async () => {
          if (!(await confirmDialog({ title: 'بازنشانی گذرواژه', message: `برای «${u.display_name}» گذرواژه موقت جدید ساخته می‌شود و نشست‌های فعلی او بسته می‌شود.`, confirmText: 'بازنشانی' }))) return;
          try {
            const r = await api.post(`/api/users/${u.id}/reset-password`);
            await showTempPassword('گذرواژه موقت جدید', u.username, r.temp_password);
            load();
          } catch (e) { toast(e.message, 'err'); }
        } }, 'بازنشانی گذرواژه'),
        u.id !== store.user.id ? h('button', { class: 'btn sm secondary', onClick: async () => {
          try { await api.put(`/api/users/${u.id}`, { active: !u.active }); load(); } catch (e) { toast(e.message, 'err'); }
        } }, u.active ? 'غیرفعال‌سازی' : 'فعال‌سازی') : null))));
  }

  function editUser(u) {
    openSheet((close) => {
      const name = h('input', { class: 'input', value: u.display_name, maxlength: 60 });
      const role = h('select', { class: 'input', disabled: u.id === store.user.id },
        ...Object.entries(store.meta.roles).map(([k, l]) => h('option', { value: k, selected: k === u.role }, l)));
      const err = h('div', { class: 'err-text' });
      return h('div', { class: 'stack' }, h('h2', null, 'ویرایش کاربر'),
        field('نام نمایشی', name), field('نقش', role), err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn secondary', onClick: () => close() }, 'انصراف'),
          h('button', { class: 'btn', onClick: async () => {
            try { await api.put(`/api/users/${u.id}`, { display_name: name.value, role: role.value }); close(); load(); } catch (e) { err.textContent = e.message; }
          } }, 'ذخیره')));
    });
  }

  function addUser() {
    openSheet((close) => {
      const username = h('input', { class: 'input code', placeholder: 'ali', autocapitalize: 'none', maxlength: 30 });
      const name = h('input', { class: 'input', placeholder: 'علی', maxlength: 60 });
      const role = h('select', { class: 'input' }, ...Object.entries(store.meta.roles).map(([k, l]) => h('option', { value: k, selected: k === 'storekeeper' }, l)));
      const err = h('div', { class: 'err-text' });
      return h('div', { class: 'stack' }, h('h2', null, 'کاربر جدید'),
        field('نام کاربری (انگلیسی)', username, 'فقط حروف انگلیسی، عدد و _ . -'), field('نام نمایشی', name), field('نقش', role), err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn secondary', onClick: () => close() }, 'انصراف'),
          h('button', { class: 'btn', onClick: async () => {
            try {
              const r = await api.post('/api/users', { username: username.value.trim(), display_name: name.value, role: role.value });
              close();
              await showTempPassword('کاربر ساخته شد', r.user.username, r.temp_password);
              load();
            } catch (e) { err.textContent = e.message; }
          } }, 'ایجاد')));
    });
  }

  await load();
  return { title: 'کاربران', back: '/more', body, actions: [h('button', { class: 'btn sm', onClick: addUser }, icon('plus'), 'کاربر جدید')] };
}

// ---------------- workers ----------------
export async function workersView() {
  const box = h('div', { class: 'list' });
  const input = h('input', { class: 'input', placeholder: 'نام کارگر جدید', maxlength: 80 });
  const body = h('div', { class: 'stack' },
    h('form', { class: 'row', onSubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try { await api.post('/api/workers', { name: input.value }); input.value = ''; load(); } catch (ex) { toast(ex.message, 'err'); }
    } }, h('div', { class: 'grow' }, input), h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'افزودن')),
    h('div', { class: 'hint' }, 'کارگرانی که در سند تحویل نامشان تایپ می‌شود هم خودکار به این فهرست اضافه می‌شوند.'),
    box);

  async function load() {
    const { workers } = await api.get('/api/workers');
    box.replaceChildren(...(workers.length ? workers.map((w) => h('div', { class: 'card row' },
      h('div', { class: 'grow' }, h('b', null, w.name), !w.active ? h('span', { class: 'chip', style: { marginInlineStart: '8px' } }, 'غیرفعال') : null),
      h('button', { class: 'btn sm secondary', onClick: async () => { await api.post(`/api/workers/${w.id}/active`, { active: !w.active }); load(); } },
        w.active ? 'غیرفعال' : 'فعال')))
      : [emptyState('هنوز کارگری ثبت نشده است.', 'users')]));
  }
  await load();
  return { title: 'کارگران', back: '/more', body };
}

// ---------------- settings ----------------
export async function settingsView() {
  const { settings: s, default_sepidar_columns: defaults, groups } = await api.get('/api/settings');
  const cols = { receipt: [], issue: [] };
  for (const doc of ['receipt', 'issue']) {
    const stored = s.sepidar_columns_v2?.[doc] ?? defaults[doc];
    cols[doc] = stored.map((c) => ({ ...c }));
    for (const d of defaults[doc]) if (!cols[doc].some((c) => c.key === d.key)) cols[doc].push({ ...d, enabled: false });
  }

  const approvalOut = h('input', { type: 'checkbox', checked: s.approval_required_out, style: { width: '22px', height: '22px' } });
  const approvalIn = h('input', { type: 'checkbox', checked: s.approval_required_in, style: { width: '22px', height: '22px' } });
  const company = h('input', { class: 'input', value: s.company_name, maxlength: 100 });
  const sepOn = h('input', { type: 'checkbox', checked: !!s.sepidar_enabled, style: { width: '22px', height: '22px' } });
  const whText = h('textarea', { class: 'input code', rows: 4, style: { direction: 'ltr' } },
    s.sepidar_warehouses.map((w) => `${w.code} ${w.title}`).join('\n'));
  const mainWh = h('select', { class: 'input' },
    ...s.sepidar_warehouses.map((w) => h('option', { value: w.code, selected: w.code === s.sepidar_main_warehouse }, `${w.title} (${w.code})`)));
  const dateFmt = h('select', { class: 'input' }, ...[['with_time', '1405/07/18 12:00:00 ق.ظ (پیش‌فرض، مثل خروجی خود سپیدار)'], ['slash', '1405/07/18'], ['digits', '14050718'], ['dash', '1405-07-18']]
    .map(([v, l]) => h('option', { value: v, selected: v === (s.sepidar_date_format || 'with_time') }, l)));
  const layout = h('select', { class: 'input' }, ...[
    ['flat', 'سربرگ در هر ردیفِ قلم تکرار می‌شود (پیش‌فرض)'],
    ['first_row_only', 'سربرگ فقط در ردیف قلم اول'],
    ['header_row_blank', 'یک ردیف فقط سربرگ، سپس اقلام بدون سربرگ'],
    ['header_row_repeat', 'یک ردیف فقط سربرگ، سپس اقلام با سربرگ تکراری'],
    ['per_row', 'هر قلم یک سند جدا (شماره‌ی پشت‌سرهم)'],
  ].map(([v, l]) => h('option', { value: v, selected: v === (s.sepidar_layout || 'flat') }, l)));
  const itemsStyle = h('select', { class: 'input' }, ...[
    ['short', 'عنوان کوتاه مثل جدول سند: «رديف»، «كد»، «عنوان»، «واحد اصلي» … (پیش‌فرض)'],
    ['native', 'عنوان کامل مثل خروجی سپیدار: «قلم خروج انبار رديف»، «قلم خروج انبار كد» …'],
  ].map(([v, l]) => h('option', { value: v, selected: v === (s.sepidar_items_titles || 'short') }, l)));
  const txtMode = h('select', { class: 'input' }, ...[
    ['none', 'بدون عنوان: 31400,100'],
    ['latin', 'با عنوان انگلیسی در خط اول: Code,Quantity'],
    ['row', 'با ردیف: 1,31400,100'],
  ].map(([v, l]) => h('option', { value: v, selected: v === (s.sepidar_txt_header || 'none') }, l)));
  const titles = h('input', { type: 'checkbox', checked: !!s.sepidar_titles, style: { width: '22px', height: '22px' } });
  const issuer = h('input', { class: 'input code', inputmode: 'numeric', value: s.sepidar_issuer_id ?? '', maxlength: 9, placeholder: 'خالی' });
  const accounts = {};
  for (const [k, g] of Object.entries(groups)) {
    accounts[k] = h('input', { class: 'input code', value: s.sepidar_accounts?.[k] || g.account || g.line_account || '', maxlength: 30, placeholder: '—' });
  }
  const party = {};
  for (const [k, g] of Object.entries(groups)) {
    party[k] = h('input', { class: 'input code', value: s.sepidar_party_codes?.[k] ?? g.party ?? '', maxlength: 30, placeholder: '—' });
  }

  const editors = {};
  function columnsEditor(doc, title) {
    const box = h('div', { class: 'stack' });
    const draw = () => box.replaceChildren(...cols[doc].map((c, i) => h('div', { class: 'row', style: { gap: '6px' } },
      h('input', { type: 'checkbox', checked: c.enabled, style: { width: '20px', height: '20px' }, onChange: (e) => { c.enabled = e.target.checked; } }),
      h('div', { class: 'grow' }, h('input', { class: 'input', value: c.header, maxlength: 100, 'aria-label': 'عنوان ستون', onInput: (e) => { c.header = e.target.value; } })),
      h('button', { class: 'btn sm icon secondary', disabled: i === 0, 'aria-label': 'بالا', onClick: () => { [cols[doc][i - 1], cols[doc][i]] = [cols[doc][i], cols[doc][i - 1]]; draw(); } }, '↑'),
      h('button', { class: 'btn sm icon secondary', disabled: i === cols[doc].length - 1, 'aria-label': 'پایین', onClick: () => { [cols[doc][i + 1], cols[doc][i]] = [cols[doc][i], cols[doc][i + 1]]; draw(); } }, '↓'))));
    draw();
    editors[doc] = box;
    const reset = h('button', { class: 'btn sm secondary', onClick: () => { cols[doc] = defaults[doc].map((c) => ({ ...c })); draw(); } }, 'بازگشت به پیش‌فرض');
    return h('div', { class: 'stack' }, h('div', { class: 'row', style: { margin: '10px 0 0' } }, h('div', { class: 'section-title grow', style: { margin: 0 } }, title), reset), box);
  }

  const err = h('div', { class: 'err-text' });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('h2', null, 'گردش تایید'),
      h('label', { class: 'row', style: { gap: '12px' } }, approvalOut, h('span', null, 'خروج‌های ثبت‌شده توسط انباردار نیاز به تایید مدیر دارد')),
      h('label', { class: 'row', style: { gap: '12px' } }, approvalIn, h('span', null, 'ورودی‌های ثبت‌شده توسط انباردار هم نیاز به تایید مدیر دارد')),
      h('div', { class: 'hint' }, 'اسنادی که خود مدیر ثبت می‌کند بدون نیاز به تایید دوم اعمال می‌شوند (و با نام او در تاریخچه می‌مانند).')),
    h('div', { class: 'card stack' }, h('h2', null, 'اطلاعات عمومی'), field('نام شرکت', company)),
    h('div', { class: 'card stack' },
      h('h2', null, 'انبارهای سپیدار'),
      field('فهرست انبارها (هر خط: کد، فاصله، عنوان)', whText, 'برای «انتقال بین انبار» و ضایعات (کد 1004) استفاده می‌شود.'),
      field('انبار این سامانه (مبدأ ورود و خروج)', mainWh, 'پس از تغییر فهرست، ذخیره کنید و صفحه را دوباره باز کنید.')),
    h('div', { class: 'card stack' },
      h('h2', null, 'خروجی سپیدار'),
      h('label', { class: 'row', style: { gap: '12px' } }, sepOn, h('span', null, 'فعال‌سازی خروجی سپیدار (آزمایشی — هنوز تکمیل نشده)')),
      h('div', { class: 'hint' }, 'تا زمانی که قالب واقعی ورود اطلاعات سپیدار مشخص نشده، این گزینه را خاموش بگذارید. «خروجی کامل» همیشه در دسترس است.')),
    h('div', { class: 'card stack', id: 'sepidar-party' },
      h('h2', null, 'فایل دریافت سپیدار — مقادیر پیش‌فرض'),
      h('div', { class: 'form-grid two' },
        ...Object.entries(groups).map(([k, g]) => field(`${g.kind} › ${g.type} — کد ${g.doc === 'receipt' ? 'تحویل‌دهنده' : 'تحویل‌گیرنده'}`, party[k])),
        h('label', { class: 'row', style: { gap: '12px' } }, titles, h('span', null, 'پر کردن ستون‌های «عنوان» (انبار، قلم، حساب…) — معمولاً باید خاموش باشد')),
        field('عنوان ستون‌های فایل اقلام (Excel)', itemsStyle, 'ستون‌ها همان ستون‌های جدول اقلام سند هستند'),
        field('قالب فایل TXT اقلام', txtMode, 'فایل فقط شامل کد کالا و تعداد است (بدون BOM و فقط حروف لاتین/عدد)'),
        field('چیدمان اقلام در فایل', layout, 'سپیدار هر ردیف را یک سند می‌گیرد؛ اگر اقلام یک سند را یکی نکرد، چیدمان دیگر را امتحان کنید'),
        field('قالب تاریخ در فایل', dateFmt, 'اگر سپیدار روی ستون تاریخ خطا داد، قالب دیگر را امتحان کنید'),
        field('شناسه‌ی عددی «صادر کننده (2)»', issuer, 'اگر خالی بماند سپیدار کاربر وارد شده را می‌گذارد؛ مقدار متنی (نام) باعث خطای «داده‌ی وارد شده صحیح نمی‌باشد» می‌شود'),
        ...Object.entries(accounts).map(([k, el]) => field(`کد حساب معین — ${groups[k].kind} › ${groups[k].type}`, el)))),
    h('div', { class: 'card stack', id: 'sepidar-cols' },
      h('h2', null, 'ستون‌های فایل دریافت سپیدار'),
      h('div', { class: 'hint' }, 'سپیدار ردیف اول فایل را به‌عنوان عنوان ستون می‌خواند. عنوان‌ها باید با نام ستون‌های «الگوی دریافت رسید انبار / خروج انبار» (با گزینه‌ی «نام کامل») یکی باشند. اگر سپیدار ستونی را نشناخت، عنوان آن را اینجا اصلاح کنید.'),
      columnsEditor('receipt', 'رسید انبار'),
      columnsEditor('issue', 'خروج انبار')),
    err,
    h('button', { class: 'btn block', onClick: async () => {
      err.textContent = '';
      try {
        await api.put('/api/settings', {
          approval_required_out: approvalOut.checked, approval_required_in: approvalIn.checked,
          company_name: company.value,
          sepidar_enabled: sepOn.checked,
          sepidar_columns_v2: cols,
          sepidar_party_codes: Object.fromEntries(Object.entries(party).map(([k, el]) => [k, el.value])),
          sepidar_issuer_id: issuer.value,
          sepidar_titles: titles.checked,
          sepidar_date_format: dateFmt.value,
          sepidar_layout: layout.value,
          sepidar_txt_header: txtMode.value,
          sepidar_items_titles: itemsStyle.value,
          sepidar_accounts: Object.fromEntries(Object.entries(accounts).map(([k, el]) => [k, el.value])),
          sepidar_warehouses: whText.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            const i = l.search(/\s/);
            return i < 0 ? { code: l, title: l } : { code: l.slice(0, i), title: l.slice(i + 1).trim() };
          }),
          sepidar_main_warehouse: mainWh.value,
        });
        store.meta = await api.get('/api/meta');
        toast('تنظیمات ذخیره شد.', 'ok');
      } catch (e) { err.textContent = e.message; }
    } }, 'ذخیره تنظیمات'));
  const syncSepidar = () => body.querySelectorAll('#sepidar-party, #sepidar-cols').forEach((el) => { el.hidden = !sepOn.checked; });
  sepOn.addEventListener('change', syncSepidar);
  syncSepidar();
  return { title: 'تنظیمات', back: '/more', body };
}

// ---------------- audit ----------------
export async function auditView() {
  let q = '';
  let offset = 0;
  const PAGE = 60;
  const box = h('div');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'جستجو در کاربر، عملیات، جزئیات…' });
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value; offset = 0; load(); }, 250); });

  async function load() {
    const r = await api.get('/api/audit' + qs({ q, limit: PAGE, offset }));
    box.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ...['زمان', 'کاربر', 'عملیات', 'جزئیات'].map((t) => h('th', null, t)))),
        h('tbody', null, ...r.rows.map((l) => h('tr', null,
          h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, fmtDateTime(l.at)),
          h('td', null, l.username || 'سیستم'),
          h('td', null, h('span', { class: 'code-tag' }, l.action), l.entity ? h('div', { class: 'muted small' }, `${l.entity} ${l.entity_id}`) : null),
          h('td', { class: 'small', style: { wordBreak: 'break-word', maxWidth: '360px' } }, l.detail)))))),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn secondary grow', disabled: offset === 0, onClick: () => { offset = Math.max(0, offset - PAGE); load(); } }, 'جدیدتر'),
        h('span', { class: 'muted small num' }, `${fa(r.total)} رکورد`),
        h('button', { class: 'btn secondary grow', disabled: offset + PAGE >= r.total, onClick: () => { offset += PAGE; load(); } }, 'قدیمی‌تر')));
  }
  await load();
  return { title: 'گزارش ممیزی', back: '/more', body: h('div', { class: 'stack' }, search, box) };
}

void navigate;
