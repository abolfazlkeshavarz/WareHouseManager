import { api, qs } from '../api.js';
import { store } from '../store.js';
import {
  h, icon, fa, fmtDateTime, field, toast, openSheet, confirmDialog, copyText, emptyState, downloadBlob, latinDigits,
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
    const me = users.find((x) => x.id === store.user.id) || store.user;
    const hasSuper = users.some((x) => x.super_admin && x.active);
    // same rule as the server: once a «مدیر ارشد» exists, only he manages other admins
    const canManage = (u) => me.super_admin || u.id === me.id || (!u.super_admin && (u.role !== 'admin' || !hasSuper));
    box.replaceChildren(...users.map((u) => h('div', { class: 'card' },
      h('div', { class: 'row wrap' },
        h('b', null, u.display_name),
        h('span', { class: `chip ${u.role === 'admin' ? 'primary' : ''}` }, u.super_admin ? 'مدیر ارشد' : store.meta.roles[u.role]),
        !u.active ? h('span', { class: 'chip danger' }, 'غیرفعال') : null,
        u.must_change_password ? h('span', { class: 'chip warn' }, 'گذرواژه موقت') : null),
      h('div', { class: 'muted small' }, h('span', { class: 'ltr' }, u.username), ' • ',
        u.last_login_at ? `آخرین ورود: ${fmtDateTime(u.last_login_at)}` : 'هنوز وارد نشده'),
      h('div', { class: 'row wrap', style: { marginTop: '10px' } },
        canManage(u) ? h('button', { class: 'btn sm secondary', onClick: () => editUser(u) }, icon('edit'), 'ویرایش') : null,
        me.super_admin ? h('button', { class: 'btn sm', onClick: () => setPassword(u) }, 'تعیین گذرواژه') : null,
        !canManage(u) ? null : h('button', { class: 'btn sm secondary', onClick: async () => {
          if (!(await confirmDialog({ title: 'بازنشانی گذرواژه', message: `برای «${u.display_name}» گذرواژه موقت جدید ساخته می‌شود و نشست‌های فعلی او بسته می‌شود.`, confirmText: 'بازنشانی' }))) return;
          try {
            const r = await api.post(`/api/users/${u.id}/reset-password`);
            await showTempPassword('گذرواژه موقت جدید', u.username, r.temp_password);
            load();
          } catch (e) { toast(e.message, 'err'); }
        } }, 'بازنشانی گذرواژه'),
        u.id !== store.user.id && canManage(u) && !u.super_admin ? h('button', { class: 'btn sm secondary', onClick: async () => {
          try { await api.put(`/api/users/${u.id}`, { active: !u.active }); load(); } catch (e) { toast(e.message, 'err'); }
        } }, u.active ? 'غیرفعال‌سازی' : 'فعال‌سازی') : null))));
  }

  function setPassword(u) {
    openSheet((close) => {
      const self = u.id === store.user.id;
      const pw = h('input', { class: 'input code', type: 'password', autocomplete: 'new-password', maxlength: 200 });
      const again = h('input', { class: 'input code', type: 'password', autocomplete: 'new-password', maxlength: 200 });
      const show = h('input', { type: 'checkbox', style: { width: '20px', height: '20px' }, onChange: () => { pw.type = again.type = show.checked ? 'text' : 'password'; } });
      const must = h('input', { type: 'checkbox', style: { width: '20px', height: '20px' } });
      const err = h('div', { class: 'err-text' });
      return h('div', { class: 'stack' },
        h('h2', null, `تعیین گذرواژه: ${u.display_name}`),
        h('div', { class: 'muted small ltr' }, u.username),
        field('گذرواژه جدید (حداقل ۸ نویسه)', pw), field('تکرار گذرواژه', again),
        h('label', { class: 'row', style: { gap: '10px' } }, show, h('span', null, 'نمایش گذرواژه')),
        self ? null : h('label', { class: 'row', style: { gap: '10px' } }, must, h('span', null, 'کاربر در ورود بعدی گذرواژه را عوض کند')),
        h('div', { class: 'hint' }, self ? 'نشست‌های دیگر شما بسته می‌شوند.' : 'کاربر از همه‌ی دستگاه‌ها خارج می‌شود و باید با گذرواژه‌ی جدید وارد شود.'),
        err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn secondary', onClick: () => close() }, 'انصراف'),
          h('button', { class: 'btn', onClick: async () => {
            err.textContent = '';
            if (pw.value.length < 8) { err.textContent = 'گذرواژه باید حداقل ۸ نویسه باشد.'; return; }
            if (pw.value !== again.value) { err.textContent = 'تکرار گذرواژه یکسان نیست.'; return; }
            try {
              await api.post(`/api/users/${u.id}/set-password`, { password: pw.value, must_change: must.checked });
              close(); toast(`گذرواژه‌ی «${u.display_name}» تغییر کرد.`, 'ok'); load();
            } catch (e) { err.textContent = e.message; }
          } }, 'ذخیره گذرواژه')));
    });
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
        w.active ? 'غیرفعال' : 'فعال'),
      h('button', { class: 'btn sm ghost icon', type: 'button', 'aria-label': 'حذف', onClick: async () => {
        if (!(await confirmDialog({ title: 'حذف کارگر', message: `«${w.name}» از فهرست کارگران حذف شود؟ نام او در اسناد و گزارش‌های قبلی باقی می‌ماند.`, confirmText: 'حذف', danger: true }))) return;
        try { await api.post(`/api/workers/${w.id}/delete`); toast('کارگر حذف شد.', 'ok'); load(); } catch (ex) { toast(ex.message, 'err'); }
      } }, icon('trash'))))
      : [emptyState('هنوز کارگری ثبت نشده است.', 'users')]));
  }
  await load();
  return { title: 'کارگران', back: '/more', body };
}

