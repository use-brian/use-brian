import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccessContext } from '@use-brian/core'
import { getAppPool, getPool, resolvePoolMax } from '../client.js'
import { getCrmConfig, getCrmSummary } from '../crm-r2.js'
import { buildAccessPredicate } from '../access-predicate.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
if (process.env.CAMPAIGN_PERMISSION_PROBE) await assertLocalFixture()
const owner = getPool(), cleanup: Array<() => Promise<void>> = []
const library = process.env.CAMPAIGN_PERMISSION_PROBE
if (library && !/^\/[^']+\.so$/.test(library)) throw new Error('Build the fixture-only permission-probe.c and set CAMPAIGN_PERMISSION_PROBE to its absolute .so path')
type Counts = { hashes: number; privileges: number; applicationPredicates: number; directPredicates: number; rls: number; functions: Array<{ oid: number; calls: number }> }

async function fixture(size: number, mode: 'allowed' | 'masked' | 'denied' | 'no-match' = 'allowed') {
  const workspaceId = randomUUID(), userId = randomUUID(), memberId = randomUUID(), assistantId = randomUUID()
  for (const id of [userId, memberId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional permission fixture',$2,false)", [workspaceId, userId])
  for (const [id, role, clearance] of [[userId, 'owner', 'confidential'], [memberId, 'member', 'internal']]) {
    await owner.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, id, role, clearance])
  }
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional permission assistant',$2,$3,'primary','confidential')", [assistantId, userId, workspaceId])
  const access: AccessContext = { workspaceId, userId: memberId, assistantId, assistantKind: 'primary', clearance: 'internal' }
  await getCrmConfig(userId, workspaceId)
  cleanup.push(async () => { await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]); await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId, memberId]]) })
  // Fixture construction is outside the measured operation. The real version
  // triggers still execute for every row; reads use app_user below.
  await owner.query(`INSERT INTO entities(workspace_id,kind,display_name,attributes,sensitivity,created_by_user_id,source)
    SELECT $1,kind,'Fictional permission record',CASE WHEN kind='deal' THEN '{"amount":1,"stage":"lead"}'::jsonb ELSE '{}'::jsonb END,
      CASE WHEN $4::boolean AND ordinal%2=0 THEN 'confidential' ELSE 'internal' END,$2,'user'
    FROM generate_series(0,$3::int-1) ordinal CROSS JOIN unnest(ARRAY['person','company','deal']) kind`, [workspaceId,userId,size,mode==='masked'])
  if (mode === 'denied') await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, memberId])
  return { access, workspaceId, memberId }
}

async function freshBackends() {
  // Pool objects remain the production pools; destroy only their idle fixture
  // connections so the unhooked comparison uses new PostgreSQL backends.
  for (const pool of [getPool(), getAppPool()]) {
    const clients: pg.PoolClient[] = []
    for (let i = 0; i < resolvePoolMax(process.env.PG_POOL_MAX); i++) clients.push(await pool.connect())
    await Promise.all(clients.map(client => client.query('SELECT 1')))
    for (const client of clients) client.release(true)
  }
}

