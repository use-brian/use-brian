import type { PoolClient } from 'pg'
import { deriveResourceScope, type EntityLinkCreateParams, type ScopeSource } from '@use-brian/core'
import { assertExecutionResourceScope } from '../db/access-predicate.js'
import { beginBrainAdmission, admitBrainCreate } from './brain-create-admission.js'
import { validateEntityAssistant } from './entity-create-admission.js'
import { WorkspaceAccessError } from './policy.js'

const tables: Record<string, string> = { entity: 'entities', memory: 'memories', task: 'tasks', workspace_file: 'workspace_files', episode: 'episodes', kb_chunk: 'kb_chunks', entity_link: 'entity_links' }
const kinds: Record<string, string> = { entity: 'entity', memory: 'memory', task: 'task', file: 'workspace_file', episode: 'episode', kb_chunk: 'kb_chunk' }

/** Endpoint IDs are not authority. Resolve live canonical envelopes under the
 * workspace lock, retain every axis, and require mutation authority. Unsupported
 * endpoint families fail closed until they have a canonical provenance adapter. */
export async function admitEntityLinkCreate(client: PoolClient, actor: string, params: EntityLinkCreateParams): Promise<{ params: EntityLinkCreateParams; ready: boolean }> {
  if (!await beginBrainAdmission(client, params.workspaceId)) return { params, ready: false }
  const member = (await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [params.workspaceId, actor])).rows[0]
  if (!member) throw new WorkspaceAccessError('not_found', 404)
  await validateEntityAssistant(client, params.workspaceId, params.assistantId)
  const references = [ { kind: kinds[params.sourceKind], id: params.sourceId }, { kind: kinds[params.targetKind], id: params.targetId },
    ...(params.sourceEpisodeId ? [{ kind: 'episode', id: params.sourceEpisodeId }] : []) ]
  if (references.some(r => !r.kind)) throw new Error('scope_evidence_missing')
  // Idempotent reassertions narrow an existing edge, never discard its privacy,
  // sensitivity, Project or held evidence during ON CONFLICT arbitration.
  const existing = (await client.query<{ id: string }>(`SELECT id FROM entity_links
    WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 AND target_kind=$4 AND target_id=$5 AND edge_type=$6
      AND valid_to IS NULL AND retracted_at IS NULL`,
    [params.workspaceId, params.sourceKind, params.sourceId, params.targetKind, params.targetId, params.edgeType])).rows[0]
  if (existing && !params.validTo) references.push({ kind: 'entity_link', id: existing.id })
  const sources: ScopeSource[] = []
  for (const ref of references.sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
    const source = (await client.query<{ source: (ScopeSource & { held: boolean; validTo: string | null; retractedAt: string | null }) | null }>(
      `SELECT jsonb_build_object('workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,
        'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
        'resourceKind',$2::text,'resourceId',r.id,'version',r.scope_version::text,'held',r.scope_held,
        'validTo',to_jsonb(r)->'valid_to','retractedAt',to_jsonb(r)->'retracted_at') AS source
        FROM ${tables[ref.kind]} r WHERE r.workspace_id=$1 AND r.id=$3 FOR SHARE OF r`, [params.workspaceId, ref.kind, ref.id],
    )).rows[0]?.source
    if (!source || source.workspaceId !== params.workspaceId || source.held || source.validTo || source.retractedAt
      || (source.userId && source.userId !== actor)) throw new WorkspaceAccessError('context_not_available', 404)
    assertExecutionResourceScope(source, 'read')
    sources.push(source)
  }
  const evidence = { producer: 'entity-link-endpoints', sources }
  const inherited = deriveResourceScope(evidence)
  const scope = deriveResourceScope(evidence, { workspaceId: params.workspaceId,
    userId: params.userId ?? inherited.userId, assistantId: params.assistantId ?? inherited.assistantId,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments ?? [], projectIds: params.projectIds ?? [] })
  const admitted = await admitBrainCreate(client, params.workspaceId, actor, {
    userId: scope.userId, assistantId: scope.assistantId, sensitivity: scope.sensitivity, compartments: params.compartments, projectIds: params.projectIds,
  }, inherited, false, 'entity_link')
  return { params: { ...params, ...scope, ...admitted }, ready: true }
}
