/** Immutable external obligations behind native inputs. [COMP:api/external-source-access] */
import { z } from 'zod'
import { resourceScopeKey, type ScopeSource } from '@use-brian/core'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import type { PoolClient } from 'pg'
import { getPool } from '../db/client.js'

const observationSource = z.object({ workspaceId: z.string().uuid(), userId: z.null(), assistantId: z.null(),
  resourceKind: z.literal('external_source'), resourceId: z.string().uuid(), version: z.string().min(1),
  sensitivity: z.enum(['public','internal','confidential']), compartments: z.array(z.string()), projectIds: z.array(z.string().uuid()) }).strict()
function denied(): never { throw new SourceProtocolError('source_access_denied') }

/** Metadata only: retain every external ancestor, including obligations on historical native versions. */
export async function readExternalSourceAncestors(workspaceId: string, rawRoots: readonly ScopeSource[], client?: Pick<PoolClient, 'query'>) {
  const roots = structuredClone(rawRoots)
  if (roots.some(source => source.workspaceId !== workspaceId)) denied()
  const ancestors: ScopeSource[] = []
  for (let offset = 0; offset < roots.length; offset += 100) {
    const part = roots.slice(offset, offset + 100).filter(source => source.resourceKind !== 'external_source')
    if (!part.length) continue
    const rows = (await (client ?? getPool()).query<{ nodeVersion: string; source: ScopeSource | null }>(`SELECT node_version AS "nodeVersion",source FROM ${client ? 'read_admitted_external_source_dependencies' : 'read_external_source_dependencies'}($1,$2,$3,$4)`, [workspaceId,part.map(source => source.resourceKind),part.map(source => source.resourceId),part.map(source => source.version)])).rows
    for (const row of rows) {
      const source = observationSource.safeParse(row.source)
      if (!source.success || source.data.workspaceId !== workspaceId || source.data.version !== row.nodeVersion) denied()
      ancestors.push(source.data)
    }
  }
  const unique = new Map<string, ScopeSource>()
  for (const source of ancestors) {
    const prior = unique.get(source.resourceId)
    if (prior && (prior.version !== source.version || resourceScopeKey(prior) !== resourceScopeKey(source))) denied()
    unique.set(source.resourceId, source)
  }
  return [...unique.values()]
}
