/** Canonical CRM/task storage adapters; no copied live records. [COMP:api/application-records] */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { crmAmountSchema, applicationAuthorityCreationScope, parseApplicationCrmFieldDefinition, type ApplicationModuleDefinition, type ApplicationOperationContext } from '@use-brian/core'
import { ApplicationPlatformError, applicationResourceRefSchema, applicationQuerySchema, type ApplicationRecordProjection,
  type ApplicationResourceDefinition, type ApplicationResourceRef } from '@use-brian/shared'
import { createCompany,createContact,createDeal } from '../db/crm.js'
import { createTask } from '../db/tasks.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'
import { getApplicationExecutionBinding } from './execution-context.js'
import { canonicalGenericReadContext, readCanonicalNativeRecord } from './field-evidence.js'
import { queryCanonicalNativeRecords } from './native-reader.js'
import { canonicalNativeResourceDefinitions } from './native-resources.js'
import { boundScopeSources } from '@use-brian/core'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'

const readInput=z.object({type:z.enum(['company','person','deal','task','file','workspace_member']),id:z.string().uuid(),fields:z.array(z.string().min(1).max(256)).max(256).refine(fields=>new Set(fields).size===fields.length).optional()}).strict()
const queryInput=z.object({type:z.enum(['company','person','deal']),query:applicationQuerySchema}).strict()
type Context=ApplicationOperationContext<PoolClient>
const creations = new WeakMap<Context, { type: 'company' | 'person' | 'deal' | 'task'; fields: string[]; scope: { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] } }>()

