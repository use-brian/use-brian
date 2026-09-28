import type { MemoryStore, ScopeSource } from '@use-brian/core'
import { getPool } from './client.js'
import { excludeExternalPrincipalsSql } from './external-principal.js'

type ReflectionEvent = Awaited<ReturnType<MemoryStore['listForReflection']>>[number]
export type ReflectionReceiptKind =
  | 'memory_verification'
  | 'brain_verification'
  | 'correction_audit'
  | 'feedback_event'

/** Read correction text and its version under the same receipt lock. */
export async function readReflectionReceipt(
  workspaceId: string, kind: ReflectionReceiptKind, id: string, feedbackMemoryId?: string,
): Promise<ReflectionEvent | null> {
  if (kind === 'feedback_event') {
    if (!feedbackMemoryId) return null
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const row = (await client.query<{
        id: string
        reason: string | null
        created_at: Date
        row_summary: string
        feedback_source: ScopeSource | null
        memory_source: ScopeSource | null
      }>(
        `SELECT ae.id,ae.metadata->>'details' AS reason,ae.created_at,
                m.summary AS row_summary,
                read_scope_source($1,'feedback_event',ae.id) AS feedback_source,
                read_scope_source($1,'memory',m.id) AS memory_source
           FROM analytics_events ae
           JOIN memory_recall_events mre ON mre.assistant_message_id=(ae.metadata->>'messageId')::uuid
           JOIN memories m ON m.id=mre.memory_id AND m.workspace_id=$1
          WHERE ae.id=$2 AND ae.workspace_id=$1 AND ae.event_name='feedback_negative'
            AND mre.memory_id=$3 AND NOT ae.scope_held
            ${excludeExternalPrincipalsSql('ae.user_id')}
          FOR SHARE OF ae,m`,
        [workspaceId,id,feedbackMemoryId],
      )).rows[0]
      await client.query('COMMIT')
      if (!row?.feedback_source || !row.memory_source
        || (row.feedback_source as ScopeSource & { held?: boolean }).held === true
        || (row.memory_source as ScopeSource & { held?: boolean }).held === true) return null
      return {
        id: row.id,
        action: 'negative_feedback',
        primitive: 'memory',
        rowId: feedbackMemoryId,
        rowSummary: row.row_summary,
        reason: row.reason,
        modelValue: null,
        userValue: null,
        at: row.created_at,
        scopeSources: [row.feedback_source,row.memory_source],
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }
  if (kind !== 'memory_verification' && kind !== 'brain_verification' && kind !== 'correction_audit') return null
  const table = kind === 'memory_verification' ? 'memory_verifications' : kind === 'brain_verification' ? 'brain_verifications' : 'correction_audit'
  const actorColumn = kind === 'correction_audit' ? 'actor_user_id' : 'verified_by'
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const row = (await client.query<{
      id: string; action: string; memory_id?: string; target_kind?: string; target_id?: string;
      reason: string | null; model_value: unknown; user_value: unknown; created_at: Date;
      primitive?: string; row_id?: string;
    }>(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND NOT scope_held
      ${excludeExternalPrincipalsSql(actorColumn)} FOR SHARE`, [workspaceId,id])).rows[0]
    if (!row || row.action === 'confirm') { await client.query('COMMIT'); return null }
    if (kind === 'correction_audit' && !['retract','soft_delete'].includes(row.action)) {
      await client.query('COMMIT'); return null
    }
    const source = (await client.query<{ source: ScopeSource | null }>(
      'SELECT read_scope_source($1,$2,$3) AS source', [workspaceId,kind,id],
    )).rows[0]?.source
    const teammate = source && (await client.query(
      `SELECT 1 WHERE true ${excludeExternalPrincipalsSql('$1::uuid')}`, [source.userId],
    )).rowCount === 1
    await client.query('COMMIT')
    if (!source || !teammate) return null
    return { id:row.id, action:row.action, primitive:row.primitive ?? row.target_kind ?? 'memory',
      rowId:row.row_id ?? row.memory_id ?? row.target_id!, rowSummary:null, reason:row.reason,
      modelValue:row.model_value ?? null, userValue:row.user_value ?? null, at:row.created_at,
      scopeSources:[source] }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}
