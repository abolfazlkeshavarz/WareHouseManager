import { api } from '../api.js';
import { store, isAdmin, refreshItems } from '../store.js';
import {
  h, icon, fa, faId, fmtDateTime, itemTitle, thumb, codeTag, emptyState, toast, openSheet, confirmDialog, promptDialog, latinDigits,
} from '../ui.js';
import { navigate } from '../app.js';
import { QrScanner, cameraSupport, feedback } from '../scanner.js';

const STATUS = {
  open: ['در حال شمارش', 'warn'],
  submitted: ['منتظر بررسی مدیر', 'primary'],
  applied: ['اعمال شده', 'in'],
  cancelled: ['لغو شده', ''],
};
const statusChip = (s) => h('span', { class: `chip ${STATUS[s]?.[1] ?? ''}` }, STATUS[s]?.[0] ?? s);
const countName = (c) => (c.title ? c.title : `شمارش ${faId(c.id)}`);

// ---------------- list ----------------
export async function countsView() {
  const { counts } = await api.get('/api/counts');
  const running = counts.find((c) => ['open', 'submitted'].includes(c.status));
  const body = h('div', { class: 'stack' });

  if (running) {
    body.append(h('a', { class: 'btn block', href: `#/counts/${running.id}` }, icon('scan'),
      running.status === 'open' ? 'ادامه‌ی شمارش' : 'مشاهده‌ی شمارش ارسال‌شده'));
  } else {
    body.append(h('button', { class: 'btn block', type: 'button', onClick: async () => {
      const title = await promptDialog({
        title: 'شروع انبارگردانی', label: 'عنوان (اختیاری)', placeholder: 'مثلاً: شمارش پایان ماه', confirmText: 'شروع شمارش',
        multiline: false, required: false,
        hint: 'قطعه‌ها را یکی‌یکی اسکن و تعداد روی قفسه را وارد کنید. موجودی تا وقتی مدیر تایید نکند تغییر نمی‌کند.',
      });
      if (title === null || title === undefined) return;
      try {
        const r = await api.post('/api/counts', { title });
        navigate(`/counts/${r.id}`);
      } catch (e) { toast(e.message, 'err'); }
    } }, icon('plus'), 'شروع شمارش جدید'));
  }

  body.append(h('div', { class: 'section-title' }, 'شمارش‌های قبلی'));
  const past = counts.filter((c) => c !== running);
  body.append(past.length ? h('div', { class: 'list' }, ...past.map((c) => h('a', { class: 'card item-card', href: `#/counts/${c.id}`, style: { color: 'inherit' } },
    h('div', { class: 'grow' },
      h('div', { class: 'row wrap', style: { gap: '6px' } }, h('b', null, countName(c)), statusChip(c.status)),
      h('div', { class: 'muted small' }, `${c.created_by_name} • ${fmtDateTime(c.created_at)}`),
      c.result ? h('div', { class: 'muted small num' }, `${fa(c.result.changed)} اصلاح از ${fa(c.result.counted)} قطعه`) : null),
    h('div', { class: 'stock' }, h('b', null, fa(c.counted_items)), h('span', null, 'شمرده')))))
    : emptyState('هنوز انبارگردانی انجام نشده است.', 'box'));
  return { title: 'انبارگردانی', back: '/more', body };
}

