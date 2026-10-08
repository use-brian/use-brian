import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, query, queryWithRLS, rollbackAndRelease } from '../client.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

async function fixture(options: { channel?: string; locked?: boolean; general?: boolean; placement?: boolean } = {}) {
  const workspace = randomUUID(), owner = randomUUID(), peer = randomUUID(), custodian = randomUUID(), assistant = randomUUID(), session = randomUUID()
  for (const user of [owner, peer, custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional session source','test',$2)", [workspace, custodian])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, custodian])
  for (const user of [owner, peer]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspace, user])
  const department = (await createDbWorkspaceGroupStore().createTeam(custodian, workspace, { name: 'Session department', key: 'session-department' })).id
  for (const user of [owner, peer]) await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace, department, user])
  await query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,placement_department_id) VALUES($1,$2,'Source assistant','standard','confidential',$3)", [assistant, workspace, options.placement ? department : null])
  await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at,context_group_id,context_compartments,effective_clearance) VALUES($1::uuid,$2,$3,$4,$5,$1::text,'idle','owner',$6,$7,$8,'confidential')",
    [session, workspace, assistant, owner, options.channel ?? 'web', options.locked === false ? null : new Date(), options.general ? null : department, options.general ? [] : [`team:${department}`]])
  const read = async (actor = owner, w = workspace) => (await queryWithRLS<{ source: ScopeSource | null }>(actor,
    "SELECT read_entity_derivation_source($1,'browser_session',$2) AS source", [w, session])).rows[0].source
  const input = () => ({ workspaceId: workspace, userId: owner, assistantId: null, createdByUserId: owner,
    sensitivity: 'confidential' as const, compartments: [`team:${department}`], projectIds: [],
    path: `/${randomUUID()}.txt`, parentPath: '/', name: 'download.txt', mime: 'text/plain', sizeBytes: 1,
    storageUri: 'fixture://session-download', tags: [], relatedIds: [], metadata: {} })
  return { workspace, owner, peer, custodian, department, assistant, session, read, input }
}

