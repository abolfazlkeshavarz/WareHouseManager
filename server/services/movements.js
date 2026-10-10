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
