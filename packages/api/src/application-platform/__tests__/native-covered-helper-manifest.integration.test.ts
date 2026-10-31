import { afterAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getAppPool, getPool, rollbackAndRelease } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const guard = 'application_native_covered_evidence_helpers_current()'
const nested = ['application_native_file_capture_helpers_current()', 'application_native_worklist_helpers_current()',
  'application_empty_query_helpers_current()', 'application_memory_statement_helpers_current()']
const families = [
  ['covered', 'application_native_root_cover(uuid,jsonb)'],
  ['file', 'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'],
  ['worklist', 'native_detached_snapshot(uuid,text,uuid,text,jsonb)'],
  ['empty query', 'application_empty_query_worklist_reset(jsonb)'],
  ['Memory', 'application_memory_field_keys()'],
  ['edge dispatcher', 'application_native_source_edges_dispatch(uuid,text,uuid,text)'],
] as const
async function transaction(read: (client: PoolClient) => Promise<void>) {
  const client = await getPool().connect()
  try { await client.query('BEGIN'); await read(client) }
  finally { await rollbackAndRelease(client) }
}
async function allowed(client: PoolClient) { return (await client.query(`SELECT ${guard} value`)).rows[0].value }
async function definition(client: PoolClient, signature: string) {
  return (await client.query(`SELECT pg_get_functiondef(p.oid) definition,p.prosrc body,p.procost,
    l.lanname FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=$1::regprocedure`, [signature])).rows[0]
}

describe.sequential('[COMP:api/application-persistence] flattened native covered helper manifest', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  it('retains a fresh true result without executing nested guards', async () => transaction(async client => {
    await client.query("SET LOCAL track_functions='all'")
    expect(await allowed(client)).toBe(true)
    expect(await allowed(client)).toBe(true)
    const counts = (await client.query(`SELECT p.proname,s.calls::int FROM pg_stat_xact_user_functions s
      JOIN pg_proc p ON p.oid=s.funcid WHERE p.oid=ANY($1::regprocedure[])`, [[guard, ...nested]])).rows
    expect(counts.find(row => row.proname === guard.slice(0,-2))?.calls).toBe(2)
    expect(counts.filter(row => row.proname !== guard.slice(0,-2)).every(row => row.calls === 0)).toBe(true)
  }))

  for (const [family, signature] of families) for (const drift of ['body', 'COST', 'ACL', 'configuration'] as const) {
    it(`refuses current ${family} ${drift} drift and recovers only after rollback`, async () => transaction(async client => {
      expect(await allowed(client)).toBe(true)
      const fn = await definition(client, signature)
      await client.query('SAVEPOINT helper_change')
      if (drift === 'body') await client.query(fn.definition.replace(fn.body, () => fn.body + '\n-- Fictional manifest drift'))
      else if (drift === 'COST') await client.query(`ALTER FUNCTION ${signature} COST ${Number(fn.procost) + 1}`)
      else if (drift === 'configuration') await client.query(`ALTER FUNCTION ${signature} SET work_mem='8MB'`)
      else {
        await client.query('CREATE ROLE fictional_manifest_reader NOLOGIN')
        await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO fictional_manifest_reader`)
      }
      expect(await allowed(client)).toBe(false)
      await client.query('ROLLBACK TO SAVEPOINT helper_change')
      expect(await allowed(client)).toBe(true)
    }))
  }

  for (const signature of nested) it(`never invokes unknown nested ${signature} code`, async () => transaction(async client => {
    const fn = await definition(client, signature)
    await client.query("CREATE FUNCTION pg_temp.unknown_manifest_canary() RETURNS boolean LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fictional_unknown_guard_invoked';END$$")
    const body = fn.lanname === 'sql' ? 'SELECT pg_temp.unknown_manifest_canary()' : 'BEGIN RETURN pg_temp.unknown_manifest_canary();END'
    await client.query(fn.definition.replace(fn.body, () => body))
    expect(await allowed(client)).toBe(false)
  }))

  it('refuses a missing member OID without accepting the remaining matching rows', async () => transaction(async client => {
    expect(await allowed(client)).toBe(true)
    await client.query('DROP FUNCTION native_detached_snapshot(uuid,text,uuid,text,jsonb)')
    expect(await allowed(client)).toBe(false)
  }))

  it('retains the existing private EXECUTE boundary', async () => {
    const app = await getAppPool().connect()
    try { await expect(app.query(`SELECT ${guard}`)).rejects.toMatchObject({ code: '42501' }) }
    finally { app.release() }
  })
})