async function measured<T>(read: () => Promise<T>, access?: AccessContext) {
  // Reserve every connection in each maintained pool, initialize hooks before any
  // measured planning, then return them. Unknown connections fail the coverage gate.
  const clients: pg.PoolClient[] = []
  for (const pool of [getPool(), getAppPool()]) for (let i = 0; i < resolvePoolMax(process.env.PG_POOL_MAX); i++) clients.push(await pool.connect())
  for (const client of clients) {
    await client.query('SELECT crm_permission_probe.begin()')
    await client.query('DISCARD PLANS')
    await client.query('SELECT crm_permission_probe.begin()')
    client.release()
  }
  const active = new Set<pg.Client>()
  let annotatedStatements = 0
  let sql = 0
  const original = pg.Client.prototype.query
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: Parameters<typeof original>) {
    if (!clients.some(client => Object.is(client, this))) throw new Error('Uninstrumented connection in CRM operation')
    sql++; active.add(this)
    const rewritten = [...args]
    const initial = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text
    if (access && initial) {
      let statement = initial
      for (const alias of ['e', 'scope']) {
        const predicate = buildAccessPredicate(access, { alias, startIdx: 1 }).sql
        statement = statement.replaceAll(predicate, `crm_permission_probe.predicate(${predicate})`)
      }
      if (statement !== initial) {
        annotatedStatements++
        rewritten[0] = (typeof args[0] === 'string' ? statement : { ...(args[0] as pg.QueryConfig), text: statement }) as typeof args[0]
      }
    }
    return Reflect.apply(original, this, rewritten)
  } as typeof original)
  const started = performance.now()
  let result: T | undefined, failure: unknown
  try { result = await read() } catch (error) { failure = error } finally { spy.mockRestore() }
  const elapsedMs = performance.now() - started
  const totals: Counts = { hashes: 0, privileges: 0, applicationPredicates: 0, directPredicates: 0, rls: 0, functions: [] }
  for (const client of clients.filter(client => [...active].some(item => Object.is(item, client)))) {
    const counts: Counts = (await client.query('SELECT crm_permission_probe.end() AS counts')).rows[0].counts
    totals.directPredicates += counts.directPredicates; totals.hashes += counts.hashes; totals.privileges += counts.privileges; totals.applicationPredicates += counts.applicationPredicates; totals.rls += counts.rls; totals.functions.push(...counts.functions)
  }
  const merged = new Map<number, number>()
  for (const fn of totals.functions) merged.set(fn.oid, (merged.get(fn.oid) ?? 0) + fn.calls)
  const names = (await owner.query('SELECT oid,proname,oid::regprocedure::text AS signature FROM pg_proc WHERE oid=ANY($1::oid[])', [[...merged.keys()]])).rows
  const functions = names.map(row => ({ name: row.proname as string, signature: row.signature as string, calls: merged.get(Number(row.oid))! })).sort((a, b) => b.calls - a.calls)
  // These codecs extract/format already selected business values; the vector
  // index access-method handler performs planning, not an authority decision.
  // Every other observed public helper is retained conservatively.
  const business = new Set(['hnswhandler', 'application_native_entity_values',
    'application_native_entity_values_before_completion', 'application_native_entity_values_before_self_profile',
    'application_native_date_value_valid'])
  const allPublicCalls = functions.filter(fn => !business.has(fn.name)).reduce((sum, fn) => sum + fn.calls, 0)
  return { result, failure, elapsedMs, sql, annotatedStatements, hashes: totals.hashes, privileges: totals.privileges, rls: totals.rls, applicationPredicates: totals.applicationPredicates, directPredicates: totals.directPredicates, functions, observedPermissionWork: allPublicCalls + totals.hashes + totals.privileges + totals.rls + totals.applicationPredicates + totals.directPredicates }
}

