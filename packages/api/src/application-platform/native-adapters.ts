/** Canonical CRM/task storage adapters; no copied live records. [COMP:api/application-records] */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { applicationAuthorityCreationScope, parseApplicationCrmFieldDefinition, type ApplicationModuleDefinition, type ApplicationOperationContext } from '@use-brian/core'
import { ApplicationPlatformError, applicationJsonSchema as importedJsonSchema, applicationResourceRefSchema, applicationQuerySchema, type ApplicationRecordProjection,
  type ApplicationResourceDefinition, type ApplicationResourceRef } from '@use-brian/shared'
import { crmCompanyPatch,crmContactPatch,crmDealPatch,authorizeCanonicalCrmPatch,patchCanonicalCrmFields,type CanonicalCrmType,type CanonicalCrmPatch } from '../db/crm.js'
import { createTask,authorizeCanonicalTaskPatch,patchCanonicalTaskFields } from '../db/tasks.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'
import { getApplicationExecutionBinding } from './execution-context.js'
import { canonicalGenericReadContext, readCanonicalNativeRecord } from './field-evidence.js'
import { queryCanonicalNativeRecords, readCanonicalNativeQueryDefinition } from './native-reader.js'
import { canonicalNativeResourceDefinitions } from './native-resources.js'
import { boundScopeSources } from '@use-brian/core'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'

const readInput=z.object({type:z.enum(['company','person','deal','task','file','workspace_member']),id:z.string().uuid(),fields:z.array(z.string().min(1).max(256)).max(256).refine(fields=>new Set(fields).size===fields.length).optional()}).strict()
const queryInput=z.object({type:z.enum(['company','person','deal','task']),query:applicationQuerySchema}).strict()
type Context=ApplicationOperationContext<PoolClient>
const creations = new WeakMap<Context, { type: 'company' | 'person' | 'deal' | 'task'; fields: string[]; scope: { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] } }>()
const crmPatches=new WeakMap<Context,Array<{type:CanonicalCrmType;id:string;patch:CanonicalCrmPatch}>>()

