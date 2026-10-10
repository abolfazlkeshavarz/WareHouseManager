// Jalali (Persian/Solar Hijri) calendar helpers. Shared by the server (exports, filters) and the browser.
// Algorithm: jalaali-js (MIT), re-implemented compactly.

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => Math.trunc(a / b);
const mod = (a, n) => a - Math.floor(a / n) * n;

function jalCal(jy, withoutLeap) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14, jp = BREAKS[0], jm, jump = 0;
  if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error('Invalid Jalali year ' + jy);
  for (let i = 1; i < bl; i++) {
    jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (withoutLeap) return { gy, march };
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j += div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy, jm, jd) {
  const r = jalCal(jy, true);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn) {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy, false);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function toJalali(gy, gm, gd) { return d2j(g2d(gy, gm, gd)); }
export function toGregorian(jy, jm, jd) { const r = d2g(j2d(jy, jm, jd)); return { gy: r.gy, gm: r.gm, gd: r.gd }; }
export function isJalaliLeap(jy) { return jalCal(jy, false).leap === 0; }
export function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeap(jy) ? 30 : 29;
}

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

const TEHRAN = 'Asia/Tehran';
const tehranParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TEHRAN, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Wall-clock parts in Tehran for a Date / ISO string. */
export function tehranClock(input) {
  const d = input instanceof Date ? input : new Date(input);
  const o = {};
  for (const p of tehranParts.formatToParts(d)) o[p.type] = p.value;
  return { gy: +o.year, gm: +o.month, gd: +o.day, hh: +o.hour, mi: +o.minute, ss: +o.second };
}

const p2 = (n) => String(n).padStart(2, '0');

/** "1405/07/18" (Latin digits) for a Date / ISO string, Tehran time. */
export function jalaliDate(input) {
  if (!input) return '';
  const c = tehranClock(input);
  const j = toJalali(c.gy, c.gm, c.gd);
  return `${j.jy}/${p2(j.jm)}/${p2(j.jd)}`;
}

/** "14:35" Tehran time. */
export function clockTime(input) {
  if (!input) return '';
  const c = tehranClock(input);
  return `${p2(c.hh)}:${p2(c.mi)}`;
}

export function jalaliDateTime(input) {
  if (!input) return '';
  return `${jalaliDate(input)} ${clockTime(input)}`;
}

/** Today's Jalali date as {jy,jm,jd}. */
export function todayJalali(now = new Date()) {
  const c = tehranClock(now);
  return toJalali(c.gy, c.gm, c.gd);
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Convert Persian / Arabic-Indic digits to Latin digits (and the Persian decimal/thousand marks). */
export function latinDigits(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

/** Parse "1405/7/18" (any digits, "/" or "-" separators) → {jy,jm,jd} or null. */
export function parseJalali(text) {
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(latinDigits(text).trim());
  if (!m) return null;
  const jy = +m[1], jm = +m[2], jd = +m[3];
  if (jm < 1 || jm > 12 || jd < 1 || jd > jalaliMonthLength(jy, jm)) return null;
  return { jy, jm, jd };
}

/**
 * Start (00:00) of a Jalali day in Tehran, as a UTC ISO string. Iran has had no DST since 2022,
 * but we resolve the offset from Intl so historical dates stay right too.
 */
export function jalaliDayStartISO(j) {
  const g = toGregorian(j.jy, j.jm, j.jd);
  const guess = Date.UTC(g.gy, g.gm - 1, g.gd, 0, 0, 0);
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const c = tehranClock(new Date(ms));
    const shown = Date.UTC(c.gy, c.gm - 1, c.gd, c.hh, c.mi, c.ss);
    ms += guess - shown;
  }
  return new Date(ms).toISOString();
}

/** End-exclusive boundary: start of the day after j. */
export function jalaliDayEndISO(j) {
  const g = toGregorian(j.jy, j.jm, j.jd);
  const next = new Date(Date.UTC(g.gy, g.gm - 1, g.gd + 1));
  const jn = toJalali(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return jalaliDayStartISO(jn);
}
