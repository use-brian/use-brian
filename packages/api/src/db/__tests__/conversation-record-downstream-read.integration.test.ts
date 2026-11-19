/** [COMP:api/conversation-visibility] Installed retained conversation lineage. */
import { afterAll, expect, it } from 'vitest'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { authSessionStore } from '../auth-session-store.js'
import { applyRLSGucs, getAppPool, getPool, queryWithRLS } from '../client.js'
import { captureNativeConversationRecord } from '../conversation-record.js'
import { initializeConversationVisibility } from '../conversation-visibility.js'
import { createMemory, getMemoryById, searchMemoriesByWorkspaceSystem } from '../memories.js'
import { ensureOfficeArtifactSessionSystem } from '../office-artifact-sessions.js'
import { officeArtifactStore } from '../office-artifacts.js'
import { addSessionMessage } from '../sessions.js'
import { createTask, getTaskById, listTasks } from '../tasks.js'
import { createWorkspaceFile, getWorkspaceFileById } from '../workspace-files.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

it('withholds native Memory, Task and file derivatives without rewriting their fanout', async () => {
  const f = await persistentContextFixture('internal')
  try {
    await initializeConversationVisibility()
    const rows = await f.history()
    const device = (await authSessionStore.create(f.ownerId, { deviceLabel:'Fictional derivation fixture',userAgent:null,ipAddress:null }))!
    const actor = { userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion }
    const capture = () => captureNativeConversationRecord(actor,{workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0})
    const delivered = await capture()
    const save = (summary:string,source:ScopeSource) => createMemory({
      workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,summary,
      createdByUserId:f.ownerId,sensitivity:'internal',
      derivationTarget:{userId:f.ownerId,assistantId:null},derivation:{producer:'fixture:prior-record-derivative',sources:[source]},
    })
    const previous = await save('Fictional retained derivative saved before source hold',delivered.source)
    const memorySource: ScopeSource = {
      ...f.envelope,userId:f.ownerId,resourceKind:'memory',resourceId:previous.id,version:previous.scopeVersion,
    }
    const child = await save('Fictional retained descendant saved before source hold',memorySource)
    const execution = await f.execution()
    const task = await runWithAgentAccess({...execution.security.access,sharedAudience:false},async()=>{
      const client=await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client,f.ownerId,f.assistantId)
        const result = await createTask(f.ownerId,{workspaceId:f.workspaceId,title:'Fictional task from delivered history',sensitivity:'internal',
          createdByAssistantId:f.assistantId,visibility:{userId:f.ownerId,assistantId:null},
          derivation:{producer:'fixture:prior-record-task',sources:[memorySource]},
        },undefined,client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    })
    const file = await createWorkspaceFile(f.ownerId,{workspaceId:f.workspaceId,path:'/fictional-derived.txt',parentPath:'/',
      name:'fictional-derived.txt',mime:'text/plain',sizeBytes:0,storageUri:'gs://fixture/fictional-derived',sensitivity:'internal',
      createdByUserId:f.ownerId,userId:f.ownerId,source:'extracted',
    },{derivation:{producer:'fixture:prior-record-file',sources:[memorySource]}})
    const ids = [previous.id, child.id]
    const read = () => queryWithRLS<{kind:string,id:string}>(f.ownerId,`SELECT 'memory' kind,id FROM memories WHERE id=ANY($1::uuid[])
      UNION ALL SELECT 'task',id FROM tasks WHERE id=$2`,[ids,task.id])
    const access={...execution.security.access,sharedAudience:false}
    const readFilePoint = () => getWorkspaceFileById(access,file.id)
    const readTask = () => getTaskById(access,task.id)
    const readMemory = (id:string) => getMemoryById(access,id)
    const expected = [{kind:'memory',id:previous.id},{kind:'memory',id:child.id},{kind:'task',id:task.id}]
    expect((await read()).rows).toEqual(expect.arrayContaining(expected))
    const readFileLineage = () => f.pool.query<{allowed:boolean}>(`SELECT public.conversation_record_derivation_current(
       workspace_id,'workspace_file',id,scope_version::text,$2) allowed FROM workspace_files WHERE id=$1`,[file.id,f.ownerId])
    expect((await readFileLineage()).rows).toEqual([{allowed:true}])
    const newDirect=await save('Fictional new direct derivative through mounted validation',delivered.source)
    const newChild=await save('Fictional new descendant through mounted validation',memorySource)
    ids.push(newDirect.id,newChild.id)
    expect((await read()).rows).toEqual(expect.arrayContaining(expected))
    expect(await readFilePoint()).toMatchObject({id:file.id})
    expect(await readTask()).toMatchObject({id:task.id})
    expect((await listTasks(access,{})).map(row=>row.id)).toContain(task.id)
    expect(await readMemory(previous.id)).toMatchObject({id:previous.id})
    expect(await readMemory(child.id)).toMatchObject({id:child.id})
    const ownerSearch=()=>searchMemoriesByWorkspaceSystem({workspaceId:f.workspaceId,searchQuery:'derivative saved',clearance:'internal'})
    expect((await ownerSearch()).map(row=>row.id)).toContain(previous.id)
    await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'Fictional newer delivery'}],scope:f.envelope})
    expect((await read()).rows).toEqual(expect.arrayContaining(expected))
    await f.pool.query("UPDATE workspace_files SET title='Fictional file metadata change' WHERE id=$1",[file.id])
    expect((await readFileLineage()).rows).toEqual([{allowed:true}])
    expect(await readFilePoint()).toMatchObject({id:file.id,title:'Fictional file metadata change'})
    const physical = () => f.pool.query<{id:string;scope_held:boolean;scope_version:string}>(`
      SELECT id,scope_held,scope_version::text FROM memories WHERE id=ANY($1::uuid[])
      UNION ALL SELECT id,scope_held,scope_version::text FROM tasks WHERE id=$2
      UNION ALL SELECT id,scope_held,scope_version::text FROM workspace_files WHERE id=$3
      ORDER BY id`,[ids,task.id,file.id])
    const beforeHold = (await physical()).rows
    expect(beforeHold).toHaveLength(6)
    expect(beforeHold.every(row=>row.scope_held===false)).toBe(true)
    await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[rows[0].id])
    expect((await read()).rowCount).toBe(0)
    expect((await ownerSearch()).map(row=>row.id)).not.toContain(previous.id)
    expect(await readFilePoint()).toBeNull()
    expect(await readTask()).toBeNull()
    expect((await listTasks(access,{})).map(row=>row.id)).not.toContain(task.id)
    expect(await readMemory(previous.id)).toBeNull()
    expect(await readMemory(child.id)).toBeNull()
    expect((await readFileLineage()).rows).toEqual([{allowed:false}])
    await expect(save('Fictional refused laundering write',memorySource)).rejects.toThrow()
    expect((await physical()).rows).toEqual(beforeHold)
    const reopened = JSON.stringify((await capture()).rows)
    expect(reopened).not.toContain('Fictional earlier request')
    expect(reopened).toContain('Fictional earlier response')
  } finally {
    await f.cleanup()
  }
},60_000)