const taskPatches=new WeakMap<Context,{id:string;patch:import('@use-brian/core').TaskUpdateFields}>()
const definitions=canonicalNativeResourceDefinitions()
async function resources(context: Context, queryType?: string): Promise<ApplicationResourceDefinition[]> {
  const app = getApplicationExecutionBinding(context.execution)
  if(queryType)return [await readCanonicalNativeQueryDefinition(canonicalGenericReadContext(context),queryType)]
  const entries:Array<{typeKey:string;fields:string[];customFields:Record<string,unknown>[];schemaVersion?:string}> = app ? (await context.transaction.query<{ value: { typeKey: string; fields: string[]; customFields: Record<string, unknown>[] } }>('SELECT application_native_catalog() AS value')).rows.map(row => row.value)
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
  if(type==='task'){const logical=(await context.transaction.query<{id:string|null}>('SELECT application_native_task_identity($1,$2) AS id',[context.execution.security.access.workspaceId,id])).rows[0]?.id;if(!logical)throw new ApplicationPlatformError('access_unavailable','The task is unavailable.');id=logical}
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
async function authorizeCrmPatchResult(context:Context,refs:ApplicationResourceRef[]) {
  const inputs=crmPatches.get(context),actor=context.execution.security.access
  if(!inputs||refs.length!==inputs.length||new Set(refs.map(ref=>`${ref.typeKey}:${ref.id}`)).size!==refs.length)throw new ApplicationPlatformError('access_unavailable','The records are unavailable.')
  for(const ref of refs){const input=inputs.find(item=>item.id===ref.id&&item.type===ref.typeKey)
    if(!input||ref.workspaceId!==actor.workspaceId||ref.origin.kind!=='native'||ref.origin.moduleKey!=='native'
      ||!await authorizeCanonicalCrmPatch(actor.userId,input.type,input.id,input.patch,context.transaction,actor))throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
  }
}
function patchFields(patch:Record<string,unknown>) {
 return Object.entries(patch).flatMap(([key,value])=>value===undefined?[]:key==='customFields'?Object.keys(value as object).map(field=>`custom.${field}`):[key])
}
async function authorizePatches(context:Context,inputs:Array<{type:CanonicalCrmType;id:string;patch:CanonicalCrmPatch}>) {
 const actor=context.execution.security.access
 for(const input of [...inputs].sort((a,b)=>`${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))) {
  if(!await authorizeCanonicalCrmPatch(actor.userId,input.type,input.id,input.patch,context.transaction,actor))throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
 }
 crmPatches.set(context,inputs)
}
async function executePatches(context:Context,inputs:Array<{type:CanonicalCrmType;id:string;patch:CanonicalCrmPatch;expectedVersion?:string}>) {
 const actor=context.execution.security.access,refs:ApplicationResourceRef[]=[]
 for(const input of inputs){const expectedVersion=input.expectedVersion??context.expectedVersion
  if(expectedVersion===undefined)throw new ApplicationPlatformError('invalid_value','A canonical source version is required.')
  const ref=await patchCanonicalCrmFields(actor.userId,input.type,input.id,input.patch,context.transaction,actor,{expectedVersion})
  if(!ref)throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
  refs.push(ref)
 }
 return refs
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
 const id=z.string().uuid().transform(value=>value.toLowerCase()),version=z.string().regex(/^[1-9]\d*$/)
 const companyInput=crmCompanyPatch.required({name:true}).omit({archivedAt:true})
 const contactInput=crmContactPatch.required({name:true}).omit({archivedAt:true})
 const dealInput=crmDealPatch.omit({archivedAt:true}).extend({closeDate:z.string().date().nullable().optional()})
 const companyPatch=z.object({id,patch:crmCompanyPatch.refine(value=>patchFields(value).length>0)}).strict()
 const contactPatch=z.object({id,patch:crmContactPatch.refine(value=>patchFields(value).length>0)}).strict()
 const dealPatch=z.object({id,patch:crmDealPatch.extend({closeDate:z.string().date().nullable().optional()}).refine(value=>patchFields(value).length>0)}).strict()
 const taskInput=z.object({title:z.string().min(1).max(512).refine(value=>value.trim().length>0),status:z.enum(['todo','in_progress','in_review','blocked','done','archived']).optional(),
  assigneeId:id.nullable().optional(),executorAssistantId:id.nullable().optional(),followUpMemberId:id.nullable().optional(),
  home:z.object({kind:z.enum(['department','project']),id}).strict().nullable().optional(),due:z.string().datetime({offset:true}).nullable().optional(),
  tags:z.array(z.string()).optional(),parentId:id.nullable().optional(),
  externalRef:z.record(importedJsonSchema).optional(),attributes:z.record(importedJsonSchema).optional()}).strict()
 const taskPatchInput=z.object({id,patch:taskInput.partial().refine(value=>Object.keys(value).length>0)}).strict()
 const taskPatch=(raw:unknown)=>{const input=taskPatchInput.parse(raw);const {due,...rest}=input.patch;return{id:input.id,patch:{...rest,...(due!==undefined?{due:due===null?null:new Date(due)}:{})}}}
 const batchInput=z.object({patches:z.array(companyPatch.extend({expectedVersion:version})).min(1).max(100)
  .refine(items=>new Set(items.map(item=>item.id)).size===items.length)}).strict()
 const mixedPatch=z.discriminatedUnion('type',[
  companyPatch.extend({type:z.literal('company'),expectedVersion:version}),contactPatch.extend({type:z.literal('person'),expectedVersion:version}),
  dealPatch.extend({type:z.literal('deal'),expectedVersion:version})])
 const mixedInput=z.object({patches:z.array(mixedPatch).min(1).max(100).refine(items=>new Set(items.map(item=>`${item.type}:${item.id}`)).size===items.length)}).strict()
 const customInput=z.object({type:z.enum(['company','person','deal']),id,values:z.record(importedJsonSchema).refine(value=>Object.keys(value).length>0)}).strict()
 const archiveInput=z.object({type:z.enum(['company','person','deal']),id,archived:z.boolean()}).strict()
 const stageInput=z.object({id,stage:z.enum(['lead','qualified','proposal','negotiation','won','lost'])}).strict()
 const moveInput=z.object({id,stageId:id}).strict()
 const relationInput=z.discriminatedUnion('type',[
  z.object({type:z.literal('person'),id,field:z.literal('companyId'),targetId:id.nullable()}).strict(),
  z.object({type:z.literal('deal'),id,field:z.enum(['companyId','contactId']),targetId:id.nullable()}).strict()])
 const participantInput=z.object({id,contactId:id,role:z.string().max(200).nullable().optional(),isPrimary:z.boolean().optional()}).strict()
 const removeParticipantInput=z.object({id,contactId:id}).strict()
 const primaryContactInput=z.object({id,contactId:id.nullable(),role:z.string().max(200).nullable().optional()}).strict()
 const participantCommand=(operation:'add'|'remove'|'primary',schema:z.ZodType)=>{
  const commandInput=new WeakMap<Context,{id:string;contactId:string|null;role?:string|null;isPrimary?:boolean}>()
  const input=(raw:unknown)=>schema.parse(raw) as {id:string;contactId:string|null;role?:string|null;isPrimary?:boolean}
  const authorize=async(context:Context,raw:unknown)=>{const value=input(raw),actor=context.execution.security.access
   if(!await authorizeCanonicalCrmPatch(actor.userId,'deal',value.id,{},context.transaction,actor))throw new ApplicationPlatformError('access_unavailable','The deal is unavailable.')
   const fields=['participants',...(operation!=='add'||value.isPrimary?['contactId']:[])]
   if(!(await context.transaction.query<{value:unknown}>('SELECT application_crm_patch_state($1,$2,$3) AS value',['deal',value.id,fields])).rows[0]?.value)throw new ApplicationPlatformError('access_unavailable','The relationship is unavailable.')
   commandInput.set(context,value)
  }
  return{input:schema,eventKey:'native.deal.participants_changed',authorize,execute:async(context:Context,raw:unknown)=>{
   if(context.expectedVersion===undefined)throw new ApplicationPlatformError('invalid_value','A canonical source version is required.')
   const value=input(raw),actor=context.execution.security.access
   return[applicationResourceRefSchema.parse((await context.transaction.query<{value:unknown}>(
    'SELECT application_mutate_canonical_deal_participant($1,$2,$3,$4,$5,$6,$7) AS value',[actor.workspaceId,value.id,value.contactId,operation,value.role??null,value.isPrimary??false,context.expectedVersion])).rows[0]?.value)]
  },authorizeResult:async(context:Context,refs:ApplicationResourceRef[])=>{const value=commandInput.get(context)
   if(!value||refs.length!==1||refs[0].id!==value.id||refs[0].typeKey!=='deal'||refs[0].workspaceId!==context.execution.security.access.workspaceId||refs[0].origin.kind!=='native'||refs[0].origin.moduleKey!=='native')throw new ApplicationPlatformError('access_unavailable','The relationship is unavailable.')
   await authorize(context,value)
  }}
 }
 const toPatch=(type:CanonicalCrmType,input:{id:string;patch:unknown})=>{const patch=input.patch as Record<string,unknown>;return{type,id:input.id,patch:{...patch,...(typeof patch.closeDate==='string'?{closeDate:new Date(patch.closeDate)}:{})} as CanonicalCrmPatch}}
 const command=(schema:z.ZodType,adapt:(raw:unknown)=>Array<{type:CanonicalCrmType;id:string;patch:CanonicalCrmPatch;expectedVersion?:string}>,eventKey='native.record.patched')=>({
  input:schema,eventKey,authorize:(context:Context,raw:unknown)=>{const inputs=adapt(raw);if(inputs.some(input=>input.expectedVersion!==undefined)&&context.expectedVersion!==undefined)throw new ApplicationPlatformError('invalid_value','Each record needs its own source version.');return authorizePatches(context,inputs)},
  execute:(context:Context,raw:unknown)=>executePatches(context,adapt(raw)),authorizeResult:authorizeCrmPatchResult,
 })
 const createCrm=(type:CanonicalCrmType,schema:z.AnyZodObject,eventKey:string)=>({input:schema,eventKey,authorize:(context:Context,raw:unknown)=>{
  const input=schema.parse(raw),fields=patchFields(input)
  if(type==='deal'){if(!fields.includes('name'))fields.push('name');if(!fields.includes('stage'))fields.push('stage')}
  return authorizeCreate(context,type,fields)
 },authorizeResult,execute:async(context:Context,raw:unknown)=>{
  const input=schema.parse(raw),access=context.execution.security.access,creation=creations.get(context)
  if(!creation)throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
  const value=(await context.transaction.query<{ref:unknown}>('SELECT application_create_canonical_crm_ref($1,$2,$3) AS ref',[type,input,{...creation.scope,workspaceId:access.workspaceId,createdByAssistantId:context.execution.assistant.id}])).rows[0]?.ref
  return [applicationResourceRefSchema.parse(value)]
 }})
 const commands:ApplicationModuleDefinition<PoolClient>['commands']={
  add_deal_participant:participantCommand('add',participantInput),remove_deal_participant:participantCommand('remove',removeParticipantInput),set_primary_contact:participantCommand('primary',primaryContactInput),
  patch_task:{input:taskPatchInput,eventKey:'native.task.patched',authorize:async(context,raw)=>{const input=taskPatch(raw),actor=context.execution.security.access
   if(!await authorizeCanonicalTaskPatch(actor.userId,actor.workspaceId,input.id,input.patch,context.transaction,actor))throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
   taskPatches.set(context,input)
  },execute:async(context,raw)=>{if(context.expectedVersion===undefined)throw new ApplicationPlatformError('invalid_value','A canonical source version is required.')
   const input=taskPatch(raw),actor=context.execution.security.access,result=await patchCanonicalTaskFields(actor.userId,actor.workspaceId,input.id,input.patch,context.transaction,actor,{expectedVersion:context.expectedVersion})
   if(!result)throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
   return[result.ref]
  },authorizeResult:async(context,refs)=>{const input=taskPatches.get(context),actor=context.execution.security.access
   if(!input||refs.length!==1||refs[0].workspaceId!==actor.workspaceId||refs[0].typeKey!=='task'||refs[0].origin.kind!=='native'||refs[0].origin.moduleKey!=='native')throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
   const state=await authorizeCanonicalTaskPatch(actor.userId,actor.workspaceId,input.id,input.patch,context.transaction,actor)
   if(!state||state.id!==refs[0].id)throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
  }},
  patch_company:command(companyPatch,raw=>[toPatch('company',companyPatch.parse(raw))],'native.company.patched'),
  patch_contact:command(contactPatch,raw=>[toPatch('person',contactPatch.parse(raw))],'native.contact.patched'),
  patch_deal:command(dealPatch,raw=>[toPatch('deal',dealPatch.parse(raw))],'native.deal.patched'),
  patch_companies:command(batchInput,raw=>{const input=batchInput.parse(raw);return input.patches.map(item=>({...toPatch('company',item),expectedVersion:item.expectedVersion}))},'native.company.patched'),
  patch_records:command(mixedInput,raw=>mixedInput.parse(raw).patches.map(item=>({...toPatch(item.type,item),expectedVersion:item.expectedVersion}))),
  set_custom_fields:command(customInput,raw=>{const input=customInput.parse(raw);return[{type:input.type,id:input.id,patch:{customFields:input.values}}]}),
  archive_record:command(archiveInput,raw=>{const input=archiveInput.parse(raw);return[{type:input.type,id:input.id,patch:{archivedAt:input.archived?new Date().toISOString():null}}]},'native.record.archived'),
  set_deal_stage:command(stageInput,raw=>{const input=stageInput.parse(raw);return[{type:'deal',id:input.id,patch:{stage:input.stage}}]},'native.deal.stage_changed'),
  move_deal:command(moveInput,raw=>{const input=moveInput.parse(raw);return[{type:'deal',id:input.id,patch:{pipelineStageId:input.stageId}}]},'native.deal.stage_changed'),
  set_relationship:command(relationInput,raw=>{const input=relationInput.parse(raw);return[{type:input.type,id:input.id,patch:{[input.field]:input.targetId}}]},'native.record.relationship_changed'),
  create_company:createCrm('company',companyInput,'native.company.created'),create_contact:createCrm('person',contactInput,'native.contact.created'),
  create_deal:createCrm('deal',dealInput,'native.deal.created'),
  create_task:{input:taskInput,eventKey:'native.task.created',authorize:(context,raw)=>authorizeCreate(context,'task',patchFields(taskInput.parse(raw))),authorizeResult,
   execute:async(context,raw)=>{const input=taskInput.parse(raw),{due,...taskValues}=input,access=context.execution.security.access,creation=creations.get(context)
    if(!creation)throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
    const record=await createTask(access.userId,{...taskValues,...(due!==undefined?{due:due===null?null:new Date(due)}:{}),workspaceId:access.workspaceId,access,...creation.scope,
     createdByAssistantId:context.execution.assistant.id,writtenBy:'system'},undefined,context.transaction,{deduplicate:false})
    context.afterCommit(()=>publishTaskLifecycle({workspaceId:record.workspaceId,taskId:record.id,kind:'created',title:record.title,status:record.status,previousStatus:null,
     tags:record.tags,previousTags:null,assigneeId:record.assigneeId,previousAssigneeId:null,due:record.due,parentId:record.parentId,changedFields:[],actorId:access.userId,writtenBy:'system'}))
    return [await creationRef(context,'task',record.id)]
   }},
 }
 return {key:'native',defaultState:'enabled',application:{version:'2',dependencies:[],resources:definitions,
  queries:['get','query'],commands:Object.keys(commands),events:[...new Set(Object.values(commands).map(command=>command.eventKey))],
  policyCapabilities:['canonical_native'],backgroundHandlers:[],uiContributions:[]},resolveResources:resources,commands,
  queries:{query:{input:queryInput,authorize:async(context,raw)=>{const input=queryInput.parse(raw);if(!(await resources(context,input.type)).length)throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')},
   execute:(context,raw)=>query(context,queryInput.parse(raw)),authorizeResult:authorizeQueryResult},get:{input:readInput,authorize:async(context,raw)=>{const input=readInput.parse(raw);await read(context,input.type,input.id,input.fields)},
   execute:async(context,raw)=>{const input=readInput.parse(raw);return read(context,input.type,input.id,input.fields)},authorizeResult:authorizeReadResult}},
 }
}
