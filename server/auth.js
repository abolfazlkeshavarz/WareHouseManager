import crypto from 'node:crypto';
import { db, nowISO, verifyPassword, audit } from './db.js';

const COOKIE = 'wh_sid';
const SESSION_DAYS = 14;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieFlags(req, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function publicUser(u) {
  return u && {
    id: u.id, username: u.username, display_name: u.display_name, role: u.role,
    must_change_password: !!u.must_change_password, active: !!u.active,
    created_at: u.created_at, last_login_at: u.last_login_at,
  };
}

// ---- login throttling (in memory; fine for a single-process app) ----
const attempts = new Map();
const MAX_FAILS = 6;
const LOCK_MS = 5 * 60 * 1000;

function throttleKey(req, username) { return `${req.ip}|${String(username).toLowerCase()}`; }

export function login(req, res, username, password) {
  const key = throttleKey(req, username);
  const rec = attempts.get(key);
  if (rec && rec.count >= MAX_FAILS && Date.now() - rec.last < LOCK_MS) {
    throw new HttpError(429, 'تعداد تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره تلاش کنید.');
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  const ok = user && user.active && verifyPassword(String(password), user.password_hash);
  if (!ok) {
    attempts.set(key, { count: (rec && Date.now() - rec.last < LOCK_MS ? rec.count : 0) + 1, last: Date.now() });
    audit(null, 'auth.login_failed', 'user', '', `username=${String(username).slice(0, 60)}`);
    throw new HttpError(401, 'نام کاربری یا گذرواژه نادرست است.');
  }
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86400e3);
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,user_agent) VALUES(?,?,?,?,?)')
    .run(sha(token), user.id, created.toISOString(), expires.toISOString(), String(req.headers['user-agent'] || '').slice(0, 200));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(created.toISOString(), user.id);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags(req, SESSION_DAYS * 86400)}`);
  audit(user, 'auth.login', 'user', user.id);
  return user;
}

export function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req, 0)}`);
}

export function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function currentToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const token = currentToken(req);
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha(token), nowISO());
    if (row) req.user = row;
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'ابتدا وارد سامانه شوید.'));
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'ابتدا وارد سامانه شوید.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'این عملیات فقط برای مدیر سیستم مجاز است.'));
  next();
}

/** Blocks use of the app (except changing the password) until a temporary password is replaced. */
export function requirePasswordChanged(req, _res, next) {
  if (req.user?.must_change_password && !req.path.startsWith('/auth/')) {
    return next(new HttpError(403, 'ابتدا گذرواژه خود را تغییر دهید.', { code: 'must_change_password' }));
  }
  next();
}

/** Cheap CSRF guard on top of SameSite=Lax: state-changing requests must carry a custom header. */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-wh'] !== '1') return next(new HttpError(403, 'درخواست نامعتبر است.'));
  next();
}
