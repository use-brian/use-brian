/**
 * claim_provenance store — the grounding gate's claim ledger (migration
 * 333). One row per figure claim in a shipped interactive reply, with its
 * evidence linkage: which tool result backed it, or 'unverified'.
 *
 * Written by the chat / channel pipelines right after the assistant message
 * row is persisted (before the channel send, so the linkage exists before
 * the user sees the reply); read by the dispute pre-pass, which loads the
 * previous reply's claims when the user disputes a figure. Best-effort by
 * contract — a ledger failure never blocks a reply.
 *
 * Spec: docs/architecture/engine/grounding-gate.md → "Claim ledger".
 * [COMP:engine/grounding-gate]
 */

import { query } from './client.js'

export type ClaimLedgerEntry = {
  claim: string
  canonical: string
  kind: 'amount' | 'percent' | 'date'
  status: 'backed' | 'unverified'
  backedByToolUseId?: string
  backedByToolName?: string
}

export async function insertClaimProvenance(
  sessionMessageId: string,
  claims: ClaimLedgerEntry[],
): Promise<void> {
  if (claims.length === 0) return
  // Supersede-on-write: the dispute pre-pass only ever reads the LATEST
  // assistant message's claims per session, so prior ledger rows for this
  // session are dead weight the moment a new reply ships. Deleting them
  // here keeps the table's steady state at ~one reply's worth of claims
  // per recently-active session — self-maintaining, no retention cron.
  // Long-horizon trend lines live in analytics (`claim_ledger_recorded`),
  // not in these content-bearing rows. If a per-message provenance UI ever
  // lands, extend retention by removing this DELETE.
  await query(
    `DELETE FROM claim_provenance
     WHERE session_message_id IN (
       SELECT id FROM session_messages
       WHERE session_id = (SELECT session_id FROM session_messages WHERE id = $1)
         AND id <> $1
     )`,
    [sessionMessageId],
  )
  const values: string[] = []
  const params: unknown[] = [sessionMessageId]
  for (const c of claims) {
    const base = params.length
    values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`)
    params.push(
      c.claim,
      c.canonical,
      c.kind,
      c.status,
      c.backedByToolUseId ?? null,
      c.backedByToolName ?? null,
    )
  }
  await query(
    `INSERT INTO claim_provenance
       (session_message_id, claim, canonical, kind, status,
        backed_by_tool_use_id, backed_by_tool_name)
     VALUES ${values.join(', ')}`,
    params,
  )
}

/**
 * The previous reply's ledger — claims of the session's most recent
 * assistant message. Empty array when the last reply carried no figure
 * claims (or none was recorded).
 */
export async function getClaimsForLatestAssistantMessage(
  sessionId: string,
): Promise<ClaimLedgerEntry[]> {
  const result = await query<{
    claim: string
    canonical: string
    kind: 'amount' | 'percent' | 'date'
    status: 'backed' | 'unverified'
    backed_by_tool_use_id: string | null
    backed_by_tool_name: string | null
  }>(
    `SELECT cp.claim, cp.canonical, cp.kind, cp.status,
            cp.backed_by_tool_use_id, cp.backed_by_tool_name
     FROM claim_provenance cp
     WHERE cp.session_message_id = (
       SELECT id FROM session_messages
       WHERE session_id = $1 AND role = 'assistant'
       ORDER BY sequence_num DESC
       LIMIT 1
     )
     ORDER BY cp.created_at`,
    [sessionId],
  )
  return result.rows.map((r) => ({
    claim: r.claim,
    canonical: r.canonical,
    kind: r.kind,
    status: r.status,
    ...(r.backed_by_tool_use_id ? { backedByToolUseId: r.backed_by_tool_use_id } : {}),
    ...(r.backed_by_tool_name ? { backedByToolName: r.backed_by_tool_name } : {}),
  }))
}
