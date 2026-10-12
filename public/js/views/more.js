import { api } from '../api.js';
import { store, isAdmin } from '../store.js';
import { h, icon, toast, field } from '../ui.js';
import { logout } from '../app.js';

function menuRow(href, ic, title, sub) {
  return h('a', { class: 'card item-card', href, style: { color: 'inherit' } },
    h('div', { class: 'thumb' }, icon(ic)),
    h('div', { class: 'grow' }, h('div', { class: 'name' }, title), sub ? h('div', { class: 'muted small' }, sub) : null),
    icon('chevron'));
}

export async function moreView() {
  const body = h('div', { class: 'stack' });
  body.append(h('div', { class: 'card row' },
    h('div', { class: 'thumb' }, icon('user')),
    h('div', { class: 'grow' }, h('b', null, store.user.display_name), h('div', { class: 'muted small' }, store.meta.roles[store.user.role]))));
  const list = h('div', { class: 'list' });
  if (isAdmin()) {
    list.append(
      menuRow('#/reports', 'chart', 'گزارش‌ها و خروجی', 'تاریخچه حرکات، خروجی کامل و سپیدار'),
      menuRow('#/labels', 'qr', 'چاپ برچسب QR', 'برچسب قطعات را چاپ کنید'),
      menuRow('#/import', 'upload', 'ورود قطعات از اکسل', 'افزودن گروهی قطعات جدید'),
      menuRow('#/users', 'users', 'کاربران', 'مدیر سیستم و انباردار'),
      menuRow('#/workers', 'user', 'کارگران', 'فهرست تحویل‌گیرندگان'),
      menuRow('#/settings', 'sliders', 'تنظیمات', 'تایید درخواست‌ها، سپیدار'),
      menuRow('#/audit', 'shield', 'گزارش ممیزی', 'ثبت تمام تغییرات سامانه'));
  }
  list.prepend(menuRow('#/worker-balance', 'users', 'مانده نزد کارگران', 'هر کارگر چه قطعه‌ای و چند عدد در دست دارد'));
  list.append(menuRow('#/account', 'user', 'حساب کاربری', 'تغییر گذرواژه'));
  body.append(list);
  body.append(h('button', { class: 'btn secondary block', onClick: logout }, icon('logout'), 'خروج از حساب'));
  return { title: 'بیشتر', body };
}

export async function accountView() {
  const cur = h('input', { class: 'input code', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input code', type: 'password', autocomplete: 'new-password' });
  const again = h('input', { class: 'input code', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'err-text', role: 'alert' });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('h2', null, 'مشخصات'),
      h('dl', { class: 'kv' },
        h('dt', null, 'نام'), h('dd', null, store.user.display_name),
        h('dt', null, 'نام کاربری'), h('dd', { class: 'ltr' }, store.user.username),
        h('dt', null, 'نقش'), h('dd', null, store.meta.roles[store.user.role]))),
    h('form', { class: 'card stack', onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (next.value !== again.value) { err.textContent = 'تکرار گذرواژه یکسان نیست.'; return; }
      try {
        await api.post('/api/auth/password', { current: cur.value, next: next.value });
        toast('گذرواژه تغییر کرد.', 'ok');
        cur.value = next.value = again.value = '';
      } catch (ex) { err.textContent = ex.message; }
    } },
    h('h2', null, 'تغییر گذرواژه'),
    field('گذرواژه فعلی', cur), field('گذرواژه جدید (حداقل ۸ نویسه)', next), field('تکرار گذرواژه جدید', again),
    err, h('button', { class: 'btn', type: 'submit' }, 'ذخیره گذرواژه')));

  if (store.installPrompt) {
    body.append(h('button', { class: 'btn soft block', onClick: async () => {
      store.installPrompt.prompt();
      await store.installPrompt.userChoice;
      store.installPrompt = null;
    } }, icon('download'), 'نصب برنامه روی گوشی'));
  }
  body.append(h('button', { class: 'btn secondary block', onClick: logout }, icon('logout'), 'خروج از حساب'));
  return { title: 'حساب کاربری', back: '/more', body };
}
