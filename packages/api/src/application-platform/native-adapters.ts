/** Canonical CRM/task storage adapters; no copied live records. [COMP:api/application-records] */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { applicationAuthorityCreationScope, parseApplicationCrmFieldDefinition, validateCrmCustomFieldValue, type ApplicationModuleDefinition, type ApplicationOperationContext,
  type ScopeSource } from '@use-brian/core'
import { ApplicationPlatformError, applicationJsonSchema, applicationResourceRefSchema, type ApplicationRecordProjection,
  type ApplicationResourceDefinition, type ApplicationResourceRef } from '@use-brian/shared'
import { createCompany } from '../db/crm.js'
import { getEntityById } from '../db/entities-store.js'
import { createTask, getTaskById } from '../db/tasks.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'
import { getApplicationExecutionBinding } from './execution-context.js'
import { bindApplicationFieldProjection } from './field-evidence.js'

const sourceSchema=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
  sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string()),version:z.string(),
  held:z.boolean(),retractedAt:z.unknown().nullable(),validTo:z.unknown().nullable()})
const readInput=z.object({type:z.enum(['company','person','deal','task','file','workspace_member']),id:z.string().uuid()}).strict()
type Context=ApplicationOperationContext<PoolClient>
const creations = new WeakMap<Context, { type: 'company' | 'task'; fields: string[]; scope: { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] } }>()

