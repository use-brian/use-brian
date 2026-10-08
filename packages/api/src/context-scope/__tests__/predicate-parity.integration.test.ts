/**
 * I10 / P10: the three implementations of the permission model v2 read rule
 * agree with the reference on the shared fixture set.
 *
 *   reference  reference-predicate.ts read(), in memory
 *   RLS        migration 649 on the app role: department_read_grants() builds
 *              the map in SQL from department_edges and the app.v2_* GUCs
 *   store      the turn resolver (department-resolver.ts, via the reference
 *              eff) feeding buildDepartmentReadPredicate on the owner pool
 *
 * Seeds the §4.1 workspace (rows as tasks, one of the nine v2 policy tables)
 * into a migration-replayed database (run through
 * scripts/crm/local-fixture.mjs) and fails on any divergence. Skips when no
 * such database is reachable; `invariants/read-predicate-parity` runs it.
 * Page-grant cases have no row-level SQL counterpart yet (pages and doc-sync
 * move to READ in Phase 4) and are checked against the reference only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { getAppPool, getPool } from '../../db/client.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { admitWorkspaceResource } from '../../workspace-access/resource-admission.js'
import { buildDepartmentReadPredicate } from '../../db/access-predicate.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../department-resolver.js'
import { read, readable, type AccessSnapshot, type Ctx, type Reader, type Row } from '../reference-predicate.js'
import {
  ALL_READERS, ALL_ROWS, ASSISTANTS, CASES_4_1, DEPARTMENTS, EDGES, LANES, OTHER_WORKSPACE, PAGE_GRANTS, PEOPLE, ROLES,
  ROWS, SALES_OWNER, SNAPSHOT, WORKSPACE,
} from './fixtures/access-matrix.js'

async function available(): Promise<boolean> {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL_APP) return false
  try {
    await getPool().query('SELECT department_read_v2 FROM workspaces LIMIT 0')
    return true
  } catch {
    return false
  }
}
const ok = await available()
const describeIf = ok ? describe : describe.skip

const DAY = 86_400_000
const pageRowIds = new Set(PAGE_GRANTS.map(g => g.rowId))
// The database clock is real time; shift the fixture's one expiring edge so
// it sits as far in the future of "now" as it does of BEFORE_EXPIRY.
const now = new Date()
const shiftedEdges = EDGES.map(e => e.expiresAt ? { ...e, expiresAt: new Date(now.getTime() + 16 * DAY) } : e)
const shifted: AccessSnapshot = { ...SNAPSHOT, edges: shiftedEdges }
const dbCtx = (ctx: Ctx): Ctx => ({ ...ctx, now })

const humanOf = (reader: Reader) => reader.credential?.issuerUserId ?? reader.principal.id

async function viaRls(reader: Reader, ctx: Ctx, sql: string, values: unknown[]): Promise<pg.QueryResult> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.v2_assistant_id',$2,true),
      set_config('app.v2_context_department',$3,true), set_config('app.v2_binding',$4,true), set_config('app.v2_cap',$5,true)`,
    [humanOf(reader), reader.assistant?.id ?? '', ctx.department ?? '',
      reader.credential?.binding ? JSON.stringify(reader.credential.binding) : '', reader.credential?.cap ?? ''])
    return await client.query(sql, values)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function viaStore(reader: Reader, ctx: Ctx, extraSql: string, values: unknown[], select = 'id'): Promise<pg.QueryResult> {
  const pool = getPool()
  const q = <R>(sql: string, v: unknown[]) => pool.query(sql, v) as unknown as Promise<{ rows: R[] }>
  const input = { workspaceId: WORKSPACE, userId: humanOf(reader), assistantId: reader.assistant?.id ?? null,
    contextDepartment: ctx.department, credential: reader.credential ? { cap: reader.credential.cap ?? null, binding: reader.credential.binding ?? null } : null }
  const { snapshot, principal } = await loadDepartmentSnapshot(q, input)
  const grant = resolveDepartmentReadGrant(snapshot, principal, input, now)
  const predicate = buildDepartmentReadPredicate({ workspaceId: WORKSPACE, userId: input.userId, assistantId: input.assistantId ?? ASSISTANTS.brian.id, assistantKind: 'standard' }, grant,
    { startIdx: values.length + 1 })
  return pool.query(`SELECT ${select} FROM tasks WHERE ${extraSql} AND ${predicate.sql}`, [...values, ...predicate.params])
}

describeIf('[COMP:access/predicate-parity] RLS, store predicate and turn resolver agree with the reference READ', () => {
  const pool = ok ? getPool() : undefined!
  const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)

  async function cleanup() {
    for (const w of [WORKSPACE, OTHER_WORKSPACE]) await q('DELETE FROM workspaces WHERE id=$1', [w])
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[...Object.values(PEOPLE).map(p => p.id), SALES_OWNER.id]])
  }

  beforeAll(async () => {
    await cleanup()
    for (const p of [...Object.values(PEOPLE), SALES_OWNER]) {
      await q(`INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1,'test',$2)`, [p.id, p.id])
    }
    for (const w of [WORKSPACE, OTHER_WORKSPACE]) {
      await q(`INSERT INTO workspaces(id,name,purpose,owner_user_id,is_personal) VALUES($1,'Fictional Co','test',$2,false)`, [w, PEOPLE.ava.id])
    }
    const base = (id: string) => SNAPSHOT.base[`user:${id}`]
    for (const [name, p] of Object.entries(PEOPLE) as [keyof typeof PEOPLE, typeof PEOPLE[keyof typeof PEOPLE]][]) {
      await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)`, [WORKSPACE, p.id, ROLES[name], base(p.id)])
    }
    await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')`, [WORKSPACE, SALES_OWNER.id])
    await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')`, [OTHER_WORKSPACE, PEOPLE.ava.id])
    await q(`INSERT INTO assistants(id,name,workspace_id,kind,clearance) VALUES($1,'Brian',$2,'primary','confidential')`, [ASSISTANTS.brian.id, WORKSPACE])
    await q(`INSERT INTO assistants(id,name,workspace_id,kind,clearance) VALUES($1,'Ops',$2,'standard','internal')`, [ASSISTANTS.ops.id, WORKSPACE])
    // Each department's creator is its owner (seeded confidential edge), and
    // the primary assistant joins every department (D12).
    const creators: Record<string, string> = { [DEPARTMENTS.board]: PEOPLE.ava.id, [DEPARTMENTS.platform]: PEOPLE.maya.id,
      [DEPARTMENTS.finance]: PEOPLE.priya.id, [DEPARTMENTS.sales]: SALES_OWNER.id }
    for (const [name, id] of Object.entries(DEPARTMENTS)) {
      await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,$3,$4,'team',$5,$6)`,
        [id, WORKSPACE, name, creators[id], id, `team:${id}`])
      await q(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,$3,$4,'team',$5)`,
        [WORKSPACE, `team:${id}`, name, creators[id], id])
    }
    // Legacy membership writes above were synced into derived edges (650);
    // the matrix is exactly §4.1's edges, so keep only owner edges and seed the rest.
    await q(`DELETE FROM department_edges WHERE workspace_id=$1 AND origin <> 'owner'`, [WORKSPACE])
    for (const e of shiftedEdges) {
      const column = e.principal.kind === 'user' ? 'user_id' : 'assistant_id'
      await q(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,${column},clearance,expires_at,origin)
        VALUES($1,$2,$3,$4,$5,$6,'store') ON CONFLICT DO NOTHING`, [WORKSPACE, e.departmentId, e.principal.kind, e.principal.id, e.clearance, e.expiresAt])
    }
    const seeded = (await q('SELECT count(*)::int n FROM department_edges WHERE workspace_id=$1', [WORKSPACE])).rows[0].n
    expect(seeded).toBe(shiftedEdges.length)
    for (const row of ALL_ROWS) {
      await q(`INSERT INTO tasks(id,workspace_id,user_id,title,sensitivity,compartments) VALUES($1,$2,$3,'fixture row',$4,$5)`,
        [row.id, row.workspaceId, row.userId, row.tier, row.departmentIds.map(d => `team:${d}`)])
    }
    await q('UPDATE workspaces SET department_read_v2=true WHERE id = ANY($1::uuid[])', [[WORKSPACE, OTHER_WORKSPACE]])
    const flagged = (await q('SELECT count(*)::int n FROM workspaces WHERE department_read_v2 AND id = ANY($1::uuid[])', [[WORKSPACE, OTHER_WORKSPACE]])).rows[0].n
    expect(flagged).toBe(2)
  })
  afterAll(async () => {
    if (!ok) return
    await cleanup()
    await getAppPool().end()
    await pool.end()
  })

  const sqlCases = CASES_4_1.filter(c => !pageRowIds.has(c.row.id))

  it.each(sqlCases.map(c => [c.name, c] as const))('by-id: %s', async (_name, c) => {
    const ctx = dbCtx(c.ctx)
    const reference = read(shifted, c.reader, c.row, ctx)
    const rls = (await viaRls(c.reader, ctx, 'SELECT id FROM tasks WHERE id=$1', [c.row.id])).rowCount === 1
    const store = (await viaStore(c.reader, ctx, 'id=$1', [c.row.id])).rowCount === 1
    expect({ reference, rls, store }).toEqual({ reference: c.expected, rls: c.expected, store: c.expected })
  })

  it('page-grant cases are decided by the reference (no row-level SQL counterpart before Phase 4)', () => {
    for (const c of CASES_4_1.filter(c => pageRowIds.has(c.row.id))) expect(read(SNAPSHOT, c.reader, c.row, c.ctx)).toBe(c.expected)
  })

  it('I11: list and count lanes return exactly what the reference READ admits, for every reader and context', async () => {
    const rows = ALL_ROWS.filter(r => !pageRowIds.has(r.id))
    const ids = rows.map(r => r.id)
    for (const reader of ALL_READERS.map(r => ({ ...r, pageGrants: [] }))) {
      for (const department of [null, ...Object.values(DEPARTMENTS)]) {
        const ctx: Ctx = { workspaceId: WORKSPACE, department, now }
        const expected = readable(shifted, reader, rows, ctx).map((r: Row) => r.id).sort()
        for (const lane of LANES.filter(l => l === 'list' || l === 'count')) {
          if (lane === 'list') {
            const rls = (await viaRls(reader, ctx, 'SELECT id FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id', [ids])).rows.map(r => r.id)
            const store = (await viaStore(reader, ctx, 'id = ANY($1::uuid[])', [ids])).rows.map(r => r.id).sort()
            expect({ rls, store }).toEqual({ rls: expected, store: expected })
          } else {
            const rls = (await viaRls(reader, ctx, 'SELECT count(*)::int n FROM tasks WHERE id = ANY($1::uuid[])', [ids])).rows[0].n
            const store = (await viaStore(reader, ctx, 'id = ANY($1::uuid[])', [ids], 'count(*)::int n')).rows[0].n
            expect({ rls, store }).toEqual({ rls: expected.length, store: expected.length })
          }
        }
      }
    }
  })

  it('the member mutation floor uses department clearance, context and credential narrowing instead of the legacy base ceiling', async () => {
    for (const reader of ALL_READERS.map(r => ({ ...r, pageGrants: [] }))) {
      for (const row of ALL_ROWS.filter(r => r.workspaceId === WORKSPACE && !pageRowIds.has(r.id))) {
        for (const department of [null, DEPARTMENTS.finance]) {
          const ctx: Ctx = { workspaceId: WORKSPACE, department, now }
          // This floor checks membership and labels; separate row policies own the private leg.
          const expected = read(shifted, reader, { ...row, userId: null }, ctx)
          const actual = (await viaRls(reader, ctx,
            'SELECT member_operation_scope_allows($1,$2,$3,true) AS allowed',
            [WORKSPACE, row.tier, row.departmentIds.map(id => `team:${id}`)])).rows[0].allowed
          expect(actual, `${reader.principal.id}/${row.id}/${department}`).toBe(expected)
        }
      }
    }
  })

  it('I8 through SQL: a key reads with its issuer\'s edges, and a binding or cap only narrows', async () => {
    const key = (issuer: string, extra: Partial<NonNullable<Reader['credential']>> = {}): Reader =>
      ({ principal: PEOPLE.ava, assistant: ASSISTANTS.brian, credential: { issuerUserId: issuer, scope: 'read', ...extra } })
    const ctx: Ctx = { workspaceId: WORKSPACE, department: null, now }
    for (const [reader, row, expected] of [
      [key(PEOPLE.jun.id), ROWS.r6, false],
      [key(PEOPLE.maya.id), ROWS.r1, true],
      [key(PEOPLE.maya.id, { cap: 'internal' }), ROWS.r1, false],
      [key(PEOPLE.maya.id, { binding: [DEPARTMENTS.finance] }), ROWS.r1, false],
      [key(PEOPLE.maya.id, { binding: [DEPARTMENTS.finance] }), ROWS.r3, true],
    ] as const) {
      const rls = (await viaRls(reader, ctx, 'SELECT id FROM tasks WHERE id=$1', [row.id])).rowCount === 1
      const store = (await viaStore(reader, ctx, 'id=$1', [row.id])).rowCount === 1
      expect({ ref: read(shifted, reader, row, ctx), rls, store }).toEqual({ ref: expected, rls: expected, store: expected })
    }
  })

  it('admission computes WRITE through the reference in a flagged workspace', async () => {
    const admit = async (input: Parameters<typeof admitWorkspaceResource>[3]) => {
      const loaded = await loadDepartmentSnapshot(<R>(sql: string, v: unknown[]) => pool.query(sql, v) as unknown as Promise<{ rows: R[] }>,
        { workspaceId: WORKSPACE, userId: PEOPLE.maya.id, assistantId: ASSISTANTS.ops.id })
      const grant = resolveDepartmentReadGrant(loaded.snapshot, loaded.principal,
        { workspaceId: WORKSPACE, userId: PEOPLE.maya.id, assistantId: ASSISTANTS.ops.id }, now)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        return await runWithAgentAccess({ workspaceId: WORKSPACE, userId: PEOPLE.maya.id, clearance: 'confidential', compartments: null, departmentRead: grant },
          () => admitWorkspaceResource(client, WORKSPACE, PEOPLE.maya.id, input))
      } finally { await client.query('ROLLBACK'); client.release() }
    }
    // Ops is internal in Finance: an internal Finance write passes, confidential is refused (write ceiling = assistant).
    const ok = await admit({ visibility: 'workspace', sensitivity: 'internal', destination: { kind: 'department', departmentId: DEPARTMENTS.finance } })
    expect(ok.envelope).toMatchObject({ sensitivity: 'internal', compartments: [`team:${DEPARTMENTS.finance}`] })
    await expect(admit({ visibility: 'workspace', sensitivity: 'confidential', destination: { kind: 'department', departmentId: DEPARTMENTS.finance } }))
      .rejects.toMatchObject({ code: 'context_not_available' })
    // Derived from a confidential Platform source into Finance: union of departments, max tier,
    // which Ops cannot hold in Finance, so it is refused rather than stamped lower (I12).
    await expect(admit({ visibility: 'workspace', sensitivity: 'public', destination: { kind: 'department', departmentId: DEPARTMENTS.finance },
      inherited: { visibility: 'workspace', sensitivity: 'confidential', compartments: [`team:${DEPARTMENTS.platform}`], projectIds: [] }, inheritedAuthority: 'read' }))
      .rejects.toMatchObject({ code: 'context_not_available' })
    const derived = await admit({ visibility: 'workspace', sensitivity: 'public',
      inherited: { visibility: 'workspace', sensitivity: 'internal', compartments: [`team:${DEPARTMENTS.platform}`, `team:${DEPARTMENTS.finance}`], projectIds: [] }, inheritedAuthority: 'read' })
    expect(derived.envelope).toMatchObject({ sensitivity: 'internal', compartments: [`team:${DEPARTMENTS.finance}`, `team:${DEPARTMENTS.platform}`].sort() })
    // Ops holds no Board edge: nothing lands in Board through Ops.
    await expect(admit({ visibility: 'workspace', sensitivity: 'public', destination: { kind: 'department', departmentId: DEPARTMENTS.board } }))
      .rejects.toMatchObject({ code: 'context_not_available' })
  })

  it('a workspace with the flag off is unchanged: the v2 policy passes and the legacy floor decides', async () => {
    await q('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [WORKSPACE])
    try {
      // Jun is an admin: legacy gives the universe, v2 would refuse Board.
      const legacy = await viaRls(fixtureReader('jun'), { workspaceId: WORKSPACE, department: null, now }, 'SELECT id FROM tasks WHERE id=$1', [ROWS.r6.id])
      expect(legacy.rowCount).toBe(1)
    } finally {
      await q('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [WORKSPACE])
    }
    const v2 = await viaRls(fixtureReader('jun'), { workspaceId: WORKSPACE, department: null, now }, 'SELECT id FROM tasks WHERE id=$1', [ROWS.r6.id])
    expect(v2.rowCount).toBe(0)
  })
})

const fixtureReader = (person: keyof typeof PEOPLE): Reader => ({ principal: PEOPLE[person], assistant: ASSISTANTS.brian })