describe('[COMP:sandbox/session-source] originating owner web session', () => {
  it('retains private context, ignores cosmetic activity, and refuses foreign or revoked readers', async () => {
    const f = await fixture(), source = await f.read()
    expect(source).toMatchObject({ resourceKind: 'browser_session', resourceId: f.session, version: '1', workspaceId: f.workspace,
      userId: f.owner, assistantId: null, sensitivity: 'confidential', compartments: [`team:${f.department}`], projectIds: [] })
    await query("UPDATE sessions SET title='Fictional new title',last_active_at=clock_timestamp() WHERE id=$1", [f.session])
    expect(await f.read()).toEqual(source)
    expect(await f.read(f.peer)).toBeNull()
    expect(await f.read(f.owner, randomUUID())).toBeNull()
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner])
    expect(await f.read()).toBeNull()
  })

  it('preserves private files and invalidates exact source versions on hold or deletion', async () => {
    const f = await fixture(), source = (await f.read())!, files = createDbWorkspaceFilesStore()
    const save = (snapshot = source) => files.createDerived(f.owner, f.input(), { producer: 'browser-session-fixture', sources: [snapshot] })
    const saved = await save()
    expect(saved).toMatchObject({ userId: f.owner, compartments: [`team:${f.department}`] })
    const access = { workspaceId: f.workspace, userId: f.owner, assistantId: '', assistantKind: 'primary' as const, clearance: 'confidential' as const }
    expect((await files.getById(access, saved.id))?.id).toBe(saved.id)
    expect(await files.getById({ ...access, userId: f.peer }, saved.id)).toBeNull()
    await query("UPDATE sessions SET context_binding_origin='held' WHERE id=$1", [f.session])
    expect(await f.read()).toBeNull()
    expect((await query('SELECT scope_held FROM workspace_files WHERE id=$1', [saved.id])).rows[0].scope_held).toBe(true)
    await expect(save()).rejects.toThrow()
    await query("UPDATE sessions SET context_binding_origin='explicit' WHERE id=$1", [f.session])
    expect(await f.read()).toMatchObject({ version: '3' })
    const recovered = await save((await f.read())!)
    await query('DELETE FROM sessions WHERE id=$1', [f.session])
    expect((await query('SELECT scope_held FROM workspace_files WHERE id=$1', [recovered.id])).rows[0].scope_held).toBe(true)
    expect(await files.getById(access, recovered.id)).toBeNull()
  })

  it('uses the department tier rather than General clearance for an inherited write', async () => {
    const f = await fixture()
    await query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.owner])
    const source = (await f.read())!
    expect(source).toMatchObject({ sensitivity: 'confidential' })
    const saved = await createDbWorkspaceFilesStore().createDerived(f.owner, f.input(), { producer: 'browser-session-fixture', sources: [source] })
    expect(saved).toMatchObject({ sensitivity: 'confidential', compartments: [`team:${f.department}`], userId: f.owner })
    const other = await createDbWorkspaceGroupStore().createTeam(f.custodian, f.workspace, { name: 'Other destination', key: 'other-destination' })
    await expect(createDbWorkspaceFilesStore().createDerived(f.owner,
      { ...f.input(), compartments: [`team:${f.department}`, `team:${other.id}`] },
      { producer: 'browser-session-fixture', sources: [source] })).rejects.toThrow()
  })

  it.each([{ channel: 'telegram' }, { locked: false }])('refuses unsupported source qualification: %j', async options => {
    const f = await fixture(options)
    expect(await f.read()).toBeNull()
  })

  it('retains the canonical historical READ of a locked archived department', async () => {
    const f = await fixture(), source = await f.read()
    await query("UPDATE workspace_groups SET status='archived' WHERE id=$1", [f.department])
    expect(await f.read()).toEqual(source)
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner])
    expect(await f.read()).toBeNull()
  })

  it('requires the bound assistant placement even for a General session', async () => {
    const f = await fixture({ general: true, placement: true })
    expect(await f.read()).toMatchObject({ compartments: [], userId: f.owner })
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner])
    expect(await f.read()).toBeNull()
  })

  it('requires placement access to a different executing assistant', async () => {
    const f = await fixture({ general: true }), acting = randomUUID()
    await query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,placement_department_id) VALUES($1,$2,'Placed executor','standard','confidential',$3)", [acting, f.workspace, f.department])
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner])
    expect(await f.read()).not.toBeNull()
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, f.owner)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [acting])
      expect((await client.query("SELECT read_entity_derivation_source($1,'browser_session',$2) AS source", [f.workspace, f.session])).rows[0].source).toBeNull()
    } finally { await rollbackAndRelease(client) }
  })

  it('keeps the acting assistant floor and rolls expiry back at commit', async () => {
    const f = await fixture()
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'public','store')", [f.workspace, f.department, f.assistant])
    const client = await getAppPool().connect(), id = randomUUID()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, f.owner)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [f.assistant])
      expect((await client.query("SELECT read_entity_derivation_source($1,'browser_session',$2) AS source", [f.workspace, f.session])).rows[0].source).toBeNull()
      await client.query('ROLLBACK')
      await query("UPDATE department_edges SET clearance='confidential',expires_at=clock_timestamp()+interval '1 second' WHERE workspace_id=$1 AND assistant_id=$2", [f.workspace, f.assistant])
      await client.query('BEGIN'); await applyRLSGucs(client, f.owner)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [f.assistant])
      const source = (await client.query("SELECT read_entity_derivation_source($1,'browser_session',$2) AS source", [f.workspace, f.session])).rows[0].source
      expect(source).not.toBeNull()
      await client.query('SELECT * FROM create_source_derived_file($1::jsonb,$2::jsonb)', [JSON.stringify({ ...f.input(), id }), JSON.stringify({ producer: 'browser-session-fixture', sources: [source] })])
      await client.query('SELECT pg_sleep(1.1)')
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '42501', message: 'scope_source_changed' })
    } finally { await rollbackAndRelease(client) }
    expect((await query('SELECT id FROM workspace_files WHERE id=$1', [id])).rows).toEqual([])
  })
})
