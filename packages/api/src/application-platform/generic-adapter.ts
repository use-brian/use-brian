/** Deployed operations over the canonical generic record store. [COMP:api/application-records] */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { applicationAuthorityFieldCatalog, applicationAuthorityQueryFieldCeiling, assertApplicationQueryFields, assertApplicationWriteFields, bindScopeSources,boundScopeSources,propertyDefSchema,
  type ApplicationModuleDefinition, type ApplicationOperationContext, type PropertyDef } from '@use-brian/core'
import { ApplicationPlatformError, applicationQuerySchema, applicationResourceSchema,
  type ApplicationQuery, type ApplicationRecordProjection, type ApplicationResourceDefinition, type ApplicationResourceRef } from '@use-brian/shared'
import { applyCanonicalApplicationRecordMutation, canonicalApplicationRecordMutationSchema,
  type CanonicalApplicationRecordMutation } from '../db/doc-entity-store.js'
import { getApplicationExecutionBinding } from './execution-context.js'
import { canonicalGenericResource,queryCanonicalGenericRecords } from './generic-reader.js'
import { bindApplicationFieldProjection,readCanonicalGenericApplicationRecord,canonicalGenericReadContext } from './field-evidence.js'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'

type Context = ApplicationOperationContext<PoolClient>
const typeKey = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/)
const getInput = z.object({ type: typeKey, id: z.string().uuid() }).strict()
const queryInput = z.object({ type: typeKey, query: applicationQuerySchema }).strict()
const historyInput = getInput.extend({ beforeVersion: z.string().regex(/^[1-9]\d*$/).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict()
const unavailable = () => new ApplicationPlatformError('access_unavailable', 'The resource is unavailable.')
const commandInputs = new WeakMap<Context, CanonicalApplicationRecordMutation[]>()
const batchInput = z.object({ operations: z.array(canonicalApplicationRecordMutationSchema).min(1).max(100) }).strict()
const patchInput = canonicalApplicationRecordMutationSchema.options[1].partial({ expectedVersion: true })
const deleteInput = canonicalApplicationRecordMutationSchema.options[2].partial({ expectedVersion: true })
const readProofs = new WeakMap<object, { type: string; schemaVersion: string; action: 'read' | 'query' | 'history';
  records: Array<{ id: string; version: string; fields?: string[] }>; requiredFields?: string[]; historyInput?: z.infer<typeof historyInput> }>()


async function resources(context: Context, type?: string): Promise<ApplicationResourceDefinition[]> {
  if (getApplicationExecutionBinding(context.execution)) {
    const result = await context.transaction.query<{ resource: unknown }>('SELECT application_generic_catalog($1) AS resource', [type ?? null])
    return result.rows.map(row => applicationResourceSchema.parse(row.resource))
  }
  // Complete schema metadata remains internal to canonical validation. Public
  // legacy catalogs project separately; SQL authorizes actual values/predicates.
  const schemas = await context.transaction.query<{ id: string;schemaVersion: number;properties: PropertyDef[] }>(
    'SELECT id,schema_version AS "schemaVersion",properties FROM public.entity_types WHERE workspace_id=$1', [context.execution.security.access.workspaceId])
  return schemas.rows.map(canonicalGenericResource).filter(resource => !type || resource.typeKey === type)
}
async function resource(context: Context, type: string) {
  const matches = await resources(context, type)
  if (matches.length !== 1 || matches[0].origin.kind !== 'generic') throw unavailable()
  const definition = matches[0], id = (definition.origin as { kind: 'generic'; entityTypeId: string }).entityTypeId
  const schema = { id, workspaceId: context.execution.security.access.workspaceId, schemaVersion: Number(definition.schemaVersion),
    properties: definition.fields.map(field => {
      if (field.kind !== 'cell') throw unavailable()
      return propertyDefSchema.parse(field.property)
    }) }
  return { definition, schema }
}
async function get(context: Context, type: string, id: string): Promise<ApplicationRecordProjection> {
  const { definition } = await resource(context, type)
  const record = await readCanonicalGenericApplicationRecord(context,definition,id)
  readProofs.set(record,{ type,schemaVersion: definition.schemaVersion,action: 'read',records: [{ id: record.ref.id,version: record.ref.version,fields: record.fields }] })
  return record
}
async function query(context: Context, type: string, input: ApplicationQuery) {
  const { definition } = await resource(context, type)
  const application = getApplicationExecutionBinding(context.execution)
  if (application) {
    const ref = { workspaceId: context.execution.security.access.workspaceId, origin: definition.origin, typeKey: type, id: 'query', version: definition.schemaVersion }
    const fields = definition.fields.map(field => field.key)
    const catalog = applicationAuthorityFieldCatalog(application.state.layers, ref, 'query', fields, [])
    // The pure ceiling validates complete query paths. Its conservative field
    // intersection is not candidate authority: SQL proves field coverage over
    // the structural domain, allowing overlapping releases to union fields.
    const paths = applicationAuthorityQueryFieldCeiling(application.state.layers, ref, fields)
    assertApplicationQueryFields(input, { ...catalog, allowed: catalog.allowed && paths.allowed })
  }
  const { result, candidates } = await queryCanonicalGenericRecords(canonicalGenericReadContext(context), definition, input)
  readProofs.set(result,{ type,schemaVersion: definition.schemaVersion,action: 'query',records: candidates })
  return result
}
async function history(context: Context, input: z.infer<typeof historyInput>) {
  const current = await get(context, input.type, input.id)
  const { schema } = await resource(context, input.type)
  if (getApplicationExecutionBinding(context.execution)) {
    const result = await context.transaction.query(`SELECT record_version::text,schema_version::text,data,source
      FROM application_generic_history($1,$2,$3,$4,$5)`, [schema.id, input.type, input.id, input.beforeVersion ?? null, input.limit])
    const records = []
    for (const row of result.rows) records.push(await bindApplicationFieldProjection(context,
      { ref: { ...current.ref, version: row.record_version }, schemaVersion: row.schema_version,
        values: row.data, fields: Object.keys(row.data), policyVersion: current.policyVersion }, 'history'))
    readProofs.set(records, { type: input.type, schemaVersion: String(schema.schemaVersion), action: 'history', historyInput: input, records: [{ id: input.id, version: current.ref.version }] })
    return bindScopeSources(records,records.flatMap(record => boundScopeSources(record)))
  }
  const result = await context.transaction.query(`SELECT record_version::text,schema_version::text,data FROM application_record_revisions
    WHERE workspace_id=$1 AND entity_instance_id=$2 AND ($3::bigint IS NULL OR record_version<$3) ORDER BY record_version DESC LIMIT $4`,
  [schema.workspaceId, input.id, input.beforeVersion ?? null, input.limit])
  const declared = new Set([...current.fields,...(current.absentFields ?? [])])
  const records = []
  for (const row of result.rows) {
    const values = Object.fromEntries(Object.entries(row.data).filter(([key]) => declared.has(key))) as ApplicationRecordProjection['values']
    records.push(await bindApplicationFieldProjection(context, { ref: { ...current.ref, version: row.record_version }, schemaVersion: row.schema_version,
      values, fields: Object.keys(values), policyVersion: current.policyVersion }, 'history'))
  }
  readProofs.set(records, { type: input.type, schemaVersion: String(schema.schemaVersion), action: 'history', historyInput: input, records: [{ id: input.id, version: current.ref.version }] })
  return bindScopeSources(records,records.flatMap(record => boundScopeSources(record)))
}

async function authorizeReadResult(context: Context, result: unknown) {
  if (!result || typeof result !== 'object') throw unavailable()
  const proof = readProofs.get(result)
  if (!proof) throw unavailable()
  const { schema } = await resource(context, proof.type)
  if (String(schema.schemaVersion) !== proof.schemaVersion) throw unavailable()
  const sources = boundScopeSources(result)
  const canonicalFields = sources.some(source => source.resourceKind === 'application_field')
  if (canonicalFields) {
    const current = await readCurrentScopeSources(context.transaction,schema.workspaceId,sources)
    if (current.some(source => source.state !== 'current')) throw unavailable()
  }
  const expected = new Map<string, string>()
  const fields = new Map<string, Set<string>>()
  for (const record of proof.records) {
    if (expected.has(record.id) && expected.get(record.id) !== record.version) throw unavailable()
    expected.set(record.id, record.version)
    fields.set(record.id, new Set([...(fields.get(record.id) ?? []), ...(record.fields ?? [])]))
  }
  if (!expected.size) return
  const app = getApplicationExecutionBinding(context.execution)
  const fresh = app ? await context.transaction.query<{ id: string; version: string; data: Record<string, unknown> }>(`SELECT id,record_version::text AS version,data
    FROM application_generic_projection($1,$2,$3,NULL,$5::text[]) WHERE id=ANY($4::uuid[])`, [schema.id, proof.type, proof.action, [...expected.keys()], proof.requiredFields ?? []])
    : await context.transaction.query<{ id: string; version: string; data: Record<string, unknown> }>(`SELECT id,record_version::text AS version,data FROM entity_instances
      WHERE workspace_id=$1 AND entity_type_id=$2 AND id=ANY($3::uuid[]) AND NOT scope_review_state_held('entity_instance',id)`, [schema.workspaceId, schema.id, [...expected.keys()]])
  if (fresh.rows.length !== expected.size || fresh.rows.some(row => expected.get(row.id) !== row.version
    || !canonicalFields && [...(fields.get(row.id) ?? [])].some(field => !Object.hasOwn(row.data, field)))) throw unavailable()
  if (proof.historyInput && JSON.stringify(await history(context, proof.historyInput)) !== JSON.stringify(result)) throw unavailable()
}

async function authorizeMutations(context: Context, inputs: CanonicalApplicationRecordMutation[]) {
  if (context.execution.surface.readOnly) throw unavailable()
  const seen = new Set<string>()
  for (const input of inputs) {
    if (input.id && seen.has(input.id)) throw new ApplicationPlatformError('invalid_value', 'A batch can change each identity only once.')
    if (input.id) seen.add(input.id)
    const { definition } = await resource(context, input.type), fields = definition.fields.map(field => field.key)
    const changes = 'data' in input ? Object.keys(input.data) : []
    if (changes.some(key => !fields.includes(key))) throw unavailable()
    const app = getApplicationExecutionBinding(context.execution)
    if (app) assertApplicationWriteFields(changes, applicationAuthorityFieldCatalog(app.state.layers,
      { workspaceId: context.execution.security.access.workspaceId, origin: definition.origin, typeKey: input.type,
        id: input.id ?? 'new', version: definition.schemaVersion }, input.operation, fields, fields))
  }
  commandInputs.set(context, inputs)
}
function singleMutation(context: Context, raw: unknown): CanonicalApplicationRecordMutation[] {
  const wire = z.union([canonicalApplicationRecordMutationSchema.options[0], patchInput, deleteInput]).safeParse(raw)
  if (!wire.success) throw new ApplicationPlatformError('invalid_value', 'The record command is invalid.')
  if (wire.data.operation === 'create') {
    if (context.expectedVersion !== undefined) throw new ApplicationPlatformError('invalid_value', 'Creation cannot use an existing-record version.')
    return [wire.data]
  }
  if (wire.data.expectedVersion !== undefined && context.expectedVersion !== undefined && wire.data.expectedVersion !== context.expectedVersion) {
    throw new ApplicationPlatformError('record_version_conflict', 'The record version preconditions disagree.')
  }
  const normalized = canonicalApplicationRecordMutationSchema.safeParse({ ...wire.data, expectedVersion: wire.data.expectedVersion ?? context.expectedVersion })
  if (!normalized.success) throw new ApplicationPlatformError('invalid_value', 'An expected record version is required.')
  return [normalized.data]
}
function batchMutations(context: Context, raw: unknown) {
  if (context.expectedVersion !== undefined) throw new ApplicationPlatformError('invalid_value', 'A batch requires per-record versions.')
  return batchInput.parse(raw).operations
}
async function authorizeMutationResult(context: Context, refs: ApplicationResourceRef[]) {
  const inputs = commandInputs.get(context)
  if (!inputs || refs.length !== inputs.length) throw unavailable()
  for (const [index, ref] of refs.entries()) {
    const input = inputs[index]
    if (ref.workspaceId !== context.execution.security.access.workspaceId || ref.typeKey !== input.type || ref.origin.kind !== 'generic'
      || input.id && input.id !== ref.id) throw unavailable()
    const result = await context.transaction.query<{ admitted: boolean }>('SELECT application_generic_receipt_allows($1,$2,$3,$4,$5) AS admitted',
      [ref.origin.entityTypeId, ref.typeKey, ref.id, input.operation, 'data' in input ? Object.keys(input.data) : []])
    if (result.rows[0]?.admitted !== true) throw unavailable()
  }
}
async function mutate(context: Context, inputs: CanonicalApplicationRecordMutation[]) {
  const refs: ApplicationResourceRef[] = []
  for (const input of inputs) {
    const { schema } = await resource(context, input.type)
    refs.push(await applyCanonicalApplicationRecordMutation(context, schema.id, input))
  }
  return refs
}

/** The module is deployed code; schemas supply data declarations, never handlers. */
export function createCanonicalGenericApplicationModule(): ApplicationModuleDefinition<PoolClient> {
  return { key: 'records', defaultState: 'enabled', application: { version: '1', dependencies: [], resources: [],
    queries: ['get', 'query', 'history'], commands: ['record_create', 'record_patch', 'record_delete', 'record_batch'], events: ['records.changed'],
    policyCapabilities: ['canonical_generic'], backgroundHandlers: [], uiContributions: [] },
  resolveResources: resources, commands: {
    record_create: { input: canonicalApplicationRecordMutationSchema.options[0], eventKey: 'records.changed',
      authorize: (context, raw) => authorizeMutations(context, singleMutation(context, raw)),
      authorizeResult: authorizeMutationResult, execute: (context, raw) => mutate(context, singleMutation(context, raw)) },
    record_patch: { input: patchInput, eventKey: 'records.changed',
      authorize: (context, raw) => authorizeMutations(context, singleMutation(context, raw)),
      authorizeResult: authorizeMutationResult, execute: (context, raw) => mutate(context, singleMutation(context, raw)) },
    record_delete: { input: deleteInput, eventKey: 'records.changed',
      authorize: (context, raw) => authorizeMutations(context, singleMutation(context, raw)),
      authorizeResult: authorizeMutationResult, execute: (context, raw) => mutate(context, singleMutation(context, raw)) },
    record_batch: { input: batchInput, eventKey: 'records.changed',
      authorize: (context, raw) => authorizeMutations(context, batchMutations(context, raw)),
      authorizeResult: authorizeMutationResult, execute: (context, raw) => mutate(context, batchMutations(context, raw)) },
  }, queries: {
    get: { input: getInput, authorize: async (context, raw) => { const input = getInput.parse(raw); await get(context, input.type, input.id) },
      execute: (context, raw) => { const input = getInput.parse(raw); return get(context, input.type, input.id) }, authorizeResult: authorizeReadResult },
    query: { input: queryInput, authorize: async (context, raw) => { const input = queryInput.parse(raw); await resource(context, input.type) },
      execute: (context, raw) => { const input = queryInput.parse(raw); return query(context, input.type, input.query) }, authorizeResult: authorizeReadResult },
    history: { input: historyInput, authorize: async (context, raw) => { const input = historyInput.parse(raw); await get(context, input.type, input.id) },
      execute: (context, raw) => history(context, historyInput.parse(raw)), authorizeResult: authorizeReadResult },
  } }
}