describe.skipIf(!library).sequential('[COMP:crm/permission-budget] whole summary observed-work regression', () => {
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA IF NOT EXISTS crm_permission_probe')
    for (const [name, args, result, symbol, strict] of [
      ['begin', '', 'void', 'crm_probe_begin', false], ['end', '', 'jsonb', 'crm_probe_end', false],
      ['rls', 'boolean', 'boolean', 'crm_probe_rls', false],
      ['predicate', 'boolean', 'boolean', 'crm_probe_predicate', false],
      ['direct', 'boolean', 'boolean', 'crm_probe_direct', false],
    ]) await owner.query(`CREATE OR REPLACE FUNCTION crm_permission_probe.${name}(${args}) RETURNS ${result} AS '${library}','${symbol}' LANGUAGE C VOLATILE ${strict ? 'STRICT' : ''} PARALLEL UNSAFE`)
    const builtins = (await owner.query(`SELECT p.oid,pg_get_function_identity_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS result,p.proisstrict,p.provolatile,p.procost
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pg_catalog' AND p.proname=ANY($1::text[])`, [[
      'md5', 'sha224', 'sha256', 'sha384', 'sha512', 'hashtext', 'hashtextextended', 'pg_has_role',
      'has_function_privilege', 'has_table_privilege', 'has_schema_privilege', 'has_database_privilege',
      'has_column_privilege', 'has_any_column_privilege', 'has_parameter_privilege', 'row_security_active',
    ]])).rows
    for (const builtin of builtins) await owner.query(`CREATE OR REPLACE FUNCTION crm_permission_probe.f_${builtin.oid}(${builtin.args}) RETURNS ${builtin.result}
      AS '${library}','crm_probe_hash' LANGUAGE C ${{ i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' }[builtin.provolatile as 'i' | 's' | 'v']} ${builtin.proisstrict ? 'STRICT' : ''} COST ${builtin.procost} PARALLEL UNSAFE`)
    await owner.query('GRANT USAGE ON SCHEMA crm_permission_probe TO app_user; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA crm_permission_probe TO app_user')
  })
  afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn() })
  afterAll(async () => { await getAppPool().end(); await owner.end() })

  it('counts nested SQL functions, explicit hashes and direct RLS predicates without changing results', async () => {
    await owner.query(`CREATE FUNCTION public.crm_probe_inner(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT md5($1)';
      CREATE FUNCTION public.crm_probe_outer(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT public.crm_probe_inner($1)';
      CREATE FUNCTION public.crm_probe_plpgsql(text) RETURNS text LANGUAGE plpgsql AS 'BEGIN RETURN public.crm_probe_outer($1); END';
      CREATE TABLE crm_permission_probe.rows(id integer); INSERT INTO crm_permission_probe.rows VALUES(1),(2),(3);
      ALTER TABLE crm_permission_probe.rows ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_policy ON crm_permission_probe.rows USING(id>1);
      GRANT SELECT ON crm_permission_probe.rows TO app_user`)
    try {
      const baseline = (await getAppPool().query("SELECT id,public.crm_probe_plpgsql(id::text) AS hash FROM crm_permission_probe.rows ORDER BY id")).rows
      const capture = await measured(async () => (await getAppPool().query("SELECT id,public.crm_probe_plpgsql(id::text) AS hash FROM crm_permission_probe.rows ORDER BY id")).rows)
      expect(capture.failure).toBeUndefined(); expect(capture.result).toEqual(baseline)
      expect(capture.hashes).toBe(2); expect(capture.rls).toBe(3)
      expect(capture.functions).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'crm_probe_inner', calls: 2 }), expect.objectContaining({ name: 'crm_probe_outer', calls: 2 }), expect.objectContaining({ name: 'crm_probe_plpgsql', calls: 2 })]))
    } finally { await owner.query('DROP TABLE crm_permission_probe.rows; DROP FUNCTION public.crm_probe_plpgsql(text),public.crm_probe_outer(text),public.crm_probe_inner(text)') }
  })

  it('counts folded hashes and builtin privileges and preserves strict null and predicate semantics', async () => {
    await freshBackends()
    const query = "SELECT md5('fixture-constant') AS hash,md5(NULL::text) AS absent,has_table_privilege(current_user,'entities','SELECT') AS allowed,crm_permission_probe.predicate(NULL::boolean) AS undecided"
    const plain = (await getAppPool().query(query)).rows
    const capture = await measured(async () => (await getAppPool().query(query)).rows)
    expect(capture.failure).toBeUndefined(); expect(capture.result).toEqual(plain)
    expect(capture.hashes).toBe(1); expect(capture.privileges).toBe(1)
    expect(capture.applicationPredicates).toBe(1)
  })

  it('counts direct SQL version and hold predicates independently of helper entries', async () => {
    await freshBackends()
    await owner.query(`CREATE TABLE crm_permission_probe.scope_rows(id integer,scope_version integer,scope_held boolean);
      INSERT INTO crm_permission_probe.scope_rows VALUES(1,1,false),(2,2,false),(3,3,false);
      GRANT SELECT ON crm_permission_probe.scope_rows TO app_user`)
    try {
      const read = async () => (await getAppPool().query('SELECT id FROM crm_permission_probe.scope_rows WHERE id=scope_version AND NOT scope_held ORDER BY id')).rows
      const plain = await read(), capture = await measured(read)
      expect(capture.failure).toBeUndefined(); expect(capture.result).toEqual(plain)
      expect(capture.directPredicates).toBe(6)
    } finally { await owner.query('DROP TABLE crm_permission_probe.scope_rows') }
  })

  for (const size of [0, 10, 100, 1000]) for (const mode of ['allowed', 'masked', 'denied', 'no-match'] as const) it(`keeps an exact ${size}-per-kind ${mode} summary at no more than 999 observed permission events`, async () => {
    await freshBackends()
    const f = await fixture(size, mode)
    const role = (await getAppPool().query(`SELECT current_user,session_user,r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns
      FROM pg_roles r JOIN pg_class c ON c.oid='entities'::regclass WHERE r.rolname=current_user`)).rows[0]
    expect(role).toMatchObject({ current_user: 'app_user', session_user: 'app_user', rolsuper: false, rolbypassrls: false, owns: false })
    const visible = mode === 'masked' ? Math.floor(size / 2) : size
    const expected = { totals: { deals: mode === 'no-match' ? 0 : visible, contacts: visible, companies: visible }, attention: { overdue: 0, stale: 0, noAmount: 0, orphaned: visible }, stages: [] }
    const pipeline = mode === 'no-match' ? randomUUID() : undefined
    const read = () => getCrmSummary(f.access, pipeline)
    await freshBackends()
    let plain: unknown, plainFailure: unknown
    try { plain = await read() } catch (error) { plainFailure = error }
    if (mode === 'denied') expect(plainFailure).toBeDefined()
    else { expect(plainFailure).toBeUndefined(); expect(plain).toEqual(expected) }
    const capture = await measured(read, f.access)
    if (process.env.CAMPAIGN_PERMISSION_REPORT) await appendFile(process.env.CAMPAIGN_PERMISSION_REPORT, JSON.stringify({ size, mode, ...capture, result: undefined, failure: capture.failure ? String(capture.failure) : undefined }) + '\n')
    if (mode === 'denied') {
      expect(capture.failure).toBeDefined(); expect(capture.result).toBeUndefined()
      expect(String(capture.failure)).toBe(String(plainFailure))
    } else {
      expect(capture.failure).toBeUndefined(); expect(capture.result).toEqual(expected)
      expect(capture.annotatedStatements).toBeGreaterThan(0); expect(capture.applicationPredicates).toBeGreaterThan(0)
    }
    expect(capture.sql).toBeGreaterThan(0)
    expect(capture.observedPermissionWork).toBeLessThanOrEqual(999)
  })
})
