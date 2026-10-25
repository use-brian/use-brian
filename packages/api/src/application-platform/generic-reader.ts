/** Shared admitted generic query engine for legacy and application callers. [COMP:api/application-records] */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { bindScopeSources, boundScopeSources, propertyDefSchema, validateDocApplicationSchema, type PropertyDef, type ScopeSource } from '@use-brian/core'
import { ApplicationPlatformError, applicationResourceSchema, type ApplicationQuery, type ApplicationRecordProjection, type ApplicationResourceDefinition } from '@use-brian/shared'
import { compileApplicationRecordQuery } from './record-query.js'
import { runCanonicalReadLease, readCanonicalGenericRecord, readCanonicalGenericQueryDomain, type CanonicalGenericReadContext } from './field-evidence.js'

const unavailable = () => new ApplicationPlatformError('access_unavailable', 'The resource is unavailable.')

/** Canonical Doc semantics stay with both generic catalog readers. */
export function validateCanonicalGenericResource(raw: unknown): ApplicationResourceDefinition {
  const resource = applicationResourceSchema.parse(raw)
  const properties = resource.fields.map(field => {
    if (field.kind !== 'cell') throw new ApplicationPlatformError('invalid_schema', 'A canonical generic field requires a property.')
    const property = propertyDefSchema.safeParse(field.property)
    if (!property.success || property.data.name !== field.key) throw new ApplicationPlatformError('invalid_schema', 'A canonical property key is invalid.')
    if (field.relationshipResolverKey && field.relationshipResolverKey !== `relation.${createHash('sha256').update(property.data.name).digest('hex')}`) {
      throw new ApplicationPlatformError('invalid_schema', 'A canonical relationship resolver is invalid.')
    }
    return property.data
  })
  validateDocApplicationSchema(properties)
  return resource
}

