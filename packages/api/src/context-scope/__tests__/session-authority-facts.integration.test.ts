/** Actual live renewal, not a cached or caller-supplied allow. [COMP:api/authority-lease] */
import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {createLoopDetector} from '@use-brian/agent-runtime/engine/loop-detector.js'
import {createToolExecutor} from '@use-brian/agent-runtime/engine/tool-executor.js'
import {pinAccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {buildTool} from '@use-brian/agent-runtime/tools/types.js'
import {z} from 'zod'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {findSessionAuthorityById} from '../../db/sessions.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {createSessionAuthorityLease} from '../authority-lease.js'
import {pinPolicyEpoch} from '../policy-epoch.js'
import {resolveLiveAccessCeilingSystem} from '../resolve-turn-scope.js'
import {findAssistantById} from '../../db/users.js'
import {createTurnDeliveryAdmission} from '../admission.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {readSessionAuthorityFacts} from '../session-authority-facts.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
afterAll(async()=>{await getAppPool().end();await getPool().end()})
describe.sequential('[COMP:api/authority-lease] coherent session facts',()=>{
 it.each([false,true])('reads live facts once under department model %s',async v2=>{
  const f=await persistentContextFixture()
  try{
   await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[f.workspaceId,v2])
   const credential=(await authSessionStore.create(f.firstId,{deviceLabel:'Fictional renewal client',userAgent:null,ipAddress:null}))!
   const input={sessionId:f.session.id,assistantId:f.assistantId,workspaceId:f.workspaceId,userId:f.firstId,
    credential:{userId:f.firstId,sessionId:credential.id,authVersion:credential.authVersion},includePolicy:true}
   const policy=await pinPolicyEpoch({workspaceId:f.workspaceId,principalId:f.firstId,assistantId:f.assistantId})
   const calls=vi.spyOn(f.pool,'query')
   try{
    const facts=await readSessionAuthorityFacts(input)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(policy.matches(facts.policy)).toBe(true)
    expect(facts).toMatchObject({session:{id:f.session.id},assistant:{id:f.assistantId},credentialCurrent:true,
     member:{role:'member',departmentReadV2:String(v2)}})
   }finally{calls.mockRestore()}
   await f.pool.query('UPDATE application_policy_workspace_epochs SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
   expect(policy.matches((await readSessionAuthorityFacts(input)).policy)).toBe(false)
   await f.pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[credential.id])
   expect((await readSessionAuthorityFacts(input)).credentialCurrent).toBe(false)
   expect((await readSessionAuthorityFacts({...input,credential:{...input.credential,userId:f.secondId}})).credentialCurrent).toBe(false)
   await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.firstId])
   expect((await readSessionAuthorityFacts(input)).member).toBeNull()
  }finally{await f.cleanup()}
 })
 it.each([false,true])('renews a policy-bound lease with one statement under model %s',async v2=>{
  const f=await persistentContextFixture()
  try{
   await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[f.workspaceId,v2])
   const execution=await f.execution(),calls=vi.spyOn(f.pool,'query')
   try{await execution.security.authority.assertCurrent();expect(calls).toHaveBeenCalledTimes(1)}finally{calls.mockRestore()}
  }finally{await f.cleanup()}
 })
 it.each(['channel_id','channel_type','mode','app_origin','anchor_kind','anchor_ref'] as const)('refuses changed %s at the real native destination owner',async field=>{
  const f=await persistentContextFixture()
  try{
   await f.history()
   const authority=await f.modelContext(f.firstId)
   await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
   const owner=createTurnDeliveryAdmission(authority.execution,authority.accumulator,f.session)
   expect(owner).toBeDefined()
   const context={...executionToolContext(authority.execution,{appId:'fictional-destination'}),scopeAccumulator:authority.accumulator}
   await owner!.authorizeDelivery(context)
   const changed=field==='channel_type'?'telegram':field==='mode'?'draft':field==='app_origin'?'doc':field==='anchor_kind'?'doc_thread':randomUUID()
   await f.pool.query(`UPDATE sessions SET ${field}=$2 WHERE id=$1`,[f.session.id,changed])
   const effect=vi.fn()
   await expect(owner!.authorizeDelivery(context).then(effect)).rejects.toThrow()
   expect(effect).not.toHaveBeenCalled()
   owner!.dispose()
  }finally{await f.cleanup()}
 })
 it('closes an opaque recipient callback against the construction policy',async()=>{
  const f=await persistentContextFixture()
  try{
   const execution=await f.execution(),policy=await pinPolicyEpoch({workspaceId:f.workspaceId,principalId:f.ownerId,assistantId:f.assistantId})
   const lease=createSessionAuthorityLease({starting:execution.security.ceiling,session:f.session,policy,
    maximumAccessCurrent:async()=>{
     await f.pool.query('UPDATE application_policy_workspace_epochs SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
     return execution.security.ceiling
    }})
   await expect(lease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  }finally{await f.cleanup()}
 })
 it.each(['assigned','all','legacy'] as const)('preserves bound Team/Project rules with %s assistant scope and refuses grant withdrawal',async mode=>{
  const f=await persistentContextFixture(),team=randomUUID(),project=randomUUID()
  try{
   await f.pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Renewal team',$3,'team','renewal',$4)",[team,f.workspaceId,f.ownerId,`team:${team}`])
   await f.pool.query('INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)',[team,f.assistantId])
   await f.pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Renewal project','renewal project',$3)",[project,f.workspaceId,f.ownerId])
   await f.pool.query('INSERT INTO assistant_project_grants(project_id,assistant_id) VALUES($1,$2)',[project,f.assistantId])
   await f.pool.query("UPDATE assistants SET team_scope_mode=$2,project_scope_mode='assigned',compartments=NULL WHERE id=$1",[f.assistantId,mode])
   await f.pool.query('UPDATE sessions SET context_group_id=$2,context_project_id=$3,context_compartments=$4 WHERE id=$1',[f.session.id,team,project,[`team:${team}`]])
   const session=(await findSessionAuthorityById(f.session.id))!,assistant=(await findAssistantById(f.assistantId))!
   const starting=await resolveLiveAccessCeilingSystem({userId:f.ownerId,assistant,session,memberMode:'member'})
   const policy=await pinPolicyEpoch({workspaceId:f.workspaceId,principalId:f.ownerId,assistantId:f.assistantId})
   const lease=createSessionAuthorityLease({starting,session,policy})
   const calls=vi.spyOn(f.pool,'query')
   try{await lease.assertCurrent();expect(calls).toHaveBeenCalledTimes(1)}finally{calls.mockRestore()}
   await f.pool.query('DELETE FROM assistant_project_grants WHERE assistant_id=$1',[f.assistantId])
   await expect(lease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  }finally{await f.cleanup()}
 })
 it.each(['assistant','membership','credential','session-lock','session-audience','channel-id','channel-type'] as const)('permanently refuses %s withdrawal before the next effect',async kind=>{
  const f=await persistentContextFixture()
  try{
   await f.history()
   const execution=await f.execution(f.firstId),session=(await findSessionAuthorityById(f.session.id))!
   const credential=(await authSessionStore.create(f.firstId,{deviceLabel:'Fictional authority client',userAgent:null,ipAddress:null}))!
   const lease=createSessionAuthorityLease({starting:pinAccessCeiling(execution.security.access),session,
    userId:f.firstId,memberMode:'member',nativeSessionCredential:{userId:f.firstId,sessionId:credential.id,authVersion:credential.authVersion}})
   await lease.assertCurrent()
   if(kind==='assistant')await f.pool.query("UPDATE assistants SET clearance='public' WHERE id=$1",[f.assistantId])
   if(kind==='membership')await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.firstId])
   if(kind==='credential'){
    await f.pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE id=$1",[credential.id])
    await f.pool.query('SELECT pg_sleep(0.03)')
   }
   if(kind==='channel-id')await f.pool.query('UPDATE sessions SET channel_id=$2 WHERE id=$1',[f.session.id,randomUUID()])
   if(kind==='channel-type')await f.pool.query("UPDATE sessions SET channel_type='telegram' WHERE id=$1",[f.session.id])
   if(kind==='session-audience')await f.pool.query("UPDATE sessions SET effective_clearance='public' WHERE id=$1",[f.session.id])
   if(kind==='session-lock')await f.pool.query("UPDATE sessions SET context_locked_at=context_locked_at+interval '1 second' WHERE id=$1",[f.session.id])
   const effect=vi.fn()
   await expect(lease.execute(effect)).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:false})
   expect(effect).not.toHaveBeenCalled()
   if(kind==='assistant')await f.pool.query("UPDATE assistants SET clearance='confidential' WHERE id=$1",[f.assistantId])
   await expect(lease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
  }finally{await f.cleanup()}
 })
 it.each(['before-start','during-effect','after-completion'] as const)('enforces fresh authority at the actual tool action (%s) without a request snapshot',async withdrawal=>{
  const f=await persistentContextFixture()
  try{
   const execution=await f.execution(f.firstId),effect=vi.fn()
   const revoke=()=>f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.firstId])
   const tool=buildTool({name:'fixture_operation',description:'Fictional authority boundary',inputSchema:z.object({}),
    async execute(){effect();if(withdrawal==='during-effect')await revoke();return{data:'Completed fictional effect'}}})
   const run=async()=>{
    const executor=createToolExecutor({tools:new Map([[tool.name,tool]]),context:executionToolContext(execution,{appId:'fixture:tool-authority'}),loopDetector:createLoopDetector()})
    executor.addTool('fixture-call',tool.name,{})
    const results=[]
    for await(const batch of executor.getRemainingResults())results.push(...batch.blocks)
    return results
   }
   if(withdrawal==='before-start')await revoke()
   if(withdrawal==='after-completion'){
    expect(await run()).toHaveLength(1)
    await revoke()
   }
   await expect(run()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false,
    operationMayHaveExecuted:withdrawal==='during-effect'})
   expect(effect).toHaveBeenCalledTimes(withdrawal==='before-start'?0:1)
  }finally{await f.cleanup()}
 })

})
