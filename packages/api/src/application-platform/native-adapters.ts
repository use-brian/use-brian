/** Canonical CRM/task storage adapters; no copied live records. [COMP:api/application-records] */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { bindScopeSource, type ApplicationModuleDefinition, type ApplicationOperationContext,
  type ScopeSource } from '@use-brian/core'
import { ApplicationPlatformError, applicationJsonSchema, type ApplicationRecordProjection,
  type ApplicationResourceDefinition, type ApplicationResourceRef } from '@use-brian/shared'
import { createCompany } from '../db/crm.js'
import { getEntityById } from '../db/entities-store.js'
import { createTask, getTaskById } from '../db/tasks.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'

const sourceSchema=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
  sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string()),version:z.string(),
  held:z.boolean(),retractedAt:z.unknown().nullable(),validTo:z.unknown().nullable()})
const readInput=z.object({type:z.enum(['company','person','deal','task']),id:z.string().uuid()}).strict()
type Context=ApplicationOperationContext<PoolClient>

const definitions:ApplicationResourceDefinition[]=[
  {typeKey:'company',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text',required:true},{key:'domain',label:'Domain',kind:'text'}]},
  {typeKey:'person',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text',required:true},{key:'email',label:'Email',kind:'text'},{key:'phone',label:'Phone',kind:'text'}]},
  {typeKey:'deal',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text',required:true},{key:'stage',label:'Stage',kind:'text'},{key:'amount',label:'Amount',kind:'number'}]},
  {typeKey:'task',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'title',label:'Title',kind:'text',required:true},{key:'status',label:'Status',kind:'text'}]},
]
async function read(context:Context,type:z.infer<typeof readInput>['type'],id:string):Promise<ApplicationRecordProjection> {
  const access=context.execution.security.access
  const record=type==='task'?await getTaskById(access,id,context.transaction):await getEntityById(access,id,{},context.transaction)
  if(!record||'kind'in record&&record.kind!==type)throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
  const kind=type==='task'?'task':'entity'
  const result=await context.transaction.query<{snapshot:unknown}>('SELECT read_entity_derivation_source($1,$2,$3) AS snapshot',[access.workspaceId,kind,id])
  const parsed=sourceSchema.safeParse(result.rows[0]?.snapshot)
  if(!parsed.success||parsed.data.held||parsed.data.retractedAt||parsed.data.validTo)throw new ApplicationPlatformError('access_unavailable','The source is unavailable.')
  const source:ScopeSource={...parsed.data,resourceKind:kind,resourceId:id}
  const attrs='attributes'in record?record.attributes:{}
  const values=type==='task'&&'title'in record?{title:record.title,status:record.status}
    :type==='company'&&'displayName'in record?{name:record.displayName,domain:attrs.domain??null}
    :type==='person'&&'displayName'in record?{name:record.displayName,email:attrs.email??null,phone:attrs.phone??null}
    :'displayName'in record?{name:record.displayName,stage:attrs.stage??null,amount:attrs.amount??null}:{}
  const json=applicationJsonSchema.parse(values) as ApplicationRecordProjection['values']
  return bindScopeSource({ref:{workspaceId:access.workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:type,id,version:source.version},
    values:json,fields:Object.keys(json),policyVersion:'native:1'},source)
}
async function authorizeResult(context:Context,refs:ApplicationResourceRef[]) {
  for(const ref of refs) {
    const input=readInput.safeParse({type:ref.typeKey,id:ref.id})
    if(ref.workspaceId!==context.execution.security.access.workspaceId||!input.success)throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
    await read(context,input.data.type,input.data.id)
  }
}
async function authorizeCreate(context:Context) {
  const access=context.execution.security.access,labels=context.execution.security.writeDefaults
  const result=await context.transaction.query<{admitted:boolean}>(`SELECT member_operation_scope_allows($1,'internal',$2,true)
    AND agent_read_scope_allows('internal',$2,$3) AS admitted`,[access.workspaceId,labels.compartments,labels.projectIds])
  if(result.rows[0]?.admitted!==true)throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
}

/** Deployed adapter registration; callable operations still require current authority. */
export function createCanonicalNativeApplicationModule():ApplicationModuleDefinition<PoolClient> {
  const companyInput=z.object({name:z.string().min(1).max(256),domain:z.string().max(256).nullable().optional()}).strict()
  const taskInput=z.object({title:z.string().min(1).max(1024)}).strict()
  return {key:'native',defaultState:'enabled',application:{version:'1',dependencies:[],resources:definitions,
    queries:['get'],commands:['create_company','create_task'],events:['native.company.created','native.task.created'],
    policyCapabilities:['canonical_native'],backgroundHandlers:[],uiContributions:[]},
  queries:{get:{input:readInput,authorize:async(context,raw)=>{const input=readInput.parse(raw);await read(context,input.type,input.id)},
    execute:async(context,raw)=>{const input=readInput.parse(raw);return read(context,input.type,input.id)}}},
  commands:{create_company:{input:companyInput,eventKey:'native.company.created',
    authorize:authorizeCreate,authorizeResult,
    execute:async(context,raw)=>{
      const input=companyInput.parse(raw),access=context.execution.security.access
      const record=await createCompany(access.userId,{...input,workspaceId:access.workspaceId,access,mergeByName:false,
        sensitivity:'internal',compartments:[...context.execution.security.writeDefaults.compartments],projectIds:[...context.execution.security.writeDefaults.projectIds],
        createdByAssistantId:context.execution.assistant.id},{client:context.transaction,afterCommit:context.afterCommit})
      return [(await read(context,'company',record.id)).ref]
    }},create_task:{input:taskInput,eventKey:'native.task.created',authorize:authorizeCreate,authorizeResult,
    execute:async(context,raw)=>{
      const input=taskInput.parse(raw),access=context.execution.security.access
      const record=await createTask(access.userId,{...input,workspaceId:access.workspaceId,access,sensitivity:'internal',
        compartments:[...context.execution.security.writeDefaults.compartments],projectIds:[...context.execution.security.writeDefaults.projectIds],
        createdByAssistantId:context.execution.assistant.id,writtenBy:'system'},undefined,context.transaction,{deduplicate:false})
      context.afterCommit(()=>publishTaskLifecycle({workspaceId:record.workspaceId,taskId:record.id,kind:'created',title:record.title,status:record.status,previousStatus:null,
        tags:record.tags,previousTags:null,assigneeId:record.assigneeId,previousAssigneeId:null,due:record.due,parentId:record.parentId,changedFields:[],actorId:access.userId,writtenBy:'system'}))
      return [(await read(context,'task',record.id)).ref]
    }},
  }}
}
