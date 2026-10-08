import { createSandboxTaskStore } from '../../db/sandbox-task-store.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool, query, queryWithRLS } from '../../db/client.js'
import { browserInputScope, executionToolContext, pinToolAuthoringAuthority, pinAccessCeiling } from '@use-brian/core'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { createMemory } from '../../db/memories.js'
import { resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { createBrowserProfileStore } from '../../db/browser-profile-store.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { findAssistantById } from '../../db/users.js'
import { findSessionAuthorityById } from '../../db/sessions.js'
import { resolveLiveAccessCeilingSystem } from '../../context-scope/resolve-turn-scope.js'
import { createSessionAuthorityLease } from '../../context-scope/authority-lease.js'
import { createFilesApi } from '../../files/files-api.js'
import type { GcsFilesClient } from '../../files/gcs-client.js'
import type { WorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import { prepareBrowserDownload, type DownloadTask } from '../download-publication.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspace = randomUUID(), owner = randomUUID(), peer = randomUUID(), custodian = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  for (const user of [owner, peer, custodian]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional download workspace','test',$2)", [workspace, custodian])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, custodian])
  for (const user of [owner, peer]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspace, user])
  const department = (await createDbWorkspaceGroupStore().createTeam(custodian, workspace, { name: 'Downloads', key: 'downloads' })).id
  for (const user of [owner, peer]) await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace, department, user])
  await query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,compartments) VALUES($1,$2,'Fictional download assistant','standard','confidential',$3)", [assistantId, workspace, [`team:${department}`]])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store')", [workspace, department, assistantId])
  await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at,context_group_id,context_compartments,effective_clearance) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','owner',clock_timestamp(),$5,$6,'confidential')", [sessionId, workspace, assistantId, owner, department, [`team:${department}`]])
  const profile = await createBrowserProfileStore().create({ workspaceId: workspace, ownerUserId: owner, name: 'Fictional browser', scope: 'owner', departmentId: department, enabledAssistantIds: [assistantId] })
  const assistant = (await findAssistantById(assistantId))!, session = { ...(await findSessionAuthorityById(sessionId))!,
    visibility: 'owner', mode: null, effectiveClearance: 'confidential', contextCompartments: [`team:${department}`] }
  const ceiling = await resolveLiveAccessCeilingSystem({ userId: owner, workspaceId: workspace, assistant, session, memberMode: 'member' })
  const authority = createSessionAuthorityLease({ starting: ceiling, session, executingAssistantId: assistantId, userId: owner, memberMode: 'member', durableSessionSource: true })
  const task: DownloadTask = { taskId: randomUUID(), sessionId, userId: owner, workspaceId: workspace, profileId: profile.id,
    profileAuthority: { id: profile.id, workspaceId: workspace, ownerUserId: owner, scope: 'owner', departmentId: department, clearance: profile.clearance },
    executionAuthority: { version: 1, assistantId, ceiling }, sourceAuthority: authority.snapshotSource!(),
    inputScope: { sensitivity: 'confidential', compartments: [`team:${department}`], projectIds: [], sources: [] } }
  const blobs = new Map<string, Buffer>(), store = createDbWorkspaceFilesStore()
  const gcs = { writeBlob: vi.fn(async (key: string, bytes: Buffer) => { blobs.set(key, bytes) }),
    readBlob: async (key: string) => blobs.has(key) ? { bytes: blobs.get(key)!, mime: 'text/plain', metadata: {} } : null,
    deleteBlob: async (key: string) => { blobs.delete(key) } } as unknown as GcsFilesClient
  const api = createFilesApi({ store, gcs, bucket: 'fictional-downloads', auditStore: { append: async () => {} } as unknown as WorkspaceAuditStore })
  const tasks = createSandboxTaskStore()
  await tasks.create({ ...task, status: 'running', sandboxId: 'fixture-sandbox', injectedSite: null, browserStartedAt: Date.now(),
    authorizedBudgetUsd: 1, createdAt: Date.now(), lastActivityAt: Date.now() })
  const publication = await prepareBrowserDownload(api, task, () => tasks.getActiveBySession(sessionId), authority,
    (expected, operation) => tasks.withPublication(expected, operation))
  const file = { path: '/browser/example.txt', name: 'example.txt', mime: 'text/plain', bytes: Buffer.from('fictional browser content') }
  return { publication, file, task, tasks, api, gcs, blobs, store, workspace, owner, peer, department, assistantId, profile }
}

