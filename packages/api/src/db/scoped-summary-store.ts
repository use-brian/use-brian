import { deriveResourceScope, resourceScopeKey, type AccessContext, type DerivedWriteEvidence, type ScopeEvidence, type ScopeSource } from '@use-brian/core'
import { getPool, query } from './client.js'
import { createMemory, getSoul } from './memories.js'
import { beginBrainAdmission } from '../workspace-access/brain-create-admission.js'
import { buildMemoryAccessPredicate } from './memory-access-predicate.js'

/** Source-validated transaction; model-provided slot keys never confer authority. */
export async function writeScopedSummary(params: {
  assistantId: string; userId: string; kind: 'soul' | 'domain'; slotKey: string;
  content: string; derivation: DerivedWriteEvidence;
}): Promise<void> {
  if (!params.content.trim()) return
  const floor = deriveResourceScope(params.derivation)
  const scopeKey = resourceScopeKey(floor)
  const identity = [floor.workspaceId,params.userId,params.assistantId,params.kind,params.slotKey,scopeKey]
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Match canonical writers' workspace-before-resource lock order.
    await beginBrainAdmission(client, floor.workspaceId)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(identity)])
    const { rows } = await client.query<{ memoryId: string }>(
      `SELECT s.memory_id AS "memoryId" FROM memory_summary_slots s
       JOIN memories m ON m.id=s.memory_id AND m.workspace_id=s.workspace_id
       WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.owner_assistant_id=$3 AND s.kind=$4 AND s.slot_key=$5 AND s.scope_key=$6 FOR UPDATE OF s,m`,identity,
    )
    const common = { summary: params.content.slice(0,100),detail: params.content,
      sensitivity: floor.sensitivity,compartments: floor.compartments,projectIds: floor.projectIds,
      derivation: params.derivation }
    // A regenerated summary is not an edit of the previous output: its only
    // inputs are the synthesis evidence. updateMemory would add the predecessor
    // as an input, making later ancestor invalidation hold the current summary
    // itself. Invalidate first, including old buggy chains, then let createMemory
    // revalidate every input. A source depending on the retired output must fail,
    // not be silently refreshed or released from holding.
    const previous = rows[0]
    if (previous) {
      await client.query(`SELECT hold_scope_descendants($1,'memory',$2)`,[floor.workspaceId,previous.memoryId])
      // Retire before validation so even a direct citation of this output is
      // rejected. A failed create rolls back retirement and all descendant holds.
      await client.query(`UPDATE memories SET valid_to=COALESCE(valid_to,now()),updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,[floor.workspaceId,previous.memoryId])
    }
    const memory = await createMemory({ ...common,workspaceId: floor.workspaceId,assistantId: params.assistantId,
      userId: params.userId,createdByUserId: params.userId,createdByAssistantId: params.assistantId,
      source: 'consolidation',tags: [`consolidation:${params.kind}`],scope: 'shared' },undefined,client)
    if (previous) {
      // Retain history without introducing a derivation edge to the predecessor.
      await client.query(`UPDATE memories SET superseded_by=$3
        WHERE workspace_id=$1 AND id=$2`,[floor.workspaceId,previous.memoryId,memory.id])
    }
    await client.query(
      `INSERT INTO memory_summary_slots(workspace_id,owner_user_id,owner_assistant_id,kind,slot_key,scope_key,memory_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(workspace_id,owner_user_id,owner_assistant_id,kind,slot_key,scope_key)
       DO UPDATE SET memory_id=EXCLUDED.memory_id,updated_at=now()`,[...identity,memory.id],
    )
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}

/** Full evidence accompanies text, so prompt assembly cannot lose its floor. */
export async function getSoulContext(
  access: AccessContext,
  appId?: string,
): Promise<{ content: string | null; evidence: ScopeEvidence }> {
  const ap = buildMemoryAccessPredicate(access,{ alias: 'm',startIdx: 5 })
  const result = await query<ScopeSource & { content: string }>(
    `SELECT m.detail AS content,m.id AS "resourceId",'memory' AS "resourceKind",m.scope_version::text AS version,
       m.workspace_id AS "workspaceId",m.user_id AS "userId",m.assistant_id AS "assistantId",
       m.sensitivity,m.compartments,m.project_ids AS "projectIds"
     FROM memory_summary_slots s JOIN memories m ON m.id=s.memory_id AND m.workspace_id=s.workspace_id
     WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.owner_assistant_id=$3 AND s.kind='soul'
       AND s.slot_key=ANY($4::text[]) AND m.valid_to IS NULL AND m.retracted_at IS NULL AND ${ap.sql}
     ORDER BY s.slot_key,s.scope_key`,
    [access.workspaceId,access.userId,access.assistantId,appId ? ['shared',`app:${appId}`] : ['shared'],...ap.params],
  )
  const sources = result.rows.map(({ content: _content,...source }) => source)
  if (sources.length) {
    const floor = deriveResourceScope({ producer: 'soul-context',sources })
    return { content: result.rows.map(row => row.content).filter(Boolean).join('\n\n') || null,
      evidence: { sensitivity: floor.sensitivity,compartments: floor.compartments,projectIds: floor.projectIds,sources } }
  }
  // Legacy data retains its old behavior until explicitly reviewed. It does
  // not become certified General simply because the new table has no row.
  const policy = await query<{ mode: string }>('SELECT classification_mode AS mode FROM workspace_access_policies WHERE workspace_id=$1',[access.workspaceId])
  if (policy.rows[0]?.mode && policy.rows[0].mode !== 'legacy') return { content: null,evidence: {} }
  return { content: await getSoul(access.assistantId,access.userId,appId),evidence: {} }
}
