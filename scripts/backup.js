// Consistent online backup of the SQLite database (safe while the server is running).
// Usage: node scripts/backup.js [target-folder]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../server/db.js';

const src = process.env.DB_FILE || path.join(DATA_DIR, 'warehouse.db');
const dir = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups'));
fs.mkdirSync(dir, { recursive: true });

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const name = `warehouse-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;
const target = path.join(dir, name);

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log('Backup written:', target);

// keep the newest 30 backups
const files = fs.readdirSync(dir).filter((f) => /^warehouse-\d{8}-\d{4}\.db$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(dir, f));
