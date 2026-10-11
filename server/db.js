import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from './constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'warehouse.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','storekeeper')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  sepidar_code TEXT,
  part_no TEXT,
  name TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  material TEXT NOT NULL DEFAULT '',
  weight_g REAL,
  unit TEXT NOT NULL DEFAULT 'عدد',
  location TEXT NOT NULL DEFAULT '',
  min_stock INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image TEXT,
  note TEXT NOT NULL DEFAULT '',
  row_no INTEGER,
  qr_token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- A document groups one or more lines moved together (e.g. everything a worker takes in one go).
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no INTEGER UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  reason TEXT NOT NULL,
  worker_id INTEGER REFERENCES workers(id),
  worker_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  client_ref TEXT UNIQUE,
  sepidar_batch_id INTEGER REFERENCES sepidar_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

CREATE TABLE IF NOT EXISTS document_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  note TEXT NOT NULL DEFAULT '',
  stock_before INTEGER,
  stock_after INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON document_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_lines_item ON document_lines(item_id);

CREATE TABLE IF NOT EXISTS sepidar_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  doc_count INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  from_at TEXT,
  to_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only trail of everything that is not a stock movement (logins, edits, exports...).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`);

// migrations for databases created by older versions
try { db.exec('ALTER TABLE sepidar_batches ADD COLUMN group_key TEXT'); } catch { /* column already exists */ }
try { db.exec('ALTER TABLE sepidar_batches ADD COLUMN party TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE sepidar_batches ADD COLUMN doc_no INTEGER'); } catch { /* exists */ }
try { db.exec('ALTER TABLE sepidar_batches ADD COLUMN doc_date TEXT'); } catch { /* exists */ }
try { db.exec("ALTER TABLE documents ADD COLUMN dest_warehouse TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }

// Stock history must never be rewritten: block UPDATE/DELETE of audit rows at the DB level.
db.exec(`
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS lines_no_delete BEFORE DELETE ON document_lines BEGIN SELECT RAISE(ABORT, 'document lines are append-only'); END;
CREATE TRIGGER IF NOT EXISTS docs_no_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'documents are append-only'); END;
`);

export const nowISO = () => new Date().toISOString();

/** Run fn inside a transaction; rolls back on throw. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- settings ----------
export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt row */ }
  }
  return out;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- audit ----------
export function audit(user, action, entity = '', entityId = '', detail = '') {
  db.prepare('INSERT INTO audit_log(at,user_id,username,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?,?)')
    .run(nowISO(), user?.id ?? null, user?.username ?? '', action, entity, String(entityId ?? ''),
      typeof detail === 'string' ? detail : JSON.stringify(detail));
}

// ---------- passwords ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- QR tokens ----------
// Upper-case + digits only (no look-alikes) so the QR code stays in the compact alphanumeric mode.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newQrToken() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}
export const QR_PREFIX = 'WH:';

// ---------- first-run seed ----------
function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(10)) s += alphabet[b % alphabet.length];
  return s;
}

/** Creates the two admins + one storekeeper on an empty database. Returns the generated credentials. */
export function seedUsersIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return null;
  const defs = [
    { username: 'mokhtar', display_name: 'مختار', role: 'admin' },
    { username: 'sattar', display_name: 'ستار', role: 'admin' },
    { username: 'anbardar', display_name: 'انباردار', role: 'storekeeper' },
  ];
  const creds = [];
  const ins = db.prepare('INSERT INTO users(username,display_name,role,password_hash,must_change_password,created_at) VALUES(?,?,?,?,1,?)');
  for (const d of defs) {
    const pw = randomPassword();
    ins.run(d.username, d.display_name, d.role, hashPassword(pw), nowISO());
    creds.push({ ...d, password: pw });
  }
  audit(null, 'system.seed_users', 'users', '', 'initial users created');
  return creds;
}

/** Loads the customer's parts list (from the Word file) on an empty items table. Stock starts at 0. */
export function seedItemsIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM items').get();
  if (c > 0) return 0;
  const file = path.join(here, 'seed', 'parts.json');
  if (!fs.existsSync(file)) return 0;
  const parts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ins = db.prepare(`INSERT INTO items(code,sepidar_code,part_no,name,variant,material,weight_g,image,note,row_no,qr_token,created_at,updated_at)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const t = nowISO();
  tx(() => {
    for (const p of parts) {
      ins.run(p.code, p.code, p.part_no, p.name, p.variant || '', p.material || '', p.weight_g ?? null,
        p.image || null, p.note || '', p.row_no ?? null, newQrToken(), t, t);
    }
    audit(null, 'system.seed_items', 'items', '', `${parts.length} items imported from the original parts list`);
  });
  return parts.length;
}