it('withdraws a retained Office copy when the original grant revokes without a record revision', async () => {
  const f = await persistentContextFixture('internal')
  try {
    const artifact = await officeArtifactStore.createShell({userId:f.ownerId,workspaceId:f.workspaceId,
      family:'document',title:'Fictional native Office conversation',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'})
    const {sessionId} = await ensureOfficeArtifactSessionSystem({artifactId:artifact.id,assistantId:f.assistantId,userId:f.ownerId})
    await f.pool.query("UPDATE office_artifacts SET default_workspace_role='deny' WHERE id=$1",[artifact.id])
    await f.pool.query(`INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role,granted_by)
      VALUES($1,$2,$3,'view',$4)`,[artifact.id,f.workspaceId,f.firstId,f.ownerId])
    await addSessionMessage({sessionId,role:'user',content:[{type:'text',text:'Fictional Office discussion'}],scope:f.envelope})
    const device = (await authSessionStore.create(f.firstId,{deviceLabel:'Fictional Office reader',userAgent:null,ipAddress:null}))!
    const capture = () => captureNativeConversationRecord({userId:f.firstId,authSessionId:device.id,authVersion:device.authVersion},
      {workspaceId:f.workspaceId,sessionId,afterSequence:0,throughSequence:1,topicThroughSequence:0})
    const before=await capture()
    const copy=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.firstId,createdByUserId:f.firstId,
      summary:'Fictional retained Office copy',sensitivity:'internal',derivationTarget:{userId:f.firstId,assistantId:null},
      derivation:{producer:'fixture:retained-office-copy',sources:[before.source]}})
    const access={...(await f.execution(f.firstId)).security.access,sharedAudience:false}
    const read = () => getMemoryById(access,copy.id)
    expect(await read()).toMatchObject({id:copy.id})
    expect(await officeArtifactStore.revokeGrant({userId:f.ownerId,artifactId:artifact.id,targetUserId:f.firstId})).toBe(true)
    expect((await f.pool.query('SELECT version::text AS version FROM conversation_envelopes WHERE session_id=$1',[sessionId])).rows)
      .toEqual([{version:before.generation}])
    expect(await read()).toBeNull()
    await expect(capture()).rejects.toThrow()
  } finally {
    await f.cleanup()
  }
},60_000)