// ---------------- one count ----------------
export async function countDetailView({ params }) {
  const id = Number(params.id);
  let data = await api.get(`/api/counts/${id}`);
  const admin = isAdmin();
  const root = h('div', { class: 'stack' });
  let scanner = null;
  let asking = false;

  const reload = async () => { data = await api.get(`/api/counts/${id}`); draw(); };
  const act = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); await reload(); } catch (e) { toast(e.message, 'err'); }
  };

  // ---- asking for the counted number ----
  async function askCount(item) {
    if (asking) return;
    asking = true;
    const prev = data.lines.find((l) => l.item_id === item.id);
    const value = await openSheet((close) => {
      const input = h('input', { class: 'input num', inputmode: 'numeric', placeholder: 'تعداد روی قفسه', value: prev ? String(prev.counted) : '',
        style: { fontSize: '26px', fontWeight: 800, textAlign: 'center', minHeight: '64px' },
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } } });
      const err = h('div', { class: 'err-text' });
      const submit = () => {
        const n = Number(latinDigits(input.value).trim());
        if (input.value.trim() === '' || !Number.isInteger(n) || n < 0) { err.textContent = 'تعداد را به صورت عدد صحیح وارد کنید (صفر هم مجاز است).'; return; }
        close(n);
      };
      setTimeout(() => { input.focus(); input.select(); }, 60);
      return h('div', { class: 'stack' },
        h('div', { class: 'row', style: { gap: '12px' } }, thumb(item.image),
          h('div', { class: 'grow' }, h('b', null, itemTitle(item)),
            h('div', { class: 'codeline' }, codeTag(item.code), item.location ? h('span', null, item.location) : null))),
        prev ? h('div', { class: 'hint' }, `قبلاً ${fa(prev.counted)} ثبت شده است؛ عدد جدید جایگزین می‌شود.`) : null,
        data.shows_expected && prev?.expected !== undefined ? h('div', { class: 'muted small num' }, `موجودی سامانه: ${fa(prev.expected)}`) : null,
        input, err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn secondary', type: 'button', onClick: () => close(null) }, 'انصراف'),
          h('button', { class: 'btn', type: 'button', onClick: submit }, 'ثبت تعداد')));
    });
    asking = false;
    if (value === null || value === undefined) return;
    await act(() => api.post(`/api/counts/${id}/lines`, { item_id: item.id, counted: value }), `${itemTitle(item)}: ${fa(value)} ثبت شد`);
  }

  async function handleCode(text) {
    const raw = String(text).trim();
    if (!raw || asking) return;
    let item = null;
    if (raw.toUpperCase().startsWith(store.meta.qr_prefix)) {
      const token = raw.slice(store.meta.qr_prefix.length).toUpperCase();
      item = store.items.find((i) => i.qr_token === token);
    } else {
      const code = latinDigits(raw);
      item = store.items.find((i) => i.code === code || i.sepidar_code === code);
    }
    if (!item) {
      try { item = (await api.get('/api/items/lookup?code=' + encodeURIComponent(raw))).item; } catch (e) { feedback(false); toast(e.message, 'err'); return; }
    }
    feedback(true);
    askCount(item);
  }

  // ---- camera + manual entry (only while the count is open) ----
  const camBox = h('div', { class: 'camera' });
  const video = h('video', { muted: true, playsinline: true, autoplay: true });
  function camMessage(text, withButton = true) {
    camBox.replaceChildren(h('div', { class: 'cam-msg' },
      h('div', { style: { marginBottom: '10px' } }, icon('camera', 36)),
      h('div', { style: { marginBottom: '12px' } }, text),
      withButton ? h('button', { class: 'btn', type: 'button', onClick: startCamera }, 'روشن کردن دوربین') : null));
  }
  async function startCamera() {
    const sup = cameraSupport();
    if (!sup.ok) { camMessage('دوربین در این اتصال در دسترس نیست. کد قطعه را دستی وارد کنید.', false); return; }
    try {
      scanner?.stop();
      scanner = new QrScanner(video, (t) => { handleCode(t); });
      await scanner.start();
      camBox.replaceChildren(video, h('div', { class: 'frame' }));
    } catch { camMessage('دوربین باز نشد. دوباره تلاش کنید یا کد را دستی وارد کنید.'); }
  }
  const stopCamera = () => { scanner?.stop(); scanner = null; };
  camMessage('برای اسکن QR قطعه، دوربین را روشن کنید.');

  const manual = h('input', { class: 'input code', placeholder: 'کد یا نام قطعه', autocomplete: 'off', enterkeyhint: 'done',
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = manual.value.trim(); if (v) { manual.value = ''; suggestions.replaceChildren(); handleCode(v); } } } });
  const suggestions = h('div', { class: 'list' });
  manual.addEventListener('input', () => {
    const q = latinDigits(manual.value).trim().toLowerCase();
    suggestions.replaceChildren();
    if (q.length < 2) return;
    for (const i of store.items.filter((x) => x.code.startsWith(q) || itemTitle(x).toLowerCase().includes(q)).slice(0, 5)) {
      suggestions.append(h('button', { class: 'card item-card', type: 'button', style: { textAlign: 'start', width: '100%' }, onClick: () => {
        manual.value = ''; suggestions.replaceChildren(); askCount(i);
      } }, thumb(i.image), h('div', { class: 'grow' }, h('div', { class: 'name' }, itemTitle(i)), h('div', { class: 'codeline' }, codeTag(i.code)))));
    }
  });

  const dynamic = h('div', { class: 'stack' });

  function progressCard() {
    const total = data.total_items;
    const done = data.lines.length;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return h('div', { class: 'card stack', style: { gap: '8px' } },
      h('div', { class: 'row' }, h('b', { class: 'grow num' }, `${fa(done)} از ${fa(total)} قطعه شمرده شد`), statusChip(data.count.status)),
      h('div', { style: { height: '10px', borderRadius: '6px', background: 'var(--border)', overflow: 'hidden' } },
        h('div', { style: { width: `${pct}%`, height: '100%', background: 'var(--primary)' } })));
  }

  function lineCard(l, editable) {
    const item = { id: l.item_id, code: l.code, name: l.name, variant: l.variant, image: l.image, location: l.location };
    const hasDiff = l.diff !== undefined && l.diff !== 0;
    return h('div', { class: 'card item-card' },
      thumb(l.image),
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, itemTitle(l)),
        h('div', { class: 'codeline' }, codeTag(l.code), h('span', null, l.counted_by_name)),
        l.diff !== undefined
          ? h('div', { class: 'small num', style: { marginTop: '2px' } }, `سامانه ${fa(l.expected)} ← شمارش ${fa(l.counted)}`,
            hasDiff ? h('span', { class: `chip ${l.diff > 0 ? 'in' : 'out'}`, style: { marginInlineStart: '8px' } },
              h('span', { class: 'ltr' }, `${l.diff > 0 ? '+' : '−'}${fa(Math.abs(l.diff))}`)) : null)
          : null),
      h('div', { class: 'stock' }, h('b', null, fa(l.counted)), h('span', null, l.unit)),
      editable ? h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'ویرایش', onClick: () => askCount(item) }, icon('edit')) : null,
      editable ? h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'حذف', onClick: async () => {
        if (await confirmDialog({ title: 'حذف از شمارش', message: `شمارش «${itemTitle(l)}» حذف شود؟`, confirmText: 'حذف', danger: true })) {
          act(() => api.post(`/api/counts/${id}/lines/${l.item_id}/delete`));
        }
      } }, icon('trash')) : null);
  }

  function draw() {
    const c = data.count;
    const open = c.status === 'open';
    const active = open || c.status === 'submitted';
    const parts = [progressCard()];

    if (c.status === 'submitted' && !admin) {
      parts.push(h('div', { class: 'banner info' }, icon('clock'), h('span', { class: 'grow' }, 'شمارش برای مدیر ارسال شد. پس از بررسی، موجودی اصلاح می‌شود.')));
    }
    if (c.status === 'applied' && c.result) {
      parts.push(h('div', { class: 'card stack', style: { gap: '6px' } },
        h('h2', null, 'نتیجه'),
        h('div', { class: 'num' }, `${fa(c.result.changed)} قطعه اصلاح شد، ${fa(c.result.same)} قطعه بدون اختلاف بود.`),
        h('div', { class: 'muted small num' }, `جمع افزایش: ${fa(c.result.plus_qty)} • جمع کاهش: ${fa(c.result.minus_qty)}`),
        h('div', { class: 'muted small' }, `${c.decided_by_name || ''} • ${fmtDateTime(c.decided_at)}`),
        admin ? h('div', { class: 'row wrap', style: { gap: '8px' } }, ...c.result.docs.map((d) => h('a', { class: 'btn sm secondary', href: `#/docs/${d}` }, 'سند اصلاح'))) : null));
    }

    // review: differences first
    if (data.shows_expected && data.lines.length) {
      const diffs = data.lines.filter((l) => l.diff !== 0).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const same = data.lines.length - diffs.length;
      parts.push(h('div', { class: 'section-title' }, `اختلاف‌ها (${fa(diffs.length)})`));
      parts.push(diffs.length ? h('div', { class: 'list' }, ...diffs.map((l) => lineCard(l, open)))
        : emptyState('شمارش با موجودی سامانه یکی است.', 'box'));
      if (same) {
        parts.push(h('details', null, h('summary', { class: 'section-title', style: { cursor: 'pointer' } }, `بدون اختلاف (${fa(same)})`),
          h('div', { class: 'list' }, ...data.lines.filter((l) => l.diff === 0).map((l) => lineCard(l, open)))));
      }
    } else if (data.lines.length) {
      parts.push(h('div', { class: 'section-title' }, `شمرده‌شده‌ها (${fa(data.lines.length)})`));
      parts.push(h('div', { class: 'list' }, ...data.lines.map((l) => lineCard(l, open))));
    } else if (open) {
      parts.push(emptyState('هنوز قطعه‌ای شمرده نشده است. QR قطعه را اسکن کنید یا کد را وارد کنید.', 'qr'));
    }

    if (active && data.uncounted.length) {
      parts.push(h('details', null,
        h('summary', { class: 'section-title', style: { cursor: 'pointer' } }, `هنوز شمرده نشده (${fa(data.uncounted.length)})`),
        h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'قطعه‌هایی که شمرده نشوند تغییری نمی‌کنند.'),
        h('div', { class: 'list' }, ...data.uncounted.slice(0, 300).map((u) => h('button', {
          class: 'card item-card', type: 'button', style: { textAlign: 'start', width: '100%' }, disabled: !open,
          onClick: () => askCount({ id: u.item_id, ...u }),
        }, thumb(u.image), h('div', { class: 'grow' }, h('div', { class: 'name' }, itemTitle(u)),
          h('div', { class: 'codeline' }, codeTag(u.code), u.location ? h('span', null, u.location) : null)))))));
    }

    // actions
    const bar = h('div', { class: 'stack' });
    if (open && !admin && data.lines.length) {
      bar.append(h('button', { class: 'btn block', type: 'button', onClick: async () => {
        if (await confirmDialog({ title: 'پایان شمارش', message: `${fa(data.lines.length)} قطعه شمرده شده است. برای بررسی مدیر ارسال شود؟ بعد از ارسال قابل تغییر نیست.`, confirmText: 'ارسال برای مدیر' })) {
          stopCamera();
          act(() => api.post(`/api/counts/${id}/submit`), 'شمارش برای مدیر ارسال شد.');
        }
      } }, icon('check'), 'پایان شمارش و ارسال برای مدیر'));
    }
    if (active && admin && data.lines.length) {
      const diffs = data.lines.filter((l) => l.diff !== 0).length;
      bar.append(h('button', { class: 'btn in block', type: 'button', onClick: async () => {
        if (await confirmDialog({
          title: 'اعمال انبارگردانی',
          message: `موجودی ${fa(diffs)} قطعه به عدد شمارش‌شده تغییر می‌کند و سند «اصلاح شمارش» ثبت می‌شود. ${fa(data.uncounted.length)} قطعه‌ی شمرده‌نشده دست نمی‌خورد.`,
          confirmText: 'اعمال اصلاحات',
        })) {
          stopCamera();
          await act(() => api.post(`/api/counts/${id}/apply`), 'انبارگردانی اعمال شد.');
          refreshItems();
        }
      } }, icon('check'), `تایید و اعمال (${fa(diffs)} اصلاح)`));
    }
    if (c.status === 'submitted' && admin) {
      bar.append(h('button', { class: 'btn secondary block', type: 'button', onClick: () => act(() => api.post(`/api/counts/${id}/reopen`), 'شمارش برای اصلاح باز شد.') }, 'بازگرداندن برای شمارش مجدد'));
    }
    if (active && (admin || c.created_by === store.user.id)) {
      bar.append(h('button', { class: 'btn ghost block', type: 'button', style: { color: 'var(--danger)' }, onClick: async () => {
        if (await confirmDialog({ title: 'لغو شمارش', message: 'این شمارش لغو شود؟ عددهای ثبت‌شده کنار گذاشته می‌شوند و موجودی تغییری نمی‌کند.', confirmText: 'لغو شمارش', danger: true })) {
          stopCamera();
          act(() => api.post(`/api/counts/${id}/cancel`), 'شمارش لغو شد.');
        }
      } }, 'لغو شمارش'));
    }
    parts.push(bar);

    dynamic.replaceChildren(...parts);
    entry.hidden = !open;
    if (!open) stopCamera();
  }

  const entry = h('div', { class: 'stack' }, camBox, manual, suggestions);
  root.append(entry, dynamic);
  draw();

  const onHide = () => { if (document.hidden) stopCamera(); };
  document.addEventListener('visibilitychange', onHide);
  return {
    title: countName(data.count),
    back: '/counts',
    body: root,
    onMount: () => { if (data.count.status === 'open' && cameraSupport().ok) startCamera(); },
    cleanup: () => { stopCamera(); document.removeEventListener('visibilitychange', onHide); },
  };
}
