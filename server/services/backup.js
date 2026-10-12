import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, DATA_DIR, getSettings, setSetting, audit } from '../db.js';
import { HttpError } from '../auth.js';

// Automatic daily backup. The app snapshots its own database into <data>/backups once a day (after `backup_hour`),
// verifies the copy and keeps the newest `backup_keep` files. Nothing has to be installed on the server.
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const NAME_RE = /^warehouse-(\d{8})-(\d{4})\.db$/;
const CHECK_EVERY_MS = 10 * 60_000;

const p2 = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;

export function backupConfig() {
  const s = getSettings();
  const keep = Number(s.backup_keep);
  const hour = Number(s.backup_hour);
  return {
    enabled: s.backup_enabled !== false,
    keep: Number.isInteger(keep) && keep >= 3 && keep <= 90 ? keep : 14,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 2,
  };
}

export function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)); } catch { /* no folder yet */ }
  return names.sort().reverse().map((name) => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, size: st.size, at: st.mtime.toISOString() };
  });
}

/** A copy is only kept if SQLite says it is intact and it really contains the data. */
function verify(file) {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const ok = copy.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('integrity_check failed');
    return {
      items: copy.prepare('SELECT COUNT(*) AS c FROM items').get().c,
      documents: copy.prepare('SELECT COUNT(*) AS c FROM documents').get().c,
    };
  } finally { copy.close(); }
}

export function runBackup(user = null, reason = 'manual') {
  const d = new Date();
  const name = `warehouse-${dayStamp(d)}-${p2(d.getHours())}${p2(d.getMinutes())}.db`;
  const target = path.join(BACKUP_DIR, name);
  const { keep } = backupConfig();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.rmSync(target, { force: true }); // a second backup in the same minute replaces the first
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const counts = verify(target);
    const size = fs.statSync(target).size;
    for (const old of listBackups().slice(keep)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });
    const last = { ok: true, at: d.toISOString(), file: name, size, reason, ...counts };
    setSetting('backup_last', last);
    audit(user, 'backup.create', 'backup', name, { reason, size, ...counts });
    return last;
  } catch (e) {
    fs.rmSync(target, { force: true });
    const last = { ok: false, at: d.toISOString(), file: name, reason, error: String(e.message || e).slice(0, 200) };
    setSetting('backup_last', last);
    audit(user, 'backup.failed', 'backup', name, { reason, error: last.error });
    console.error('Backup failed:', last.error);
    return last;
  }
}

export function backupState() {
  const files = listBackups();
  return { ...backupConfig(), last: getSettings().backup_last ?? null, files: files.slice(0, 30), total: files.length };
}

export function backupFile(name) {
  if (!NAME_RE.test(String(name))) throw new HttpError(400, 'نام فایل نامعتبر است.');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'فایل پشتیبان پیدا نشد.');
  return file;
}

/** Is today's backup due? (after the configured hour, and none made today yet — also catches up after downtime) */
export function backupDue(now = new Date()) {
  const { enabled, hour } = backupConfig();
  if (!enabled || now.getHours() < hour) return false;
  const today = dayStamp(now);
  return !listBackups().some((f) => f.name.slice(10, 18) === today);
}

let timer = null;
export function startBackupSchedule() {
  if (timer) return;
  const tick = () => { try { if (backupDue()) runBackup(null, 'daily'); } catch (e) { console.error('Backup schedule error:', e.message); } };
  timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
  setTimeout(tick, 90_000).unref(); // shortly after start, so a restart never skips a day
}
