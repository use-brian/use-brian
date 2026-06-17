/**
 * A2A loop-prevention limits and JSON-RPC-shaped error codes.
 *
 * See docs/architecture/integrations/a2a.md for rationale. Defaults are
 * conservative and tunable from analytics once §12 (workflow) lands.
 *
 * [COMP:a2a/limits]
 */

/**
 * Hard caps on consult chain depth, by mode.
 *
 * - Restricted (capabilityId set): allows §12-style multi-step workflows that
 *   compose specialists. 5 leaves headroom without going expansive.
 * - Free (no capabilityId): cross-workspace conversation MUST stay single-hop
 *   to match the existing `askAssistant` semantics — no chaining across users.
 */
export const CONSULT_LIMITS = {
  MAX_DEPTH_RESTRICTED: 5,
  MAX_DEPTH_FREE: 1,
} as const

/**
 * Initial `ConsultChain.budget` per top-level entry point.
 *
 * A "top-level entry point" is something that initiates a fresh chain — a user
 * turn in chat, a workflow run, a scheduled job firing, or an external A2A
 * inbound request. `a2a_external = 1` deliberately forces leaf behavior at the
 * boundary; trust is reset at every external hop.
 */
export const INITIAL_BUDGET = {
  user_turn: 10,
  workflow_run: 10,
  scheduled_job: 5,
  a2a_external: 1,
} as const

/**
 * Error codes returned in `ConsultError`. JSON-RPC-shaped (`-32xxx` reserved
 * range mirrors A2A spec; `-33xxx` is sidanclaw additions).
 *
 * Cycle / depth / budget rejections use `UNSUPPORTED_OPERATION` with a `reason`
 * field on the error so the caller's LLM sees a recoverable tool error rather
 * than a hard crash.
 */
export const ERROR_CODES = {
  // A2A spec subset
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  // sidanclaw additions
  SHARING_BLOCKED: -33001,
  CAPABILITY_NOT_FOUND: -33002,
  CALLER_NOT_AUTHORIZED: -33003,
  INPUT_VALIDATION_FAILED: -33004,
} as const

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES]

export type EntryPoint = keyof typeof INITIAL_BUDGET
