import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, query, queryWithRLS, rollbackAndRelease } from '../client.js'
import { createBrowserProfileStore } from '../browser-profile-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createDbWorkspaceFilesStore } from '../workspace-files-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspace = randomUUID(), owner = randomUUID(), peer = randomUUID(), custodian = randomUUID()
  for (const user of [owner, peer, custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional profile source','test',$2)", [workspace, custodian])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, custodian])
  for (const user of [owner, peer]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspace, user])
  const department = (await createDbWorkspaceGroupStore().createTeam(custodian, workspace, { name: 'Source department', key: 'source-department' })).id
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [workspace, department, owner])
  const profiles = createBrowserProfileStore()
  const profile = await profiles.create({ workspaceId: workspace, ownerUserId: owner, name: 'Private source browser', scope: 'owner', departmentId: department })
  const read = async (actor = owner, id = profile.id, w = workspace) => (await queryWithRLS<{ source: ScopeSource | null }>(actor,
    "SELECT read_entity_derivation_source($1,'browser_profile',$2) AS source", [w, id])).rows[0].source
  return { workspace, owner, peer, department, profiles, profile, read }
}

describe('[COMP:sandbox/profile-source] canonical profile evidence', () => {
  it('preserves private department evidence, denies other actors, and refuses revoked authority', async () => {
    const f = await fixture(), source = await f.read()
    expect(source).toMatchObject({ resourceKind: 'browser_profile', resourceId: f.profile.id, version: '1',
      workspaceId: f.workspace, userId: f.owner, assistantId: null, sensitivity: 'confidential',
      compartments: [`team:${f.department}`], projectIds: [] })
    expect(JSON.stringify(source)).not.toContain(f.profile.name)
    expect(await f.read(f.peer)).toBeNull()
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [f.workspace, f.department, f.peer])
    expect(await f.read(f.peer)).toBeNull()
    expect(await f.read(f.owner, f.profile.id, randomUUID())).toBeNull()
    await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.owner])
    expect(await f.read()).toBeNull()
    await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner])
    expect(await f.read()).toEqual(source)
    await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner])
    expect(await f.read()).toBeNull()
  })

  it('versions semantic changes, validates exact snapshots, and holds saved descendants', async () => {
    const f = await fixture(), source = (await f.read())!
    await query("UPDATE browser_profiles SET name='Renamed source' WHERE id=$1", [f.profile.id])
    expect(await f.read()).toEqual(source)
    const files = createDbWorkspaceFilesStore()
    const write = (snapshot = source) => files.createDerived(f.owner, { workspaceId: f.workspace,
      path: `/${randomUUID()}.txt`, parentPath: '/', name: 'download.txt', mime: 'text/plain',
      sizeBytes: 1, storageUri: 'fixture://download', createdByUserId: f.owner,
      sensitivity: 'confidential', compartments: [`team:${f.department}`], projectIds: [],
    }, { producer: 'browser-download-fixture', sources: [snapshot] })
    const saved = await write()
    expect(saved).toMatchObject({ userId: f.owner, compartments: [`team:${f.department}`], sensitivity: 'confidential' })
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [f.workspace, f.department, f.peer])
    const peerAccess = { workspaceId: f.workspace, userId: f.peer, assistantId: '', assistantKind: 'primary' as const, clearance: 'confidential' as const }
    expect(await files.getById(peerAccess, saved.id)).toBeNull()
    expect((await query('SELECT scope_held FROM workspace_files WHERE id=$1', [saved.id])).rows[0].scope_held).toBe(false)
    await query("UPDATE browser_profiles SET scope='workspace' WHERE id=$1", [f.profile.id])
    expect(await f.read()).toMatchObject({ version: '2', userId: null })
    expect((await query('SELECT scope_held FROM workspace_files WHERE id=$1', [saved.id])).rows[0].scope_held).toBe(true)
    await expect(write()).rejects.toThrow()
    const shared = await write((await f.read())!)
    expect((await files.getById(peerAccess, shared.id))?.id).toBe(shared.id)
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.peer])
    expect(await files.getById(peerAccess, shared.id)).toBeNull()
    await query('DELETE FROM browser_profiles WHERE id=$1', [f.profile.id])
    expect((await query('SELECT scope_held FROM workspace_files WHERE id=$1', [shared.id])).rows[0].scope_held).toBe(true)
    const unclassified = await f.profiles.create({ workspaceId: f.workspace, ownerUserId: f.owner, name: 'Unclassified shared source', scope: 'workspace' })
    expect(await f.read(f.owner, unclassified.id)).toBeNull()
  })

  it('locks profile classification and supporting access until the reader transaction ends', async () => {
    const f = await fixture(), reader = await getAppPool().connect(), revoker = await getPool().connect()
    try {
      await reader.query('BEGIN'); await applyRLSGucs(reader, f.owner)
      expect((await reader.query("SELECT read_entity_derivation_source($1,'browser_profile',$2) AS source", [f.workspace, f.profile.id])).rows[0].source).not.toBeNull()
      for (const sql of [
        'DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',
        "UPDATE browser_profiles SET scope='workspace' WHERE workspace_id=$1 AND owner_user_id=$2",
        'DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
      ]) {
        await revoker.query('BEGIN'); await revoker.query("SET LOCAL lock_timeout='100ms'")
        await expect(revoker.query(sql, [f.workspace, f.owner])).rejects.toMatchObject({ code: '55P03' })
        await revoker.query('ROLLBACK')
      }
    } finally { await rollbackAndRelease(reader); await rollbackAndRelease(revoker) }
  })

  it('requires the acting assistant department tier and current profile eligibility', async () => {
    const f = await fixture(), assistant = randomUUID()
    await query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Fictional browser assistant','standard','confidential')", [assistant, f.workspace, f.owner])
    await query('UPDATE browser_profiles SET enabled_assistant_ids=ARRAY[$2::uuid] WHERE id=$1', [f.profile.id, assistant])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'public','store')", [f.workspace, f.department, assistant])
    const readAsAgent = async () => {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN'); await applyRLSGucs(client, f.owner)
        await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [assistant])
        return (await client.query("SELECT read_entity_derivation_source($1,'browser_profile',$2) AS source", [f.workspace, f.profile.id])).rows[0].source
      } finally { await rollbackAndRelease(client) }
    }
    expect(await readAsAgent()).toBeNull()
    await query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND assistant_id=$2", [f.workspace, assistant])
    expect(await readAsAgent()).toMatchObject({ userId: f.owner, sensitivity: 'confidential', compartments: [`team:${f.department}`] })
    await query("UPDATE browser_profiles SET enabled_assistant_ids='{}' WHERE id=$1", [f.profile.id])
    expect(await readAsAgent()).toBeNull()
  })

  it('rolls back publication when a locked supporting edge expires before commit', async () => {
    const f = await fixture(), source = (await f.read())!, id = randomUUID()
    await query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.owner])
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, f.owner)
      await client.query('SELECT * FROM create_source_derived_file($1::jsonb,$2::jsonb)', [JSON.stringify({
        id, workspaceId: f.workspace, userId: f.owner, assistantId: null, createdByUserId: f.owner,
        sensitivity: 'confidential', compartments: [`team:${f.department}`], projectIds: [],
        path: '/expiry.txt', parentPath: '/', name: 'expiry.txt', mime: 'text/plain', sizeBytes: 1,
        storageUri: 'fixture://expiry', tags: [], relatedIds: [], metadata: {},
      }), JSON.stringify({ producer: 'browser-download-fixture', sources: [source] })])
      await client.query('SELECT pg_sleep(1.1)')
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '42501', message: 'scope_source_changed' })
    } finally { await rollbackAndRelease(client) }
    expect((await query('SELECT id FROM workspace_files WHERE id=$1', [id])).rows).toEqual([])
  })
})
