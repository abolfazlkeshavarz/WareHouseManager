import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR, nowISO, audit } from '../db.js';
import { HttpError } from '../auth.js';

// Which version is running, and the mailbox used to ask the HOST to update / roll back.
//
// The app runs in a container and cannot rebuild itself, so it only writes a request file into the data volume.
// scripts/updater.sh (a small service on the host) picks it up, does the git/docker work and reports back:
//   <data>/updater/request.json   app  -> host   { id, action: check | update | rollback, by, at }
//   <data>/updater/host.json      host -> app    heartbeat, commit, previous version, what is available
//   <data>/updater/status.json    host -> app    progress / result of the last action
const DIR = path.join(DATA_DIR, 'updater');
const HEARTBEAT_MAX_AGE_MS = 120_000;
const RUNNING_MAX_AGE_MS = 30 * 60_000;
const ACTIONS = new Set(['check', 'update', 'rollback']);

let cached = null;
export function versionInfo() {
  if (cached) return cached;
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* keep default */ }
  let commit = (process.env.APP_COMMIT || '').trim();
  if (!commit || commit === 'unknown') {
    // not built as an image (npm start): read the checked-out commit straight from .git
    try {
      const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
      const full = head.startsWith('ref: ') ? fs.readFileSync(path.join(ROOT, '.git', head.slice(5)), 'utf8').trim() : head;
      commit = full.slice(0, 7);
    } catch { commit = ''; }
  }
  cached = { version, commit, built_at: (process.env.APP_BUILT_AT || '').trim() };
  return cached;
}

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); } catch { return null; }
}

export function updateState() {
  const host = readJson('host.json');
  const status = readJson('status.json');
  const age = host?.heartbeat ? Date.now() - Date.parse(host.heartbeat) : Infinity;
  const installed = Number.isFinite(age) && age < HEARTBEAT_MAX_AGE_MS;
  const running = status?.state === 'running' && Date.now() - Date.parse(status.started_at || 0) < RUNNING_MAX_AGE_MS;
  return {
    current: versionInfo(),
    updater: {
      installed,
      branch: host?.branch ?? '',
      previous: host?.previous ?? null,     // { commit, version } the app can go back to
      available: host?.available ?? null,   // { behind, commit, version, subject, date } or null when up to date
      checked_at: host?.checked_at ?? null,
    },
    status: status ? { ...status, state: status.state === 'running' && !running ? 'failed' : status.state } : null,
    pending: fs.existsSync(path.join(DIR, 'request.json')),
    busy: running,
  };
}

export function requestUpdate(admin, action) {
  if (!ACTIONS.has(action)) throw new HttpError(400, 'درخواست نامعتبر است.');
  const s = updateState();
  if (!s.updater.installed) throw new HttpError(409, 'سرویس به‌روزرسانی روی سرور نصب یا فعال نیست.', { code: 'updater_missing' });
  if (s.busy || s.pending) throw new HttpError(409, 'یک عملیات به‌روزرسانی در حال انجام است. کمی صبر کنید.');
  if (action === 'rollback' && !s.updater.previous?.commit) throw new HttpError(409, 'نسخه‌ی قبلی برای بازگشت ثبت نشده است.');
  if (action === 'update' && !s.updater.available) throw new HttpError(409, 'نسخه‌ی جدیدی برای نصب پیدا نشد. ابتدا «بررسی نسخه جدید» را بزنید.');
  const req = { id: crypto.randomBytes(6).toString('hex'), action, by: admin.username, at: nowISO() };
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, 'request.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(req));
  fs.renameSync(tmp, path.join(DIR, 'request.json'));
  if (action !== 'check') audit(admin, `app.${action}`, 'app', '', { from: s.current, to: action === 'update' ? s.updater.available : s.updater.previous });
  return req;
}
