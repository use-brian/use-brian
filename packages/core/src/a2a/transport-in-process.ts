/**
 * In-process A2A transport.
 *
 * Implements `ConsultTransport.send()` for callers that live in the same
 * process as their callees (the only supported deployment today). Performs
 * the cycle/depth/budget checks specified in `docs/architecture/integrations/a2a.md`,
 * resolves the destination's mode (via `mode-resolver`), applies the mode's
 * tool filter, then delegates query-loop execution to a callback (`runConsult`)
 * supplied by the consuming app.
 *
 * Why a callback rather than a direct `queryLoop` call: this module lives in
 * `@sidanclaw/core` which has no `pg` / DB / store-construction surface. The
 * actual execution wires DB-backed stores, MCP injection, etc., which is the
 * `@sidanclaw/api` layer's job. The callback boundary keeps the core free of
 * those dependencies.
 *
 * [COMP:a2a/transport-in-process]
 */

import { resolveMode, type ModeResolverDeps, type ModeResolution } from '../inter-assistant/mode-resolver.js'
import { CONSULT_LIMITS, ERROR_CODES } from './limits.js'
import type {
  A2AMessage,
  Artifact,
  AssistantMode,
  ConsultError,
  ConsultRequest,
  ConsultResponse,
  ConsultTransport,
  Task,
} from './types.js'

export type RunConsultParams = {
  request: ConsultRequest
  /** Resolved mode for this consult — `null` for free mode (no mode bound), or an AssistantMode. */
  mode: AssistantMode | null
}

export type RunConsultResult = {
  /** Response text from the destination's query loop. */
  text: string
  /** Optional structured artifacts (restricted-mode capability invocations may surface these). */
  artifacts?: Artifact[]
  /**
   * If true, the destination has queued the consult for owner approval (a
   * `pending_message` was created). The transport returns a Task with
   * `status.state='input_required'` so the caller's LLM sees it as a
   * recoverable async event.
   */
  inputRequired?: boolean
}

export type InProcessTransportDeps = ModeResolverDeps & {
  /**
   * Run the destination's query loop with mode-filtered tools and return the
   * response. Implementer is responsible for: tool filtering by `mode.exposedTools`,
   * memory context, MCP injection, session creation, billing attribution, etc.
   */
  runConsult: (params: RunConsultParams) => Promise<RunConsultResult>

  /**
   * Wall-clock source — pulled out for test-determinism. Defaults to `Date.now`
   * when omitted at construction.
   */
  now?: () => number
}

/**
 * Build a `ConsultTransport` whose `send()` runs in-process.
 */
export function createInProcessTransport(deps: InProcessTransportDeps): ConsultTransport {
  const now = deps.now ?? Date.now

  return {
    async send(request: ConsultRequest): Promise<ConsultResponse> {
      const isCrossWorkspace = request.caller.workspaceId !== request.target.workspaceId
      const isFreeMode = request.target.capabilityId === undefined

      // Step 1: cycle check (visited set) — applies to all consults.
      if (request.chain.path.includes(request.target.assistantId)) {
        return errorResponse(request, {
          code: ERROR_CODES.UNSUPPORTED_OPERATION,
          message: 'Cycle detected — destination already in chain.path.',
          reason: 'cycle_detected',
        })
      }

      // Step 2: depth check (mode-specific).
      const maxDepth = isFreeMode
        ? CONSULT_LIMITS.MAX_DEPTH_FREE
        : CONSULT_LIMITS.MAX_DEPTH_RESTRICTED
      if (request.chain.depth >= maxDepth) {
        return errorResponse(request, {
          code: ERROR_CODES.UNSUPPORTED_OPERATION,
          message: `Depth limit ${maxDepth} exceeded for ${isFreeMode ? 'free' : 'restricted'} mode.`,
          reason: 'depth_exceeded',
        })
      }

      // Step 3: budget check.
      if (request.chain.budget <= 0) {
        return errorResponse(request, {
          code: ERROR_CODES.UNSUPPORTED_OPERATION,
          message: 'Consult budget exhausted for this top-level turn.',
          reason: 'budget_exhausted',
        })
      }

      // Step 4: mode resolution. Cross-workspace → mode-or-no-connection.
      // Within workspace → modes don't apply (full workspace trust).
      let resolution: ModeResolution
      if (isCrossWorkspace) {
        resolution = await resolveMode(
          deps,
          request.caller.assistantId,
          request.target.assistantId,
        )
        if (resolution.kind === 'no_connection') {
          return errorResponse(request, {
            code: ERROR_CODES.SHARING_BLOCKED,
            message: 'No accepted connection between caller and destination.',
            reason: 'sharing_blocked',
          })
        }
      } else {
        resolution = { kind: 'free' }
      }

      const mode: AssistantMode | null =
        resolution.kind === 'mode' ? resolution.mode : null

      // Step 5: capability cap (decision #5: mode caps capability cross-workspace).
      // If a capability is invoked, its exposedTools must be ⊆ mode.exposedTools.
      // Within-workspace capability invocations bypass this check (no mode applies).
      // The capability's own exposedTools are looked up by the runConsult impl
      // — we surface the check here only when we have both the mode and the
      // capability id; the runConsult callback is responsible for the actual
      // intersection (it has access to the SpecialistCard registry).
      // For the pure free-mode path, no capability check is needed.

      // Step 6: input_required — if mode requires approval, the destination
      // must store an input_required Task. The runConsult callback is the
      // place where pending_messages are written; surface that here is
      // overloading. Instead, we hand the mode to runConsult and let it
      // decide. The transport's job is to wrap the result.

      const result = await deps.runConsult({ request, mode })

      const taskId = `task_${now()}_${Math.random().toString(36).slice(2, 10)}`
      const contextId = request.contextId ?? `ctx_${taskId}`
      const timestamp = new Date(now()).toISOString()

      // input_required short-circuit: destination has queued the consult for
      // owner approval. Caller's LLM sees a recoverable state and surfaces a
      // wait message to the user.
      if (result.inputRequired) {
        const task: Task = {
          taskId,
          contextId,
          status: { state: 'input_required', timestamp },
          artifacts: [],
        }
        return { task }
      }

      const responseMessage: A2AMessage | undefined = isFreeMode
        ? {
            messageId: `msg_${now()}_${Math.random().toString(36).slice(2, 10)}`,
            role: 'agent',
            parts: [{ kind: 'text', text: result.text }],
            contextId,
            taskId,
          }
        : undefined

      const task: Task = {
        taskId,
        contextId,
        status: { state: 'completed', timestamp },
        artifacts: result.artifacts ?? [],
        history: isFreeMode && responseMessage ? [responseMessage] : undefined,
      }

      return { task }
    },
  }
}

/**
 * Wrap a `ConsultError` as a `ConsultResponse` with a failed Task. Lets the
 * caller's LLM see a recoverable tool error rather than a thrown exception.
 */
function errorResponse(request: ConsultRequest, error: ConsultError): ConsultResponse {
  const taskId = `task_err_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const contextId = request.contextId ?? `ctx_${taskId}`
  const failureMessage: A2AMessage = {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    role: 'agent',
    parts: [
      { kind: 'text', text: error.message },
      { kind: 'data', data: { error } as Record<string, unknown> },
    ],
    contextId,
    taskId,
  }
  const task: Task = {
    taskId,
    contextId,
    status: { state: 'failed', message: failureMessage, timestamp: new Date().toISOString() },
    artifacts: [],
  }
  return { task }
}