// ---------------- settings ----------------
const UPDATE_STEPS = {
  backup: 'پشتیبان‌گیری از پایگاه داده…', fetch: 'دریافت نسخه‌ی جدید…', build: 'ساخت و راه‌اندازی نسخه (چند دقیقه طول می‌کشد)…',
  restoring: 'نسخه‌ی جدید بالا نیامد؛ در حال برگرداندن نسخه‌ی قبلی…',
  done: 'با موفقیت انجام شد.', up_to_date: 'همین حالا آخرین نسخه نصب است.',
  restored: 'نسخه‌ی جدید بالا نیامد و نسخه‌ی قبلی برگردانده شد.', broken: 'ناموفق بود و برنامه بالا نیامد. سرور را بررسی کنید.',
  merge: 'ادغام نسخه‌ی جدید ممکن نشد.', local_changes: 'روی سرور فایل‌های تغییرکرده وجود دارد؛ به‌روزرسانی خودکار انجام نشد.',
  no_previous: 'نسخه‌ی قبلی برای بازگشت ثبت نشده است.',
};

/** «پشتیبان‌گیری خودکار»: schedule controls (saved with the page) + the list of copies, backup-now and download. */
function backupCard() {
  const enabled = h('input', { type: 'checkbox', style: { width: '22px', height: '22px' } });
  const hour = h('select', { class: 'input' }, ...Array.from({ length: 24 }, (_, i) => h('option', { value: String(i) }, `${fa(i)}:۰۰`)));
  const keep = h('input', { class: 'input num', inputmode: 'numeric', maxlength: 2 });
  const info = h('div', { class: 'stack' });
  const sizeText = (n) => (n >= 1048576 ? `${fa((n / 1048576).toFixed(1))} مگابایت` : `${fa(Math.max(1, Math.round(n / 1024)))} کیلوبایت`);

  function draw(s) {
    enabled.checked = s.enabled; hour.value = String(s.hour); keep.value = String(s.keep);
    const newest = s.files[0];
    const stale = !newest || Date.now() - Date.parse(newest.at) > 48 * 3600_000;
    const rows = [];
    if (s.last && !s.last.ok) rows.push(h('div', { class: 'banner attn' }, h('span', { class: 'grow' }, `آخرین پشتیبان‌گیری ناموفق بود (${fmtDateTime(s.last.at)}).`, h('div', { class: 'muted small ltr' }, s.last.error || ''))));
    else if (stale) rows.push(h('div', { class: 'banner attn' }, h('span', { class: 'grow' }, newest ? 'بیش از دو روز است پشتیبانی گرفته نشده است.' : 'هنوز پشتیبانی گرفته نشده است.')));
    else rows.push(h('div', { class: 'banner info' }, h('span', { class: 'grow' }, `آخرین پشتیبان: ${fmtDateTime(newest.at)} (${sizeText(newest.size)})`,
      s.last?.ok && s.last.file === newest.name ? h('div', { class: 'muted small num' }, `${fa(s.last.items)} قطعه • ${fa(s.last.documents)} سند • بررسی سلامت: سالم`) : null)));
    rows.push(h('button', { class: 'btn secondary block', type: 'button', onClick: async (e) => {
      e.target.disabled = true;
      try { draw(await api.post('/api/backups')); toast('پشتیبان گرفته شد.', 'ok'); } catch (ex) { toast(ex.message, 'err'); e.target.disabled = false; }
    } }, 'پشتیبان همین حالا'));
    if (s.files.length) {
      rows.push(h('details', null, h('summary', { class: 'section-title', style: { cursor: 'pointer' } }, `فایل‌های پشتیبان (${fa(s.total)})`),
        h('div', { class: 'list' }, ...s.files.map((f) => h('div', { class: 'row', style: { gap: '8px' } },
          h('div', { class: 'grow' }, h('div', { class: 'num' }, fmtDateTime(f.at)), h('div', { class: 'muted small' }, sizeText(f.size))),
          h('button', { class: 'btn sm secondary', type: 'button', onClick: async () => {
            try { const res = await api.blob('GET', `/api/backups/${f.name}`); downloadBlob(await res.blob(), f.name); } catch (ex) { toast(ex.message, 'err'); }
          } }, icon('download'), 'دریافت'))))));
    }
    info.replaceChildren(...rows);
  }
  api.get('/api/backups').then(draw).catch((e) => info.replaceChildren(h('div', { class: 'err-text' }, e.message)));

  const card = h('div', { class: 'card stack' },
    h('h2', null, 'پشتیبان‌گیری خودکار'),
    h('label', { class: 'row', style: { gap: '12px' } }, enabled, h('span', null, 'هر روز به‌صورت خودکار از پایگاه داده پشتیبان گرفته شود')),
    h('div', { class: 'form-grid two' }, field('ساعت پشتیبان‌گیری', hour), field('تعداد پشتیبان‌های نگهداری‌شده', keep, 'قدیمی‌ترها خودکار پاک می‌شوند.')),
    info,
    h('div', { class: 'hint' }, 'پشتیبان‌ها روی همان سرور نگه داشته می‌شوند. هر چند وقت یک‌بار یک فایل را با «دریافت» روی کامپیوتر یا فلش خودتان هم ذخیره کنید.'));
  return { card, values: () => ({ backup_enabled: enabled.checked, backup_hour: Number(hour.value), backup_keep: Number(latinDigits(keep.value)) }) };
}

