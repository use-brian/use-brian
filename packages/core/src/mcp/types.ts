import type { ToolClassification } from './classifier.js'

/**
 * MCP tool setting — per-user policy for an external tool.
 */
export type McpToolSetting = {
  id: string
  assistantId: string
  userId: string
  serverName: string
  toolName: string
  policy: 'allow' | 'ask' | 'block'
  classification: ToolClassification
  timesAllowed: number
  timesDenied: number
}

/**
 * MCP tool settings store interface.
 */
export type McpSettingsStore = {
  getPolicy(params: {
    assistantId: string
    userId: string
    serverName: string
    toolName: string
  }): Promise<McpToolSetting | null>

  setPolicy(params: {
    assistantId: string
    userId: string
    serverName: string
    toolName: string
    policy: 'allow' | 'ask' | 'block'
    classification: ToolClassification
  }): Promise<void>

  recordUsage(params: {
    assistantId: string
    userId: string
    serverName: string
    toolName: string
    allowed: boolean
  }): Promise<void>

  /** Atomically increment usage and return updated counts (for graduated trust). */
  recordUsageAndGetCount(params: {
    assistantId: string
    userId: string
    serverName: string
    toolName: string
    allowed: boolean
  }): Promise<{ timesAllowed: number; timesDenied: number }>
}

/**
 * MCP server connection info.
 */
export type McpServerConfig = {
  name: string
  url: string
  tools: McpToolInfo[]
}

export type McpToolInfo = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// ── Confirmation types ────────────────────────────────────────

export type ConfirmationDecision = 'allow' | 'deny' | 'always_allow' | 'always_deny'

/**
 * The user's answer to a confirmation prompt, plus an optional free-text
 * note attached when denying.
 *
 * The `comment` is the "Deny with comment" affordance: a UI that offers it
 * (the web chat confirmation card, the approvals panel's reason box) passes
 * the user's note here so it reaches the model-facing `declinedToolResult`.
 * The model reads it as an instruction and revises before re-proposing —
 * a bare deny only lets it re-ask. Absent for allow/always_* decisions,
 * for a plain deny with no note, and for channels that resolve by keyword.
 *
 * Spec: docs/architecture/engine/tool-executor.md → "Declined confirmations".
 */
export type ConfirmationOutcome = {
  decision: ConfirmationDecision
  comment?: string
}

export type ToolConfirmationRequest = {
  toolCallId: string
  toolName: string
  serverName: string
  input: Record<string, unknown>
  classification: ToolClassification | null
  description: string
  /**
   * Pre-formatted lines to display in the confirmation prompt. When set,
   * channel routes render these instead of the generic
   * `formatConfirmationInput(input)` fallback. Used by tools (e.g.
   * `deleteMemory`) that need to surface human-readable details
   * (memory summaries) instead of opaque ids.
   */
  displayLines?: string[]
  /**
   * Whether the UI should offer "Always Allow" / "Always Deny" in addition
   * to Allow/Deny. True for MCP tools (the decision persists in
   * `mcp_tool_settings`); false for built-in tools, where each call
   * targets a distinct entity and a persistent decision would be
   * misleading. Default is treated as `false` by channel renderers.
   */
  allowPersistentApproval?: boolean
  /**
   * The `pending_approvals` row id when this request was persisted under
   * the Q10 unified surface (WU-6.3). When set, channels MUST pass this
   * back to the resolve endpoint so the DB row gets flipped on user click.
   * Absent when the executor ran without a `createToolInvocationApproval`
   * port (smoke / scheduled-job / worker contexts) — those flows fall back
   * to the in-memory-only confirmation path.
   */
  approvalId?: string
}

/**
 * Path B durability event (WU-6.3). Emitted by the tool executor
 * alongside `ToolConfirmationRequest` — but ONLY when the
 * `createToolInvocationApproval` port persisted a `pending_approvals`
 * row. Carries the row id + the frozen tool input + the expiry so a
 * consumer can write a `session_resume_points` checkpoint and recover
 * the suspension after a process restart.
 *
 * Distinct from `ToolConfirmationRequest`: that drives the channel UI;
 * this is the durability signal. Consumers without durable resume
 * (smoke / scheduled-job / worker contexts) never see it because those
 * contexts don't wire `createToolInvocationApproval`.
 *
 * See docs/plans/company-brain/approvals.md → "Chat resume — Path B".
 */
export type AwaitingApprovalEvent = {
  /** The persisted `pending_approvals` row id. */
  approvalId: string
  /** The suspended tool call's id (matches `ToolConfirmationRequest.toolCallId`). */
  toolCallId: string
  toolName: string
  /** Model-proposed input, frozen at suspension — the approval gates THIS input. */
  toolInput: Record<string, unknown>
  /** Human-readable confirmation text (joined `displayLines` or the tool description). */
  describeText: string
  /** Expiry of the approval row, or null when none was set. */
  expiresAt: Date | null
}

/**
 * Promise-based pause/resume for tool confirmation.
 *
 * The tool executor calls `waitForDecision()` which blocks until
 * the route handler calls `resolve()` with the user's choice.
 */
export type ConfirmationResolver = {
  resolve(toolCallId: string, decision: ConfirmationDecision, comment?: string): void
  waitForDecision(toolCallId: string, timeoutMs: number): Promise<ConfirmationOutcome>
}

/** After this many `allow` decisions, auto-promote to `always_allow`. */
export const AUTO_PROMOTE_THRESHOLD = 5

/**
 * Create a ConfirmationResolver backed by a Map of pending Promises.
 *
 * Supports early-arriving decisions: if `resolve()` is called before
 * `waitForDecision()`, the decision is stored and returned immediately
 * when `waitForDecision()` is called.
 */
export function createConfirmationResolver(): ConfirmationResolver {
  type Pending = { resolve: (o: ConfirmationOutcome) => void; reject: (e: Error) => void }
  const pending = new Map<string, Pending>()
  const earlyDecisions = new Map<string, ConfirmationOutcome>()

  return {
    resolve(toolCallId: string, decision: ConfirmationDecision, comment?: string) {
      const trimmed = comment?.trim()
      const outcome: ConfirmationOutcome = trimmed
        ? { decision, comment: trimmed }
        : { decision }
      const p = pending.get(toolCallId)
      if (p) {
        p.resolve(outcome)
        pending.delete(toolCallId)
      } else {
        // Decision arrived before waitForDecision — store for pickup
        earlyDecisions.set(toolCallId, outcome)
      }
    },

    waitForDecision(toolCallId: string, timeoutMs: number): Promise<ConfirmationOutcome> {
      // Check for early-arriving decision
      const early = earlyDecisions.get(toolCallId)
      if (early !== undefined) {
        earlyDecisions.delete(toolCallId)
        return Promise.resolve(early)
      }

      return new Promise<ConfirmationOutcome>((resolve, reject) => {
        pending.set(toolCallId, { resolve, reject })

        const timer = setTimeout(() => {
          if (pending.has(toolCallId)) {
            pending.delete(toolCallId)
            reject(new Error('Confirmation timed out'))
          }
        }, timeoutMs)

        // Don't let the timer keep the process alive
        if (typeof timer === 'object' && 'unref' in timer) {
          timer.unref()
        }
      })
    },
  }
}
