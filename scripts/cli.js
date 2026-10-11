// Admin command line for the deployed app (works inside the container too).
//
//   node scripts/cli.js list-users
//   node scripts/cli.js create-admin <username> "<display name>"
//   node scripts/cli.js reset-password <username>
//   node scripts/cli.js stats
//
// In production:  make prod-shell CMD="reset-password mokhtar"
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, hashPassword, nowISO, audit } from '../server/db.js';
import { recodeItems } from '../server/services/items.js';

const [cmd, ...args] = process.argv.slice(2);

function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

function usage() {
  console.log(`Usage:
  list-users
  create-admin <username> "<display name>"
  reset-password <username>
  stats
  apply-sepidar-codes   rename our items to the codes they have in Sepidar (server/seed/sepidar-code-map.json)
  recode <old-code> <new-code>`);
}

switch (cmd) {
  case 'list-users': {
    const rows = db.prepare('SELECT username, display_name, role, active, must_change_password, last_login_at FROM users ORDER BY role, id').all();
    for (const u of rows) {
      console.log(`${u.username.padEnd(16)} ${u.role.padEnd(12)} ${u.active ? 'active  ' : 'DISABLED'} ${u.must_change_password ? '(temp password) ' : ''}${u.display_name}  last login: ${u.last_login_at ?? '-'}`);
    }
    break;
  }
  case 'create-admin': {
    const [username, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username ?? '') || !name) { usage(); process.exit(1); }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { console.error('That username already exists.'); process.exit(1); }
    const pw = randomPassword();
    db.prepare('INSERT INTO users(username,display_name,role,password_hash,must_change_password,created_at) VALUES(?,?,?,?,1,?)')
      .run(username, name, 'admin', hashPassword(pw), nowISO());
    audit(null, 'cli.create_admin', 'user', username);
    console.log(`Created admin "${username}". Temporary password (must be changed at first login):\n${pw}`);
    break;
  }
  case 'reset-password': {
    const [username] = args;
    const u = username && db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!u) { console.error('No such user.'); process.exit(1); }
    const pw = randomPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE id = ?').run(hashPassword(pw), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(null, 'cli.reset_password', 'user', username);
    console.log(`New temporary password for "${username}" (must be changed at first login):\n${pw}`);
    break;
  }
  case 'apply-sepidar-codes':
  case 'recode': {
    let map;
    if (cmd === 'recode') {
      if (args.length !== 2) { usage(); process.exit(1); }
      map = { [args[0]]: args[1] };
    } else {
      const file = new URL('../server/seed/sepidar-code-map.json', import.meta.url);
      map = JSON.parse(fs.readFileSync(file, 'utf8')).map;
    }
    const r = recodeItems(null, map);
    for (const c of r.changed) console.log(`renamed  ${c.from} -> ${c.to}   ${c.name}`);
    for (const k of r.skipped) console.log(`skipped  ${k.from} -> ${k.to}   ${k.reason}`);
    if (!r.changed.length && !r.skipped.length) console.log('nothing to do');
    break;
  }
  case 'stats': {
    const n = (sql) => db.prepare(sql).get().c;
    console.log(`items:     ${n('SELECT COUNT(*) AS c FROM items')} (${n('SELECT COUNT(*) AS c FROM items WHERE active = 1')} active)`);
    console.log(`users:     ${n('SELECT COUNT(*) AS c FROM users')}`);
    console.log(`documents: ${n('SELECT COUNT(*) AS c FROM documents')} (${n("SELECT COUNT(*) AS c FROM documents WHERE status = 'pending'")} pending)`);
    console.log(`lines:     ${n('SELECT COUNT(*) AS c FROM document_lines')}`);
    console.log(`audit:     ${n('SELECT COUNT(*) AS c FROM audit_log')}`);
    break;
  }
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