/** «نسخه و به‌روزرسانی»: shows the running version and asks the host updater service to update / roll back. */
function updateCard() {
  const box = h('div', { class: 'stack' });
  const card = h('div', { class: 'card stack', style: { borderColor: 'var(--warn)' } },
    h('div', { class: 'row', style: { gap: '8px' } }, h('h2', { class: 'grow' }, 'نسخه و به‌روزرسانی'), h('span', { class: 'chip warn' }, 'آزمایشی')),
    box);
  let timer = null;
  let stopped = false;
  let started = null; // commit that was running when an action was requested

  const verText = (v) => (v ? `${v.version || '—'}${v.commit ? ' (' + v.commit + ')' : ''}` : '—');
  const schedule = (ms) => { clearTimeout(timer); if (!stopped) timer = setTimeout(refresh, ms); };

  async function send(action, confirm) {
    if (confirm && !(await confirmDialog(confirm))) return;
    try {
      const s = await api.post('/api/update', { action });
      started = s.current.commit;
      draw(s, action === 'check' ? 'در حال بررسی…' : 'درخواست ثبت شد…');
      schedule(2500);
    } catch (e) { toast(e.message, 'err'); }
  }

  function draw(s, note) {
    const u = s.updater;
    const st = s.status;
    const working = s.busy || s.pending;
    const rows = [h('dl', { class: 'kv' },
      h('dt', null, 'نسخه‌ی در حال اجرا'), h('dd', { class: 'ltr' }, verText(s.current)),
      s.current.built_at ? h('dt', null, 'زمان ساخت') : null, s.current.built_at ? h('dd', null, fmtDateTime(s.current.built_at)) : null,
      u.previous ? h('dt', null, 'نسخه‌ی قبلی') : null, u.previous ? h('dd', { class: 'ltr' }, verText(u.previous)) : null)];

    if (!u.installed) {
      rows.push(h('div', { class: 'hint' }, 'سرویس به‌روزرسانی روی سرور فعال نیست. برای فعال کردن، یک بار روی سرور این دستور را اجرا کنید:'),
        h('div', { class: 'code-tag ltr', style: { display: 'block', padding: '8px' } }, 'make updater-install'));
    } else {
      if (working) rows.push(h('div', { class: 'banner info' }, h('div', { class: 'spinner', style: { width: '18px', height: '18px' } }),
        h('span', { class: 'grow' }, (st?.state === 'running' && UPDATE_STEPS[st.step]) || note || 'در حال انجام…')));
      else if (st && st.action !== 'check') rows.push(h('div', { class: `banner ${st.state === 'done' ? 'info' : 'attn'}` },
        h('span', { class: 'grow' }, `${st.action === 'rollback' ? 'بازگشت به نسخه‌ی قبلی' : 'به‌روزرسانی'}: ${UPDATE_STEPS[st.step] || (st.state === 'done' ? 'انجام شد.' : 'ناموفق بود.')}`,
          st.finished_at ? h('div', { class: 'muted small' }, fmtDateTime(st.finished_at)) : null,
          st.state !== 'done' && st.detail ? h('div', { class: 'muted small ltr' }, st.detail) : null)));

      rows.push(u.available
        ? h('div', null, h('b', null, `نسخه‌ی جدید آماده است: `), h('span', { class: 'ltr' }, verText(u.available)),
          h('div', { class: 'muted small' }, `${fa(u.available.behind)} تغییر جدید${u.available.subject ? ' • ' + u.available.subject : ''}`))
        : h('div', { class: 'muted small' }, `نسخه‌ی جدیدی پیدا نشد.${u.checked_at ? ' آخرین بررسی: ' + fmtDateTime(u.checked_at) : ''}`));

      rows.push(h('div', { class: 'row wrap', style: { gap: '8px' } },
        u.available ? h('button', { class: 'btn grow', type: 'button', disabled: working, onClick: () => send('update', {
          title: 'به‌روزرسانی برنامه',
          message: `نسخه‌ی ${verText(u.available)} نصب می‌شود. قبل از آن از پایگاه داده پشتیبان گرفته می‌شود. برنامه چند دقیقه در دسترس نخواهد بود؛ اگر نسخه‌ی جدید بالا نیاید، نسخه‌ی فعلی خودکار برمی‌گردد.`,
          confirmText: 'به‌روزرسانی',
        }) }, icon('download'), 'به‌روزرسانی') : null,
        h('button', { class: 'btn secondary grow', type: 'button', disabled: working, onClick: () => send('check') }, 'بررسی نسخه جدید'),
        u.previous ? h('button', { class: 'btn secondary grow', type: 'button', disabled: working, onClick: () => send('rollback', {
          title: 'بازگشت به نسخه‌ی قبلی',
          message: `برنامه به نسخه‌ی ${verText(u.previous)} برمی‌گردد. اطلاعات (قطعات، اسناد، موجودی) دست نمی‌خورد. برنامه چند دقیقه در دسترس نخواهد بود.`,
          confirmText: 'بازگشت', danger: true,
        }) }, 'بازگشت به نسخه‌ی قبلی') : null));
      rows.push(h('div', { class: 'hint' }, 'هنگام به‌روزرسانی کسی سند ثبت نکند. این بخش آزمایشی است؛ روش مطمئن همیشه اجرای دستی روی سرور است.'));
    }
    box.replaceChildren(...rows.filter(Boolean));
    return working;
  }

  async function refresh() {
    if (stopped) return;
    try {
      const s = await api.get('/api/update', { noAuthRedirect: true });
      if (started && s.current.commit && s.current.commit !== started) { location.reload(); return; }
      const working = draw(s);
      if (!working) started = null;
      schedule(working ? 3000 : 30000);
    } catch (e) {
      if (started) {
        // the container is being replaced: the server is away for a moment
        box.replaceChildren(h('div', { class: 'banner info' }, h('div', { class: 'spinner', style: { width: '18px', height: '18px' } }),
          h('span', { class: 'grow' }, 'برنامه در حال راه‌اندازی مجدد است…')));
        schedule(3000);
      } else if (e.status === 401) {
        stopped = true;
      } else {
        box.replaceChildren(h('div', { class: 'err-text' }, e.message));
        schedule(15000);
      }
    }
  }
  refresh();
  return { card, stop: () => { stopped = true; clearTimeout(timer); } };
}

