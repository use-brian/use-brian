import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator,createMemoryTools,type AccessCeiling,type ScopeEvidence,type ScopeSource,type ToolContext} from '@use-brian/core'
import {getPool,getAppPool,runWithAgentAccess} from '../../db/client.js'
import {createMemory} from '../../db/memories.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {validateCallerScopeEvidence} from '../caller-evidence.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),userId=randomUUID(),sourceAssistant=randomUUID(),callee=randomUUID(),projectId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Evidence fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
  for(const [id,kind] of [[sourceAssistant,'standard'],[callee,'primary']])await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Fixture assistant',$4,'confidential')",[id,workspaceId,userId,kind])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product'),($1,'finance','Finance')",[workspaceId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,workspaceId,userId])
  const source=await createMemory({workspaceId,userId,assistantId:sourceAssistant,createdByUserId:userId,summary:'Source context',sensitivity:'internal',compartments:['product'],projectIds:[projectId]})
  const snapshot=(await pool.query<{source:ScopeSource}>('SELECT read_scope_source($1,$2,$3) source',[workspaceId,'memory',source.id])).rows[0].source
  const evidence:ScopeEvidence={sources:[snapshot]}
  const ceiling:AccessCeiling={workspaceId,userId,clearance:'internal',compartments:['product','finance'],mutationCompartments:['product','finance'],projectIds:[projectId],visibilityAssistantIds:[sourceAssistant]}
  const context=(value:ScopeEvidence):ToolContext=>({...ceiling,assistantId:callee,assistantKind:'primary',appId:'web',sessionId:randomUUID(),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal,
    assistantCompartments:ceiling.compartments,assistantProjectIds:ceiling.projectIds,scopeAccumulator:new ContextScopeAccumulator(value)})
  const save=createMemoryTools(createDbMemoryStore()).saveMemory
  return {workspaceId,userId,sourceAssistant,callee,source,snapshot,evidence,ceiling,context,save,projectId}
}
describe('[COMP:api/caller-scope-evidence] canonical consult evidence and memory writes',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('carries source privacy and derivation edges through the real saveMemory tool and writer',async()=>{
    const f=await fixture(),validated=await validateCallerScopeEvidence(f.evidence,f.ceiling)
    const ctx=f.context(validated)
    await runWithAgentAccess(f.ceiling,()=>f.save.execute({summary:'Derived through consult',scope:'user',
      derivation:{sources:[]},compartments:[],projectIds:[],sensitivity:'public'},ctx))
    const row=(await pool.query("SELECT id,sensitivity,compartments,project_ids,user_id,assistant_id FROM memories WHERE workspace_id=$1 AND summary='Derived through consult'",[f.workspaceId])).rows[0]
    expect(row).toMatchObject({sensitivity:'internal',compartments:['product'],project_ids:[f.projectId],user_id:f.userId,assistant_id:f.sourceAssistant})
    expect((await pool.query('SELECT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1',[row.id])).rows).toEqual([{source_id:f.source.id}])
    await pool.query("UPDATE memories SET summary='Changed source' WHERE id=$1",[f.source.id])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[row.id])).rows[0].scope_held).toBe(true)
  })
  it.each(['workspace','user','assistant','clearance','team','project'])('refuses a caller source outside the receiver %s ceiling',async axis=>{
    const f=await fixture(),ceiling={...f.ceiling}
    if(axis==='workspace')ceiling.workspaceId=randomUUID()
    if(axis==='user')ceiling.userId=randomUUID()
    if(axis==='assistant')ceiling.visibilityAssistantIds=[]
    if(axis==='clearance')ceiling.clearance='public'
    if(axis==='team')ceiling.compartments=[]
    if(axis==='project')ceiling.projectIds=[]
    await expect(validateCallerScopeEvidence(f.evidence,ceiling)).rejects.toMatchObject({reason:'caller_evidence_unavailable',retrySafe:false})
  })
  it('keeps a requested personal note private when its source is workspace-wide knowledge',async()=>{
    const f=await fixture(),id=randomUUID()
    await pool.query("INSERT INTO knowledge_entries(id,workspace_id,path,title,content,created_by) VALUES($1,$2,'shared.md','Shared reference','Shared content',$3)",[id,f.workspaceId,f.userId])
    const source=(await pool.query('SELECT read_scope_source($1,$2,$3) source',[f.workspaceId,'knowledge_entry',id])).rows[0].source
    expect(source).toMatchObject({userId:null,assistantId:null})
    const validated=await validateCallerScopeEvidence({sources:[source]},f.ceiling)
    await runWithAgentAccess(f.ceiling,()=>f.save.execute({summary:'Personal analysis',scope:'user',derivationTarget:{userId:null,assistantId:null}},f.context(validated)))
    expect((await pool.query("SELECT user_id,assistant_id FROM memories WHERE workspace_id=$1 AND summary='Personal analysis'",[f.workspaceId])).rows[0]).toEqual({user_id:f.userId,assistant_id:null})
  })
  it('refuses incompatible requested visibility at the canonical writer',async()=>{
    const f=await fixture()
    await expect(createMemory({workspaceId:f.workspaceId,userId:f.userId,assistantId:f.callee,createdByUserId:f.userId,summary:'Refused target',sensitivity:'internal',
      derivation:{producer:'fixture',sources:[f.snapshot]},derivationTarget:{userId:randomUUID(),assistantId:null}})).rejects.toThrow('scope_visibility_incompatible')
    expect((await pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Refused target'",[f.workspaceId])).rows).toEqual([])
  })
  it.each(['edit','hold','delete'])('refuses %s sources before context use and at canonical persistence',async change=>{
    const f=await fixture(),validated=await validateCallerScopeEvidence(f.evidence,f.ceiling)
    if(change==='edit')await pool.query("UPDATE memories SET summary='Updated' WHERE id=$1",[f.source.id])
    if(change==='hold')await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[f.source.id])
    if(change==='delete')await pool.query('DELETE FROM memories WHERE id=$1',[f.source.id])
    await expect(validateCallerScopeEvidence(validated,f.ceiling)).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
    await expect(runWithAgentAccess(f.ceiling,()=>f.save.execute({summary:'Refused output',scope:'user'},f.context(validated)))).rejects.toThrow('scope_source_changed')
    expect((await pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Refused output'",[f.workspaceId])).rows).toEqual([])
  })
  it('preserves both existing-memory and new-context sources on updates',async()=>{
    const f=await fixture(),target=await createMemory({workspaceId:f.workspaceId,userId:f.userId,assistantId:f.sourceAssistant,createdByUserId:f.userId,summary:'Existing note',sensitivity:'internal',compartments:['finance']})
    const validated=await validateCallerScopeEvidence(f.evidence,f.ceiling)
    await runWithAgentAccess(f.ceiling,()=>f.save.execute({id:target.id,summary:'Updated from caller'},f.context(validated)))
    const row=(await pool.query("SELECT id,compartments,project_ids FROM memories WHERE workspace_id=$1 AND summary='Updated from caller' AND valid_to IS NULL",[f.workspaceId])).rows[0]
    expect(row).toMatchObject({compartments:['finance','product'],project_ids:[f.projectId]})
    const ids=(await pool.query('SELECT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1',[row.id])).rows.map(r=>r.source_id).sort()
    expect(ids).toEqual([target.id,f.source.id].sort())
  })
  it('allows a source-protected derived create without granting mutation of the caller source',async()=>{
    const f=await fixture(),readOnly={...f.ceiling,mutationCompartments:[]}
    const validated=await validateCallerScopeEvidence(f.evidence,readOnly)
    await runWithAgentAccess(readOnly,async()=>{
      const result=await f.save.execute({summary:'Read-only derived note',scope:'user'},f.context(validated))
      expect(result.isError).not.toBe(true)
      const refused=await f.save.execute({id:f.source.id,summary:'Forbidden source edit'},f.context(validated))
      expect(refused.isError).toBe(true)
    })
    expect((await pool.query('SELECT summary FROM memories WHERE id=$1',[f.source.id])).rows[0].summary).toBe('Source context')
    expect((await pool.query("SELECT compartments FROM memories WHERE workspace_id=$1 AND summary='Read-only derived note'",[f.workspaceId])).rows[0].compartments).toEqual(['product'])
  })
  it('keeps known label floors while refusing malformed source metadata without leaking it',async()=>{
    const f=await fixture()
    expect(await validateCallerScopeEvidence({sensitivity:'internal',compartments:['product'],projectIds:[]},f.ceiling)).toEqual({sensitivity:'internal',compartments:['product'],projectIds:[]})
    for(const evidence of [{sources:[{...f.snapshot,version:'stale-private-detail'}]},{sources:[{...f.snapshot,workspaceId:undefined}]},{compartments:'product'},{sources:{}},{sensitivity:'unknown'}]) {
      await expect(validateCallerScopeEvidence(evidence as ScopeEvidence,f.ceiling)).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
      await expect(validateCallerScopeEvidence(evidence as ScopeEvidence,f.ceiling)).rejects.not.toThrow('stale-private-detail')
    }
  })
})
