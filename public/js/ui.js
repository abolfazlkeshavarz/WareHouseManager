// Tiny DOM + UI helpers (no framework). All text goes through textContent, so user data can never inject HTML.
import { jalaliDate, clockTime, latinDigits } from './lib/jalali.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------- numbers & dates ----------
const faNum = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 2 });
export const fa = (n) => (n === null || n === undefined || n === '' ? '' : faNum.format(Number(n)));
/** Persian digits without thousands separators (document numbers, ids). */
export const faId = (n) => (n === null || n === undefined || n === '' ? '' : String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]));
export const faDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
export const fmtDate = (iso) => (iso ? faDigits(jalaliDate(iso)) : '');
export const fmtTime = (iso) => (iso ? faDigits(clockTime(iso)) : '');
export const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)} - ${fmtTime(iso)}` : '');
export { latinDigits };

/** Normalises text for searching: Latin digits, Persian ی/ک, no ZWNJ/diacritics, lower case. */
export function normSearch(s) {
  return latinDigits(String(s ?? ''))
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ۀ/g, 'ه').replace(/[‌‍]/g, ' ')
    .replace(/[ً-ٟ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const itemTitle = (i) => (i.variant ? `${i.name} (${i.variant})` : i.name);

// ---------- icons ----------
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3 M16 4h3a1 1 0 0 1 1 1v3 M20 16v3a1 1 0 0 1-1 1h-3 M8 20H5a1 1 0 0 1-1-1v-3 M7 12h10',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h6',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 13l4 4L19 7',
  x: 'M6 6l12 12 M18 6 6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4',
  printer: 'M7 9V4h10v5 M6 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1 M7 14h10v6H7z',
  download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  upload: 'M12 16V5 M7 9l5-5 5 5 M5 20h14',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20a6.5 6.5 0 0 1 13 0 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14a6 6 0 0 1 3.5 6',
  sliders: 'M4 7h10 M18 7h2 M4 17h2 M10 17h10 M16 4v6 M8 14v6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3 M10 17l-5-5 5-5 M5 12h11',
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  flash: 'M13 2 4 14h7l-1 8 9-12h-7z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  edit: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  back: 'M9 6l6 6-6 6',
  chevron: 'M15 6l-6 6 6 6',
  alert: 'M12 4 2.5 20h19z M12 10v4 M12 17h.01',
  inbox: 'M12 4v11 M7 10l5 5 5-5 M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  outbox: 'M12 20V9 M7 14l5-5 5 5 M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  qr: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h3v3h-3z M20 14v6h-6',
  chart: 'M4 20V4 M4 20h16 M8 16v-5 M12 16V8 M16 16v-8',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  image: 'M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5 M9 9h.01',
  refresh: 'M20 11a8 8 0 0 0-14-4 M4 5v4h4 M4 13a8 8 0 0 0 14 4 M20 19v-4h-4',
  keyboard: 'M3 7h18v10H3z M7 11h.01 M11 11h.01 M15 11h.01 M7 14h10',
  warehouse: 'M3 10l9-6 9 6v10H3z M8 20v-6h8v6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
};

export function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  for (const d of (ICONS[name] || ICONS.box).split(' M').map((p, i) => (i ? 'M' + p : p))) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// ---------- toast ----------
export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  box.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 2600);
}

// ---------- sheet / dialogs ----------
/** Opens a bottom sheet; build(close) returns its content. Resolves when closed. */
export function openSheet(build, { dismissable = true } = {}) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' });
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(undefined); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay && dismissable) close(undefined); });
    append(sheet, [build(close)]);
    overlay.append(sheet);
    document.body.append(overlay);
    const first = sheet.querySelector('input,textarea,select');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  });
}

export function confirmDialog({ title, message, confirmText = 'تایید', cancelText = 'انصراف', danger = false }) {
  return openSheet((close) => h('div', null,
    h('h2', null, title),
    message ? h('p', { class: 'muted', style: { margin: 0 } }, message) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn secondary', onClick: () => close(false) }, cancelText),
      h('button', { class: `btn ${danger ? 'danger' : ''}`, onClick: () => close(true) }, confirmText)),
  )).then((v) => !!v);
}

export function promptDialog({ title, label, placeholder = '', confirmText = 'ثبت', multiline = true, required = true, hint }) {
  return openSheet((close) => {
    const input = h(multiline ? 'textarea' : 'input', { class: 'input', placeholder, maxlength: 300 });
    const err = h('div', { class: 'err-text' });
    const submit = () => {
      const v = input.value.trim();
      if (required && !v) { err.textContent = 'این فیلد الزامی است.'; return; }
      close(v);
    };
    return h('div', { class: 'stack' },
      h('h2', null, title),
      h('div', { class: 'field' }, label ? h('label', null, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null, err),
      h('div', { class: 'actions' },
        h('button', { class: 'btn secondary', onClick: () => close(null) }, 'انصراف'),
        h('button', { class: 'btn', onClick: submit }, confirmText)),
    );
  });
}

// ---------- small components ----------
export function spinner() {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
}

export function emptyState(text, ic = 'inbox') {
  return h('div', { class: 'empty' }, icon(ic), h('div', null, text));
}

export function thumb(src, cls = '') {
  return src
    ? h('img', { class: `thumb ${cls}`, src, alt: '', loading: 'lazy' })
    : h('div', { class: `thumb ${cls}` }, icon('image'));
}

export function codeTag(code) {
  return h('span', { class: 'code-tag' }, code);
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