export async function settingsView() {
  const { settings: s } = await api.get('/api/settings');

  const approvalOut = h('input', { type: 'checkbox', checked: s.approval_required_out, style: { width: '22px', height: '22px' } });
  const approvalIn = h('input', { type: 'checkbox', checked: s.approval_required_in, style: { width: '22px', height: '22px' } });
  const checkStock = h('input', { type: 'checkbox', checked: s.check_stock !== false, style: { width: '22px', height: '22px' } });
  const countBlind = h('input', { type: 'checkbox', checked: s.count_blind !== false, style: { width: '22px', height: '22px' } });
  const company = h('input', { class: 'input', value: s.company_name, maxlength: 100 });
  const whText = h('textarea', { class: 'input code', rows: 4, style: { direction: 'ltr' } },
    s.sepidar_warehouses.map((w) => `${w.code} ${w.title}`).join('\n'));
  const mainWh = h('select', { class: 'input' },
    ...s.sepidar_warehouses.map((w) => h('option', { value: w.code, selected: w.code === s.sepidar_main_warehouse }, `${w.title} (${w.code})`)));

  const err = h('div', { class: 'err-text' });
  const update = updateCard();
  const backup = backupCard();
  const body = h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('h2', null, 'گردش تایید'),
      h('label', { class: 'row', style: { gap: '12px' } }, approvalOut, h('span', null, 'خروج‌های ثبت‌شده توسط انباردار نیاز به تایید مدیر دارد')),
      h('label', { class: 'row', style: { gap: '12px' } }, approvalIn, h('span', null, 'ورودی‌های ثبت‌شده توسط انباردار هم نیاز به تایید مدیر دارد')),
      h('div', { class: 'hint' }, 'اسنادی که خود مدیر ثبت می‌کند بدون نیاز به تایید دوم اعمال می‌شوند (و با نام او در تاریخچه می‌مانند).')),
    h('div', { class: 'card stack' },
      h('h2', null, 'کنترل موجودی'),
      h('label', { class: 'row', style: { gap: '12px' } }, checkStock, h('span', null, 'هنگام خروج، اگر تعداد از موجودی انبار بیشتر بود خطا داده شود')),
      h('div', { class: 'hint' }, 'اگر خاموش باشد، ثبت خروج بیش از موجودی هم ممکن است و موجودی قطعه می‌تواند منفی شود.')),
    h('div', { class: 'card stack' },
      h('h2', null, 'انبارگردانی'),
      h('label', { class: 'row', style: { gap: '12px' } }, countBlind, h('span', null, 'شمارش کور: هنگام شمارش، موجودی سامانه به انباردار نشان داده نشود')),
      h('div', { class: 'hint' }, 'با روشن بودن این گزینه انباردار فقط عدد روی قفسه را وارد می‌کند و اختلاف‌ها را فقط مدیر می‌بیند.')),
    h('div', { class: 'card stack' }, h('h2', null, 'اطلاعات عمومی'), field('نام شرکت', company)),
    h('div', { class: 'card stack' },
      h('h2', null, 'انبارها'),
      field('فهرست انبارها (هر خط: کد، فاصله، عنوان)', whText, 'برای «انتقال بین انبار» و ضایعات (کد 1004) و فایل بارکد سپیدار استفاده می‌شود.'),
      field('انبار این سامانه (مبدأ ورود و خروج)', mainWh, 'پس از تغییر فهرست، ذخیره کنید و صفحه را دوباره باز کنید.')),
    backup.card,
    update.card,
    err,
    h('button', { class: 'btn block', onClick: async () => {
      err.textContent = '';
      try {
        await api.put('/api/settings', {
          approval_required_out: approvalOut.checked, approval_required_in: approvalIn.checked, check_stock: checkStock.checked, count_blind: countBlind.checked, ...backup.values(),
          company_name: company.value,
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
  return { title: 'تنظیمات', back: '/more', body, cleanup: update.stop };
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
