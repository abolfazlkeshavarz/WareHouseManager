import { api } from '../api.js';
import { store, isAdmin, refreshItems } from '../store.js';
import { h, icon, fa, faId, toast, itemTitle, codeTag, thumb, emptyState, latinDigits, confirmDialog } from '../ui.js';
import { QrScanner, cameraSupport, feedback } from '../scanner.js';
import { navigate } from '../app.js';

const CART_KEY = 'wh_cart_v1';
const HIDDEN_REASONS = new Set(['adjust_in', 'adjust_out']);

const newRef = () => (crypto.randomUUID?.() ?? `r${Date.now()}${Math.random().toString(16).slice(2)}`);

function emptyCart(direction = 'out') {
  return { direction, reason: direction === 'out' ? 'to_worker' : 'return_from_worker', worker_name: '', dest_warehouse: '', note: '', lines: [], client_ref: newRef(), user_id: store.user.id };
}

function loadCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    if (c && c.user_id === store.user.id && Array.isArray(c.lines)) return c;
  } catch { /* ignore */ }
  return emptyCart();
}

function saveCart(cart) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* storage may be blocked */ }
}

export async function scanView({ query }) {
  let cart = loadCart();
  if (query.mode && ['in', 'out'].includes(query.mode) && query.mode !== cart.direction && !cart.lines.length) cart = emptyCart(query.mode);
  else if (query.mode && query.mode !== cart.direction && cart.lines.length) {
    // keep the in-progress document; the user can switch manually
  }

  // coming from «مانده نزد کارگران»: start a delivery / return for that worker (only when no document is in progress)
  if (query.worker && !cart.lines.length) {
    if (['in', 'out'].includes(query.mode)) cart = emptyCart(query.mode);
    cart.worker_name = String(query.worker).slice(0, 80);
    saveCart(cart);
  }

  let workers = [];
  try { workers = (await api.get('/api/workers')).workers.filter((w) => w.active); } catch { /* optional */ }

  const root = h('div', { class: 'stack' });
  let scanner = null;
  let flashId = null;
  let busy = false;

  const persist = () => saveCart(cart);

  // ---- cart operations ----
  function addItem(item, qty = 1) {
    const line = cart.lines.find((l) => l.item_id === item.id);
    if (line) line.qty += qty;
    else cart.lines.unshift({ item_id: item.id, qty, note: '' });
    flashId = item.id;
    persist();
    renderCart();
    renderBar();
  }

  async function handleCode(text) {
    const raw = String(text).trim();
    if (!raw) return;
    let item = null;
    if (raw.toUpperCase().startsWith(store.meta.qr_prefix)) {
      const token = raw.slice(store.meta.qr_prefix.length).toUpperCase();
      item = store.items.find((i) => i.qr_token === token);
    } else {
      const code = latinDigits(raw);
      item = store.items.find((i) => i.code === code || i.sepidar_code === code);
    }
    if (!item) {
      try { item = (await api.get('/api/items/lookup?code=' + encodeURIComponent(raw))).item; } catch (e) {
        feedback(false);
        toast(e.message, 'err');
        return;
      }
    }
    feedback(true);
    addItem(item, 1);
    toast(`${itemTitle(item)} افزوده شد`, 'ok');
    const frame = root.querySelector('.frame');
    if (frame) { frame.classList.add('hit'); setTimeout(() => frame.classList.remove('hit'), 500); }
  }

  // ---- header: mode + reason + worker ----
  const modeBox = h('div');
  const metaBox = h('div', { class: 'stack' });

  function reasonsFor(direction) {
    return Object.entries(store.meta.reasons)
      .filter(([k, v]) => v.direction === direction && !HIDDEN_REASONS.has(k) && (isAdmin() || k !== 'opening'));
  }

  function setDirection(direction) {
    if (cart.direction === direction) return;
    cart.direction = direction;
    cart.reason = reasonsFor(direction)[0][0];
    persist();
    renderHeader();
    renderCart();
    renderBar();
  }

  function renderHeader() {
    modeBox.replaceChildren(h('div', { class: 'segmented', role: 'tablist' },
      h('button', { class: `out ${cart.direction === 'out' ? 'active' : ''}`, onClick: () => setDirection('out') }, icon('outbox'), 'خروج از انبار'),
      h('button', { class: `in ${cart.direction === 'in' ? 'active' : ''}`, onClick: () => setDirection('in') }, icon('inbox'), 'ورود به انبار')));

    const sel = h('select', { class: 'input', onChange: (e) => { cart.reason = e.target.value; persist(); renderHeader(); } },
      ...reasonsFor(cart.direction).map(([k, v]) => h('option', { value: k, selected: k === cart.reason }, v.label)));
    const parts = [h('div', { class: 'field' }, h('label', null, 'علت'), sel)];
    const needsWorker = ['to_worker', 'return_from_worker'].includes(cart.reason);
    if (needsWorker) {
      const listId = 'workers-list';
      const w = h('input', { class: 'input', list: listId, placeholder: 'نام کارگر', value: cart.worker_name, maxlength: 80, autocomplete: 'off',
        onInput: (e) => { cart.worker_name = e.target.value; persist(); } });
      parts.push(h('div', { class: 'field' },
        h('label', null, cart.reason === 'to_worker' ? 'تحویل‌گیرنده (کارگر) *' : 'بازگرداننده (کارگر)'),
        w, h('datalist', { id: listId }, ...workers.map((x) => h('option', { value: x.name })))));
    }
    const rdef = store.meta.reasons[cart.reason];
    if (rdef?.needs_dest) {
      const others = store.meta.warehouses.filter((w) => w.code !== store.meta.main_warehouse);
      if (!others.some((w) => w.code === cart.dest_warehouse)) cart.dest_warehouse = others[0]?.code ?? '';
      persist();
      parts.push(h('div', { class: 'field' }, h('label', null, 'انبار مقصد *'),
        h('select', { class: 'input', onChange: (e) => { cart.dest_warehouse = e.target.value; persist(); } },
          ...others.map((w) => h('option', { value: w.code, selected: w.code === cart.dest_warehouse }, `${w.title} (${w.code})`)))));
    } else if (rdef?.dest_default) {
      const w = store.meta.warehouses.find((x) => x.code === rdef.dest_default);
      parts.push(h('div', { class: 'hint' }, `به صورت خودکار به «${w ? w.title : rdef.dest_default}» منتقل می‌شود.`));
    }
    metaBox.replaceChildren(...parts);
    metaBox.className = parts.length > 1 ? 'form-grid two' : 'stack';
  }

  // ---- camera ----
  const camBox = h('div', { class: 'camera' });
  const video = h('video', { muted: true, playsinline: true, autoplay: true });
  let torchOn = false;

  function camMessage(text, withButton = true) {
    camBox.replaceChildren(h('div', { class: 'cam-msg' },
      h('div', { style: { marginBottom: '10px' } }, icon('camera', 36)),
      h('div', { style: { marginBottom: '12px' } }, text),
      withButton ? h('button', { class: 'btn', onClick: startCamera }, 'روشن کردن دوربین') : null));
  }

  async function startCamera() {
    const sup = cameraSupport();
    if (!sup.ok) {
      camMessage(sup.reason === 'insecure'
        ? 'دوربین فقط در اتصال امن (HTTPS) کار می‌کند. فعلاً کد قطعه را دستی وارد کنید یا سامانه را با آدرس https باز کنید.'
        : 'این مرورگر دسترسی به دوربین را پشتیبانی نمی‌کند. کد را دستی وارد کنید.', false);
      return;
    }
    try {
      scanner?.stop();
      scanner = new QrScanner(video, (t) => { handleCode(t); });
      await scanner.start();
      const actions = h('div', { class: 'cam-actions' });
      if (scanner.torchSupported) {
        actions.append(h('button', { class: 'btn sm cam-btn', onClick: async () => { torchOn = !torchOn; try { await scanner.setTorch(torchOn); } catch { torchOn = false; } } }, icon('flash'), 'چراغ'));
      }
      camBox.replaceChildren(video, h('div', { class: 'frame' }), actions);
    } catch (e) {
      const msg = {
        NotAllowedError: 'دسترسی به دوربین مجاز نیست. در تنظیمات مرورگر اجازه دوربین را بدهید و دوباره تلاش کنید.',
        SecurityError: 'دسترسی به دوربین مجاز نیست. در تنظیمات مرورگر اجازه دوربین را بدهید و دوباره تلاش کنید.',
        NotFoundError: 'دوربینی روی این دستگاه پیدا نشد. کد قطعه را دستی وارد کنید.',
        NotReadableError: 'دوربین توسط برنامه دیگری استفاده می‌شود. آن را ببندید و دوباره تلاش کنید.',
      }[e?.name] || 'دوربین باز نشد. دوباره تلاش کنید یا کد را دستی وارد کنید.';
      camMessage(msg);
    }
  }

  function stopCamera() { scanner?.stop(); scanner = null; }
  camMessage('برای اسکن QR قطعه، دوربین را روشن کنید.');

  // ---- manual entry ----
  const manual = h('input', { class: 'input code', placeholder: 'کد قطعه (مثلاً 30700)', inputmode: 'text', autocomplete: 'off', enterkeyhint: 'done',
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitManual(); } } });
  const suggestions = h('div', { class: 'list' });
  function submitManual() {
    const v = manual.value.trim();
    if (!v) return;
    manual.value = '';
    suggestions.replaceChildren();
    handleCode(v);
  }
  manual.addEventListener('input', () => {
    const q = latinDigits(manual.value).trim().toLowerCase();
    suggestions.replaceChildren();
    if (q.length < 2) return;
    const hits = store.items.filter((i) => i.code.startsWith(q) || itemTitle(i).toLowerCase().includes(q)).slice(0, 5);
    for (const i of hits) {
      suggestions.append(h('button', { class: 'card item-card', style: { textAlign: 'start', width: '100%' }, onClick: () => {
        manual.value = ''; suggestions.replaceChildren(); feedback(true); addItem(i, 1);
      } }, thumb(i.image), h('div', { class: 'grow' }, h('div', { class: 'name' }, itemTitle(i)), h('div', { class: 'codeline' }, codeTag(i.code))),
      h('div', { class: 'stock' }, h('b', null, fa(i.stock)), h('span', null, i.unit))));
    }
  });

  // ---- cart ----
  const cartBox = h('div', { class: 'list' });
  const noteBox = h('div');
  const barBox = h('div');

  function lineView(l) {
    const it = store.itemsById.get(l.item_id);
    if (!it) return null;
    const isOver = () => store.meta.check_stock !== false && cart.direction === 'out' && l.qty > it.stock;
    const errBox = h('div', { class: 'err-text' }, 'تعداد از موجودی انبار بیشتر است.');
    // Updated in place: re-rendering the list here would replace the buttons under the finger and swallow the tap
    // (e.g. typing a count and then tapping «حذف» right away).
    const sync = () => {
      const over = isOver();
      card.classList.toggle('bad', over);
      errBox.hidden = !over;
      if (qtyInput.value !== String(l.qty)) qtyInput.value = String(l.qty);
      persist(); renderBar();
    };
    const qtyInput = h('input', { class: 'input num', inputmode: 'numeric', value: String(l.qty), 'aria-label': 'تعداد',
      onFocus: (e) => e.target.select(),
      onChange: (e) => {
        const n = parseInt(latinDigits(e.target.value), 10);
        l.qty = Number.isFinite(n) && n > 0 ? n : 1;
        sync();
      } });
    const step = (d) => { l.qty = Math.max(1, l.qty + d); sync(); };
    const noteInput = h('input', { class: 'input', placeholder: 'توضیح این ردیف (اختیاری)', value: l.note, maxlength: 300,
      onInput: (e) => { l.note = e.target.value; persist(); } });
    const card = h('div', { class: `card cart-line ${isOver() ? 'bad' : ''} ${flashId === l.item_id ? 'flash' : ''}` },
      thumb(it.image),
      h('div', { class: 'grow' },
        h('div', { class: 'name', style: { fontWeight: 700 } }, itemTitle(it)),
        h('div', { class: 'codeline' }, codeTag(it.code), h('span', null, `موجودی: ${fa(it.stock)} ${it.unit}`)),
        errBox),
      h('div', { class: 'ctrl' },
        h('div', { class: 'qty-stepper' },
          h('button', { class: 'btn secondary', type: 'button', onClick: () => step(-1), 'aria-label': 'کم کردن' }, icon('minus')),
          qtyInput,
          h('button', { class: 'btn secondary', type: 'button', onClick: () => step(1), 'aria-label': 'زیاد کردن' }, icon('plus'))),
        h('div', { class: 'grow' }, noteInput),
        h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'حذف', onClick: () => {
          cart.lines = cart.lines.filter((x) => x !== l); persist();
          if (cart.lines.length) card.remove(); else renderCart();
          renderBar();
        } }, icon('trash'))),
    );
    errBox.hidden = !isOver();
    return card;
  }

  function renderCart() {
    const nodes = cart.lines.map(lineView).filter(Boolean);
    cartBox.replaceChildren(...(nodes.length ? nodes : [emptyState('قطعه‌ای اسکن نشده است. QR قطعه را اسکن کنید یا کد را وارد کنید.', 'qr')]));
    flashId = null;
    if (!cart.lines.length) noteBox.replaceChildren();
    else if (!noteBox.firstChild) {
      noteBox.replaceChildren(h('div', { class: 'field' }, h('label', null, 'توضیح سند (اختیاری)'),
        h('textarea', { class: 'input', placeholder: 'مثلاً: شیفت صبح - خط مونتاژ ۲', maxlength: 500, onInput: (e) => { cart.note = e.target.value; persist(); } }, cart.note)));
    }
  }

  function totals() {
    return { lines: cart.lines.length, qty: cart.lines.reduce((s, l) => s + l.qty, 0) };
  }

  function needsApproval() {
    return !isAdmin() && (cart.direction === 'out' ? store.meta.approval_required_out : store.meta.approval_required_in);
  }

  let bar = null;
  function renderBar() {
    const t = totals();
    if (!t.lines) { barBox.replaceChildren(); bar = null; return; }
    if (!bar) {
      bar = {
        lines: h('b', { class: 'num' }),
        qty: h('div', { class: 'muted small num' }),
        btn: h('button', { class: 'btn', type: 'button', onClick: submit }),
      };
      barBox.replaceChildren(h('div', { class: 'sticky-bar' },
        h('div', { class: 'grow' }, bar.lines, bar.qty),
        h('button', { class: 'btn ghost', type: 'button', onClick: async () => {
          if (await confirmDialog({ title: 'پاک کردن فهرست', message: 'همه قطعات این سند حذف شوند؟', confirmText: 'پاک کن', danger: true })) {
            cart = emptyCart(cart.direction); persist(); renderHeader(); renderCart(); renderBar();
          }
        } }, 'پاک کردن'),
        bar.btn));
    }
    bar.lines.textContent = `${fa(t.lines)} قلم`;
    bar.qty.textContent = `جمع تعداد: ${fa(t.qty)}`;
    bar.btn.textContent = needsApproval() ? 'ارسال برای تایید مدیر' : (cart.direction === 'out' ? 'ثبت خروج' : 'ثبت ورود');
    bar.btn.className = `btn ${cart.direction}`;
    bar.btn.disabled = busy;
  }

  async function submit() {
    if (busy) return;
    if (cart.reason === 'to_worker' && !cart.worker_name.trim()) { toast('نام کارگر تحویل‌گیرنده را وارد کنید.', 'err'); return; }
    busy = true; renderBar();
    try {
      const { document: doc, duplicate } = await api.post('/api/documents', {
        direction: cart.direction, reason: cart.reason, worker_name: cart.worker_name, dest_warehouse: cart.dest_warehouse, note: cart.note,
        client_ref: cart.client_ref, lines: cart.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, note: l.note })),
      });
      cart = emptyCart(cart.direction);
      persist();
      stopCamera();
      await refreshItems();
      toast(doc.status === 'pending'
        ? `درخواست ${faId(doc.doc_no)} ثبت شد و منتظر تایید مدیر است.`
        : `سند ${faId(doc.doc_no)} ثبت و موجودی به‌روز شد.${duplicate ? ' (قبلاً ثبت شده بود)' : ''}`, 'ok');
      navigate(`/docs/${doc.id}`);
    } catch (e) {
      toast(e.message, 'err');
      if (e.data?.code === 'insufficient_stock') await refreshItems().then(() => { renderCart(); });
    } finally {
      busy = false; renderBar();
    }
  }

  // ---- assemble ----
  renderHeader();
  root.append(
    modeBox, metaBox, camBox,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, manual),
      h('button', { class: 'btn soft', onClick: submitManual }, icon('plus'), 'افزودن')),
    suggestions, cartBox, noteBox, barBox);
  renderCart();
  renderBar();

  // preselect an item coming from the item page
  if (query.item) {
    const it = store.itemsById.get(Number(query.item));
    if (it && !cart.lines.some((l) => l.item_id === it.id)) { cart.lines.unshift({ item_id: it.id, qty: 1, note: '' }); persist(); renderCart(); renderBar(); }
  }

  const onHide = () => { if (document.hidden) stopCamera(); };
  document.addEventListener('visibilitychange', onHide);

  return {
    title: 'اسکن و ثبت',
    body: root,
    onMount: () => { if (cameraSupport().ok) startCamera(); },
    cleanup: () => { stopCamera(); document.removeEventListener('visibilitychange', onHide); },
  };
}
