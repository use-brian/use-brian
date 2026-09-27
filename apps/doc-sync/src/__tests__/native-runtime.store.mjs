export const rows = new Map()
export let seed
export function setSeed(page) { seed = page }
export async function query(sql, params) {
  if (sql.includes('SELECT ydoc FROM documents')) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] }
  if (sql.includes('SELECT page, name FROM saved_views')) return { rows: [{ page: seed, name: 'Native runtime' }] }
  if (sql.includes('INSERT INTO documents')) {
    rows.set(params[0], { ydoc: Buffer.from(params[1]), stateVector: Buffer.from(params[2]),
      page: JSON.parse(params[3]), title: params[4], seq: (rows.get(params[0])?.seq ?? 0) + 1 })
    return { rows: [] }
  }
  if (sql.includes('UPDATE saved_views')) return { rows: [] }
  throw new Error(`Unexpected fixture SQL: ${sql}`)
}
export function queryWithRLS() { throw new Error('No user database in this fixture') }
export function getPool() { throw new Error('No pool in this fixture') }
// Office metadata publication shares the import graph, but this document-only
// runtime fixture must never open a user transaction or provide RLS authority.
export function getAppPool() { throw new Error('No app pool in this fixture') }
export function applyRLSGucs() { throw new Error('No RLS transaction in this fixture') }
export function rollbackAndRelease() { throw new Error('No transaction to release in this fixture') }
