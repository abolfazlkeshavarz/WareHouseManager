export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, url, body, opts = {}) {
  const headers = { 'x-wh': '1' };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
    headers['content-type'] = opts.contentType || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'ارتباط با سرور برقرار نشد. اتصال اینترنت/شبکه را بررسی کنید.');
  }
  if (opts.blob && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !opts.noAuthRedirect) onUnauthorized();
    throw new ApiError(res.status, data?.error || 'خطای ناشناخته', data);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}, opts) => request('PUT', url, body, opts),
  blob: (method, url, body) => request(method, url, body, { blob: true }),
};

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}
