import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createKnowledgeSyncWorker, type DispatchEvent } from '@use-brian/core'
import { setKnowledgeEventDispatcher } from '../../knowledge-event-fanout.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as github from '../../github/client.js'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { createDbKnowledgeStore } from '../knowledge-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool = getPool(), store = createDbKnowledgeStore()
// The isolated fixture provisions its non-owner role AFTER migrations. Mirror
// only 632's three named runtime grants; no owner-role or broad function grant.
await pool.query(`GRANT EXECUTE ON FUNCTION claim_knowledge_source_sync(uuid,uuid,uuid,jsonb),
  release_knowledge_source_sync(uuid,uuid,uuid),apply_knowledge_source_sync(jsonb,jsonb) TO assurance_app`)
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function fixture(mode = 'simple', ready = true) {
  const userId = randomUUID(), workspaceId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Knowledge admission',$2,false)", [workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(userId,workspaceId,{name:'Default',key:'default'})
  const other = await groups.createTeam(userId,workspaceId,{name:'Other',key:'other'})
  await pool.query('UPDATE workspace_access_policies SET access_mode=$2,setup_state=$3,default_department_id=$4 WHERE workspace_id=$1',[workspaceId,mode,ready?'ready':'legacy',team.id])
  const input = (patch: Record<string,unknown> = {}) => ({workspaceId,path:randomUUID(),title:'Entry',content:'Body',sensitivity:'internal' as const,actorId:userId,...patch})
  return {userId,workspaceId,team,other,input}
}
describe('[COMP:api/knowledge-store] canonical knowledge ready-mode admission (production app pool)', () => {
  it('[COMP:api/workflow-input-evidence] emits exact source versions for synced create, update and deletion',async()=>{
    const f=await fixture('departments'),events:DispatchEvent[]=[]
    const source=await store.createSource({workspaceId:f.workspaceId,sourceType:'github',repo:'fixture/source',
      binding:{sensitivity:'internal',compartments:[],projectIds:[]}},{actorUserId:f.userId})
    const authority=(await store.captureSourceSync(source))!
    setKnowledgeEventDispatcher({dispatch:async event=>{events.push(event)}})
    try {
      const original=await store.upsertByPath(f.input({path:'event-source',sourceId:source.id,sourceSha:'first',compartments:[]}),authority)
      const updated=await store.upsertByPath(f.input({path:'event-source',title:'Updated fixture',sourceId:source.id,sourceSha:'second',compartments:[]}),authority)
      expect(await store.deleteByTeamAndPath(f.workspaceId,updated.path,authority)).toBe(true)
      expect(events.map(event=>event.payload)).toEqual([
        expect.objectContaining({entryId:original.id,sourceVersion:original.scopeVersion,action:'created'}),
        expect.objectContaining({entryId:updated.id,sourceVersion:updated.scopeVersion,action:'updated'}),
        expect.objectContaining({entryId:updated.id,sourceVersion:updated.scopeVersion,action:'deleted'}),
      ])
      expect(updated.scopeVersion).not.toBe(original.scopeVersion)
      for (const entry of [original,updated]) {
        expect((await pool.query('SELECT source FROM workflow_knowledge_event_receipts WHERE entry_id=$1 AND source_version=$2',[entry.id,entry.scopeVersion])).rows[0].source).toMatchObject({resourceId:entry.id,version:entry.scopeVersion,sensitivity:'internal'})
      }
    } finally {setKnowledgeEventDispatcher(null);await store.releaseSourceSync(authority)}
  })
  it('syncs through the real producer with frozen binding authority and canonical lineage', async () => {
    const f = await fixture('departments'), directory = await mkdtemp(join(tmpdir(), 'knowledge-binding-'))
    try {
      await writeFile(join(directory, 'index.md'), '---\ntitle: Bound source\n---\nCanonical content')
      const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'local', repo: directory,
        binding: { sensitivity: 'confidential', compartments: [f.other.compartmentKey!], projectIds: [] } }, { actorUserId: f.userId })
      const authority = await store.captureSourceSync(source)
      expect(authority).toBeDefined()
      await store.releaseSourceSync(authority!)
      await expect(store.upsertByPath(f.input({ sourceId: source.id, sourceSha: 'sha' }), {})).rejects.toThrow('knowledge_sync_authority_required')
      await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [f.workspaceId])
      const events: Array<{ type: string; error?: string }> = []
      const worker = createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [source] },
        api: {} as never, credentials: { getPat: async () => { throw new Error('local source must not fetch credentials') } }, onEvent: event => events.push(event) })
      await worker.tick()
      expect(events.filter(e => e.type === 'sync_error')).toEqual([])
      const entries = (await pool.query('SELECT id,sensitivity,compartments,scope_held FROM knowledge_entries WHERE workspace_id=$1', [f.workspaceId])).rows
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ sensitivity: 'confidential', compartments: [f.other.compartmentKey], scope_held: false })
      expect((await pool.query("SELECT s.source_kind FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1", [entries[0].id])).rows).toEqual([{ source_kind: 'knowledge_source' }])
      await expect(store.upsertByPath(f.input({ sourceId: source.id, sourceSha: 'late' }), authority)).rejects.toThrow('knowledge_source_changed')
      const current = (await store.getSource(source.id))!
      const liveAuthority = await store.captureSourceSync(current)
      const access = { workspaceId: f.workspaceId, userId: f.userId, clearance: 'confidential' as const, compartments: null, mutationCompartments: [], projectIds: null }
      const write = f.input({ sourceId: source.id, sourceSha: 'read-floor' })
      const derived = await runWithAgentAccess(access, () => store.upsertByPath(write, liveAuthority))
      expect(derived).toMatchObject({ compartments: [f.other.compartmentKey], sensitivity: 'confidential' })
      expect((await runWithAgentAccess(access, () => store.upsertByPath(write, liveAuthority))).id).toBe(derived.id)
      expect((await pool.query("SELECT id FROM scope_derivations WHERE resource_kind='knowledge_entry' AND resource_id=$1", [derived.id])).rowCount).toBe(1)
      await expect(runWithAgentAccess(access, () => store.upsertByPath({ ...write, compartments: [f.team.compartmentKey!] }, liveAuthority))).rejects.toBeDefined()
      await expect(store.upsertByPath({ ...write, userId: f.userId } as typeof write, liveAuthority)).rejects.toThrow('knowledge_partition_not_supported')
      await pool.query("UPDATE workspace_members SET role='member',clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
      await expect(store.upsertByPath(write, liveAuthority)).rejects.toBeDefined()
      await pool.query("UPDATE workspace_members SET role='owner',clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
      await pool.query('UPDATE workspace_knowledge_sources SET binding_held=true WHERE id=$1', [source.id])
      expect((await pool.query('SELECT scope_held FROM knowledge_entries WHERE workspace_id=$1', [f.workspaceId])).rows.every(row => row.scope_held)).toBe(true)
      await expect(store.upsertByPath(f.input({ sourceId: source.id, sourceSha: 'held' }), liveAuthority)).rejects.toThrow('knowledge_source_changed')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('fences deletion, links and checkpoints and never rewinds on errors', async () => {
    const f = await fixture('departments')
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/repo',
      binding: { sensitivity: 'internal', compartments: [], projectIds: [] } }, { actorUserId: f.userId })
    const authority = (await store.captureSourceSync(source))!
    const entry = await store.upsertByPath(f.input({ path: 'owned', sourceId: source.id, sourceSha: 'head', compartments: [] }), authority)
    const manual = await store.create(f.input({ compartments: [] }))
    await expect(store.deleteByTeamAndPath(f.workspaceId, manual.path, authority)).rejects.toThrow('knowledge_source_target_conflict')
    await expect(store.updateRelatedIds(manual.id, [entry.id], authority)).rejects.toThrow('knowledge_source_target_conflict')
    const foreign = await fixture('departments')
    const foreignEntry = await store.create(foreign.input({ compartments: [] }))
    await expect(store.updateRelatedIds(entry.id, [foreignEntry.id], authority)).rejects.toThrow('knowledge_source_target_conflict')
    await store.updateRelatedIds(entry.id, [manual.id], authority)
    const removable = await store.upsertByPath(f.input({ path: 'removable', sourceId: source.id, sourceSha: 'head', compartments: [] }), authority)
    expect(await store.deleteByTeamAndPath(f.workspaceId, removable.path, authority)).toBe(true)
    await store.updateSourceSync(source.id, 'new', null, authority)
    await expect(store.updateSourceSync(source.id, 'old', null, authority)).rejects.toThrow('knowledge_source_changed')
    await expect(store.updateSourceSync(source.id, 'old', 'late failure', authority)).rejects.toThrow('knowledge_source_changed')
    await expect(store.updateSourceSync(source.id, 'old', 'unfenced failure')).rejects.toThrow('knowledge_sync_authority_required')
    expect((await store.getSource(source.id))!.lastSyncedSha).toBe('new')
    const current = (await store.captureSourceSync((await store.getSource(source.id))!))!
    await pool.query("UPDATE workspace_members SET role='member',clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    await expect(store.deleteByTeamAndPath(f.workspaceId, entry.path, current)).rejects.toBeDefined()
    await pool.query("UPDATE workspace_members SET role='owner',clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    await pool.query('UPDATE workspace_knowledge_sources SET binding_held=true WHERE id=$1', [source.id])
    await expect(store.deleteByTeamAndPath(f.workspaceId, entry.path, current)).rejects.toThrow('knowledge_source_changed')
    await expect(store.updateRelatedIds(entry.id, [], current)).rejects.toBeDefined()
    expect((await pool.query('SELECT id FROM knowledge_entries WHERE id=$1', [entry.id])).rowCount).toBe(1)
  })
  it('rejects a deletion-only producer after its captured source is held', async () => {
    const f = await fixture('departments')
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/repo', rootPath: 'docs',
      binding: { sensitivity: 'internal', compartments: [], projectIds: [] } }, { actorUserId: f.userId })
    const initial = (await store.captureSourceSync(source))!
    const entry = await store.upsertByPath(f.input({ path: 'removed', sourceId: source.id, sourceSha: 'old', compartments: [] }), initial)
    await store.updateSourceSync(source.id, 'old', null, initial)
    const current = (await store.getSource(source.id))!
    const events: Array<{ type: string }> = []
    const worker = createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [current] },
      credentials: { getPat: async () => 'test' }, onEvent: e => events.push(e), api: {
        getRepoPermissions: async () => ({ push: false }), getBranchHead: async () => 'new',
        compareCommits: async () => {
          await pool.query('UPDATE workspace_knowledge_sources SET binding_held=true WHERE id=$1', [source.id])
          return { headSha: 'new', files: [{ filename: 'docs/removed.md', status: 'removed' }] }
        },
      } as never })
    await worker.tick()
    expect(events.some(e => e.type === 'sync_error')).toBe(true)
    expect((await store.getSource(source.id))!.lastSyncedSha).toBe('old')
    expect((await pool.query('SELECT id FROM knowledge_entries WHERE id=$1', [entry.id])).rowCount).toBe(1)
  })
  it('rejects unbound ready removal through the producer and fences legacy ownership', async () => {
    const f = await fixture('departments', false)
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/unbound' })
    const other = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/other' })
    const manual = await store.create(f.input({ path: 'manual' }))
    const foreign = await store.create(f.input({ path: 'other', sourceId: other.id }))
    const owned = await store.create(f.input({ path: 'owned', sourceId: source.id }))
    await store.updateSourceSync(source.id, 'base')
    const current = (await store.getSource(source.id))!
    const authority = (await store.captureSourceSync(current))!
    await expect(store.deleteByTeamAndPath(f.workspaceId, manual.path, authority)).rejects.toThrow('knowledge_source_target_conflict')
    await expect(store.deleteByTeamAndPath(f.workspaceId, foreign.path, authority)).rejects.toThrow('knowledge_source_target_conflict')
    expect(await store.deleteByTeamAndPath(f.workspaceId, owned.path, authority)).toBe(true)
    await store.updateSourceSync(source.id, 'base', null, authority)
    const legacyErrors: string[] = []
    await createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [(await store.getSource(source.id))!] },
      credentials: { getPat: async () => 'test' }, onEvent: e => { if (e.type === 'sync_error') legacyErrors.push(e.error!) }, api: {
        getRepoPermissions: async () => ({ push: false }), getBranchHead: async () => 'new',
        compareCommits: async () => ({ headSha: 'new', files: [{ filename: 'manual.md', status: 'removed' }] }),
      } as never }).tick()
    expect(legacyErrors).toContain('knowledge_source_target_conflict')
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.workspaceId])
    const events: Array<{ type: string }> = []
    let io = 0
    await createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [current] },
      credentials: { getPat: async () => { io++; return 'test' } }, onEvent: e => events.push(e), api: {
        getRepoPermissions: async () => ({ push: false }), getBranchHead: async () => 'new',
        compareCommits: async () => ({ headSha: 'new', files: [{ filename: 'manual.md', status: 'removed' }] }),
      } as never }).tick()
    expect(events.some(e => e.type === 'sync_error')).toBe(true)
    expect(io).toBe(0)
    await expect(store.deleteByTeamAndPath(f.workspaceId, manual.path)).rejects.toThrow('knowledge_sync_authority_required')
    expect((await pool.query('SELECT id FROM knowledge_entries WHERE id=ANY($1::uuid[])', [[manual.id, foreign.id]])).rowCount).toBe(2)
  })

  it('fences an expired old producer before publication while the new run still has the same base cursor', async () => {
    const f = await fixture('departments')
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/race',
      binding: { sensitivity: 'internal', compartments: [], projectIds: [] } }, { actorUserId: f.userId })
    const initial = (await store.captureSourceSync(source))!
    await store.upsertByPath(f.input({ path: 'page', content: 'base', sourceId: source.id, sourceSha: 'base', compartments: [] }), initial)
    await store.updateSourceSync(source.id, 'base', null, initial)
    const base = (await store.getSource(source.id))!
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
    const oldIO = deferred(), resumeOld = deferred(), newPublished = deferred(), finishNew = deferred()
    const errors: string[] = []
    const oldWorker = createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [base] },
      credentials: { getPat: async () => 'test' }, onEvent: e => { if (e.type === 'sync_error') errors.push(e.error!) }, api: {
        getRepoPermissions: async () => ({ push: false }), getBranchHead: async () => 'old-head',
        compareCommits: async () => ({ headSha: 'old-head', files: [{ filename: 'page.md', status: 'modified' }] }),
        getFileContents: async () => { oldIO.resolve(); await resumeOld.promise; return { content: 'old content' } },
      } as never })
    const oldRun = oldWorker.tick()
    await oldIO.promise
    await expect(store.captureSourceSync(base)).rejects.toThrow('knowledge_sync_in_progress')
    await pool.query("UPDATE workspace_knowledge_sources SET sync_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [source.id])
    let fullWalks = 0, diffs = 0
    const newWorker = createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [(await store.getSource(source.id))!],
      updateSourceSync: async (id, sha, error, authority) => { if (!error && sha === 'new-head') { newPublished.resolve(); await finishNew.promise } await store.updateSourceSync(id, sha, error, authority) },
    }, credentials: { getPat: async () => 'test' }, api: {
      getRepoPermissions: async () => ({ push: false }), getBranchHead: async () => 'new-head',
      getRepoTree: async () => { fullWalks++; return [{ path: 'page.md', sha: 'blob' }] },
      compareCommits: async () => { diffs++; throw new Error('recovery must not diff') },
      getFileContents: async () => ({ content: 'new content' }),
    } as never })
    const newRun = newWorker.tick()
    await newPublished.promise
    expect((await store.getSource(source.id))!.lastSyncedSha).toBe('base')
    resumeOld.resolve(); await oldRun
    expect(errors).toContain('knowledge_source_changed')
    expect((await pool.query('SELECT content FROM knowledge_entries WHERE workspace_id=$1 AND path=$2', [f.workspaceId, 'page'])).rows[0].content).toBe('new content')
    finishNew.resolve(); await newRun
    await newWorker.tick()
    expect(fullWalks).toBe(1); expect(diffs).toBe(0)
    expect((await store.getSource(source.id))!).toMatchObject({ lastSyncedSha: 'new-head', syncDirty: false, syncRunId: null })
  })

  it('fully reconciles interrupted writes even when HEAD equals the old checkpoint, including removals', async () => {
    const f = await fixture('departments')
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/recover',
      binding: { sensitivity: 'internal', compartments: [], projectIds: [] } }, { actorUserId: f.userId })
    const initial = (await store.captureSourceSync(source))!
    await store.updateSourceSync(source.id, 'base', null, initial)
    const interrupted = (await store.captureSourceSync((await store.getSource(source.id))!))!
    await store.upsertByPath(f.input({ path: 'page', content: 'partial', sourceId: source.id, sourceSha: 'abandoned', compartments: [] }), interrupted)
    await store.upsertByPath(f.input({ path: 'ghost', content: 'partial', sourceId: source.id, sourceSha: 'abandoned', compartments: [] }), interrupted)
    await store.releaseSourceSync(interrupted)
    let trees = 0
    await createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [(await store.getSource(source.id))!] },
      credentials: { getPat: async () => 'test' }, api: {
        getRepoPermissions: async () => ({ push: false }), getBranchHead: async () => 'base',
        getRepoTree: async () => { trees++; return [{ path: 'page.md', sha: 'blob' }] },
        getFileContents: async () => ({ content: 'restored base' }),
        compareCommits: async () => { throw new Error('must reconcile') },
      } as never }).tick()
    expect(trees).toBe(1)
    expect((await pool.query('SELECT path,content FROM knowledge_entries WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ path: 'page', content: 'restored base' }])
    expect((await store.getSource(source.id))!).toMatchObject({ lastSyncedSha: 'base', syncDirty: false, syncRunId: null })
  })

  it.each(['no actor', 'foreign member', 'read-only member'] as const)('denies direct app-role legacy entry points for %s', async caller => {
    const f = await fixture('departments', false), foreign = await fixture('departments', false)
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/private-legacy' })
    const entry = await store.create(f.input({ path: 'secret', content: 'private source content', sourceId: source.id, compartments: [f.other.compartmentKey!] }))
    const reader = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [reader])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'member','confidential','assigned')", [f.workspaceId, reader])
    const requestId = randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Read-only legacy fixture',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,
      [requestId, f.workspaceId, reader, f.other.id, 'b'.repeat(64), f.userId])
    await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`, [requestId])
    const actor = caller === 'no actor' ? null : caller === 'foreign member' ? foreign.userId : reader
    const direct = (sql: string, params: unknown[]) => actor === null ? getAppPool().query(sql, params)
      : runWithAgentAccess({ workspaceId: f.workspaceId, userId: actor, clearance: 'confidential', compartments: null, mutationCompartments: [], projectIds: [] },
        () => queryWithRLS(actor, sql, params))
    if (caller === 'read-only member') {
      expect((await direct(`SELECT member_operation_scope_allows($1,'internal',$2,false) AS readable,
        member_operation_scope_allows($1,'internal',$2,true) AS writable`, [f.workspaceId, [f.other.compartmentKey]])).rows).toEqual([{ readable: true, writable: false }])
      expect((await direct('SELECT id FROM knowledge_entries WHERE id=$1', [entry.id])).rows).toEqual([{ id: entry.id }])
    }
    // This is a real app-role SQL call, not the opaque TypeScript store gate.
    await expect(direct('SELECT * FROM claim_knowledge_source_sync($1,$2,$3,$4::jsonb)',
      [f.workspaceId, source.id, randomUUID(), JSON.stringify(source)])).rejects.toMatchObject({ code: '42501' })
    expect((await store.getSource(source.id))!.syncRunId).toBeNull()
    const authority = (await store.captureSourceSync(source))!
    const captured = (await store.getSource(source.id))!
    const input = { workspaceId: f.workspaceId, sourceId: source.id, path: entry.path, title: 'Overwrite', content: 'attacker content',
      sourceSha: 'attacker-sha', sensitivity: 'internal', compartments: [], projectIds: [], tags: [], relatedIds: [], targetId: entry.id,
      error: 'attacker error', writeAccess: true }
    for (const operation of ['upsert', 'delete', 'related', 'checkpoint', 'error', 'probe']) {
      await expect(direct('SELECT * FROM apply_knowledge_source_sync($1::jsonb,$2::jsonb)',
        [JSON.stringify({ ...input, operation }), JSON.stringify(captured)])).rejects.toMatchObject({ code: '42501' })
    }
    await expect(direct('SELECT release_knowledge_source_sync($1,$2,$3)',
      [f.workspaceId, source.id, captured.syncRunId])).rejects.toMatchObject({ code: '42501' })
    // Even possession of the precise live token cannot enter the privileged worker functions.
    await expect(direct('SELECT * FROM claim_knowledge_source_sync_worker($1,$2,$3,$4::jsonb)',
      [f.workspaceId, source.id, randomUUID(), JSON.stringify(source)])).rejects.toMatchObject({ code: '42501' })
    await expect(direct('SELECT * FROM apply_knowledge_source_sync_worker($1::jsonb,$2::jsonb)',
      [JSON.stringify({ ...input, operation: 'delete' }), JSON.stringify(captured)])).rejects.toMatchObject({ code: '42501' })
    await expect(direct('SELECT release_knowledge_source_sync_worker($1,$2,$3)',
      [f.workspaceId, source.id, captured.syncRunId])).rejects.toMatchObject({ code: '42501' })
    expect((await pool.query('SELECT content FROM knowledge_entries WHERE id=$1', [entry.id])).rows).toEqual([{ content: 'private source content' }])
    expect((await store.getSource(source.id))!).toMatchObject({ lastSyncedSha: null, syncRunId: captured.syncRunId, syncDirty: true, syncError: null })
    await store.releaseSourceSync(authority)
  })

  it('rejects truncated GitHub adapter inventories before recovery publishes, deletes, or checkpoints', async () => {
    const f = await fixture('departments')
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'github', repo: 'org/truncated',
      binding: { sensitivity: 'internal', compartments: [], projectIds: [] } }, { actorUserId: f.userId })
    const initial = (await store.captureSourceSync(source))!
    for (const path of ['visible', 'omitted']) await store.upsertByPath(f.input({ path, content: 'original '+path, sourceId: source.id, sourceSha: 'base', compartments: [] }), initial)
    await store.updateSourceSync(source.id, 'base', null, initial)
    const abandoned = (await store.captureSourceSync((await store.getSource(source.id))!))!
    await store.releaseSourceSync(abandoned) // dirty recovery, with an existing cursor
    const events: Array<{ type: string; error?: string }> = []
    let fileFetches = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'next' } }))
      if (url.includes('/git/trees/')) return new Response(JSON.stringify({ truncated: true, tree: [{ path: 'visible.md', sha: 'blob', type: 'blob' }] }))
      if (url.includes('/contents/')) { fileFetches++; return new Response(JSON.stringify({ content: Buffer.from('replacement').toString('base64'), encoding: 'base64' })) }
      if (url.endsWith('/repos/org/truncated')) return new Response(JSON.stringify({ permissions: { push: false } }))
      throw new Error('Unexpected GitHub request: '+url)
    }))
    try {
      // Actual GitHub adapter + actual core producer + production store/app pool.
      await createKnowledgeSyncWorker({ store: { ...store, getSourcesDueForSync: async () => [(await store.getSource(source.id))!] },
        api: github, credentials: { getPat: async () => 'test' }, onEvent: e => events.push(e) }).tick()
    } finally { vi.unstubAllGlobals() }
    expect(events).toContainEqual(expect.objectContaining({ type: 'sync_error', error: expect.stringContaining('tree is truncated') }))
    expect(events.some(e => e.type === 'sync_completed')).toBe(false)
    expect(fileFetches).toBe(0)
    expect((await pool.query('SELECT path,content,source_sha FROM knowledge_entries WHERE workspace_id=$1 ORDER BY path', [f.workspaceId])).rows).toEqual([
      { path: 'omitted', content: 'original omitted', source_sha: 'base' }, { path: 'visible', content: 'original visible', source_sha: 'base' },
    ])
    expect((await store.getSource(source.id))!).toMatchObject({ lastSyncedSha: 'base', syncDirty: true, syncRunId: null })
  })

  it('rejects resource-first source writers without waiting backwards', async () => {
    const f = await fixture('departments', false)
    const source = await store.createSource({ workspaceId: f.workspaceId, sourceType: 'local', repo: '/legacy' })
    const first = await pool.connect(), second = await pool.connect()
    try {
      await first.query('BEGIN')
      await first.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      await second.query('BEGIN')
      await second.query("SET LOCAL statement_timeout='1s'")
      await expect(second.query('UPDATE workspace_knowledge_sources SET write_access=true WHERE id=$1', [source.id])).rejects.toMatchObject({ code: '55P03' })
      await first.query('SELECT id FROM workspace_knowledge_sources WHERE id=$1 FOR UPDATE', [source.id])
    } finally { await first.query('ROLLBACK'); await second.query('ROLLBACK'); first.release(); second.release() }
  })
  it('configures an explicit immutable source binding with per-call actor authority', async () => {
    const f = await fixture('departments')
    const input = { workspaceId: f.workspaceId, sourceType: 'local' as const, repo: '/configured-kb',
      binding: { sensitivity: 'confidential' as const, compartments: [f.other.compartmentKey!], projectIds: [] } }
    await expect(store.createSource(input)).rejects.toThrow('knowledge_source_admission_required')
    await expect(store.createSource({ ...input, actorId: f.userId } as typeof input)).rejects.toThrow('knowledge_source_admission_required')
    await expect(runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'confidential', compartments: null, mutationCompartments: [], projectIds: null },
      () => store.createSource(input, { actorUserId: f.userId }))).rejects.toMatchObject({ code: 'context_not_available' })
    const source = await store.createSource(input, { actorUserId: f.userId })
    expect(source).toMatchObject({ configuredByUserId: f.userId, bindingVersion: '1', bindingSensitivity: 'confidential',
      bindingCompartments: [f.other.compartmentKey], bindingProjectIds: [], bindingHeld: false })
    expect(await store.getSource(source.id)).toMatchObject({ id: source.id, configuredByUserId: f.userId, bindingVersion: '1' })
    await store.updateSourceSync(source.id, 'current-head', null, await store.captureSourceSync(source))
    expect(await store.getSource(source.id)).toMatchObject({ lastSyncedSha: 'current-head', bindingVersion: '1' })
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [f.workspaceId])
    expect(await store.getSource(source.id)).toMatchObject({ bindingCompartments: [f.other.compartmentKey], bindingVersion: '1' })
    await expect(pool.query("UPDATE workspace_knowledge_sources SET repo='retargeted' WHERE id=$1", [source.id])).rejects.toThrow('knowledge_source_binding_immutable')
    await expect(store.updateSourceDefaultSensitivity(source.id, 'public')).rejects.toThrow('knowledge_source_binding_immutable')
    await pool.query('UPDATE workspace_knowledge_sources SET binding_held=true WHERE id=$1', [source.id])
    await expect(pool.query('UPDATE workspace_knowledge_sources SET binding_held=false WHERE id=$1', [source.id])).rejects.toThrow('knowledge_source_binding_held')
  })
  it.each(['create','upsertByPath'] as const)('%s defaults only omitted Simple labels', async method => {
    const f = await fixture()
    expect((await store[method](f.input())).compartments).toEqual([f.team.compartmentKey])
    for (const compartments of [[],null,[f.other.compartmentKey]]) await expect(store[method](f.input({compartments}))).rejects.toMatchObject({code:'access_mode_destination_conflict'})
    await expect(store[method](f.input({expectedPolicyRevision:'-1'}))).rejects.toMatchObject({code:'access_policy_conflict'})
    await expect(store[method](f.input({actorId:randomUUID()}))).rejects.toBeDefined()
    await expect(store[method](f.input({actorId:null}))).rejects.toThrow('knowledge_actor_required')
  })
  it('uses a non-owner SQL role and admits ordinary Simple members', async () => {
    const role = (await getAppPool().query(`SELECT r.rolsuper,r.rolbypassrls,
      current_user=(SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='knowledge_entries') AS owner
      FROM pg_roles r WHERE r.rolname=current_user`)).rows[0]
    expect(role).toEqual({rolsuper:false,rolbypassrls:false,owner:false})
    const f=await fixture(), member=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,member])
    const row=await store.upsertByPath(f.input({actorId:member}))
    expect(row.compartments).toEqual([f.team.compartmentKey])
    expect(await store.updateManualEntryContent(f.workspaceId,row.id,'Member update',{actorId:member})).toMatchObject({id:row.id})
    await expect(store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'blocked'})).rejects.toThrow('knowledge_source_admission_required')
  })
  it('uses Departments explicit choices and retains actual prior floors across mode changes', async () => {
    const f = await fixture('departments')
    await expect(store.create(f.input())).rejects.toMatchObject({code:'context_selection_required'})
    expect((await store.create(f.input({compartments:[]}))).compartments).toEqual([])
    const prior = await store.create(f.input({compartments:[f.other.compartmentKey],sensitivity:'confidential'}))
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1",[f.workspaceId])
    const updated = await store.upsertByPath(f.input({path:prior.path,sensitivity:'public'}))
    expect(updated).toMatchObject({id:prior.id,sensitivity:'confidential',compartments:[f.other.compartmentKey]})
    expect(await store.updateManualEntryContent(f.workspaceId,prior.id,'new',{actorId:f.userId})).toMatchObject({id:prior.id})
    await pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1',[prior.id])
    await expect(store.upsertByPath(f.input({path:prior.path}))).rejects.toBeDefined()
    await expect(store.updateManualEntryContent(f.workspaceId,prior.id,'held',{actorId:f.userId})).rejects.toBeDefined()
    expect((await pool.query('SELECT content FROM knowledge_entries WHERE id=$1',[prior.id])).rows[0].content).toBe('new')
  })
  it('enforces ambient mutation, confidentiality and Project ceilings on old and new rows', async () => {
    const f = await fixture(), row = await store.create(f.input())
    const ceiling = {workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,mutationCompartments:[],projectIds:null}
    await expect(runWithAgentAccess(ceiling,()=>store.create(f.input()))).rejects.toBeDefined()
    await expect(runWithAgentAccess(ceiling,()=>store.upsertByPath(f.input({path:row.path})))).rejects.toBeDefined()
    await expect(runWithAgentAccess(ceiling,()=>store.updateManualEntryContent(f.workspaceId,row.id,'denied'))).rejects.toBeDefined()
    await expect(runWithAgentAccess({...ceiling,mutationCompartments:null,clearance:'public'},()=>store.create(f.input()))).rejects.toBeDefined()
    await expect(store.create(f.input({projectIds:[randomUUID()]}))).rejects.toBeDefined()
    const foreign = await fixture()
    await expect(store.updateManualEntryContent(f.workspaceId,(await store.create(foreign.input())).id,'foreign',{actorId:f.userId})).rejects.toBeDefined()
  })
  it('preserves Projects and rejects private partitions rather than broadening them', async () => {
    const f = await fixture('departments'), projectId = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,f.workspaceId,f.userId])
    const row = await store.create(f.input({compartments:[f.team.compartmentKey],projectIds:[projectId]}))
    expect((await store.upsertByPath(f.input({path:row.path}))).projectIds).toEqual([projectId])
    await expect(runWithAgentAccess({workspaceId:f.workspaceId,userId:f.userId,clearance:'confidential',compartments:null,projectIds:[]},()=>store.upsertByPath(f.input({path:row.path})))).rejects.toBeDefined()
    await expect(store.create(f.input({userId:f.userId}))).rejects.toThrow('knowledge_partition_not_supported')
    await expect(store.create(f.input({assistantId:randomUUID()}))).rejects.toThrow('knowledge_partition_not_supported')
  })
  it('requires current SQL member mutation grants, not stale readable labels', async () => {
    const f = await fixture('departments'), member = randomUUID()
    const row = await store.create(f.input({compartments:[f.other.compartmentKey]}))
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[f.workspaceId,member])
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,member])
    await createDbWorkspaceGroupStore().addMember(f.userId,f.team.id,member)
    expect((await store.create(f.input({actorId:member,compartments:[f.team.compartmentKey]}))).compartments).toEqual([f.team.compartmentKey])
    const requestId=randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Knowledge read grant',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[requestId,f.workspaceId,member,f.other.id,'a'.repeat(64),f.userId])
    await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[requestId])
    expect((await queryWithRLS(member,'SELECT id FROM knowledge_entries WHERE id=$1',[row.id])).rows).toEqual([{id:row.id}])
    await expect(store.create(f.input({actorId:member,compartments:[f.other.compartmentKey]}))).rejects.toBeDefined()
    await expect(store.upsertByPath(f.input({actorId:member,path:row.path,compartments:[]}))).rejects.toBeDefined()
    await expect(store.updateManualEntryContent(f.workspaceId,row.id,'stale',{actorId:member})).rejects.toBeDefined()
    expect((await pool.query('SELECT content,compartments FROM knowledge_entries WHERE id=$1',[row.id])).rows[0]).toEqual({content:'Body',compartments:[f.other.compartmentKey]})
  })
  it('blocks unvalidated sync sources and does not erase an existing source binding', async () => {
    const f = await fixture('simple',false)
    const source = await store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'test'})
    const prior = await store.create(f.input({sourceId:source.id,compartments:[f.team.compartmentKey]}))
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1",[f.workspaceId])
    await expect(store.upsertByPath(f.input({path:prior.path}))).rejects.toThrow('knowledge_source_admission_required')
    await expect(store.create(f.input({sourceId:source.id}))).rejects.toThrow('knowledge_source_admission_required')
    await expect(runWithAgentAccess({userId:f.userId,workspaceId:f.workspaceId,clearance:'confidential',compartments:null,projectIds:null},()=>store.createSource({workspaceId:f.workspaceId,sourceType:'local',repo:'blocked'}))).rejects.toThrow('knowledge_source_admission_required')
    expect((await pool.query('SELECT source_id FROM knowledge_entries WHERE id=$1',[prior.id])).rows[0].source_id).toBe(source.id)
  })
  it('keeps legacy owner/system behavior unchanged', async () => {
    const f = await fixture('departments',false)
    const row = await store.create(f.input({actorId:null}))
    expect(row.compartments).toEqual([])
    expect((await store.upsertByPath(f.input({path:row.path,actorId:null}))).id).toBe(row.id)
    expect(await store.updateManualEntryContent(f.workspaceId,row.id,'legacy')).toMatchObject({id:row.id})
  })
})