const definitions=canonicalNativeResourceDefinitions()
async function resources(context: Context, queryType?: string): Promise<ApplicationResourceDefinition[]> {
  const app = getApplicationExecutionBinding(context.execution)
  const entries:Array<{typeKey:string;fields:string[];customFields:Record<string,unknown>[];schemaVersion?:string}> = queryType ? (await context.transaction.query<{value:{typeKey:string;fields:string[];customFields:Record<string,unknown>[]}}>('SELECT application_native_query_catalog($1,$2) AS value',[context.execution.security.access.workspaceId,queryType])).rows.flatMap(row=>row.value?[row.value]:[]) : app ? (await context.transaction.query<{ value: { typeKey: string; fields: string[]; customFields: Record<string, unknown>[] } }>('SELECT application_native_catalog() AS value')).rows.map(row => row.value)
    : definitions.map(definition => ({ typeKey: definition.typeKey, fields: definition.fields.map(field => field.key), customFields: [] as Record<string, unknown>[] }))
  if (!app && !queryType) {
    const custom = await context.transaction.query<{ definition: Record<string, unknown> }>(`SELECT jsonb_build_object('id',id,'entityKind',entity_kind,'fieldKey',field_key,
      'label',label,'fieldType',field_type,'options',options,'isRequired',is_required,'position',position) AS definition
      FROM crm_field_definitions WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY position,id`, [context.execution.security.access.workspaceId])
    for (const row of custom.rows) entries.find(entry => entry.typeKey === row.definition.entityKind)?.customFields.push(row.definition)
  }
  return entries.map(entry => {
    const base = definitions.find(definition => definition.typeKey === entry.typeKey)
    if (!base) throw new ApplicationPlatformError('invalid_schema', 'The native schema is unavailable.')
    const custom: ApplicationResourceDefinition['fields'] = entry.customFields.map(raw => {
      const definition = parseApplicationCrmFieldDefinition(raw)
      return { key: `custom.${definition.fieldKey}`, label: definition.label, kind: 'crm', required: definition.isRequired,
        definition: definition as unknown as Record<string, import('@use-brian/shared').ApplicationJson> }
    })
    const fields = [...base.fields.filter(field => entry.fields.includes(field.key) && !custom.some(configured => configured.key === field.key)), ...custom]
    return { ...base, fields, schemaVersion: `${entry.schemaVersion??'1'}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}` }
  })
}
async function read(context:Context,type:z.infer<typeof readInput>['type'],id:string,fields?:readonly string[]):Promise<ApplicationRecordProjection> {
  const definition=(await resources(context)).find(resource=>resource.typeKey===type)
  if(!definition || fields?.some(field=>!definition.fields.some(candidate=>candidate.key===field))) {
    throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
  }
  const projection=await readCanonicalNativeRecord(canonicalGenericReadContext(context),definition,id,fields)
  return projection
}
async function query(context:Context,raw:z.infer<typeof queryInput>) {
  const definition=(await resources(context,raw.type)).find(resource=>resource.typeKey===raw.type)
  if(!definition)throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
  return queryCanonicalNativeRecords(canonicalGenericReadContext(context),definition,raw.query)
}
async function authorizeQueryResult(context:Context,result:unknown) {
  if(!result||typeof result!=='object')throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
  const sources=boundScopeSources(result)
  if(!sources.length || (await readCurrentScopeSources(context.transaction,context.execution.security.access.workspaceId,sources)).some(source=>source.state!=='current')) {
    throw new ApplicationPlatformError('access_unavailable','The source changed.')
  }
}
async function authorizeReadResult(context: Context, result: unknown) {
  const value = result as ApplicationRecordProjection, ref = applicationResourceRefSchema.safeParse(value?.ref)
  const input = ref.success ? readInput.safeParse({ type: ref.data.typeKey, id: ref.data.id }) : null
  if (!ref.success || !input?.success || ref.data.workspaceId !== context.execution.security.access.workspaceId
    || ref.data.origin.kind !== 'native' || ref.data.origin.moduleKey !== 'native') throw new ApplicationPlatformError('access_unavailable', 'The source is unavailable.')
  const current = await read(context, input.data.type, input.data.id,[...value.fields,...(value.absentFields??[])])
  if (current.ref.version !== value.ref.version || current.policyVersion !== value.policyVersion
    || value.fields.some(field => !current.fields.includes(field))) throw new ApplicationPlatformError('access_unavailable', 'The source changed.')
}
async function authorizeResult(context:Context,refs:ApplicationResourceRef[]) {
  const application = getApplicationExecutionBinding(context.execution), creation = creations.get(context)
  for(const ref of refs) {
    const input=readInput.safeParse({type:ref.typeKey,id:ref.id})
    if(ref.workspaceId!==context.execution.security.access.workspaceId||!input.success || ref.origin.kind !== 'native' || ref.origin.moduleKey !== 'native')throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
    if (application) {
      if (!creation || creation.type !== ref.typeKey) throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
      await creationRef(context, creation.type, ref.id)
    } else await read(context,input.data.type,input.data.id)
  }
}
async function creationRef(context: Context, type: 'company' | 'person' | 'deal' | 'task', id: string): Promise<ApplicationResourceRef> {
  if (!getApplicationExecutionBinding(context.execution)) return (await read(context,type,id)).ref
  const creation = creations.get(context)
  if (!creation || creation.type !== type) throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
  const value = (await context.transaction.query<{ ref: unknown }>('SELECT application_native_creation_ref($1,$2,$3) AS ref', [type,id,creation.fields])).rows[0]?.ref
  const parsed = applicationResourceRefSchema.safeParse(value)
  if (!parsed.success) throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
  return parsed.data
}
async function authorizeCreate(context:Context,type:'company'|'person'|'deal'|'task',fields:string[]) {
  if (context.expectedVersion !== undefined) throw new ApplicationPlatformError('invalid_value', 'Creation cannot use an existing-record version.')
  const access=context.execution.security.access,labels=context.execution.security.writeDefaults
  const application = getApplicationExecutionBinding(context.execution)
  if (application) {
    const scope = applicationAuthorityCreationScope(application.state.layers,
      { workspaceId: access.workspaceId, origin: { kind: 'native', moduleKey: 'native' }, typeKey: type, id: 'new', version: 'new' }, fields, access)
    const result = await context.transaction.query<{ admitted: boolean }>('SELECT application_native_creation_admitted($1,$2,$3,$4,$5) AS admitted',
      [type,scope.sensitivity,scope.compartments,scope.projectIds,fields])
    if (!result.rows[0]?.admitted) throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
    creations.set(context,{ type,fields,scope }); return
  }
  const result=await context.transaction.query<{admitted:boolean}>(`SELECT member_operation_scope_allows($1,'internal',$2,true)
    AND agent_read_scope_allows('internal',$2,$3) AS admitted`,[access.workspaceId,labels.compartments,labels.projectIds])
  if(result.rows[0]?.admitted!==true)throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
  creations.set(context,{ type,fields,scope:{ sensitivity:'internal',compartments:[...labels.compartments],projectIds:[...labels.projectIds] } })
}

