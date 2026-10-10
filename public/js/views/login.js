import { api } from '../api.js';
import { h, icon, toast } from '../ui.js';

function logoBlock(title, subtitle) {
  return [
    h('img', { class: 'logo', src: '/icons/icon-192.png', alt: '' }),
    h('h1', null, title),
    h('p', null, subtitle),
  ];
}

export function loginView(onSuccess) {
  const user = h('input', { class: 'input code', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'mokhtar' });
  const pass = h('input', { class: 'input code', name: 'password', type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
  const err = h('div', { class: 'err-text', role: 'alert' });
  const btn = h('button', { class: 'btn block', type: 'submit' }, 'ورود');

  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true;
    try {
      const { user: u } = await api.post('/api/auth/login', { username: user.value.trim(), password: pass.value }, { noAuthRedirect: true });
      await onSuccess(u);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  } },
  h('div', { class: 'field' }, h('label', null, 'نام کاربری'), user),
  h('div', { class: 'field' }, h('label', null, 'گذرواژه'), pass),
  err, btn);

  return h('div', { class: 'auth' }, h('div', { class: 'card' }, ...logoBlock('انبار قطعات', 'برای ادامه وارد حساب خود شوید'), form));
}

/** Shown right after login with a temporary password: the user must choose their own before anything else. */
export function forcePasswordView(onDone) {
  const cur = h('input', { class: 'input code', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input code', type: 'password', autocomplete: 'new-password' });
  const again = h('input', { class: 'input code', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'err-text', role: 'alert' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (next.value !== again.value) { err.textContent = 'تکرار گذرواژه یکسان نیست.'; return; }
    try {
      await api.post('/api/auth/password', { current: cur.value, next: next.value });
      toast('گذرواژه با موفقیت تغییر کرد.', 'ok');
      onDone();
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('div', { class: 'banner info' }, icon('info'), 'برای امنیت، قبل از شروع کار گذرواژه موقت خود را تغییر دهید.'),
  h('div', { class: 'field' }, h('label', null, 'گذرواژه فعلی (موقت)'), cur),
  h('div', { class: 'field' }, h('label', null, 'گذرواژه جدید (حداقل ۸ نویسه)'), next),
  h('div', { class: 'field' }, h('label', null, 'تکرار گذرواژه جدید'), again),
  err, h('button', { class: 'btn block', type: 'submit' }, 'ذخیره و ادامه'));
  return h('div', { class: 'auth' }, h('div', { class: 'card' }, ...logoBlock('تغییر گذرواژه', ''), form));
}