describe('[COMP:sandbox/download-publication] real derived-file publication', () => {
  it.each([{enrichment:false,pageSource:false},{enrichment:true,pageSource:false},{enrichment:false,pageSource:true}])('publishes a workflow download with its private primitive parent and profile receipts (%j)',async ({enrichment,pageSource})=>{
    const f=await fixture(),runs=createDbWorkflowRunStore()
    const workflow=await createDbWorkflowStore().create({userId:f.owner,workspaceId:f.workspace,name:'Download fixture',
      contextGroupId:f.department,authoringAuthority:f.task.executionAuthority!,
      definition:{startStepId:'browser',steps:[{id:'browser',type:'tool_call',toolName:'fixtureBrowser',arguments:{}}]}})
    const run=await runs.createRun({workflowId:workflow.id,workspaceId:f.workspace,triggeredBy:f.owner,triggerKind:'manual'})
    const blueprintId=enrichment?randomUUID():null
    if(blueprintId)await query(`INSERT INTO blueprint_records(id,workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,created_by,sensitivity,compartments)
      VALUES($1::uuid,$2,'{}','Fixture enrichment',$1::text,'{}','workflow',$3,$4,'confidential',$5)`,[blueprintId,f.workspace,run.id,f.owner,[`team:${f.department}`]])
    const initial=await resolveWorkflowRunScope({userId:f.owner,workspaceId:f.workspace,assistantId:f.assistantId,run})
    const primitive=pageSource
      ? (await query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance)
          VALUES($1,$2,'Private download page','tasks','table','{"blocks":[]}','saved','confidential') RETURNING page_event_revision AS id`,[f.workspace,f.owner])).rows[0]
      : await createMemory({workspaceId:f.workspace,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,
          summary:'Private download source',sensitivity:'confidential',compartments:[`team:${f.department}`]})
    const primitiveKind=pageSource?'page_event_changed':'memory'
    const raw=(await queryWithRLS(f.owner,'SELECT read_entity_derivation_source($1,$2,$3) AS source',[f.workspace,primitiveKind,primitive.id])).rows[0].source
    const {workspaceId,resourceKind,resourceId,version,userId,assistantId,sensitivity,compartments,projectIds}=raw
    const evidence=browserInputScope(await validateCallerScopeEvidence({...initial.inputScopeEvidence,
      compartments:[...(initial.inputScopeEvidence.compartments??[]),...initial.turnScope.writeCompartments],
      projectIds:[...(initial.inputScopeEvidence.projectIds??[]),...initial.turnScope.writeProjectIds],
      sources:[...(initial.inputScopeEvidence.sources??[]),{workspaceId,resourceKind,resourceId,version,userId,assistantId,sensitivity,compartments,projectIds}]},
      pinAccessCeiling(initial.turnScope.access)),f.workspace)
    await runs.updateRun(run.id,{vars:{__contextScopeEvidence:evidence}})
    const scope=await resolveWorkflowRunScope({userId:f.owner,workspaceId:f.workspace,assistantId:f.assistantId,run})
    const task:DownloadTask={...f.task,taskId:randomUUID(),sessionId:run.id,inputScope:browserInputScope({},f.workspace),
      executionAuthority:pinToolAuthoringAuthority(executionToolContext(scope.executionContext,{appId:'fixture'})),
      sourceAuthority:scope.executionContext.security.authority.snapshotSource!()}
    await f.tasks.create({...task,status:'running',sandboxId:'workflow-fixture',injectedSite:null,browserStartedAt:Date.now(),
      authorizedBudgetUsd:1,createdAt:Date.now(),lastActivityAt:Date.now()})
    const publication=await prepareBrowserDownload(f.api,task,()=>f.tasks.getActiveBySession(run.id),scope.executionContext.security.authority,
      (expected,operation)=>f.tasks.withPublication(expected,operation))
    const saved=await publication.writeBytes(f.file)
    expect(saved).toMatchObject({userId:f.owner,...(pageSource?{}:{assistantId:f.assistantId}),sensitivity:'confidential',compartments:[`team:${f.department}`]})
    const receipts=(await query('SELECT source_kind,source_id FROM scope_derivation_sources WHERE derivation_id IN(SELECT id FROM scope_derivations WHERE resource_id=$1)',[saved.id])).rows
    expect(receipts).toEqual(expect.arrayContaining([{source_kind:'workflow_run',source_id:run.id},{source_kind:primitiveKind,source_id:primitive.id},{source_kind:'browser_profile',source_id:f.profile.id}]))
    if(pageSource)expect(receipts.some(row=>row.source_kind==='page_live_changed')).toBe(true)
    if(blueprintId)expect(receipts).toContainEqual({source_kind:'blueprint_record',source_id:blueprintId})
    expect((await publication.writeBytes(f.file)).id).toBe(saved.id)
    await runs.updateRun(run.id,{status:'failed',error:{reason:'workflow_cancelled',message:'Fixture cancellation'}})
    expect((await query('SELECT scope_held FROM workspace_files WHERE id=$1',[saved.id])).rows[0].scope_held).toBe(true)
    await expect(publication.writeBytes({...f.file,path:'/browser/new.txt'})).rejects.toThrow()
    expect((await query('SELECT id FROM workspace_files WHERE workspace_id=$1',[f.workspace])).rows).toEqual([{id:saved.id}])
  })
  it('persists a private department file and rejects a same-department peer', async () => {
    const f = await fixture(), saved = await f.publication.writeBytes(f.file)
    expect(saved).toMatchObject({ userId: f.owner, sensitivity: 'confidential', compartments: [`team:${f.department}`], createdByAssistantId: f.assistantId })
    const access = { workspaceId: f.workspace, userId: f.owner, assistantId: '', assistantKind: 'primary' as const, clearance: 'confidential' as const }
    expect((await f.store.getById(access, saved.id))?.id).toBe(saved.id)
    expect(await f.store.getById({ ...access, userId: f.peer }, saved.id)).toBeNull()
    expect((await f.publication.writeBytes(f.file)).id).toBe(saved.id)
    await query("UPDATE browser_profiles SET scope='workspace' WHERE id=$1", [f.profile.id])
    expect(await f.store.getById(access, saved.id)).toBeNull()
  })
  it('publishes a compute sandbox artifact through the same retained task floor', async () => {
    const f = await fixture()
    const saved = await f.publication.writeBytes({ ...f.file, path: 'out.json', origin: 'compute-artifact' })
    expect(saved.path.startsWith('/computer/artifacts/')).toBe(true)
    expect(saved).toMatchObject({ userId: f.owner, sensitivity: 'confidential', compartments: [`team:${f.department}`], createdByAssistantId: f.assistantId })
    const producers = (await query('SELECT producer FROM scope_derivations WHERE resource_id=$1', [saved.id])).rows
    expect(producers).toEqual([{ producer: 'compute-artifact' }])
  })
  it('rolls back a history change admitted after the last lease check but before the file transaction', async () => {
    const f = await fixture(), create = f.store.createDerived.bind(f.store)
    f.store.createDerived = async (...args) => {
      await f.tasks.noteInputScope(f.task.taskId, { sensitivity: 'confidential', compartments: [`team:${f.department}`], projectIds: [],
        sources: [{ workspaceId: f.workspace, userId: f.owner, assistantId: null, resourceKind: 'workspace_file', resourceId: randomUUID(),
          version: '1', sensitivity: 'confidential', compartments: [`team:${f.department}`], projectIds: [] }] })
      return create(...args)
    }
    await expect(f.publication.writeBytes(f.file)).rejects.toThrow()
    expect((await query('SELECT id FROM workspace_files WHERE workspace_id=$1', [f.workspace])).rows).toHaveLength(0)
  })
  it('refuses human grant revocation during the actual blob write before inserting a row', async () => {
    const f = await fixture()
    vi.mocked(f.gcs.writeBlob).mockImplementationOnce(async () => { await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspace, f.owner]) })
    await expect(f.publication.writeBytes(f.file)).rejects.toThrow()
    expect((await query('SELECT id FROM workspace_files WHERE workspace_id=$1', [f.workspace])).rows).toHaveLength(0)
  })
  it('does not borrow stronger human authority after the executing assistant is downgraded', async () => {
    const f = await fixture()
    await query("UPDATE department_edges SET clearance='public' WHERE workspace_id=$1 AND assistant_id=$2", [f.workspace, f.assistantId])
    await expect(f.publication.writeBytes(f.file)).rejects.toThrow()
    expect(f.gcs.writeBlob).not.toHaveBeenCalled()
  })
  it('refuses profile assistant removal during the blob write', async () => {
    const f = await fixture()
    vi.mocked(f.gcs.writeBlob).mockImplementationOnce(async () => {
      await query("UPDATE browser_profiles SET enabled_assistant_ids=ARRAY[]::uuid[] WHERE id=$1", [f.profile.id])
    })
    await expect(f.publication.writeBytes(f.file)).rejects.toThrow()
    expect((await query('SELECT id FROM workspace_files WHERE workspace_id=$1', [f.workspace])).rows).toHaveLength(0)
  })
  it('refuses a profile source version changed during the blob write', async () => {
    const f = await fixture()
    vi.mocked(f.gcs.writeBlob).mockImplementationOnce(async () => { await query("UPDATE browser_profiles SET scope='workspace' WHERE id=$1", [f.profile.id]) })
    await expect(f.publication.writeBytes(f.file)).rejects.toThrow()
    expect((await query('SELECT id FROM workspace_files WHERE workspace_id=$1', [f.workspace])).rows).toHaveLength(0)
  })
})