/** Deployed adapter registration; callable operations still require current authority. */
export function createCanonicalNativeApplicationModule():ApplicationModuleDefinition<PoolClient> {
  const companyInput=z.object({name:z.string().min(1).max(256),domain:z.string().max(256).nullable().optional()}).strict()
  const contactInput=z.object({name:z.string().min(1).max(256),email:z.string().max(320).nullable().optional(),phone:z.string().max(100).nullable().optional()}).strict()
  const dealInput=z.object({stage:z.enum(['lead','qualified','proposal','negotiation','won','lost']).optional(),amount:crmAmountSchema.nullable().optional()}).strict()
  const taskInput=z.object({title:z.string().min(1).max(1024)}).strict()
  return {key:'native',defaultState:'enabled',application:{version:'1',dependencies:[],resources:definitions,
    queries:['get','query'],commands:['create_company','create_contact','create_deal','create_task'],events:['native.company.created','native.contact.created','native.deal.created','native.task.created'],
    policyCapabilities:['canonical_native'],backgroundHandlers:[],uiContributions:[]},
  resolveResources: resources,
  queries:{query:{input:queryInput,authorize:async(context,raw)=>{const input=queryInput.parse(raw);if(!(await resources(context,input.type)).length)throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')},
    execute:(context,raw)=>query(context,queryInput.parse(raw)),authorizeResult:authorizeQueryResult},get:{input:readInput,authorize:async(context,raw)=>{const input=readInput.parse(raw);await read(context,input.type,input.id,input.fields)},
    execute:async(context,raw)=>{const input=readInput.parse(raw);return read(context,input.type,input.id,input.fields)}, authorizeResult: authorizeReadResult}},
  commands:{create_company:{input:companyInput,eventKey:'native.company.created',
    authorize:(context,raw)=>{const input=companyInput.parse(raw);return authorizeCreate(context,'company',['name',...(input.domain?['domain']:[])])},authorizeResult,
    execute:async(context,raw)=>{
      const input=companyInput.parse(raw),access=context.execution.security.access
      const creation=creations.get(context)
      if(!creation)throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
      const record=await createCompany(access.userId,{...input,workspaceId:access.workspaceId,access,mergeByName:false,
        sensitivity:creation.scope.sensitivity,compartments:creation.scope.compartments,projectIds:creation.scope.projectIds,
        createdByAssistantId:context.execution.assistant.id},{client:context.transaction,afterCommit:context.afterCommit})
      return [await creationRef(context,'company',record.id)]
    }},create_contact:{input:contactInput,eventKey:'native.contact.created',
    authorize:(context,raw)=>{const input=contactInput.parse(raw);return authorizeCreate(context,'person',['name',...(input.email?['email']:[]),...(input.phone?['phone']:[])])},authorizeResult,
    execute:async(context,raw)=>{
      const input=contactInput.parse(raw),access=context.execution.security.access,creation=creations.get(context)
      if(!creation) throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
      const record=await createContact(access.userId,{...input,workspaceId:access.workspaceId,access,
        sensitivity:creation.scope.sensitivity,compartments:creation.scope.compartments,projectIds:creation.scope.projectIds,
        createdByAssistantId:context.execution.assistant.id},undefined,{client:context.transaction,afterCommit:context.afterCommit})
      return [await creationRef(context,'person',record.id)]
    }},create_deal:{input:dealInput,eventKey:'native.deal.created',
    authorize:(context,raw)=>{const input=dealInput.parse(raw);return authorizeCreate(context,'deal',['name','stage',...(input.amount!=null?['amount']:[])])},authorizeResult,
    execute:async(context,raw)=>{
      const input=dealInput.parse(raw),access=context.execution.security.access,creation=creations.get(context)
      if(!creation) throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
      const record=await createDeal(access.userId,{...input,workspaceId:access.workspaceId,access,
        sensitivity:creation.scope.sensitivity,compartments:creation.scope.compartments,projectIds:creation.scope.projectIds,
        createdByAssistantId:context.execution.assistant.id},undefined,{client:context.transaction,afterCommit:context.afterCommit})
      return [await creationRef(context,'deal',record.id)]
    }},create_task:{input:taskInput,eventKey:'native.task.created',authorize:context=>authorizeCreate(context,'task',['title']),authorizeResult,
    execute:async(context,raw)=>{
      const input=taskInput.parse(raw),access=context.execution.security.access
      const creation=creations.get(context)
      if(!creation)throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
      const record=await createTask(access.userId,{...input,workspaceId:access.workspaceId,access,sensitivity:creation.scope.sensitivity,
        compartments:creation.scope.compartments,projectIds:creation.scope.projectIds,
        createdByAssistantId:context.execution.assistant.id,writtenBy:'system'},undefined,context.transaction,{deduplicate:false})
      context.afterCommit(()=>publishTaskLifecycle({workspaceId:record.workspaceId,taskId:record.id,kind:'created',title:record.title,status:record.status,previousStatus:null,
        tags:record.tags,previousTags:null,assigneeId:record.assigneeId,previousAssigneeId:null,due:record.due,parentId:record.parentId,changedFields:[],actorId:access.userId,writtenBy:'system'}))
      return [await creationRef(context,'task',record.id)]
    }},
  }}
}
