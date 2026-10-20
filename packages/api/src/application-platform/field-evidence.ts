/** Canonical field captures and current-reader ancestry. [COMP:api/application-field-evidence] */
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { bindScopeSources, boundScopeSources, resourceScopeKey, validateApplicationValues, type ApplicationOperationContext, type ScopeSource } from '@use-brian/core'
import { ApplicationPlatformError, applicationJsonSchema, type ApplicationRecordProjection,type ApplicationResourceDefinition } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { currentApplicationReadTransaction,getApplicationExecutionBinding } from './execution-context.js'

const sourceSchema = z.object({ workspaceId: z.string().uuid(), userId: z.string().uuid().nullable(), assistantId: z.string().uuid().nullable(),
  resourceKind: z.enum(['application_field','external_source']), resourceId: z.string().uuid(), version: z.string().min(1),
  sensitivity: z.enum(['public','internal','confidential']), compartments: z.array(z.string()), projectIds: z.array(z.string().uuid()) }).strict()
const captureSchema = z.object({ values: z.record(applicationJsonSchema), sources: z.array(sourceSchema).min(1),
  policyVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
function unavailable(): never { throw new ApplicationPlatformError('access_unavailable', 'The source is unavailable.') }

/** The SQL connection, not this descriptor, authenticates and authorizes the reader. */
export interface CanonicalGenericReadContext {
  transaction: PoolClient
  workspaceId: string
  applicationFingerprint?: string
  /** Private live-host check; never serialized as resource metadata or authority. */
  assertLive?:()=>void
}
export function canonicalGenericReadContext(context: ApplicationOperationContext<PoolClient>): CanonicalGenericReadContext {
  const application = getApplicationExecutionBinding(context.execution),bound=currentApplicationReadTransaction(context.execution.security.access)
  if(bound&&bound.client!==context.transaction)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  return { ...(bound?{assertLive:bound.assertLive}:{}),transaction: context.transaction, workspaceId: context.execution.security.access.workspaceId,
    ...(application ? { applicationFingerprint: application.state.fingerprint } : {}) }
}

/** Host liveness brackets the actual transport, including rejected SQL. */
async function readWithCanonicalLease<T>(context:CanonicalGenericReadContext,operation:()=>Promise<T>):Promise<T> {
  context.assertLive?.()
  try{return await operation()}finally{context.assertLive?.()}
}

/** Generic values and absence are selected/captured under actual native/app SQL rights. */
export async function readCanonicalGenericApplicationRecord(context: ApplicationOperationContext<PoolClient>,
  definition: ApplicationResourceDefinition,id: string,
  query?: { fields: readonly string[]; expectedVersion: string }): Promise<ApplicationRecordProjection> {
  return readCanonicalGenericRecord(canonicalGenericReadContext(context),definition,id,query)
}

/** Shared native/application SQL capture; no execution-context fabrication for legacy readers. */
export async function readCanonicalGenericRecord(context: CanonicalGenericReadContext,
  definition: ApplicationResourceDefinition,id: string,
  query?: { fields: readonly string[]; expectedVersion: string }): Promise<ApplicationRecordProjection> {
  const origin = structuredClone(definition.origin),workspaceId = context.workspaceId
  const declared = new Set(definition.fields.map(field => field.key)),fields = query ? [...query.fields] : undefined
  if (origin.kind !== 'generic') unavailable()
  const captured = captureSchema.extend({ id: z.string().uuid(),recordVersion: z.string().min(1),absentFields: z.array(z.string()).max(256) }).safeParse(
    (await readWithCanonicalLease(context,()=>context.transaction.query<{ value: unknown }>(query
      ? "SELECT read_generic_application_projection($1,$2,$3,$4,'query',$5,$5) AS value"
      : 'SELECT read_generic_application_record($1,$2,$3,$4) AS value',
      [workspaceId,origin.entityTypeId,definition.typeKey,id,...(fields ? [fields] : [])]))).rows[0]?.value)
  if (!captured.success || captured.data.sources.some(source => source.workspaceId !== workspaceId)
    || captured.data.id !== id.toLowerCase() || query && captured.data.recordVersion !== query.expectedVersion
    || captured.data.sources[0].resourceKind !== 'application_field'
    || new Set(captured.data.absentFields).size !== captured.data.absentFields.length
    || [...Object.keys(captured.data.values),...captured.data.absentFields].some(field => !declared.has(field))
    || captured.data.absentFields.some(field => Object.hasOwn(captured.data.values,field))
    || fields && !isDeepStrictEqual([...fields].sort(),[...Object.keys(captured.data.values),...captured.data.absentFields].sort())) unavailable()
  const policyVersion = context.applicationFingerprint ? createHash('sha256').update(JSON.stringify({ application: context.applicationFingerprint,field: captured.data.policyVersion })).digest('hex') : captured.data.policyVersion
  return bindScopeSources({ ref: { workspaceId,origin,typeKey: definition.typeKey,id: captured.data.id,version: captured.data.recordVersion },
    values: captured.data.values,fields: Object.keys(captured.data.values),policyVersion,
    ...(captured.data.absentFields.length ? { absentFields: captured.data.absentFields } : {}) },captured.data.sources)
}

/** Validate only values actually selected; reading immutable metadata is allowed. */
export function validateCanonicalNativeValues(definition:ApplicationResourceDefinition,values:ApplicationRecordProjection['values']):void {
  validateApplicationValues({...definition,fields:definition.fields.filter(field=>Object.hasOwn(values,field.key))
    .map(field=>({...field,immutable:false}))},values)
}

type NativeAmountEncoding = 'number' | 'string' | 'null' | 'invalid'
const nativeAmountEncodings = new WeakMap<ApplicationRecordProjection, NativeAmountEncoding>()
/** Private selected-value format, never a grant or a serialized projection field. */
export function canonicalNativeAmountEncoding(projection: ApplicationRecordProjection): Exclude<NativeAmountEncoding, 'invalid'> {
  const encoding = nativeAmountEncodings.get(projection)
  if (encoding === undefined) unavailable()
  if (encoding === 'invalid') throw new ApplicationPlatformError('invalid_value', 'The canonical amount requires review.')
  return encoding
}

/** Canonical native values are selected and captured before crossing the SQL boundary. */
export async function readCanonicalNativeRecord(context:CanonicalGenericReadContext,
  definition:ApplicationResourceDefinition,id:string,fields?:readonly string[]):Promise<ApplicationRecordProjection> {
  if(definition.origin.kind!=='native' || definition.origin.moduleKey!=='native') unavailable()
  const captured=captureSchema.extend({id:z.string().uuid(),recordVersion:z.string().min(1),
    valueEncodings:z.object({amount:z.enum(['number','string','null','invalid']).optional()}).strict().optional()}).safeParse(
    (await readWithCanonicalLease(context,()=>context.transaction.query<{value:unknown}>('SELECT read_native_application_record($1,$2,$3,$4) AS value',
      [context.workspaceId,definition.typeKey,id,fields?[...fields]:null]))).rows[0]?.value)
  if(!captured.success || captured.data.id!==id.toLowerCase() || captured.data.sources[0].resourceKind!=='application_field'
    || captured.data.sources.some(source=>source.workspaceId!==context.workspaceId)
    || Object.keys(captured.data.values).some(field=>!definition.fields.some(candidate=>candidate.key===field))
    || fields && !isDeepStrictEqual([...fields].sort(),Object.keys(captured.data.values).sort())) unavailable()
  validateCanonicalNativeValues(definition,captured.data.values)
  const policyVersion=context.applicationFingerprint
    ? createHash('sha256').update(JSON.stringify({application:context.applicationFingerprint,field:captured.data.policyVersion})).digest('hex')
    :captured.data.policyVersion
  const projection = bindScopeSources({ref:{workspaceId:context.workspaceId,origin:definition.origin,typeKey:definition.typeKey,id:captured.data.id,version:captured.data.recordVersion},
    values:captured.data.values,fields:Object.keys(captured.data.values),policyVersion},captured.data.sources)
  if (definition.typeKey === 'deal' && Object.hasOwn(captured.data.values, 'amount') && captured.data.valueEncodings?.amount) {
    nativeAmountEncodings.set(projection, captured.data.valueEncodings.amount)
  }
  return projection
}

/** A row-free native/app domain is captured under actual current SQL ceilings. */
export async function readCanonicalGenericQueryDomain(context: CanonicalGenericReadContext,
  definition: ApplicationResourceDefinition,fields: readonly string[],predicateFields: readonly string[]): Promise<ScopeSource[]> {
  const origin=definition.origin
  if (origin.kind !== 'generic') unavailable()
  const workspaceId = context.workspaceId
  const value = (await readWithCanonicalLease(context,()=>context.transaction.query<{ value: unknown }>('SELECT observe_generic_application_query_domain($1,$2,$3,$4,$5) AS value',
    [workspaceId,origin.entityTypeId,definition.typeKey,[...fields],[...predicateFields]]))).rows[0]?.value
  if (value === null) unavailable()
  const parsed = captureSchema.safeParse(value)
  if (!parsed.success || Object.keys(parsed.data.values).length || parsed.data.sources[0].resourceKind !== 'application_field'
    || parsed.data.sources.some(source => source.workspaceId !== workspaceId)) unavailable()
  return parsed.data.sources
}

/** Capture only the values actually returned, under the exact admitted transaction. */
export async function bindApplicationFieldProjection<T extends ApplicationRecordProjection>(
  context: ApplicationOperationContext<PoolClient>, projection: T,
  selection: 'read' | 'history' = 'read',
): Promise<T> {
  const lease=canonicalGenericReadContext(context)
  const snapshot = structuredClone(projection), ref = snapshot.ref
  const absentFields = snapshot.absentFields ?? []
  if (ref.workspaceId !== context.execution.security.access.workspaceId
    || boundScopeSources(projection).length > 0
    || snapshot.fields.length !== new Set(snapshot.fields).size
    || !isDeepStrictEqual([...snapshot.fields].sort(), Object.keys(snapshot.values).sort())
    || new Set(absentFields).size !== absentFields.length || absentFields.some(field => Object.hasOwn(snapshot.values,field))) unavailable()
  const captured = captureSchema.safeParse((await readWithCanonicalLease(lease,()=>context.transaction.query<{ value: unknown }>(
    'SELECT observe_application_field_projection($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [ref.workspaceId,ref.origin,ref.typeKey,ref.id,ref.version,selection,selection === 'history' ? ref.version : null,[...snapshot.fields,...absentFields]],
  ))).rows[0]?.value)
  if (!captured.success || !isDeepStrictEqual(projection,snapshot) || boundScopeSources(projection).length > 0
    || !isDeepStrictEqual(captured.data.values, snapshot.values)
    || captured.data.sources.some(source => source.workspaceId !== ref.workspaceId)
    || captured.data.sources[0].resourceKind !== 'application_field') unavailable()
  // Never append a field source to a whole-row binding: the caller creates a
  // new projection so a field-limited app is judged by its own field authority.
  return bindScopeSources(projection, captured.data.sources)
}

/** Metadata discovery grants nothing. An admitted client validates every recorded version. */
export async function readApplicationFieldAncestors(workspaceId: string, rawRoots: readonly ScopeSource[], client?: Pick<PoolClient,'query'>): Promise<ScopeSource[]> {
  const roots = structuredClone(rawRoots)
  if (roots.some(source => source.workspaceId !== workspaceId)) unavailable()
  const sources = new Map<string, ScopeSource>()
  for (let offset = 0; offset < roots.length; offset += 100) {
    const part = roots.slice(offset, offset + 100)
    const rows = (await (client ?? getPool()).query<{ nodeVersion: string; source: unknown }>(
      `SELECT node_version AS "nodeVersion",source FROM ${client ? 'read_admitted_application_field_dependencies' : 'read_application_field_dependencies'}($1,$2,$3,$4)`,
      [workspaceId,part.map(source => source.resourceKind),part.map(source => source.resourceId),part.map(source => source.version)],
    )).rows
    for (const row of rows) {
      const parsed = sourceSchema.safeParse(row.source)
      if (!parsed.success || parsed.data.resourceKind !== 'application_field' || parsed.data.workspaceId !== workspaceId
        || parsed.data.version !== row.nodeVersion) unavailable()
      const source = parsed.data, key = `${source.resourceId}:${source.version}`
      const prior = sources.get(key)
      if (prior && resourceScopeKey(prior) !== resourceScopeKey(source)) unavailable()
      sources.set(key, source)
    }
  }
  return [...sources.values()]
}
