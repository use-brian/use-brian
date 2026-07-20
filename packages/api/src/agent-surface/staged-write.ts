/**
 * Staged-write executor — applies an approved `kind='staged_write'` row
 * (the Approve band of the agent capability surface, §6.1).
 *
 * On approve, the unified approvals route calls `applyStagedWrite` with the
 * approval row. The executor:
 *   1. looks up the ORIGINAL (unwrapped) tool by `tool_name` in the agent
 *      toolset's rawWrites map,
 *   2. re-validates the frozen `arguments` against the tool's schema
 *      (defaults / coercions are load-bearing),
 *   3. builds a ToolContext bound to the workspace primary assistant — the
 *      same authority the staging surface acted with — stamped with the
 *      approver as the acting user,
 *   4. executes and returns the outcome for the audit trail.
 *
 * The row flip (`respond`) happens in the route AFTER a successful apply,
 * mirroring skill-approvals' apply-then-settle order, so a failed apply
 * leaves the row pending and retryable.
 *
 * Component tag: [COMP:agent-surface/staged-write].
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SensitivityAccumulator, isSensitivity, type Tool, type ToolContext } from '@use-brian/core'
import { query } from '../db/client.js'
import type { PendingApproval } from '../db/pending-approvals-store.js'

export type StagedWriteDeps = {
  /** The UNWRAPPED agent write tools (toolset.ts `rawWrites`). */
  rawWrites: Map<string, Tool>
}

export type StagedWriteOutcome =
  | { ok: true; resultText: string }
  | { ok: false; error: string }

/**
 * Resolve the (owner, primary assistant) authority for the approval's
 * workspace — the same binding the agent surfaces use. Falls back to the
 * oldest assistant for a pre-backfill workspace.
 */
async function resolveApplyPrincipal(workspaceId: string): Promise<{
  ownerUserId: string
  assistantId: string
  clearance: string | null
} | null> {
  const result = await query<{ ownerUserId: string; assistantId: string; clearance: string | null }>(
    `SELECT w.owner_user_id AS "ownerUserId", a.id AS "assistantId", a.clearance
     FROM workspaces w
     JOIN LATERAL (
       SELECT id, clearance FROM assistants
       WHERE workspace_id = w.id
       ORDER BY (kind = 'primary') DESC, created_at ASC
       LIMIT 1
     ) a ON true
     WHERE w.id = $1`,
    [workspaceId],
  )
  return result.rows[0] ?? null
}

export async function applyStagedWrite(
  deps: StagedWriteDeps,
  approval: PendingApproval,
  approverUserId: string,
): Promise<StagedWriteOutcome> {
  const toolName = approval.toolName
  if (!toolName) return { ok: false, error: 'staged_write row carries no tool_name' }
  const tool = deps.rawWrites.get(toolName)
  if (!tool) return { ok: false, error: `no agent write tool named '${toolName}' is registered` }

  const principal = await resolveApplyPrincipal(approval.workspaceId)
  if (!principal) return { ok: false, error: 'workspace has no assistant to bind the apply to' }

  let parsed: unknown
  try {
    parsed = (tool.inputSchema as z.ZodTypeAny).parse(approval.arguments ?? {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `staged arguments no longer validate: ${msg}` }
  }

  const clearance = isSensitivity(principal.clearance) ? principal.clearance : 'internal'
  const sensitivity = new SensitivityAccumulator()
  sensitivity.note(clearance)
  const payload = (approval.approvalPayload ?? {}) as Record<string, unknown>
  const ctx: ToolContext = {
    // The approver is the acting human — RLS and audit stamp them.
    userId: approverUserId,
    assistantId: approval.originatingAssistantId ?? principal.assistantId,
    sessionId: randomUUID(),
    appId: approval.originatingAssistantId ?? principal.assistantId,
    // Provenance: the apply traces back to the staging credential.
    channelType: typeof payload.surface === 'string' ? (payload.surface as string) : 'staged_write',
    channelId: typeof payload.credentialId === 'string' ? (payload.credentialId as string) : approval.id,
    workspaceId: approval.workspaceId,
    clearance,
    assistantClearance: clearance,
    sensitivity,
    abortSignal: new AbortController().signal,
  }

  try {
    const result = await tool.execute(parsed, ctx)
    const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
    if (result.isError) return { ok: false, error: body }
    return { ok: true, resultText: body }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
