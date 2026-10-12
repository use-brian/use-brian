/**
 * Shared Project foundation matrix (platform
 * docs/plans/project-shared-spaces-implementation.md §10, §15.5). The
 * reference predicate, RLS (department_row_allows over the SQL admission map)
 * and the store predicate (the turn resolver's grant through
 * buildDepartmentReadPredicate) must agree on the same fixtures, with real
 * source and destination authority. Runs only through
 * scripts/crm/local-fixture.mjs (an owned, migration-replayed database).
 * Spec: docs/architecture/features/project-shared-spaces.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { getAppPool, getPool } from '../../db/client.js'
import { buildDepartmentReadPredicate } from '../../db/access-predicate.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../department-resolver.js'
import { read, readable, type AccessSnapshot, type Ctx, type Reader, type Row } from '../reference-predicate.js'
import { ASSISTANTS, DEPARTMENTS, EDGES, PEOPLE, ROLES, SALES_OWNER, SNAPSHOT, WORKSPACE } from './fixtures/access-matrix.js'
import { ALL_PROJECT_ROWS, PROJECT_CASES, PROJECT_EDGES, PROJECT_OWNERS, PROJECT_READERS, PROJECT_ROWS, PROJECT_SNAPSHOT, PROJECTS } from './fixtures/project-shared-matrix.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const DAY = 86_400_000
const now = new Date()
// The database clock is real time: an expiring edge sits 16 days ahead.
const shiftEdge = <E extends { expiresAt: Date | null }>(e: E): E => e.expiresAt ? { ...e, expiresAt: new Date(now.getTime() + 16 * DAY) } : e
const shifted: AccessSnapshot = { ...PROJECT_SNAPSHOT, edges: SNAPSHOT.edges.map(shiftEdge), projectEdges: PROJECT_EDGES.map(shiftEdge) }
const dbCtx = (ctx: Ctx): Ctx => ({ ...ctx, now })
const humanOf = (reader: Reader) => reader.credential?.issuerUserId ?? reader.principal.id
const labels = (row: Row) => [...row.departmentIds.map(d => `team:${d}`), ...(row.projectScopeIds ?? []).map(p => `project:${p}`)]

const pool = getPool()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)

async function viaRls(reader: Reader, sql: string, values: unknown[]): Promise<pg.QueryResult> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.v2_assistant_id',$2,true),
      set_config('app.v2_context_department','',true), set_config('app.v2_binding',$3,true), set_config('app.v2_cap',$4,true)`,
    [humanOf(reader), reader.assistant?.id ?? '', reader.credential?.binding ? JSON.stringify(reader.credential.binding) : '', reader.credential?.cap ?? ''])
    return await client.query(sql, values)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function grantFor(reader: Reader) {
  const query = <R>(sql: string, v: unknown[]) => pool.query(sql, v) as unknown as Promise<{ rows: R[] }>
  const input = { workspaceId: WORKSPACE, userId: humanOf(reader), assistantId: reader.assistant?.id ?? null, contextDepartment: null,
    credential: reader.credential ? { cap: reader.credential.cap ?? null, binding: reader.credential.binding ?? null } : null }
  const { snapshot, principal } = await loadDepartmentSnapshot(query, input)
  return { grant: resolveDepartmentReadGrant(snapshot, principal, input, now), input }
}

async function viaStore(reader: Reader, extraSql: string, values: unknown[], operation: 'read' | 'mutation' = 'read', select = 'id'): Promise<pg.QueryResult> {
  const { grant, input } = await grantFor(reader)
  const predicate = buildDepartmentReadPredicate({ workspaceId: WORKSPACE, userId: input.userId, assistantId: input.assistantId ?? ASSISTANTS.brian.id, assistantKind: 'standard' },
    grant, { startIdx: values.length + 1, operation })
  return pool.query(`SELECT ${select} FROM tasks WHERE ${extraSql} AND ${predicate.sql}`, [...values, ...predicate.params])
}

async function cleanup() {
  await q('DELETE FROM workspaces WHERE id=$1', [WORKSPACE])
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[...Object.values(PEOPLE).map(p => p.id), SALES_OWNER.id]])
}

describe('[COMP:access/project-shared-matrix] Shared Project foundation: reference, RLS and store agree', () => {
  beforeAll(async () => {
    await cleanup()
    for (const p of [...Object.values(PEOPLE), SALES_OWNER]) await q(`INSERT INTO users(id,auth_provider,auth_provider_id,name) VALUES($1,'test',$2,'Fictional person')`, [p.id, p.id])
    await q(`INSERT INTO workspaces(id,name,purpose,owner_user_id,is_personal) VALUES($1,'Fictional Co','test',$2,false)`, [WORKSPACE, PEOPLE.ava.id])
    for (const [name, p] of Object.entries(PEOPLE) as [keyof typeof PEOPLE, typeof PEOPLE[keyof typeof PEOPLE]][]) {
      await q('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [WORKSPACE, p.id, ROLES[name], SNAPSHOT.base[`user:${p.id}`]])
    }
    await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')`, [WORKSPACE, SALES_OWNER.id])
    await q(`INSERT INTO assistants(id,name,workspace_id,kind,clearance) VALUES($1,'Brian',$2,'primary','confidential')`, [ASSISTANTS.brian.id, WORKSPACE])
    await q(`INSERT INTO assistants(id,name,workspace_id,kind,clearance) VALUES($1,'Ops',$2,'standard','internal')`, [ASSISTANTS.ops.id, WORKSPACE])
    const creators: Record<string, string> = { [DEPARTMENTS.board]: PEOPLE.ava.id, [DEPARTMENTS.platform]: PEOPLE.maya.id,
      [DEPARTMENTS.finance]: PEOPLE.priya.id, [DEPARTMENTS.sales]: SALES_OWNER.id }
    for (const [name, id] of Object.entries(DEPARTMENTS)) {
      await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,$3,$4,'team',$5,$6)`, [id, WORKSPACE, name, creators[id], id, `team:${id}`])
      await q(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,$3,$4,'team',$5)`, [WORKSPACE, `team:${id}`, name, creators[id], id])
    }
    await q(`DELETE FROM department_edges WHERE workspace_id=$1 AND origin <> 'owner'`, [WORKSPACE])
    for (const e of EDGES.map(shiftEdge)) {
      const column = e.principal.kind === 'user' ? 'user_id' : 'assistant_id'
      await q(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,${column},clearance,expires_at,origin) VALUES($1,$2,$3,$4,$5,$6,'store') ON CONFLICT DO NOTHING`,
        [WORKSPACE, e.departmentId, e.principal.kind, e.principal.id, e.clearance, e.expiresAt])
    }
    // Shared scopes, owners (each seeds its edge) and the rest of the roster.
    for (const [name, projectId] of Object.entries(PROJECTS)) {
      await q('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,$3,$4)', [projectId, WORKSPACE, name, PEOPLE.maya.id])
      if (projectId === PROJECTS.legacy) continue
      await q(`INSERT INTO project_shared_scopes(project_id,workspace_id,origin,status) VALUES($1,$2,'created',$3)`,
        [projectId, WORKSPACE, projectId === PROJECTS.quarantined ? 'quarantined' : 'active'])
    }
    for (const o of PROJECT_OWNERS) await q('INSERT INTO project_shared_owners(workspace_id,project_id,user_id) VALUES($1,$2,$3)', [WORKSPACE, o.project, o.person.id])
    for (const e of PROJECT_EDGES.map(shiftEdge)) {
      const column = e.principal.kind === 'user' ? 'user_id' : 'assistant_id'
      await q(`INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,${column},expires_at,origin) VALUES($1,$2,$3,$4,$5,'invited')
        ON CONFLICT DO NOTHING`, [WORKSPACE, e.projectId, e.principal.kind, e.principal.id, e.expiresAt])
    }
    for (const row of ALL_PROJECT_ROWS) {
      await q(`INSERT INTO tasks(id,workspace_id,user_id,title,sensitivity,compartments) VALUES($1,$2,$3,'fixture row',$4,$5)`,
        [row.id, row.workspaceId, row.userId, row.tier, labels(row)])
    }
    await q('UPDATE workspaces SET department_read_v2=true, project_shared_spaces=true WHERE id=$1', [WORKSPACE])
  })
  afterAll(async () => {
    await cleanup()
    await getAppPool().end()
    await pool.end()
  })

  const timeless = PROJECT_CASES.filter(c => c.ctx.now.getTime() < new Date('2026-10-31T00:00:00Z').getTime())

  it.each(timeless.filter(c => c.ctx.operation !== 'mutation').map(c => [c.name, c] as const))('by-id read: %s', async (_name, c) => {
    const reference = read(shifted, c.reader, c.row, dbCtx(c.ctx))
    const rls = (await viaRls(c.reader, 'SELECT id FROM tasks WHERE id=$1', [c.row.id])).rowCount === 1
    const store = (await viaStore(c.reader, 'id=$1', [c.row.id])).rowCount === 1
    expect({ reference, rls, store }).toEqual({ reference: c.expected, rls: c.expected, store: c.expected })
  })

  it('list and count lanes return exactly what the reference admits, for every reader', async () => {
    const ids = ALL_PROJECT_ROWS.map(r => r.id)
    for (const reader of PROJECT_READERS) {
      const expected = readable(shifted, reader, ALL_PROJECT_ROWS, dbCtx({ workspaceId: WORKSPACE, department: null, now })).map(r => r.id).sort()
      const rls = (await viaRls(reader, 'SELECT id FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY id', [ids])).rows.map(r => r.id)
      const store = (await viaStore(reader, 'id = ANY($1::uuid[])', [ids])).rows.map(r => r.id).sort()
      const count = (await viaRls(reader, 'SELECT count(*)::int n FROM tasks WHERE id = ANY($1::uuid[])', [ids])).rows[0].n
      expect({ rls, store, count }, `${reader.principal.id}/${reader.assistant?.id}`).toEqual({ rls: expected, store: expected, count: expected.length })
    }
  })

  it('the mutation floor and the store mutation predicate admit members only, never oversight (D27)', async () => {
    for (const reader of PROJECT_READERS) {
      for (const row of ALL_PROJECT_ROWS) {
        const expected = read(shifted, reader, { ...row, userId: null }, { ...dbCtx({ workspaceId: WORKSPACE, department: null, now }), operation: 'mutation' })
        const floor = (await viaRls(reader, 'SELECT member_operation_scope_allows($1,$2,$3,true) AS allowed', [WORKSPACE, row.tier, labels(row)])).rows[0].allowed
        const store = (await viaStore(reader, 'id=$1', [row.id], 'mutation')).rowCount === 1
        const storeExpected = read(shifted, reader, row, { ...dbCtx({ workspaceId: WORKSPACE, department: null, now }), operation: 'mutation' })
        expect({ floor, store }, `${reader.principal.id}/${reader.assistant?.id}/${row.id}`).toEqual({ floor: expected, store: storeExpected })
      }
    }
  })

  it('an expired membership is no membership on every path', async () => {
    const priya = PROJECT_READERS.find(r => r.principal.id === PEOPLE.priya.id)!
    await q('UPDATE project_shared_members SET expires_at = now() - interval \'1 minute\' WHERE project_id=$1 AND user_id=$2', [PROJECTS.atlas, PEOPLE.priya.id])
    try {
      expect((await viaRls(priya, 'SELECT id FROM tasks WHERE id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(0)
      expect((await viaStore(priya, 'id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(0)
      expect((await grantFor(priya)).grant.projects).toEqual({})
    } finally {
      await q('UPDATE project_shared_members SET expires_at = now() + interval \'16 days\' WHERE project_id=$1 AND user_id=$2', [PROJECTS.atlas, PEOPLE.priya.id])
    }
  })

  it('disabling the capability makes Project material unavailable, never General; re-enabling restores it', async () => {
    const maya = PROJECT_READERS.find(r => r.principal.id === PEOPLE.maya.id && r.assistant?.id === ASSISTANTS.brian.id)!
    const ava = PROJECT_READERS.find(r => r.principal.id === PEOPLE.ava.id && !r.assistant)!
    await q('UPDATE workspaces SET project_shared_spaces=false WHERE id=$1', [WORKSPACE])
    try {
      for (const reader of [maya, ava]) {
        expect((await viaRls(reader, 'SELECT id FROM tasks WHERE id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(0)
        expect((await viaStore(reader, 'id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(0)
      }
    } finally {
      await q('UPDATE workspaces SET project_shared_spaces=true WHERE id=$1', [WORKSPACE])
    }
    expect((await viaRls(maya, 'SELECT id FROM tasks WHERE id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(1)
  })

  it('a workspace rolled back to the legacy read rule admits no Project-labelled row, even to an admin universe', async () => {
    const jun = PROJECT_READERS.find(r => r.principal.id === PEOPLE.jun.id && !r.assistant)!
    const maya = PROJECT_READERS.find(r => r.principal.id === PEOPLE.maya.id && r.assistant?.id === ASSISTANTS.brian.id)!
    await q('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [WORKSPACE])
    try {
      for (const reader of [jun, maya]) expect((await viaRls(reader, 'SELECT id FROM tasks WHERE id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(0)
    } finally {
      await q('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [WORKSPACE])
    }
  })

  it('a label naming no shared scope in the row workspace is refused at write time', async () => {
    await expect(q(`INSERT INTO tasks(workspace_id,title,sensitivity,compartments) VALUES($1,'x','internal',$2)`, [WORKSPACE, [`project:${PROJECTS.legacy}`]]))
      .rejects.toThrow(/project_scope_label_invalid/)
  })
})
