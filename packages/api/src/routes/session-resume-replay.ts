/**
 * Path B durable chat resume — the replay implementation (WU-6.4).
 *
 * `runSessionResume` (`chat.ts`) owns the resume-point + approval lookup
 * and the status gate; it delegates the actual turn replay to an injected
 * `SessionResumeReplay` callback. This file builds that callback.
 *
 * The replay runs after a Cloud Run restart killed the chat process that
 * suspended a `requiresConfirmation` tool. It:
 *   1. reloads the suspended session + its message history,
 *   2. runs the approved tool (or records the rejection / expiry),
 *   3. drives a fresh `queryLoop` turn so the model reports the outcome
 *      to the user and continues,
 *   4. persists the resulting assistant message(s).
 *
 * Robustness over fidelity: rather than reconstruct an exact
 * tool_use/tool_result pair across the restart boundary — the suspended
 * assistant turn is not persisted at suspension time — the outcome is
 * handed to the model as a self-contained note. `ensureToolResultPairing`
 * still repairs any dangling tool_use in the reloaded history so the
 * provider call is valid either way.
 *
 * Spec: docs/plans/company-brain/approvals.md → "Chat resume — Path B".
 *
 * [COMP:brain/session-resume-worker]
 */

import {
  queryLoop,
  ensureToolResultPairing,
  SensitivityAccumulator,
  type LLMProvider,
  type Tool,
  type ToolContext,
  type Message,
  type AnalyticsLogger,
} from '@use-brian/core'
import {
  findSessionById,
  getSessionMessages,
  addSessionMessage,
  toStampedMessages,
  type Session,
} from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import type { SessionResumeReplay, ResumeReplayParams } from './chat.js'

export type SessionResumeReplayDeps = {
  provider: LLMProvider
  /** Boot-time tool registry — the suspended tool is resolved from here. */
  tools: Map<string, Tool>
  /** Base L1 system prompt. The assistant's L2 is appended per-session. */
  systemPrompt: string
  /** Model for the continuation turn. Defaults to `gemini-flash`. */
  model?: string
  analytics?: AnalyticsLogger
  /**
   * Phase 3 of askQuestion suspend-resume — rehydrate worker state from
   * `worker_runs` before the continuation turn. When both `workerManager`
   * and `workerRunsStore` are wired (workspace-scoped resumes), the
   * replay calls `workerManager.setPersistence(...)` + `rehydrate(...)`
   * so completed workers feed into Phase 4b's notifications queue and
   * any still-running rows respawn from their last turn boundary.
   * Both absent → legacy behavior (no rehydrate; the model synthesizes
   * with whatever the session history holds).
   *
   * See docs/architecture/engine/askquestion-suspend-resume.md.
   */
  workerManager?: import('@use-brian/core').WorkerManager
  workerRunsStore?: import('@use-brian/core').WorkerRunsStore
}

type AssistantRow = NonNullable<Awaited<ReturnType<typeof findAssistantById>>>

/** Build the `ToolContext` shared by the suspended-tool run and the queryLoop turn. */
function buildContext(session: Session, assistant: AssistantRow): ToolContext {
  return {
    userId: session.userId,
    assistantId: assistant.id,
    sessionId: session.id,
    appId: 'Use Brian',
    channelType: session.channelType,
    channelId: session.channelId,
    workspaceId: assistant.workspaceId ?? undefined,
    assistantKind: assistant.kind,
    clearance: assistant.clearance,
    sensitivity: new SensitivityAccumulator(),
    abortSignal: new AbortController().signal,
  }
}

/**
 * Resolve the self-contained outcome note handed to the continuation
 * turn. For an approved action this runs the suspended tool with its
 * frozen input. Never throws — every failure mode (missing tool, invalid
 * input, tool error, tool throw) resolves to a note the model can relay
 * to the user. Exported for direct unit testing.
 */
export async function resolveResumeOutcomeNote(
  tools: Map<string, Tool>,
  params: Pick<
    ResumeReplayParams,
    | 'suspendedToolName'
    | 'suspendedToolInput'
    | 'approvalStatus'
    | 'rejectReason'
    | 'answerText'
    | 'approvalKind'
  >,
  context: ToolContext,
): Promise<string> {
  const {
    suspendedToolName: toolName,
    approvalStatus,
    rejectReason,
    answerText,
    approvalKind,
  } = params

  // askQuestion suspend-resume — the suspended tool is the question itself.
  // The outcome note is the user's typed answer (NOT a tool execution
  // result). The queryLoop continuation turn reads this as user-role text
  // and can finish synthesis with worker findings + the answer. See
  // docs/architecture/engine/askquestion-suspend-resume.md.
  if (approvalKind === 'question') {
    if (approvalStatus === 'expired') {
      return (
        '[Resumed after question] The question expired before the user answered. ' +
        'Acknowledge that no answer came in, summarize what was found so far, and stop.'
      )
    }
    if (approvalStatus === 'rejected') {
      // Cancel pathway (Phase 2 maps cancel → status='rejected').
      return (
        '[Resumed after question] The user cancelled this research session. ' +
        'Acknowledge the cancellation. Do not continue research; surface any ' +
        'findings already gathered if useful, then stop.'
      )
    }
    // approvalStatus === 'approved' — the answer is in answerText.
    const answer = (answerText ?? '').trim()
    if (!answer) {
      // Defensive: route validation should reject empty answers; if one
      // sneaks through, fall through to a generic continuation note.
      return (
        '[Resumed after question] The user submitted an empty answer. ' +
        'Use the best inference from prior context and continue.'
      )
    }
    return (
      `[Resumed after question] The user answered: ${answer}\n\n` +
      'Continue from where you paused — synthesize the final reply using this ' +
      'answer plus any background worker results that have arrived.'
    )
  }

  if (approvalStatus === 'rejected') {
    return (
      `[Resumed after approval] The user declined the pending action "${toolName}". ` +
      (rejectReason ? `Reason: ${rejectReason}. ` : '') +
      'Acknowledge this and continue without performing it.'
    )
  }
  if (approvalStatus === 'expired') {
    return (
      `[Resumed after approval] The approval request for "${toolName}" expired before ` +
      'the user responded — the action was not performed. Let the user know.'
    )
  }

  // approvalStatus === 'approved' → run the frozen tool call.
  const tool = tools.get(toolName)
  if (!tool) {
    return (
      `[Resumed after approval] The approved action "${toolName}" could not run — ` +
      'the tool is no longer available. Tell the user the action did not complete.'
    )
  }
  let input: unknown
  try {
    input = tool.inputSchema.parse(params.suspendedToolInput)
  } catch (err) {
    return (
      `[Resumed after approval] The approved action "${toolName}" could not run — ` +
      `its arguments are no longer valid (${err instanceof Error ? err.message : String(err)}). ` +
      'Tell the user the action did not complete.'
    )
  }
  try {
    const result = await tool.execute(input, context)
    const resultText =
      typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
    if (result.isError) {
      return (
        `[Resumed after approval] The user approved "${toolName}", but it failed: ` +
        `${resultText}. Tell the user it did not complete.`
      )
    }
    return (
      `[Resumed after approval] The user approved "${toolName}" and it executed ` +
      `successfully. Result:\n${resultText}\n\nReport the outcome to the user and continue.`
    )
  } catch (err) {
    return (
      `[Resumed after approval] The user approved "${toolName}" but it threw an error: ` +
      `${err instanceof Error ? err.message : String(err)}. Tell the user it did not complete.`
    )
  }
}