export function canonicalGenericResource(schema: { id: string; schemaVersion: number; properties: PropertyDef[] }): ApplicationResourceDefinition {
  return validateCanonicalGenericResource({ typeKey: `record.${schema.id}`, origin: { kind: 'generic', entityTypeId: schema.id },
    schemaVersion: String(schema.schemaVersion), fields: schema.properties.map(property => ({ key: property.name, label: property.name, kind: 'cell', property,
      ...(property.config.kind === 'relation' ? { relationshipResolverKey: `relation.${createHash('sha256').update(property.name).digest('hex')}` } : {}) })) })
}
export async function queryCanonicalGenericRecords(context: CanonicalGenericReadContext, definition: ApplicationResourceDefinition, input: ApplicationQuery) {
  return runCanonicalReadLease(context,()=>queryGenericRecordsInLease(context,definition,input))
}
async function queryGenericRecordsInLease(context: CanonicalGenericReadContext, definition: ApplicationResourceDefinition, input: ApplicationQuery) {
  if (definition.origin.kind !== 'generic') throw unavailable()
  const type = definition.typeKey
  const schema = { id: definition.origin.entityTypeId, workspaceId: context.workspaceId, schemaVersion: Number(definition.schemaVersion),
    properties: definition.fields.map(field => {
      if (field.kind !== 'cell') throw unavailable()
      return propertyDefSchema.parse(field.property)
    }) }
  const predicates = [...new Set(input.filters.map(filter => filter.field))]
  const postFields = [...new Set([...input.sort.map(sort => sort.field),...input.aggregate.map(item => item.field)])]
  const fields = [...new Set([...(input.fields ?? []),...predicates,...postFields])]
  if (fields.some(field => !schema.properties.some(property => property.name === field))) {
    throw new ApplicationPlatformError('invalid_value', 'The declared query is invalid.')
  }
  if (input.cursor && input.aggregate.length) throw new ApplicationPlatformError('invalid_value', 'Aggregate queries cannot use a page cursor.')
  const compiled = compileApplicationRecordQuery(schema, input.filters, input.sort, input.limit, input.cursor)
  const domainSources = await readCanonicalGenericQueryDomain(context,definition,fields,predicates)
  const values = [...compiled.values]
  const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
  const candidatePort = `read_generic_application_query_candidates($1,$2,${bind(type)},${bind(predicates)}::text[],${bind(fields)}::text[])`
  const postCheck = `require_application_query_fields(read_fields,${bind(postFields)}::text[])`
  const aggregateSql = input.aggregate.map((item, index) => {
    const property = schema.properties.find(property => property.name === item.field)
    if (!property || ['files', 'multi_select', 'date'].includes(property.config.kind)
      || item.operation === 'sum' && property.config.kind !== 'number') throw new ApplicationPlatformError('invalid_value', 'The declared aggregate is invalid.')
    const field = `data->${bind(item.field)}::text->>'value'`
    const expression = property.config.kind === 'number' ? `(${field})::numeric` : field
    return `${item.operation}(${expression})::text AS "aggregate${index}"`
  })
  // Materialize field admission before evaluating predicates, then validate
  // sort/aggregate dependencies only on matching records. All candidates and
  // matches are consumed even when the returned page is shorter.
  const result = await runCanonicalReadLease(context,()=>context.transaction.query(`WITH candidates AS MATERIALIZED (SELECT * FROM ${candidatePort}),
    filtered AS MATERIALIZED (SELECT * FROM candidates r WHERE ${compiled.predicateWhere}),
    checked AS MATERIALIZED (SELECT * FROM filtered WHERE ${postCheck}),
    page AS MATERIALIZED (SELECT *,record_version::text AS version,${compiled.sortSelect} FROM checked r
      WHERE ${compiled.where} ORDER BY ${compiled.orderBy} LIMIT ${compiled.limitParameter})
    SELECT (SELECT coalesce(jsonb_agg(to_jsonb(page)),'[]') FROM page) AS page,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',record_version::text)),'[]') FROM candidates) AS candidates,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',record_version::text,'usesCreatedTime',created_at IS NOT NULL)),'[]') FROM checked) AS matches
      ${aggregateSql.length ? `,(SELECT to_jsonb(totals) FROM (SELECT ${aggregateSql.join(',')} FROM checked) totals) AS aggregates` : ''}`, values))
  const reference = z.object({ id: z.string().uuid(),version: z.string().min(1) })
  const candidateRefs = z.array(reference).max(4096).parse(result.rows[0]?.candidates)
  if (domainSources.length && (await runCanonicalReadLease(context,()=>context.transaction.query<{ admitted: boolean }>(
    'SELECT assert_generic_application_query_candidates($1,$2,$3,$4,$5) AS admitted',
    [schema.workspaceId,schema.id,domainSources[0].resourceId,domainSources[0].version,JSON.stringify(candidateRefs)],
  ))).rows[0]?.admitted !== true) throw unavailable()
  const matches = z.array(reference.extend({ usesCreatedTime: z.boolean() })).max(4096).parse(result.rows[0]?.matches)
  const rows = z.array(reference.extend({ data: z.record(z.unknown()),absent_fields: z.array(z.string()) }).passthrough()).max(input.limit+1).parse(result.rows[0]?.page)
  const hasMore = rows.length > input.limit,selected = rows.slice(0,input.limit)
  const selectedById = new Map(selected.map(row => [row.id,row]))
  const matchingById = new Map(matches.map(row => [row.id,row]))
  const sources: ScopeSource[] = [...domainSources],recordsById = new Map<string,ApplicationRecordProjection>()
  for (const candidate of candidateRefs) {
    const selectedRow = selectedById.get(candidate.id),match = matchingById.get(candidate.id)
    const used = new Set(predicates)
    if (match) {
      postFields.forEach(field => used.add(field))
      if (match.usesCreatedTime) schema.properties.filter(property => property.config.kind === 'created_time').forEach(property => used.add(property.name))
    }
    const outputFields = selectedRow ? input.fields ?? [...Object.keys(selectedRow.data),...selectedRow.absent_fields] : []
    outputFields.forEach(field => used.add(field))
    const capture = await readCanonicalGenericRecord(context,definition,candidate.id,{ fields: [...used].sort(),expectedVersion: candidate.version })
    sources.push(...boundScopeSources(capture))
    if (selectedRow) {
      const outputValues = Object.fromEntries(Object.entries(capture.values).filter(([field]) => outputFields.includes(field)))
      const expectedValues = Object.fromEntries(Object.entries(selectedRow.data).filter(([field]) => outputFields.includes(field)))
      if (!isDeepStrictEqual(outputValues,expectedValues) || selectedRow.version !== candidate.version) throw unavailable()
      const absentFields = (capture.absentFields ?? []).filter(field => outputFields.includes(field))
      recordsById.set(candidate.id,bindScopeSources({ ref: capture.ref,values: outputValues,fields: Object.keys(outputValues),
        policyVersion: capture.policyVersion,...(absentFields.length ? { absentFields } : {}) },boundScopeSources(capture)))
    }
  }
  const records = selected.map(row => { const record = recordsById.get(row.id);if (!record) throw unavailable();return record })
  const aggregates = aggregateSql.length ? input.aggregate.map((item,index) => ({ ...item,
    value: z.string().nullable().parse(result.rows[0].aggregates[`aggregate${index}`]) })) : undefined
  const output = bindScopeSources({ records,...(hasMore ? { nextCursor: compiled.cursorFor(selected[selected.length-1]) } : {}),
    ...(aggregates ? { aggregates } : {}) },sources)
  return { result: output, candidates: candidateRefs }
}
