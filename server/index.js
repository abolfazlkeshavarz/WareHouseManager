import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { db, ROOT, DATA_DIR, UPLOAD_DIR, seedUsersIfEmpty, seedItemsIfEmpty } from './db.js';
import { sessionMiddleware, csrfGuard, requirePasswordChanged, requireAuth, HttpError } from './auth.js';
import { api } from './routes.js';
import { versionInfo } from './services/updater.js';
import { startBackupSchedule, listBackups } from './services/backup.js';

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ---- first-run data ----
const creds = seedUsersIfEmpty();
const imported = seedItemsIfEmpty();
if (creds) {
  const lines = [
    '=== حساب‌های اولیه (فقط یک‌بار نمایش داده می‌شود) ===',
    ...creds.map((c) => `${c.role === 'admin' ? 'مدیر ' : 'انباردار'}  ${c.username}  /  ${c.password}   (${c.display_name})`),
    'در اولین ورود، تغییر گذرواژه اجباری است.',
  ];
  console.log('\n' + lines.join('\n') + '\n');
  try { fs.writeFileSync(path.join(DATA_DIR, 'FIRST-RUN-PASSWORDS.txt'), lines.join('\n') + '\n', 'utf8'); } catch { /* ignore */ }
}
if (imported) console.log(`${imported} قطعه از فایل اولیه وارد شد (موجودی همه صفر است؛ موجودی اولیه را از بخش «قطعات» ثبت کنید).`);

// ---- app ----
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

// liveness/readiness probe for Docker, nginx and scripts/health.sh (no auth, no data)
app.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', ...versionInfo(), last_backup_at: listBackups()[0]?.at ?? null });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use('/api', sessionMiddleware, csrfGuard, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', requirePasswordChanged, api);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'مسیر پیدا نشد.')));

// uploaded part photos (logged-in users only)
app.use('/uploads', sessionMiddleware, requireAuth, express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));

const pub = path.join(ROOT, 'public');
app.use(express.static(pub, {
  etag: true,
  setHeaders(res, file) {
    if (/\.(html|webmanifest)$/.test(file) || file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
// SPA fallback (hash routing is used, but keep deep links harmless)
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'حجم فایل بیش از حد مجاز است.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'درخواست نامعتبر است.' });
  console.error(err);
  res.status(500).json({ error: 'خطای داخلی سرور.' });
});

// ---- listen (HTTPS when a cert is configured: phone cameras require a secure context) ----
let server;
const pfx = process.env.SSL_PFX;
const key = process.env.SSL_KEY;
const cert = process.env.SSL_CERT;
if (pfx) {
  server = https.createServer({ pfx: fs.readFileSync(pfx), passphrase: process.env.SSL_PASSPHRASE || '' }, app);
} else if (key && cert) {
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, app);
} else {
  server = http.createServer(app);
}
server.listen(PORT, HOST, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`Warehouse app listening on ${proto}://localhost:${PORT}`);
  startBackupSchedule();
});

export { app, server };
