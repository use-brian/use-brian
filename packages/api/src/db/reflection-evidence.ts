import type { MemoryStore, ScopeSource } from '@use-brian/core'
import { getPool } from './client.js'
import { excludeExternalPrincipalsSql } from './external-principal.js'

type ReflectionEvent = Awaited<ReturnType<MemoryStore['listForReflection']>>[number]
export type ReflectionReceiptKind = 'memory_verification' | 'brain_verification' | 'correction_audit'

/** Read correction text and its version under the same receipt lock. */
export async function readReflectionReceipt(
  workspaceId: string, kind: ReflectionReceiptKind, id: string,
): Promise<ReflectionEvent | null> {
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