const definitions:ApplicationResourceDefinition[]=[
  {typeKey:'company',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text',required:true},{key:'domain',label:'Domain',kind:'text'}]},
  {typeKey:'person',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text',required:true},{key:'email',label:'Email',kind:'text'},{key:'phone',label:'Phone',kind:'text'}]},
  {typeKey:'deal',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text',required:true},{key:'stage',label:'Stage',kind:'text'},{key:'amount',label:'Amount',kind:'number'}]},
  {typeKey:'task',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'title',label:'Title',kind:'text',required:true},{key:'status',label:'Status',kind:'text'}]},
  {typeKey:'file',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'name',label:'Name',kind:'text'},{key:'mimeType',label:'MIME type',kind:'text'},{key:'sizeBytes',label:'Size',kind:'number'},{key:'storageRef',label:'Storage reference',kind:'text'}]},
  {typeKey:'workspace_member',origin:{kind:'native',moduleKey:'native'},schemaVersion:'1',fields:[{key:'id',label:'Member ID',kind:'text'}]},
]
async function resources(context: Context): Promise<ApplicationResourceDefinition[]> {
  const app = getApplicationExecutionBinding(context.execution)
  const entries = app ? (await context.transaction.query<{ value: { typeKey: string; fields: string[]; customFields: Record<string, unknown>[] } }>('SELECT application_native_catalog() AS value')).rows.map(row => row.value)
    : definitions.map(definition => ({ typeKey: definition.typeKey, fields: definition.fields.map(field => field.key), customFields: [] as Record<string, unknown>[] }))
  if (!app) {
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
    const fields = [...base.fields.filter(field => entry.fields.includes(field.key)), ...custom]
    return { ...base, fields, schemaVersion: `1:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}` }
  })
}
async function read(context:Context,type:z.infer<typeof readInput>['type'],id:string):Promise<ApplicationRecordProjection> {
  const access=context.execution.security.access
  const application=getApplicationExecutionBinding(context.execution)
  if(application) {
    const result=await context.transaction.query<{projection:unknown}>('SELECT application_native_projection($1,$2) AS projection',[type,id])
    const parsed=z.object({values:z.record(applicationJsonSchema),source:sourceSchema}).safeParse(result.rows[0]?.projection)
    if(!parsed.success)throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
    const values=parsed.data.values as ApplicationRecordProjection['values']
    const definition = (await resources(context)).find(resource => resource.typeKey === type)
    if (!definition) throw new ApplicationPlatformError('access_unavailable', 'The schema is unavailable.')
    for (const field of definition.fields) if (field.kind === 'crm' && Object.hasOwn(values, field.key)
      && !validateCrmCustomFieldValue(parseApplicationCrmFieldDefinition(field.definition), values[field.key])) {
      throw new ApplicationPlatformError('invalid_value', 'The canonical record requires review.')
    }
    return bindApplicationFieldProjection(context, {ref:{workspaceId:access.workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:type,id,version:parsed.data.source.version},
      values,fields:Object.keys(values),policyVersion:`${application.state.fingerprint}:${definition.schemaVersion}`})
  }
  if (type === 'file' || type === 'workspace_member') {
    const result = type === 'workspace_member'
      ? await context.transaction.query<{ values: unknown; source: unknown }>(`SELECT jsonb_build_object('id',m.user_id) AS values,
        jsonb_build_object('workspaceId',m.workspace_id,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
          'version',md5(to_jsonb(m)::text),'held',false,'retractedAt',NULL,'validTo',NULL) AS source
        FROM workspace_members m WHERE m.workspace_id=$1 AND m.user_id=$2`, [access.workspaceId,id])
      : await context.transaction.query<{ values: unknown; source: unknown }>(`SELECT jsonb_build_object('name',f.name,'mimeType',f.mime,'sizeBytes',f.size_bytes,'storageRef',f.storage_uri) AS values,
        read_scope_source(f.workspace_id,'workspace_file',f.id) AS source FROM workspace_files f WHERE f.workspace_id=$1 AND f.id=$2`, [access.workspaceId,id])
    const parsedValues = z.record(applicationJsonSchema).safeParse(result.rows[0]?.values), parsedSource = sourceSchema.safeParse(result.rows[0]?.source)
    if (!parsedValues.success || !parsedSource.success || parsedSource.data.held || parsedSource.data.retractedAt || parsedSource.data.validTo) {
      throw new ApplicationPlatformError('access_unavailable', 'The source is unavailable.')
    }
    const values = parsedValues.data, source = parsedSource.data
    return bindApplicationFieldProjection(context, { ref: { workspaceId: access.workspaceId, origin: { kind: 'native', moduleKey: 'native' }, typeKey: type, id, version: source.version },
      values, fields: Object.keys(values), policyVersion: 'native:1' })
  }
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
  const definition = (await resources(context)).find(resource => resource.typeKey === type)!
  if ('displayName' in record) for (const field of definition.fields) if (field.kind === 'crm') {
    const custom = attrs.custom_fields && typeof attrs.custom_fields === 'object' ? attrs.custom_fields as Record<string, unknown> : {}
    Object.assign(values, { [field.key]: custom[parseApplicationCrmFieldDefinition(field.definition).fieldKey] ?? null })
  }
  const json=applicationJsonSchema.parse(values) as ApplicationRecordProjection['values']
  return bindApplicationFieldProjection(context, {ref:{workspaceId:access.workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:type,id,version:source.version},
    values:json,fields:Object.keys(json),policyVersion:`native:${definition.schemaVersion}`})
}
async function authorizeReadResult(context: Context, result: unknown) {
  const value = result as ApplicationRecordProjection, ref = applicationResourceRefSchema.safeParse(value?.ref)
  const input = ref.success ? readInput.safeParse({ type: ref.data.typeKey, id: ref.data.id }) : null
  if (!ref.success || !input?.success || ref.data.workspaceId !== context.execution.security.access.workspaceId
    || ref.data.origin.kind !== 'native' || ref.data.origin.moduleKey !== 'native') throw new ApplicationPlatformError('access_unavailable', 'The source is unavailable.')
  const current = await read(context, input.data.type, input.data.id)
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
async function creationRef(context: Context, type: 'company' | 'task', id: string): Promise<ApplicationResourceRef> {
  if (!getApplicationExecutionBinding(context.execution)) return (await read(context,type,id)).ref
  const creation = creations.get(context)
  if (!creation || creation.type !== type) throw new ApplicationPlatformError('access_unavailable','The operation is unavailable.')
  const value = (await context.transaction.query<{ ref: unknown }>('SELECT application_native_creation_ref($1,$2,$3) AS ref', [type,id,creation.fields])).rows[0]?.ref
  const parsed = applicationResourceRefSchema.safeParse(value)
  if (!parsed.success) throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
  return parsed.data
}
async function authorizeCreate(context:Context,type:'company'|'task',fields:string[]) {
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
  const taskInput=z.object({title:z.string().min(1).max(1024)}).strict()
  return {key:'native',defaultState:'enabled',application:{version:'1',dependencies:[],resources:definitions,
    queries:['get'],commands:['create_company','create_task'],events:['native.company.created','native.task.created'],
    policyCapabilities:['canonical_native'],backgroundHandlers:[],uiContributions:[]},
  resolveResources: resources,
  queries:{get:{input:readInput,authorize:async(context,raw)=>{const input=readInput.parse(raw);await read(context,input.type,input.id)},
    execute:async(context,raw)=>{const input=readInput.parse(raw);return read(context,input.type,input.id)}, authorizeResult: authorizeReadResult}},
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
