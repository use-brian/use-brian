/** Fresh source authority for exact persisted observations. [COMP:api/external-source-access] */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator, resourceScopeKey, scopeGrantContains, type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { SOURCE_PROTOCOL_VERSION, SourceProtocolError, sourceSubjectKey, sourceResourceKey,
  type SourceAction, type SourceObservation, type SourceSubject } from '@use-brian/brian-app/connector'
import { getPool } from '../db/client.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { buildConnectorAuthHeaders } from '../mcp/auth-headers.js'
import type { ConnectorSourceRuntimeFactory } from './source-runtime.js'
import type { SourceOperationProof } from './source-access.js'
import { pinExternalSourceOperation, resolveNativeSourceRecipientCeiling } from './source-store.js'

export type PreparedExternalSourceAuthority = Readonly<{ operationId: string }>
type ProofBatch = { proof: SourceOperationProof; sources: ScopeSource[] }
type Prepared = { execution: ExecutionContext; action: SourceAction; batches: ProofBatch[]; assertAncestryCurrent: () => Promise<void>; transaction?: { xid: string; pid: number } }
const prepared = new WeakMap<PreparedExternalSourceAuthority, Prepared>()
function denied(): never { throw new SourceProtocolError('source_access_denied') }
type ObservationRow = { id: string; version: string; profileId: string; instanceId: string; observation: SourceObservation;
  sensitivity: ScopeSource['sensitivity']; compartments: string[]; projectIds: string[] }

/** Pin only in the canonical operation's existing transaction; no owner impersonation or remote SQL. */
export async function pinPreparedExternalSourceAuthority(client: PoolClient, execution: ExecutionContext, token: PreparedExternalSourceAuthority) {
  const binding = prepared.get(token)
  if (!binding || binding.execution !== execution) denied()
  await execution.security.authority.assertCurrent()
  await binding.assertAncestryCurrent()
  const transaction = (await client.query<{ xid: string; pid: number; actor: string }>(`SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid,
    nullif(current_setting('app.current_user_id',true),'') AS actor`)).rows[0]
  if (transaction?.actor !== execution.security.access.userId || binding.transaction
    && (binding.transaction.xid !== transaction.xid || binding.transaction.pid !== transaction.pid)) denied()
  binding.transaction = { xid: transaction.xid, pid: transaction.pid }
  for (const batch of binding.batches) await pinExternalSourceOperation(client, execution, batch.proof, batch.sources, binding.action)
  await execution.security.authority.assertCurrent()
}

/** Metadata only: retain every external ancestor, including obligations on historical native versions. */
async function externalAncestors(workspaceId: string, roots: readonly ScopeSource[]) {
  const ancestors: ScopeSource[] = []
  for (let offset = 0; offset < roots.length; offset += 100) {
    const part = roots.slice(offset, offset + 100)
    const rows = (await getPool().query<{ nodeVersion: string; source: ScopeSource | null }>(`WITH RECURSIVE lineage(kind,id,version) AS (
      SELECT * FROM unnest($2::text[],$3::uuid[],$4::text[])
      UNION
      SELECT next.kind,next.id,next.version FROM lineage l CROSS JOIN LATERAL (
        SELECT s.source_kind AS kind,s.source_id AS id,s.source_version AS version FROM scope_derivations d
          JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
          WHERE d.workspace_id=$1 AND d.resource_kind=l.kind AND d.resource_id=l.id
        UNION
        SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
          JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
          WHERE l.kind='file_segment' AND fs.workspace_id=$1 AND fs.id=l.id
        UNION
        SELECT source->>'resourceKind',(source->>'resourceId')::uuid,source->>'version'
          FROM jsonb_array_elements(CASE WHEN l.kind='workflow_run' THEN read_workflow_derivation_inputs($1,l.id) ELSE '[]'::jsonb END) input
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(input#>'{evidence,sources}','[]'::jsonb)
            || CASE WHEN jsonb_typeof(input->'blueprintSource')='object' THEN jsonb_build_array(input->'blueprintSource') ELSE '[]'::jsonb END) source
      ) next
    ) SELECT l.version AS "nodeVersion",CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
      'workspaceId',o.workspace_id,'userId',NULL,'assistantId',NULL,'resourceKind','external_source','resourceId',o.id,'version',o.version,
      'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids) END AS source
      FROM lineage l LEFT JOIN external_source_observations o ON o.workspace_id=$1 AND o.id=l.id
      WHERE l.kind='external_source'`, [workspaceId,part.map(source => source.resourceKind),part.map(source => source.resourceId),part.map(source => source.version)])).rows
    for (const row of rows) {
      if (!row.source || row.source.version !== row.nodeVersion) denied()
      ancestors.push(row.source)
    }
  }
  return ancestors
}

