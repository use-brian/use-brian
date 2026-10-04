import type { PoolClient } from 'pg'
import type { KnowledgeSource, KnowledgeStore } from '../db/knowledge-store.js'
import { admitWorkspaceResource } from './resource-admission.js'

/** Opaque per-run provenance. JSON lookalikes cannot authorize a writer. */
const captures = new WeakMap<object, Readonly<KnowledgeSource>>()
const identity = (source: Partial<KnowledgeSource>) => JSON.stringify([
  source.id, source.workspaceId, source.sourceType, source.repo, source.branch, source.rootPath,
  source.connectorInstanceId, source.lastSyncedSha, source.bindingVersion,
])
export function captureKnowledgeSyncAuthority(current: KnowledgeSource, expected: Partial<KnowledgeSource>): object {
  if (current.bindingHeld || !current.syncRunId || identity(current) !== identity(expected)) throw new Error('knowledge_source_changed')
  const authority = Object.freeze({})
  captures.set(authority, Object.freeze(structuredClone(current)))
  return authority
}
export function knowledgeSyncCapture(authority: object): Readonly<KnowledgeSource> {
  const source = captures.get(authority)
  if (!source) throw new Error('knowledge_sync_authority_required')
  return source
}

export async function admitKnowledgeSync(client: PoolClient, authority: object, input: Parameters<KnowledgeStore['upsertByPath']>[0]) {
  const source = knowledgeSyncCapture(authority)
  if (input.workspaceId !== source.workspaceId || input.sourceId !== source.id || !input.sourceSha) throw new Error('knowledge_source_changed')
  if (('userId' in input && input.userId != null) || ('assistantId' in input && input.assistantId != null)) throw new Error('knowledge_partition_not_supported')
  const current = (await client.query<{ id: string }>(`SELECT id FROM workspace_knowledge_sources
    WHERE workspace_id=$1 AND id=$2 AND binding_version::text=$3 AND last_synced_sha IS NOT DISTINCT FROM $4 AND sync_run_id=$5 AND sync_lease_until>clock_timestamp() AND NOT binding_held FOR SHARE`,
  [source.workspaceId, source.id, source.bindingVersion, source.lastSyncedSha, source.syncRunId])).rows[0]
  if (!current) throw new Error('knowledge_source_changed')
  const prior = (await client.query<{ sourceId: string | null; scopeHeld: boolean; sensitivity: typeof input.sensitivity; compartments: string[]; projectIds: string[] }>(
    `SELECT source_id AS "sourceId",scope_held AS "scopeHeld",sensitivity,compartments,project_ids AS "projectIds"
     FROM knowledge_entries WHERE workspace_id=$1 AND path=$2 FOR UPDATE`, [source.workspaceId, input.path],
  )).rows[0]
  if (prior && (prior.scopeHeld || prior.sourceId !== source.id)) throw new Error('knowledge_source_target_conflict')
  if (!source.configuredByUserId) {
    const policy = (await client.query("SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1", [source.workspaceId])).rows[0]
    if (policy?.setup_state !== 'legacy') throw new Error('knowledge_source_admission_required')
    return { ...input, compartments: input.compartments ?? [], projectIds: input.projectIds ?? [] }
  }
  const tiers = ['public', 'internal', 'confidential']
  const sensitivity = tiers[Math.max(tiers.indexOf(source.bindingSensitivity!), tiers.indexOf(input.sensitivity), tiers.indexOf(prior?.sensitivity ?? 'public'))] as typeof input.sensitivity
  const additions = [...new Set([...(input.compartments ?? []), ...(prior?.compartments ?? [])])].filter(key => !source.bindingCompartments!.includes(key))
  const admitted = await admitWorkspaceResource(client, source.workspaceId, source.configuredByUserId!, {
    writerKind: 'knowledge_entry', visibility: 'workspace', sensitivity,
    inherited: { visibility: 'workspace', sensitivity: source.bindingSensitivity!, compartments: source.bindingCompartments!, projectIds: source.bindingProjectIds! },
    inheritedAuthority: 'read',
    requestedLabels: { compartments: additions.length ? additions : undefined,
      projectIds: [...new Set([...(input.projectIds ?? []), ...(prior?.projectIds ?? [])])] },
  })
  return { ...input, ...admitted.envelope }
}
