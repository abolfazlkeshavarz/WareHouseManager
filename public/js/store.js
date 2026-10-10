import { api } from './api.js';

/** Shared client state. Views read from here; refresh* functions re-fetch from the server. */
export const store = {
  user: null,
  meta: null,
  items: [],
  itemsById: new Map(),
  pending: 0,
  installPrompt: null,
  listeners: new Set(),
};

export const isAdmin = () => store.user?.role === 'admin';

export function onStoreChange(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}
const emit = () => store.listeners.forEach((fn) => fn());

export async function loadMeta() {
  store.meta = await api.get('/api/meta');
}

export async function refreshItems() {
  const { items } = await api.get('/api/items');
  store.items = items;
  store.itemsById = new Map(items.map((i) => [i.id, i]));
  emit();
  return items;
}

export async function refreshPending() {
  try {
    const s = await api.get('/api/summary', { noAuthRedirect: true });
    store.pending = s.pending;
    emit();
    return s;
  } catch {
    return null;
  }
}

/** Replaces a single item in the cache (after a stock-changing action). */
export function patchItem(item) {
  const i = store.items.findIndex((x) => x.id === item.id);
  if (i >= 0) store.items[i] = item; else store.items.push(item);
  store.itemsById.set(item.id, item);
  emit();
}

export function reasonLabel(key) {
  return store.meta?.reasons?.[key]?.label ?? key;
}
export function statusLabel(key) {
  return store.meta?.statuses?.[key] ?? key;
}
