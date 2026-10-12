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
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createDbSavedViewStore } from '../../db/saved-views-store.js'
import { createDbPageGrantStore } from '../../db/page-grant-store.js'
import { projectAggregates, projectContent } from '../../db/project-aggregates.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { admitWorkspaceResource } from '../../workspace-access/resource-admission.js'
import { decideSessionRead } from '../../session-read-access.js'
import { accessCeilingContains } from '@use-brian/core'
import { createAuthorityLease } from '../authority-lease.js'
import { automaticContextAccess, resolveLiveAccessCeilingSystem, type TurnScopeAssistant } from '../resolve-turn-scope.js'
import { buildAccessPredicate } from '../../db/access-predicate.js'

import { buildDepartmentReadPredicate } from '../../db/access-predicate.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../department-resolver.js'
import { read, readable, type AccessSnapshot, type Ctx, type Reader, type Row } from '../reference-predicate.js'
import { ASSISTANTS, DEPARTMENTS, EDGES, PEOPLE, ROLES, SALES_OWNER, SNAPSHOT, WORKSPACE } from './fixtures/access-matrix.js'
import { ALL_PROJECT_ROWS, PROJECT_CASES, PROJECT_EDGES, PROJECT_OWNERS, PROJECT_READERS, PROJECT_ROWS, PROJECT_SNAPSHOT, PROJECTS } from './fixtures/project-shared-matrix.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
// The doc-sync page gate, run against the real database (outside this package's typecheck root).
const { assertPageAccess } = await import(new URL('../../../../../apps/doc-sync/src/clearance-gate.ts', import.meta.url).href) as {
  assertPageAccess: (params: { userId: string; pageId: string; query: never }) => Promise<{ role: string }>
}

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
      expect((await grantFor(priya)).grant.projects ?? {}).toEqual({})
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


  // ── Phase 3: whole-resource propagation on actual writers and readers ──

  const pageStore = createDbSavedViewStore()
  const human = { provenance: { kind: 'human-authored' as const, actorId: PEOPLE.maya.id } }
  const draft = (name: string, extra: Record<string, unknown>) => pageStore.createDraft({ userId: PEOPLE.maya.id, workspaceId: WORKSPACE, name,
    entity: 'tasks', viewType: 'table', binding: { entity: 'tasks', viewType: 'table' }, page: { blocks: [] }, ...extra } as never, human)
  const readers = () => ({
    maya: PROJECT_READERS.find(r => r.principal.id === PEOPLE.maya.id && r.assistant?.id === ASSISTANTS.brian.id)!,
    priya: PROJECT_READERS.find(r => r.principal.id === PEOPLE.priya.id)!,
    jun: PROJECT_READERS.find(r => r.principal.id === PEOPLE.jun.id && !r.assistant)!,
    ava: PROJECT_READERS.find(r => r.principal.id === PEOPLE.ava.id && !r.assistant)!,
  })

  it('pages: a Project collection page is read by participants and the workspace owner, edited only by participants, inherited by children', async () => {
    const r = readers()
    const page = await draft('Atlas plan', { sharedProjectId: PROJECTS.atlas })
    expect(page).toMatchObject({ sharedProjectId: PROJECTS.atlas, teamspaceId: null, projectId: PROJECTS.atlas })
    const visible = async (reader: Reader) => (await viaRls(reader, 'SELECT id FROM saved_views WHERE id=$1', [page.id])).rowCount === 1
    expect({ maya: await visible(r.maya), priya: await visible(r.priya), jun: await visible(r.jun), ava: await visible(r.ava) })
      .toEqual({ maya: true, priya: true, jun: false, ava: true })
    const canMutate = async (reader: Reader) => (await viaRls(reader,
      'SELECT saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true,shared_project_id) AS ok FROM saved_views WHERE id=$1', [page.id])).rows[0]?.ok ?? false
    expect({ maya: await canMutate(r.maya), ava: await canMutate(r.ava) }).toEqual({ maya: true, ava: false })
    // A child stays in the collection; moving into or out of it is refused.
    const child = await draft('Atlas notes', { nestParentId: page.id })
    expect(child.sharedProjectId).toBe(PROJECTS.atlas)
    await expect(q('UPDATE saved_views SET shared_project_id=NULL WHERE id=$1', [child.id])).rejects.toThrow(/project_placement_move_refused/)
    const general = await draft('Unrelated', { teamspaceId: null })
    await expect(q('UPDATE saved_views SET nest_parent_id=$2 WHERE id=$1', [general.id, page.id])).rejects.toThrow(/project_placement_move_refused/)
    // An oversight reader cannot write a child into the collection.
    await expect(queryWithRLS(PEOPLE.ava.id, `INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,binding,state,shared_project_id,clearance)
      VALUES($1,$2,'x','tasks','table','{}'::jsonb,'draft',$3,'internal')`, [WORKSPACE, PEOPLE.ava.id, PROJECTS.atlas])).rejects.toThrow()
  })

  it('pages: publication and link tokens never widen Project material (unsupported release refused)', async () => {
    const grants = createDbPageGrantStore()
    const page = await draft('Atlas public?', { sharedProjectId: PROJECTS.atlas })
    await expect(grants.publishPage({ userId: PEOPLE.maya.id, pageId: page.id, indexable: false })).rejects.toMatchObject({ code: 'project_publication_unsupported' })
    // Even a pre-existing grant on a public page resolves nothing.
    await q(`UPDATE saved_views SET clearance='public' WHERE id=$1`, [page.id])
    await q(`UPDATE workspaces SET external_sharing_enabled=true WHERE id=$1`, [WORKSPACE])
    await q(`INSERT INTO page_grants(page_id,principal_type,principal_ref,role,created_by) VALUES($1,'published',$2,'view',$3)`, [page.id, page.id, PEOPLE.maya.id])
    await q(`INSERT INTO page_grants(page_id,principal_type,principal_ref,role,created_by) VALUES($1,'link','fixture-token-hash','view',$2)`, [page.id, PEOPLE.maya.id])
    expect(await grants.resolvePublishedPage(page.id)).toBeNull()
    expect(await grants.resolveLinkPage('unused', page.id)).toBeNull()
  })

  it('aggregates and Project content: participants see counts and items, a nonparticipant admin sees nothing', async () => {
    const page = await draft('Atlas aggregate page', { sharedProjectId: PROJECTS.atlas })
    await q(`UPDATE saved_views SET state='saved' WHERE id=$1`, [page.id])
    const maya = await projectAggregates(PEOPLE.maya.id, WORKSPACE, PROJECTS.atlas)
    const jun = await projectAggregates(PEOPLE.jun.id, WORKSPACE, PROJECTS.atlas)
    expect(maya.pages ?? 0).toBeGreaterThan(0)
    expect(jun.pages ?? 0).toBe(0)
    const items = async (userId: string) => (await projectContent(userId, WORKSPACE, PROJECTS.atlas, 'work', 'aggregate', 0)).items.map(i => i.id)
    expect(await items(PEOPLE.maya.id)).toContain(page.id)
    expect(await items(PEOPLE.jun.id)).toEqual([])
  })

  it('chats: a shared Project chat carries the label and follows admission; a private Project chat stays personal', async () => {
    const r = readers()
    const shared = (await q(`INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,visibility,workspace_id,effective_clearance,context_project_id)
      VALUES($1,$2,'web',gen_random_uuid()::text,'workspace',$3,'internal',$4) RETURNING id, context_compartments`, [ASSISTANTS.brian.id, PEOPLE.maya.id, WORKSPACE, PROJECTS.atlas])).rows[0]
    expect(shared.context_compartments).toEqual([`project:${PROJECTS.atlas}`])
    await q(`INSERT INTO session_messages(session_id,role,content,sequence_num) VALUES($1,'user','"Atlas kickoff"'::jsonb,1)`, [shared.id])
    const sees = async (reader: Reader, id: string) => ({
      session: (await viaRls(reader, 'SELECT id FROM sessions WHERE id=$1', [id])).rowCount === 1,
      messages: (await viaRls(reader, 'SELECT id FROM session_messages WHERE session_id=$1', [id])).rowCount! > 0,
    })
    expect(await sees(r.maya, shared.id)).toEqual({ session: true, messages: true })
    expect(await sees(r.priya, shared.id)).toEqual({ session: true, messages: true })
    expect(await sees(r.jun, shared.id)).toEqual({ session: false, messages: false })
    expect(await sees(r.ava, shared.id)).toEqual({ session: true, messages: true })
    // The private option: a personal session associated with the Project.
    const personal = (await q(`INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,visibility,workspace_id,context_project_id)
      VALUES($1,$2,'web',gen_random_uuid()::text,'personal',$3,$4) RETURNING id, context_compartments`, [ASSISTANTS.brian.id, PEOPLE.maya.id, WORKSPACE, PROJECTS.atlas])).rows[0]
    expect(personal.context_compartments).toEqual([])
    expect((await sees(r.ava, personal.id)).session).toBe(false)
    expect((await sees(r.priya, personal.id)).session).toBe(false)
    // The read gate the Live roster and stream share evaluates the label too.
    const decide = async (userId: string) => {
      const query = <R>(sql: string, v: unknown[]) => pool.query(sql, v) as unknown as Promise<{ rows: R[] }>
      const departmentAccess = await loadDepartmentSnapshot(query, { workspaceId: WORKSPACE, userId, assistantId: null })
      return decideSessionRead({ callerUserId: userId, assistantWorkspaceId: WORKSPACE, membershipClearance: 'internal', departmentAccess,
        session: { userId: PEOPLE.maya.id, visibility: 'workspace', mode: null, effectiveClearance: 'internal', contextCompartments: shared.context_compartments } }).readable
    }
    expect({ priya: await decide(PEOPLE.priya.id), jun: await decide(PEOPLE.jun.id), ava: await decide(PEOPLE.ava.id) }).toEqual({ priya: true, jun: false, ava: true })
  })

  it('admission: a Project destination stamps the label, keeps source Departments, and refuses oversight and absent assistants', async () => {
    const admit = async (userId: string, assistantId: string | null, input: Parameters<typeof admitWorkspaceResource>[3]) => {
      const reader: Reader = { principal: { kind: 'user', id: userId }, assistant: assistantId ? { kind: 'assistant', id: assistantId } : null }
      const { grant } = await grantFor(reader)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        return await runWithAgentAccess({ workspaceId: WORKSPACE, userId, clearance: 'confidential', compartments: null, departmentRead: grant },
          () => admitWorkspaceResource(client, WORKSPACE, userId, input))
      } finally { await client.query('ROLLBACK'); client.release() }
    }
    const destination = { kind: 'project' as const, projectId: PROJECTS.atlas }
    const ok = await admit(PEOPLE.maya.id, ASSISTANTS.brian.id, { visibility: 'workspace', sensitivity: 'internal', destination })
    expect(ok.envelope).toMatchObject({ compartments: [`project:${PROJECTS.atlas}`], projectIds: [PROJECTS.atlas] })
    const derived = await admit(PEOPLE.maya.id, ASSISTANTS.brian.id, { visibility: 'workspace', sensitivity: 'public', destination,
      inherited: { visibility: 'workspace', sensitivity: 'internal', compartments: [`team:${DEPARTMENTS.finance}`], projectIds: [] }, inheritedAuthority: 'read' })
    expect(derived.envelope.compartments).toEqual([`project:${PROJECTS.atlas}`, `team:${DEPARTMENTS.finance}`].sort())
    expect(derived.envelope.sensitivity).toBe('internal')
    await expect(admit(PEOPLE.ava.id, null, { visibility: 'workspace', sensitivity: 'internal', destination })).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(admit(PEOPLE.maya.id, ASSISTANTS.ops.id, { visibility: 'workspace', sensitivity: 'internal', destination })).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(admit(PEOPLE.jun.id, ASSISTANTS.brian.id, { visibility: 'workspace', sensitivity: 'internal', destination })).rejects.toMatchObject({ code: 'context_not_available' })
  })


  // ── Phase 4: live authority, delivery and collaboration contraction ──

  const brianRow = async (): Promise<TurnScopeAssistant> => (await q(`SELECT id, workspace_id AS "workspaceId", kind, clearance, compartments,
      default_compartments AS "defaultCompartments", team_scope_mode AS "teamScopeMode", default_workspace_group_id AS "defaultWorkspaceGroupId",
      project_scope_mode AS "projectScopeMode", default_project_id AS "defaultProjectId" FROM assistants WHERE id=$1`, [ASSISTANTS.brian.id])).rows[0]
  const liveCeiling = async (userId: string) => (await resolveLiveAccessCeilingSystem({ userId, assistant: await brianRow(),
    workspaceId: WORKSPACE, session: { contextGroupId: null, contextProjectId: PROJECTS.atlas, contextLockedAt: new Date() } as never }))

  it('doc-sync: the per-message page gate reads current admission; oversight connects read-only; removal disconnects', async () => {
    const page = await draft('Atlas live doc', { sharedProjectId: PROJECTS.atlas })
    const rls = (<R,>(userId: string, sql: string, values: unknown[]) => queryWithRLS<R & Record<string, unknown>>(userId, sql, values).then(r => r.rows)) as never
    const access = (userId: string) => assertPageAccess({ userId, pageId: page.id, query: rls })
    expect((await access(PEOPLE.priya.id)).role).not.toBe('view')
    expect((await access(PEOPLE.ava.id)).role).toBe('view')
    await expect(access(PEOPLE.jun.id)).rejects.toThrow()
    await q('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2', [PROJECTS.atlas, PEOPLE.priya.id])
    try {
      await expect(access(PEOPLE.priya.id)).rejects.toThrow()
    } finally {
      await q(`INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,expires_at,origin) VALUES($1,$2,'user',$3,now()+interval '16 days','invited')`,
        [WORKSPACE, PROJECTS.atlas, PEOPLE.priya.id])
    }
  })

  it('a running turn bound to the Project is invalidated by removal and is never revived by a later re-invite', async () => {
    const starting = await liveCeiling(PEOPLE.priya.id)
    expect(starting.departmentRead?.projects).toMatchObject({ [PROJECTS.atlas]: 'member' })
    const lease = createAuthorityLease(starting, async () => { try { return await liveCeiling(PEOPLE.priya.id) } catch { return null } })
    await expect(lease.assertCurrent()).resolves.toBeUndefined()
    await q('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2', [PROJECTS.atlas, PEOPLE.priya.id])
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    await q(`INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,expires_at,origin) VALUES($1,$2,'user',$3,now()+interval '16 days','invited')`,
      [WORKSPACE, PROJECTS.atlas, PEOPLE.priya.id])
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    // Removing the acting assistant from the roster contracts the same way.
    const fresh = createAuthorityLease(await liveCeiling(PEOPLE.maya.id), async () => { try { return await liveCeiling(PEOPLE.maya.id) } catch { return null } })
    await q('DELETE FROM project_shared_members WHERE project_id=$1 AND assistant_id=$2', [PROJECTS.atlas, ASSISTANTS.brian.id])
    try {
      await expect(fresh.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    } finally {
      await q(`INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,assistant_id,origin) VALUES($1,$2,'assistant',$3,'invited')`,
        [WORKSPACE, PROJECTS.atlas, ASSISTANTS.brian.id])
    }
  })

  it('losing the workspace-owner role ends oversight immediately; a frozen ceiling cannot gain a Project invited later', async () => {
    const ava = PROJECT_READERS.find(r => r.principal.id === PEOPLE.ava.id && !r.assistant)!
    const before = (await grantFor(ava)).grant
    expect(before.projects).toMatchObject({ [PROJECTS.atlas]: 'oversight' })
    await q(`UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2`, [WORKSPACE, PEOPLE.ava.id])
    try {
      const after = (await grantFor(ava)).grant
      expect(after.projects ?? {}).toEqual({})
      expect((await viaRls(ava, 'SELECT id FROM tasks WHERE id=$1', [PROJECT_ROWS.note.id])).rowCount).toBe(0)
      const base = { workspaceId: WORKSPACE, userId: PEOPLE.ava.id, clearance: 'confidential' as const, compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null }
      expect(accessCeilingContains({ ...base, departmentRead: after }, { ...base, departmentRead: before })).toBe(false)
    } finally {
      await q(`UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, [WORKSPACE, PEOPLE.ava.id])
    }
  })


  it('relevance (D18): admitted to A and B, a turn about A injects no B material automatically; an explicit read still reaches B', async () => {
    const maya = PROJECT_READERS.find(r => r.principal.id === PEOPLE.maya.id && r.assistant?.id === ASSISTANTS.brian.id)!
    const { grant } = await grantFor(maya)
    const access = { workspaceId: WORKSPACE, userId: PEOPLE.maya.id, assistantId: ASSISTANTS.brian.id, assistantKind: 'standard' as const, departmentRead: grant }
    const ids = [PROJECT_ROWS.note.id, PROJECT_ROWS.beaconNote.id]
    const select = async (ctx: typeof access) => {
      const predicate = buildAccessPredicate(ctx, { startIdx: 2 })
      return (await pool.query(`SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND ${predicate.sql} ORDER BY id`, [ids, ...predicate.params])).rows.map(r => r.id)
    }
    expect(await select(access)).toEqual([...ids].sort())
    expect(await select(automaticContextAccess(access, PROJECTS.atlas))).toEqual([PROJECT_ROWS.note.id])
    expect(await select(automaticContextAccess(access, null))).toEqual([])
  })

  it('a label naming no shared scope in the row workspace is refused at write time', async () => {
    await expect(q(`INSERT INTO tasks(workspace_id,title,sensitivity,compartments) VALUES($1,'x','internal',$2)`, [WORKSPACE, [`project:${PROJECTS.legacy}`]]))
      .rejects.toThrow(/project_scope_label_invalid/)
  })
})
