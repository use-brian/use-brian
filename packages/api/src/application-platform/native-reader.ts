/** Canonical native query evaluation after SQL field/domain admission. [COMP:api/application-records] */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { bindScopeSources, validateApplicationValues, parseApplicationCrmFieldDefinition, type ScopeSource } from '@use-brian/core'
import { ApplicationPlatformError, applicationJsonSchema, type ApplicationQuery, type ApplicationResourceDefinition, type ApplicationFieldDefinition, type ApplicationRecordProjection } from '@use-brian/shared'
import { runCanonicalReadLease, validateCanonicalNativeValues, type CanonicalGenericReadContext } from './field-evidence.js'
import { canonicalNativeResourceDefinitions } from './native-resources.js'

const unavailable=()=>new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
function invalid():never {throw new ApplicationPlatformError('invalid_value','The declared query or cursor is invalid.')}
const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
  resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string().min(1),
  sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()
const capture=z.object({values:z.record(applicationJsonSchema),sources:z.array(source).min(1),policyVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const row=z.object({id:z.string().uuid(),data:z.record(applicationJsonSchema),record_version:z.string().min(1),sources:z.array(source).min(1),policy_version:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()
function scalar(field:ApplicationFieldDefinition):'numeric'|'boolean'|'timestamptz'|'text'|'jsonb' {
  if(field.kind==='number'||field.kind==='decimal')return 'numeric'
  if(field.kind==='timestamp')return 'timestamptz'
  if(field.kind==='boolean')return 'boolean'
  if(field.kind==='json')return 'jsonb'
  if(field.kind==='cell')invalid()
  if(field.kind==='crm') {
    const kind=parseApplicationCrmFieldDefinition(field.definition).fieldType
    if(kind==='number')return 'numeric'
    if(kind==='boolean')return 'boolean'
    if(kind==='multi_select')return 'jsonb'
  }
  return 'text'
}
/** Native scalar expressions never unwrap fake generic cells or interpolate keys. */
export function compileNativeApplicationQuery(workspaceId:string,definition:ApplicationResourceDefinition,input:ApplicationQuery) {
  const values:unknown[]=[workspaceId,definition.typeKey],bind=(value:unknown)=>{values.push(value);return `$${values.length}`}
  const fields=new Map(definition.fields.map(field=>[field.key,field])),expressions=new Map<string,{sql:string;cast:ReturnType<typeof scalar>;field:ApplicationFieldDefinition}>()
  function expression(key:string) {
    const cached=expressions.get(key);if(cached)return cached
    const field=fields.get(key);if(!field)throw unavailable()
    const cast=scalar(field),parameter=bind(key),sql=cast==='jsonb'?`nullif(data->${parameter}::text,'null'::jsonb)`:`(data->>${parameter}::text)::${cast}`
    const result={sql,cast,field};expressions.set(key,result);return result
  }
  function checkValue(field:ApplicationFieldDefinition,value:unknown) {
    if(value===null)return
    validateApplicationValues({...definition,fields:[{...field,required:false,immutable:false}]},{[field.key]:value})
  }
  const clauses:string[]=[]
  for(const filter of input.filters) {
    const item=expression(filter.field)
    if(filter.op==='contains') {
      if(item.cast==='jsonb'){checkValue(item.field,filter.value);clauses.push(`${item.sql} @> ${bind(JSON.stringify(filter.value))}::jsonb`)}
      else if(item.cast==='text'&&typeof filter.value==='string'){checkValue(item.field,filter.value);clauses.push(`strpos(lower(${item.sql}),lower(${bind(filter.value)}::text))>0`)}
      else invalid()
    } else if(filter.op==='in') {
      if(item.cast==='jsonb'||!Array.isArray(filter.value)||filter.value.length>100)invalid()
      filter.value.forEach(value=>{if(value===null)invalid();checkValue(item.field,value)})
      clauses.push(`${item.sql}=ANY(${bind(filter.value)}::${item.cast}[])`)
    } else {
      if(item.cast==='jsonb'&&!['eq','neq'].includes(filter.op))invalid()
      checkValue(item.field,filter.value)
      if(filter.value===null) {
        if(filter.op!=='eq'&&filter.op!=='neq')invalid()
        clauses.push(`${item.sql} IS ${filter.op==='neq'?'NOT ':''}NULL`)
      } else {
        const operators={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as const
        clauses.push(`${item.sql} ${operators[filter.op]} ${bind(item.cast==='jsonb'?JSON.stringify(filter.value):filter.value)}::${item.cast}`)
      }
    }
  }
  const aggregates=input.aggregate.map((item,index)=>{
    const field=expression(item.field);if(field.cast==='jsonb'||item.operation==='sum'&&field.cast!=='numeric'||field.cast==='boolean'&&item.operation!=='count')invalid()
    return `${item.operation}(${field.sql})::text AS "aggregate${index}"`
  })
  const order=input.sort.map(item=>{const field=expression(item.field);if(field.cast==='jsonb')invalid();return {...field,direction:item.direction}})
  order.push({sql:'id::text',cast:'text',field:{key:'id',label:'ID',kind:'text'},direction:'asc'})
  const signature=createHash('sha256').update(JSON.stringify({workspaceId,type:definition.typeKey,schema:definition.schemaVersion,filters:input.filters,sort:input.sort})).digest('hex')
  let after='true'
  if(input.cursor) {
    let decoded:unknown;try{decoded=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'))}catch{invalid()}
    const cursor=z.object({v:z.literal(1),signature:z.literal(signature),values:z.array(z.string().nullable()).length(order.length)}).strict().safeParse(decoded)
    if(!cursor.success)invalid()
    const prefixes:string[]=[],alternatives:string[]=[]
    for(const [index,item]of order.entries()) {
      const value=cursor.data.values[index]
      if(value!==null&&(value.length>8192||item.cast==='numeric'&&!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
        ||item.cast==='boolean'&&!['true','false'].includes(value)||item.cast==='timestamptz'&&!Number.isFinite(Date.parse(value))))invalid()
      const parameter=`${bind(value)}::${item.cast}`
      if(value!==null)alternatives.push(`(${[...prefixes,`(${item.sql} ${item.direction==='asc'?'>':'<'} ${parameter} OR ${item.sql} IS NULL)`].join(' AND ')})`)
      prefixes.push(`${item.sql} IS NOT DISTINCT FROM ${parameter}`)
    }
    after=alternatives.length?`(${alternatives.join(' OR ')})`:'false'
  }
  return {values,bind,predicate:clauses.join(' AND ')||'true',after,aggregates,
    order:order.map(item=>`${item.sql} ${item.direction.toUpperCase()} NULLS LAST`).join(','),
    sort:order.map((item,index)=>`${item.sql}::text AS "__sort${index}"`).join(','),limit:bind(input.limit+1),
    cursorFor:(value:Record<string,unknown>)=>{const encoded=Buffer.from(JSON.stringify({v:1,signature,values:order.map((_,index)=>value[`__sort${index}`])})).toString('base64url');if(encoded.length>4096)invalid();return encoded}}
}

const nativeQueryFrames=new AsyncLocalStorage<{client:PoolClient;active:boolean}>()
const nativeQueryQueues=new WeakMap<PoolClient,Promise<void>>()
/** Serialize private data frames; nested compiled evaluation retains one live frame. */
export async function runCanonicalNativeQueryFrame<T>(context:CanonicalGenericReadContext,operation:()=>Promise<T>):Promise<T> {
  context.assertLive?.()
  const parent=nativeQueryFrames.getStore()
  if(parent?.client===context.transaction) {
    if(!parent.active)throw unavailable()
    const result=await runCanonicalReadLease(context,operation);context.assertLive?.();if(!parent.active)throw unavailable();return result
  }
  let release!:()=>void
  const tail=new Promise<void>(resolve=>{release=resolve}),previous=nativeQueryQueues.get(context.transaction)??Promise.resolve()
  nativeQueryQueues.set(context.transaction,tail)
  const frame={client:context.transaction,active:true}
  try {
    await previous;context.assertLive?.()
    const result=await runCanonicalReadLease(context,()=>nativeQueryFrames.run(frame,operation));context.assertLive?.();return result
  }finally{
    frame.active=false;release()
    if(nativeQueryQueues.get(context.transaction)===tail)nativeQueryQueues.delete(context.transaction)
  }
}

/** Query catalogs are selected by the same current SQL domain as evaluation. */
export async function readCanonicalNativeQueryDefinition(context:CanonicalGenericReadContext,type:string):Promise<ApplicationResourceDefinition> {
  context.assertLive?.()
  const entry=z.object({typeKey:z.literal(type),fields:z.array(z.string()),customFields:z.array(z.record(z.unknown())),schemaVersion:z.string().optional()}).strict().safeParse(
    (await runCanonicalReadLease(context,()=>context.transaction.query<{value:unknown}>('SELECT application_native_query_catalog($1,$2) AS value',[context.workspaceId,type]))).rows[0]?.value)
  context.assertLive?.()
  const base=canonicalNativeResourceDefinitions().find(definition=>definition.typeKey===type)
  if(!entry.success||!base)throw unavailable()
  const custom:ApplicationResourceDefinition['fields']=entry.data.customFields.map(raw=>{
    const definition=parseApplicationCrmFieldDefinition(raw)
    return {key:`custom.${definition.fieldKey}`,label:definition.label,kind:'crm',required:definition.isRequired,
      definition:definition as unknown as Record<string,import('@use-brian/shared').ApplicationJson>}
  })
  const fields=[...base.fields.filter(field=>entry.data.fields.includes(field.key)&&!custom.some(configured=>configured.key===field.key)),...custom]
  return {...base,fields,schemaVersion:`${entry.data.schemaVersion??'1'}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`}
}

export async function queryCanonicalNativeRecords(context:CanonicalGenericReadContext,definition:ApplicationResourceDefinition,input:ApplicationQuery) {
  return runCanonicalNativeQueryFrame(context,()=>queryNativeRecordsInFrame(context,definition,input))
}
async function queryNativeRecordsInFrame(context:CanonicalGenericReadContext,definition:ApplicationResourceDefinition,input:ApplicationQuery) {
  if(definition.origin.kind!=='native'||definition.origin.moduleKey!=='native'||!['company','person','deal'].includes(definition.typeKey))throw unavailable()
  const consumed=[...new Set([...input.filters.map(item=>item.field),...input.sort.map(item=>item.field),...input.aggregate.map(item=>item.field)])].sort()
  const output=input.fields??definition.fields.map(field=>field.key),fields=[...new Set([...output,...consumed])].sort()
  if(new Set(output).size!==output.length||fields.some(field=>!definition.fields.some(item=>item.key===field)))throw unavailable()
  if(input.cursor&&input.aggregate.length)invalid()
  const compiled=compileNativeApplicationQuery(context.workspaceId,definition,input)
  const domain=capture.safeParse((await runCanonicalReadLease(context,()=>context.transaction.query<{value:unknown}>('SELECT observe_native_application_query_domain($1,$2,$3,$4) AS value',
    [context.workspaceId,definition.typeKey,fields,consumed]))).rows[0]?.value)
  if(!domain.success||Object.keys(domain.data.values).length||domain.data.sources[0].resourceKind!=='application_field'
    ||domain.data.sources.some(source=>source.workspaceId!==context.workspaceId))throw unavailable()
  const identity=domain.data.sources[0]
  // Capture and validate every consumed field before evaluating any predicate,
  // sort or aggregate. SQL expressions receive only these admitted snapshots.
  const candidates=z.array(row).max(4096).parse((await runCanonicalReadLease(context,()=>context.transaction.query(
    'SELECT * FROM read_native_application_query_candidates($1,$2,$3,$4,$5)',
    [context.workspaceId,definition.typeKey,consumed,identity.resourceId,identity.version]))).rows)
  for(const candidate of candidates)validateCanonicalNativeValues(definition,candidate.data)
  const candidateValues=compiled.bind(JSON.stringify(candidates))
  const result=(await runCanonicalReadLease(context,()=>context.transaction.query(`WITH candidates AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(${candidateValues}::jsonb) AS captured(id uuid,data jsonb,record_version text,sources jsonb,policy_version text)),
    filtered AS MATERIALIZED (SELECT * FROM candidates WHERE ${compiled.predicate}),
    page AS MATERIALIZED (SELECT *,${compiled.sort} FROM filtered WHERE ${compiled.after} ORDER BY ${compiled.order} LIMIT ${compiled.limit})
    SELECT $1::uuid AS workspace_id,$2::text AS type_key,(SELECT coalesce(jsonb_agg(to_jsonb(page)),'[]') FROM page) AS page
     ${compiled.aggregates.length?`,(SELECT to_jsonb(totals) FROM (SELECT ${compiled.aggregates.join(',')} FROM filtered) totals) AS aggregates`:''}`,compiled.values))).rows[0]
  if(result?.workspace_id!==context.workspaceId||result?.type_key!==definition.typeKey)throw unavailable()
  const page=z.array(row).max(input.limit+1).parse(result?.page)
  const sources:ScopeSource[]=[...domain.data.sources,...candidates.flatMap(candidate=>candidate.sources)]
  if(sources.some(source=>source.workspaceId!==context.workspaceId))throw unavailable()
  const records:ApplicationRecordProjection[]=[],selected=page.slice(0,input.limit)
  const projected=z.array(row.omit({record_version:true})).max(input.limit).parse((await runCanonicalReadLease(context,()=>context.transaction.query(
    'SELECT * FROM read_native_application_query_records($1,$2,$3,$4,$5,$6,$7)',
    [context.workspaceId,definition.typeKey,selected.map(item=>item.id),selected.map(item=>item.record_version),[...output].sort(),identity.resourceId,identity.version]))).rows)
  const byId=new Map(projected.map(item=>[item.id,item]))
  if(projected.length!==selected.length||byId.size!==projected.length)throw unavailable()
  for(const candidate of selected) {
    const value=byId.get(candidate.id)
    if(!value||output.some(field=>!Object.hasOwn(value.data,field))||Object.keys(value.data).length!==output.length
      ||value.sources.some(source=>source.workspaceId!==context.workspaceId))throw unavailable()
    validateCanonicalNativeValues(definition,value.data)
    const policyVersion=context.applicationFingerprint?createHash('sha256').update(JSON.stringify({application:context.applicationFingerprint,field:value.policy_version})).digest('hex'):value.policy_version
    const record=bindScopeSources({ref:{workspaceId:context.workspaceId,origin:definition.origin,typeKey:definition.typeKey,id:candidate.id,version:candidate.record_version},
      values:value.data,fields:Object.keys(value.data),policyVersion},value.sources)
    records.push(record);sources.push(...value.sources)
  }
  const aggregates=compiled.aggregates.length?input.aggregate.map((item,index)=>({...item,value:z.string().nullable().parse(result.aggregates[`aggregate${index}`])})):undefined
  const unique=[...new Map(sources.map(source=>[`${source.resourceKind}:${source.resourceId}:${source.version}`,source])).values()]
  return bindScopeSources({records,...(page.length>input.limit?{nextCursor:compiled.cursorFor(page[input.limit-1])}:{}),...(aggregates?{aggregates}:{})},unique)
}
