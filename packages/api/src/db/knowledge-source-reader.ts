/** Native source-card fields under original R1 authority. [COMP:api/application-persistence] */
import {z} from 'zod'
import {bindScopeSources,DerivedScopeError,intersectAccessCeilings,pinAccessCeiling,type AccessContext,type SessionContextAuthority} from '@use-brian/core'
import {getPool,applyRLSGucs,runWithAgentAccess} from './client.js'
import {readRetainedContextFrame} from './session-context-revisions.js'
import {currentApplicationReadTransaction} from '../application-platform/execution-context.js'
import {validateCallerScopeEvidence} from '../context-scope/caller-evidence.js'
import type {KnowledgeSource} from './knowledge-store.js'
export type KnowledgeSourceProjection=Pick<KnowledgeSource,'id'|'workspaceId'|'sourceType'|'repo'|'branch'|'rootPath'|'lastSyncedAt'>
const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.string().min(1),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const native=source.extend({resourceKind:z.literal('knowledge_source')})
const snapshot=native.extend({held:z.boolean(),validTo:z.string().nullable(),retractedAt:z.string().nullable()})
const capture=z.object({values:z.record(z.unknown()),sources:z.array(source.extend({resourceKind:z.enum(['application_field','external_source'])})).min(1),
 policyVersion:z.string().regex(/^[a-f0-9]{64}$/),recordVersion:z.string().min(1),source:native}).strict()
const values=z.object({id:z.string().uuid(),sourceType:z.enum(['github','local']),repo:z.string(),branch:z.string(),rootPath:z.string(),
 lastSyncedAt:z.string().datetime({offset:true}).nullable().transform(value=>value===null?null:new Date(value))}).strict()
function denied():never{throw new DerivedScopeError('scope_evidence_missing')}
export async function readNativeKnowledgeSource(ctx:AccessContext,id:string,authority:SessionContextAuthority):Promise<KnowledgeSourceProjection|null>{
 const command=structuredClone({ctx,id}),execution=authority.execution
 if(currentApplicationReadTransaction(ctx)||ctx.systemRead||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
  ||execution.security.access.userId!==ctx.userId||execution.security.access.workspaceId!==ctx.workspaceId||execution.assistant.id!==ctx.assistantId)denied()
 await execution.security.authority.assertCurrent()
 const raw=(await getPool().query<{source:unknown}>("SELECT read_scope_source($1,'knowledge_source',$2) AS source",[command.ctx.workspaceId,command.id])).rows[0]?.source
 if(raw===null||raw===undefined)return null
 const root=snapshot.parse(raw)
 if(root.held||root.validTo!==null||root.retractedAt!==null)return null
 if(root.workspaceId!==command.ctx.workspaceId||root.resourceId!==command.id)denied()
 const{held,validTo,retractedAt,...original}=root
 const requested=pinAccessCeiling({...execution.security.access,...Object.fromEntries(Object.entries(command.ctx).filter(([,value])=>value!==undefined))})
 const ceiling=intersectAccessCeilings(execution.security.ceiling,requested)
 return readRetainedContextFrame(authority,[original],async client=>{
  await runWithAgentAccess({...execution.security.access,...ceiling},()=>applyRLSGucs(client,command.ctx.userId))
  const raw=(await client.query<{value:unknown}>('SELECT read_native_knowledge_source_projection($1,$2,$3) AS value',[command.ctx.workspaceId,command.id,original.version])).rows[0]?.value
  if(raw===null||raw===undefined)return null
  const observed=capture.parse(raw)
  if(observed.source.workspaceId!==command.ctx.workspaceId||observed.source.resourceId!==command.id||observed.source.version!==original.version
   ||observed.sources.some(source=>source.workspaceId!==command.ctx.workspaceId))denied()
  const sources=[observed.source,...observed.sources]
  await execution.security.authority.assertCurrent();await validateCallerScopeEvidence({sources},ceiling,client)
  const selected=values.parse(observed.values)
  if(selected.id!==command.id)denied()
  return bindScopeSources({...selected,workspaceId:command.ctx.workspaceId},sources)
 })
}
