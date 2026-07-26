/**
 * In-process A2A transport.
 *
 * Implements `ConsultTransport.send()` for callers that live in the same
 * process as their callees (the only supported deployment today). Performs
 * the cycle/depth/budget checks specified in `docs/architecture/integrations/a2a.md`,
 * then delegates query-loop execution to a callback (`runConsult`) supplied
 * by the consuming app.
 *
 * Consults are workspace-internal: connections only exist between assistants
 * of the same workspace (auto-seeded primary → sibling edges), so a
 * cross-workspace request is rejected with SHARING_BLOCKED before any
 * execution. The destination-side "mode" policy layer (assistant_modes) was
 * retired 2026-07-24 along with the sharing/discovery feature — same-workspace
 * consults run with full workspace trust.
 *
 * Why a callback rather than a direct `queryLoop` call: this module lives in
 * `@use-brian/core` which has no `pg` / DB / store-construction surface. The
 * actual execution wires DB-backed stores, MCP injection, etc., which is the
 * `@use-brian/api` layer's job. The callback boundary keeps the core free of
 * those dependencies.
 *
 * [COMP:a2a/transport-in-process]
 */

import { CONSULT_LIMITS, ERROR_CODES } from './limits.js'
import type {
  A2AMessage,
  Artifact,
  ConsultError,
  ConsultRequest,
  ConsultResponse,
  ConsultTransport,
  Task,
} from './types.js'

export type RunConsultParams = {
  request: ConsultRequest
}

export type RunConsultResult = {
  /** Response text from the destination's query loop. */
  text: string
  /** Optional structured artifacts (restricted-mode capability invocations may surface these). */
  artifacts?: Artifact[]
}

export type InProcessTransportDeps = {
  /**
   * Run the destination's query loop and return the response. Implementer is
   * responsible for: memory context, MCP injection, session creation, billing
   * attribution, etc.
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
      const isFreeMode = request.target.capabilityId === undefined

      // Step 1: cycle check (visited set) — applies to all consults.
      if (request.chain.path.includes(request.target.assistantId)) {
        return errorResponse(request, {
          code: ERROR_CODES.UNSUPPORTED_OPERATION,
          message: 'Cycle detected — destination already in chain.path.',
          reason: 'cycle_detected',
        })
      }

      // Step 2: depth check.
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

      // Step 4: workspace boundary. Connections are workspace-internal
      // (auto-seeded primary → sibling); there is no cross-workspace grant
      // mechanism, so a cross-workspace consult is rejected outright.
      if (request.caller.workspaceId !== request.target.workspaceId) {
        return errorResponse(request, {
          code: ERROR_CODES.SHARING_BLOCKED,
          message: 'Cross-workspace consults are not supported.',
          reason: 'sharing_blocked',
        })
      }

      const result = await deps.runConsult({ request })

      const taskId = `task_${now()}_${Math.random().toString(36).slice(2, 10)}`
      const contextId = request.contextId ?? `ctx_${taskId}`
      const timestamp = new Date(now()).toISOString()

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