export function createSessionResumeReplay(deps: SessionResumeReplayDeps): SessionResumeReplay {
  const model = deps.model ?? 'gemini-flash'

  return async function replay(params: ResumeReplayParams): Promise<'completed' | 'deferred'> {
    const { sessionId, suspendedToolName } = params

    const session = await findSessionById(sessionId)
    if (!session) {
      // Session vanished — nothing to resume. 'completed' so the
      // resume_point is cleaned up rather than retried forever.
      return 'completed'
    }
    const assistant = await findAssistantById(session.assistantId)
    if (!assistant) return 'completed'

    const context = buildContext(session, assistant)

    // Phase 3 of askQuestion suspend-resume — rehydrate the worker
    // manager from `worker_runs` BEFORE the continuation turn runs.
    // Completed rows arrive as pre-populated notifications so Phase 4b's
    // drain on the first turn boundary surfaces them to the synthesis;
    // running rows respawn from their last checkpointed history so they
    // continue from where they were when the prior instance died.
    // Workspace-scoped only — matches the suspend gate in chat.ts.
    if (
      assistant.workspaceId
      && deps.workerManager
      && deps.workerRunsStore
    ) {
      deps.workerManager.setPersistence({
        store: deps.workerRunsStore,
        sessionId,
        workspaceId: assistant.workspaceId,
      })
      try {
        const { respawned, notificationsReady } = await deps.workerManager.rehydrate(
          sessionId,
          { ...context, workerManager: undefined },
          deps.tools,
        )
        if (respawned > 0 || notificationsReady > 0) {
          deps.analytics?.logEvent({
            userId: session.userId,
            sessionId,
            eventName: 'session_resume_workers_rehydrated',
            channelType: 'web',
            metadata: {
              respawned,
              notifications_ready: notificationsReady,
            },
          })
        }
      } catch (err) {
        // Don't fail the resume because rehydration failed — the user
        // still gets a reply (possibly missing worker findings). Log
        // loudly for diagnosis.
        console.warn(
          `[session-resume] worker rehydrate failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // ── 1. Resolve the outcome note (runs the approved tool) ──
    const outcomeNote = await resolveResumeOutcomeNote(deps.tools, params, context)

    // ── 2. Rebuild the conversation, append the outcome note ──
    const dbMessages = await getSessionMessages(sessionId)
    const history = ensureToolResultPairing(toStampedMessages(dbMessages, 'UTC') as Message[])
    const messages: Message[] = [
      ...history,
      { role: 'user', content: [{ type: 'text', text: outcomeNote }] },
    ]

    // Persist the outcome as a system-role note so the session timeline
    // explains the assistant message the resume is about to produce.
    await addSessionMessage({
      sessionId,
      role: 'system',
      content: [{ type: 'text', text: outcomeNote }],
    })

    // ── 3. Drive the continuation turn ──
    const systemPrompt = assistant.systemPrompt
      ? `${deps.systemPrompt}\n\n${assistant.systemPrompt}`
      : deps.systemPrompt

    for await (const event of queryLoop({
      provider: deps.provider,
      model,
      systemPrompt,
      messages,
      tools: deps.tools,
      // Inject the rehydrated workerManager so Phase 4b sees the
      // pre-populated notifications + any respawned running workers.
      // Absent when worker persistence isn't wired (legacy path).
      context: deps.workerManager
        ? { ...context, workerManager: deps.workerManager }
        : context,
      channelType: session.channelType,
      resumeContext: {
        approvalId: params.approvalId,
        suspendedToolName,
        loopStepIndex: params.loopStepIndex,
      },
    })) {
      if (event.type === 'turn_complete') {
        await addSessionMessage({
          sessionId,
          role: 'assistant',
          content: event.response.content,
        })
      } else if (event.type === 'error') {
        // Surface the failure so the poll worker marks the job failed
        // with a loud log rather than silently dropping the resume.
        throw event.error
      }
    }

    return 'completed'
  }
}