/** Resolve immutable external obligations before sending fresh source requests. */
export function createRetainedSourceAuthorityCoordinator(options: { factory: ConnectorSourceRuntimeFactory; instances: ConnectorInstanceStore }) {
  return {
    async prepare(execution: ExecutionContext, rawSources: readonly ScopeSource[], action: SourceAction, rawRecipients?: readonly SourceSubject[]): Promise<PreparedExternalSourceAuthority> {
      await execution.security.authority.assertCurrent()
      const workspaceId = execution.security.access.workspaceId
      if (!workspaceId || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member') denied()
      const roots = structuredClone(rawSources)
      if (roots.some(source => source.workspaceId !== workspaceId)) denied()
      const nativeRoots = roots.filter(source => source.resourceKind !== 'external_source')
      const ancestry = await externalAncestors(workspaceId, nativeRoots)
      const evidenceKey = (values: readonly ScopeSource[]) => JSON.stringify([...new Set(values.map(source =>
        JSON.stringify([source.resourceKind,source.resourceId,source.version,resourceScopeKey(source)])))].sort())
      const ancestryKey = evidenceKey(ancestry)
      let ancestryInvalid = false
      const assertAncestryCurrent = async () => {
        if (ancestryInvalid) denied()
        try { if (evidenceKey(await externalAncestors(workspaceId, nativeRoots)) !== ancestryKey) denied() }
        catch (error) { ancestryInvalid = true; throw error }
      }
      const sources = [...roots.filter(source => source.resourceKind === 'external_source'),...ancestry]
      const unique = new Map<string, ScopeSource>()
      for (const source of sources) {
        if (source.workspaceId !== workspaceId) denied()
        const previous = unique.get(source.resourceId)
        if (previous && (previous.version !== source.version || resourceScopeKey(previous) !== resourceScopeKey(source))) denied()
        unique.set(source.resourceId, source)
      }
      const recipients = structuredClone(rawRecipients ?? [{ kind: 'human' as const, id: execution.security.access.userId, executingAssistantId: execution.assistant.id }])
      if (!recipients.length || recipients.length > 100 || new Set(recipients.map(sourceSubjectKey)).size !== recipients.length) denied()
      const operationId = randomUUID(), batches: ProofBatch[] = [], list = [...unique.values()]
      const groups = new Map<string, { instanceId: string; values: Array<{ source: ScopeSource; observation: SourceObservation }> }>()
      for (let offset = 0; offset < list.length; offset += 100) {
        const part = list.slice(offset, offset + 100)
        const rows = (await getPool().query<ObservationRow>(`SELECT o.id,o.version,r.profile_id AS "profileId",p.connector_instance_id AS "instanceId",
          o.observation,o.sensitivity,o.compartments,o.project_ids AS "projectIds" FROM external_source_observations o
          JOIN external_source_resources r ON r.id=o.resource_id AND r.workspace_id=o.workspace_id
          JOIN connector_source_profiles p ON p.id=r.profile_id AND p.workspace_id=r.workspace_id
          WHERE o.workspace_id=$1 AND o.id=ANY($2::uuid[]) AND r.state='active' AND p.status='qualified'`,
          [workspaceId,part.map(source => source.resourceId)])).rows
        if (rows.length !== part.length) denied()
        for (const source of part) {
          const row = rows.find(row => row.id === source.resourceId)
          if (!row || row.version !== source.version || !row.instanceId || row.observation.retention.mode !== 'governed'
            || resourceScopeKey(source) !== resourceScopeKey({ workspaceId, userId: null, assistantId: null,
              sensitivity: row.sensitivity, compartments: row.compartments, projectIds: row.projectIds })) denied()
          const group = groups.get(row.profileId) ?? { instanceId: row.instanceId, values: [] }
          if (group.instanceId !== row.instanceId) denied()
          group.values.push({ source, observation: row.observation }); groups.set(row.profileId, group)
        }
      }
      if (list.length) {
        const floor = new ContextScopeAccumulator({ sources: [...roots,...list] }).evidence
        const labels = { sensitivity: floor.sensitivity, compartments: floor.compartments, projectIds: floor.projectIds }
        const ceilings = [execution.security.ceiling]
        for (const subject of recipients) ceilings.push(await resolveNativeSourceRecipientCeiling(subject, workspaceId))
        for (const ceiling of ceilings) {
          if (roots.some(source => source.userId !== null && source.userId !== ceiling.userId
            || source.assistantId !== null && !scopeGrantContains(ceiling.visibilityAssistantIds, [source.assistantId]))) denied()
          await validateCallerScopeEvidence(labels, ceiling)
        }
      }
      for (const group of groups.values()) {
        const credentials = await options.instances.getAuthCredentialsSystem(group.instanceId)
        if (!credentials) denied()
        const runtime = await options.factory({ workspaceId, instanceId: group.instanceId, execution,
          accumulator: new ContextScopeAccumulator(), headers: buildConnectorAuthHeaders(credentials) ?? {} })
        if (!runtime || runtime.execution !== execution) denied()
        const size = action === 'retain' ? 50 : 100
        for (let offset = 0; offset < group.values.length; offset += size) {
          const part = group.values.slice(offset, offset + size)
          const observations = new Map(part.map(({ observation }) => [JSON.stringify([sourceResourceKey(observation.resource), [...observation.fields].sort()]), observation]))
          const proof = await runtime.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId,
            items: [...observations.values()].flatMap(observation => (action === 'retain' ? ['derive','retain'] as const : [action]).map(requested => ({
              itemId: randomUUID(), resource: observation.resource, fields: observation.fields, action: requested, retentionMode: 'governed' as const }))),
            recipients: recipients.map(subject => ({ recipientId: randomUUID(), subject })) })
          batches.push({ proof, sources: part.map(({ source }) => source) })
        }
      }
      await execution.security.authority.assertCurrent()
      await assertAncestryCurrent()
      const token = Object.freeze({ operationId }); prepared.set(token, { execution, action, batches, assertAncestryCurrent })
      return token
    },
  }
}
