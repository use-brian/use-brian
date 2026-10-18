/** Canonical field captures and current-reader ancestry. [COMP:api/application-field-evidence] */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { bindScopeSources, boundScopeSources, resourceScopeKey, type ApplicationOperationContext, type ScopeSource } from '@use-brian/core'
import { ApplicationPlatformError, applicationJsonSchema, type ApplicationRecordProjection } from '@use-brian/shared'
import { getPool } from '../db/client.js'

const sourceSchema = z.object({ workspaceId: z.string().uuid(), userId: z.string().uuid().nullable(), assistantId: z.string().uuid().nullable(),
  resourceKind: z.enum(['application_field','external_source']), resourceId: z.string().uuid(), version: z.string().min(1),
  sensitivity: z.enum(['public','internal','confidential']), compartments: z.array(z.string()), projectIds: z.array(z.string().uuid()) }).strict()
const captureSchema = z.object({ values: z.record(applicationJsonSchema), sources: z.array(sourceSchema).min(1),
  policyVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
function unavailable(): never { throw new ApplicationPlatformError('access_unavailable', 'The source is unavailable.') }

/** Capture only the values actually returned, under the exact admitted transaction. */
export async function bindApplicationFieldProjection<T extends ApplicationRecordProjection>(
  context: ApplicationOperationContext<PoolClient>, projection: T,
  selection: 'read' | 'history' = 'read',
): Promise<T> {
  const snapshot = structuredClone(projection), ref = snapshot.ref
  if (ref.workspaceId !== context.execution.security.access.workspaceId
    || boundScopeSources(projection).length > 0
    || snapshot.fields.length !== new Set(snapshot.fields).size
    || !isDeepStrictEqual([...snapshot.fields].sort(), Object.keys(snapshot.values).sort())) unavailable()
  const captured = captureSchema.safeParse((await context.transaction.query<{ value: unknown }>(
    'SELECT observe_application_field_projection($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [ref.workspaceId,ref.origin,ref.typeKey,ref.id,ref.version,selection,selection === 'history' ? ref.version : null,snapshot.fields],
  )).rows[0]?.value)
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
