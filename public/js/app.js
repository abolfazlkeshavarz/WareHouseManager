import { api, ApiError, setUnauthorizedHandler } from './api.js';
import { store, isAdmin, loadMeta, refreshItems, refreshPending, onStoreChange } from './store.js';
import { h, icon, fa, toast, spinner, $ } from './ui.js';
import { loginView, forcePasswordView } from './views/login.js';
import { homeView } from './views/home.js';
import { scanView } from './views/scan.js';
import { itemsView, itemDetailView, itemFormView } from './views/items.js';
import { docsView, docDetailView } from './views/docs.js';
import { reportsView } from './views/reports.js';
import { moreView, accountView } from './views/more.js';
import { usersView, workersView, settingsView, auditView } from './views/admin.js';
import { labelsView, importView } from './views/labels.js';

const app = document.getElementById('app');

// [pattern, view, adminOnly]
const ROUTES = [
  ['/', homeView],
  ['/scan', scanView],
  ['/items', itemsView],
  ['/items/new', itemFormView, true],
  ['/items/:id', itemDetailView],
  ['/items/:id/edit', itemFormView, true],
  ['/docs', docsView],
  ['/docs/:id', docDetailView],
  ['/reports', reportsView, true],
  ['/more', moreView],
  ['/account', accountView],
  ['/users', usersView, true],
  ['/workers', workersView, true],
  ['/settings', settingsView, true],
  ['/audit', auditView, true],
  ['/labels', labelsView, true],
  ['/import', importView, true],
];

function matchRoute(path) {
  for (const [pattern, view, adminOnly] of ROUTES) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = re.exec(path);
    if (m) return { view, adminOnly, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', '#' + path);
  else location.hash = path;
  if (replace) render();
}

// ---------- shell ----------
function navConfig() {
  const admin = isAdmin();
  return [
    { path: '/', label: 'خانه', ic: 'home', exact: true },
    { path: '/items', label: 'قطعات', ic: 'box' },
    { path: '/scan', label: 'اسکن', ic: 'scan', scan: true },
    { path: '/docs', label: admin ? 'درخواست‌ها' : 'اسناد', ic: 'file', badge: admin ? store.pending : 0 },
    { path: '/more', label: 'بیشتر', ic: 'menu' },
  ];
}

const SIDE_EXTRA = [
  { path: '/reports', label: 'گزارش‌ها و خروجی', ic: 'chart' },
  { path: '/labels', label: 'چاپ برچسب QR', ic: 'qr' },
  { path: '/users', label: 'کاربران', ic: 'users' },
  { path: '/workers', label: 'کارگران', ic: 'user' },
  { path: '/settings', label: 'تنظیمات', ic: 'sliders' },
  { path: '/audit', label: 'گزارش ممیزی', ic: 'shield' },
];

function isActive(item, path) {
  if (item.exact) return path === item.path;
  if (item.path === '/more') return ['/more', '/account', '/users', '/workers', '/settings', '/audit', '/labels', '/import', '/reports'].includes(path);
  return path === item.path || path.startsWith(item.path + '/');
}

function navLink(item, path) {
  const a = h('a', { href: '#' + item.path, class: `navitem ${item.scan ? 'scan' : ''} ${isActive(item, path) ? 'active' : ''}` },
    item.scan ? h('span', { class: 'fab' }, icon(item.ic)) : icon(item.ic),
    h('span', null, item.label),
    item.badge ? h('span', { class: 'badge' }, fa(item.badge)) : null);
  return a;
}

function shell() {
  const topbar = h('header', { class: 'topbar', id: 'topbar' });
  const content = h('main', { class: 'content', id: 'content' });
  const side = h('aside', { class: 'sidebar', id: 'sidebar' });
  const bottom = h('nav', { class: 'bottomnav', id: 'bottomnav', 'aria-label': 'ناوبری اصلی' });
  app.replaceChildren(h('div', { class: 'shell' }, side, h('div', { class: 'main' }, topbar, content), bottom));
}

function renderNav(path) {
  const nav = navConfig();
  const bottom = $('#bottomnav');
  const side = $('#sidebar');
  if (!bottom || !side) return;
  bottom.replaceChildren(...nav.map((n) => navLink(n, path)));
  const extras = isAdmin() ? SIDE_EXTRA.map((n) => navLink(n, path)) : [];
  side.replaceChildren(...[
    h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '' }), h('span', null, 'انبار قطعات')),
    ...nav.filter((n) => n.path !== '/more').map((n) => navLink({ ...n, scan: false }, path)),
    extras.length ? h('div', { class: 'sep' }) : null,
    ...extras,
    h('div', { class: 'user' },
      h('div', { style: { fontWeight: 700 } }, store.user.display_name),
      h('div', { class: 'muted small' }, store.meta?.roles?.[store.user.role] ?? ''),
      h('a', { href: '#/account', class: 'small' }, 'حساب کاربری')),
  ].filter(Boolean));
}

