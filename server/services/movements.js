import { db } from '../db.js';

// One row per document line, joined with everything a report needs.
const BASE = `
  FROM document_lines l
  JOIN documents d ON d.id = l.document_id
  JOIN items i ON i.id = l.item_id
  JOIN users cu ON cu.id = d.created_by
  LEFT JOIN users du ON du.id = d.decided_by`;

const COLUMNS = `
  l.id AS line_id, l.qty, l.note AS line_note, l.stock_before, l.stock_after,
  d.id AS doc_id, d.doc_no, d.direction, d.reason, d.worker_name, d.note AS doc_note, d.status,
  d.created_at, d.decided_at, COALESCE(d.decided_at, d.created_at) AS effective_at, d.decision_note,
  d.sepidar_batch_id,
  cu.display_name AS created_by_name, du.display_name AS decided_by_name,
  i.id AS item_id, i.code, i.sepidar_code, i.name, i.variant, i.unit`;

/**
 * filters: status, direction, reason, user_id, item_id, worker, from (ISO, inclusive), to (ISO, exclusive), q
 */
export function queryMovements(f = {}, { limit = 100, offset = 0, order = 'DESC' } = {}) {
  const where = [];
  const params = [];
  where.push('d.deleted_at IS NULL');
  if (f.status) { where.push('d.status = ?'); params.push(f.status); }
  if (f.direction) { where.push('d.direction = ?'); params.push(f.direction); }
  if (f.reason) { where.push('d.reason = ?'); params.push(f.reason); }
  if (f.user_id) { where.push('d.created_by = ?'); params.push(Number(f.user_id)); }
  if (f.item_id) { where.push('l.item_id = ?'); params.push(Number(f.item_id)); }
  if (f.worker) { where.push('d.worker_name LIKE ?'); params.push(`%${f.worker}%`); }
  if (f.from) { where.push('COALESCE(d.decided_at, d.created_at) >= ?'); params.push(f.from); }
  if (f.to) { where.push('COALESCE(d.decided_at, d.created_at) < ?'); params.push(f.to); }
  if (f.q) {
    where.push('(i.name LIKE ? OR i.code LIKE ? OR i.variant LIKE ? OR d.worker_name LIKE ? OR d.note LIKE ? OR l.note LIKE ? OR CAST(d.doc_no AS TEXT) LIKE ?)');
    const like = `%${String(f.q).trim()}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const dir = order === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) AS c ${BASE} ${sqlWhere}`).get(...params).c;
  const summary = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN d.direction='in' AND d.status='approved' THEN l.qty END),0) AS qty_in,
           COALESCE(SUM(CASE WHEN d.direction='out' AND d.status='approved' THEN l.qty END),0) AS qty_out
    ${BASE} ${sqlWhere}`).get(...params);
  let sql = `SELECT ${COLUMNS} ${BASE} ${sqlWhere} ORDER BY effective_at ${dir}, l.id ${dir}`;
  const args = [...params];
  if (limit != null) { sql += ' LIMIT ? OFFSET ?'; args.push(limit, offset); }
  return { total, summary, rows: db.prepare(sql).all(...args) };
}

/**
 * What each worker still holds: approved «تحویل به کارگر» minus «بازگشت از کارگر», grouped by worker name and by part
 * (variants of one part number count together, because a worker often takes the raw part and returns the assembled one).
 */
export function workerBalances() {
  const rows = db.prepare(`
    SELECT d.worker_name AS worker, i.id AS item_id, i.code, i.part_no, i.name, i.variant, i.unit, i.image,
           SUM(CASE WHEN d.reason = 'to_worker' THEN l.qty ELSE 0 END) AS given,
           SUM(CASE WHEN d.reason = 'return_from_worker' THEN l.qty ELSE 0 END) AS returned,
           MAX(COALESCE(d.decided_at, d.created_at)) AS last_at
    FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN items i ON i.id = l.item_id
    WHERE d.status = 'approved' AND d.reason IN ('to_worker', 'return_from_worker') AND d.worker_name <> ''
    GROUP BY d.worker_name, i.id ORDER BY i.row_no, i.code`).all();
  const workers = new Map();
  for (const r of rows) {
    let w = workers.get(r.worker);
    if (!w) workers.set(r.worker, w = { name: r.worker, given: 0, returned: 0, holding: 0, last_at: r.last_at, parts: new Map() });
    const key = r.part_no ? `p:${r.part_no}:${r.name}` : `i:${r.item_id}`;
    let p = w.parts.get(key);
    if (!p) w.parts.set(key, p = { part_no: r.part_no || '', name: r.name, unit: r.unit, image: r.image, given: 0, returned: 0, balance: 0, variants: [] });
    p.given += r.given; p.returned += r.returned;
    p.variants.push({ item_id: r.item_id, code: r.code, variant: r.variant, given: r.given, returned: r.returned });
    w.given += r.given; w.returned += r.returned;
    if (r.last_at > w.last_at) w.last_at = r.last_at;
  }
  const out = [];
  for (const w of workers.values()) {
    const parts = [...w.parts.values()];
    for (const p of parts) { p.balance = p.given - p.returned; if (p.balance > 0) w.holding += p.balance; }
    parts.sort((a, b) => b.balance - a.balance);
    out.push({ ...w, parts });
  }
  return out.sort((a, b) => b.holding - a.holding || a.name.localeCompare(b.name, 'fa'));
}