let renderToken = 0;
let cleanup = null;

async function render() {
  if (!store.user) return;
  const token = ++renderToken;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const { path, query } = parseHash();
  const route = matchRoute(path);
  if (!$('#content')) shell();
  const content = $('#content');
  const topbar = $('#topbar');
  renderNav(path);

  if (!route) { navigate('/', { replace: true }); return; }
  if (route.adminOnly && !isAdmin()) { toast('این بخش فقط برای مدیر سیستم است.', 'err'); navigate('/', { replace: true }); return; }

  content.replaceChildren(spinner());
  try {
    const result = await route.view({ params: route.params, query, path });
    if (token !== renderToken) { result.cleanup?.(); return; } // a newer navigation won
    cleanup = result.cleanup || null;
    topbar.replaceChildren(...[
      result.back ? h('a', { class: 'btn ghost icon', href: '#' + (result.back === true ? '/' : result.back), 'aria-label': 'بازگشت', onClick: result.back === true ? (e) => { e.preventDefault(); history.back(); } : null }, icon('back')) : null,
      h('h1', null, result.title || 'انبار قطعات'),
      ...(result.actions || []),
    ].filter(Boolean));
    content.replaceChildren(result.body);
    window.scrollTo(0, 0);
    document.title = (result.title ? result.title + ' · ' : '') + 'انبار قطعات';
    result.onMount?.();
  } catch (e) {
    if (token !== renderToken) return;
    if (e instanceof ApiError && e.status === 401) return;
    content.replaceChildren(h('div', { class: 'empty' }, icon('alert'), h('div', null, e.message || 'خطا در بارگذاری'),
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn secondary', onClick: render }, 'تلاش دوباره'))));
    topbar.replaceChildren(h('h1', null, 'خطا'));
  }
}

// ---------- session ----------
async function startSession(user) {
  store.user = user;
  if (user.must_change_password) {
    app.replaceChildren(forcePasswordView(async () => {
      store.user = { ...store.user, must_change_password: false };
      await startSession(store.user);
    }));
    return;
  }
  try {
    await Promise.all([loadMeta(), refreshItems(), refreshPending()]);
  } catch (e) {
    toast(e.message, 'err');
  }
  shell();
  if (!location.hash || location.hash === '#/login') location.hash = '/';
  render();
}

function showLogin() {
  store.user = null;
  renderToken++;
  app.replaceChildren(loginView(async (user) => { await startSession(user); }));
}

setUnauthorizedHandler(() => {
  if (store.user) { toast('نشست شما پایان یافت. دوباره وارد شوید.', 'err'); showLogin(); }
});

export async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
  showLogin();
}

window.addEventListener('hashchange', render);
onStoreChange(() => { if (store.user && $('#bottomnav')) renderNav(parseHash().path); });

// refresh pending-count badge while the app is open
setInterval(() => { if (store.user && !document.hidden) refreshPending(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.user) refreshPending(); });

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); store.installPrompt = e; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---------- boot ----------
(async function boot() {
  app.replaceChildren(spinner());
  try {
    const { user } = await api.get('/api/auth/me', { noAuthRedirect: true });
    if (user) await startSession(user); else showLogin();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card center' },
      h('p', null, e.message), h('button', { class: 'btn', onClick: () => location.reload() }, 'تلاش دوباره'))));
  }
})();
