import type { ChannelPipelineParams } from './channel-pipeline.js'
import { resolveChannelAnswerContext as interpretAnswerContext } from './channel-answer-context.js'
import { channelConfirmations } from './channel-interactions.js'

type AnswerContext = Awaited<ReturnType<typeof interpretAnswerContext>>

/** Pipeline must reuse this result instead of interpreting/consuming the answer
 * again. In particular, `continue` without questionAnswer is still admitted. */
export type AdmittedChannelMessage = { admittedAnswerContext?: AnswerContext }

/** Shared pipeline integration: import this in place of the raw resolver.
 * Unsplit routes still interpret exactly once, inside their normal turn. */
export function resolveChannelAnswerContext(
  params: ChannelPipelineParams & AdmittedChannelMessage,
  binding?: Parameters<typeof interpretAnswerContext>[1],
): Promise<AnswerContext> {
  return params.admittedAnswerContext
    ? Promise.resolve(params.admittedAnswerContext)
    : interpretAnswerContext(params, binding)
}

/** Split admission for routes whose media intake can terminate the turn before
 * the conversational pipeline. Call under the conversation lock, after identity
 * and live confirmation handling, and before any download or ingestion.
 * `handled` has already been sent: return without forwarding to the pipeline.
 * For `continue`, first check abortController.signal.aborted, then forward the
 * entire result as admittedAnswerContext with the SAME abortController. Even a
 * continue result without questionAnswer must be forwarded to avoid re-consuming.
 * The active-turn registration covers interpretation and is always released. */
export async function admitChannelMessage(params: ChannelPipelineParams): Promise<AnswerContext> {
  // A cancelled queued turn must not consume a question or dispatch an action.
  // Callers must also check the signal before starting media/conversation work.
  if (params.abortController.signal.aborted) return { kind: 'continue' }
  const incoming = params.incomingMessage ?? params.archiveIncoming
  const scope = params.interactionScope
  const unregister = scope ? channelConfirmations.registerTurn(scope, params.abortController, {
    messageId: incoming?.messageId == null ? undefined : String(incoming.messageId),
    onAbort: () => params.hooks.sendResponse('Stopped.'),
  }) : undefined
  try {
    const answer = await interpretAnswerContext(params, scope && incoming ? {
      integrationId: scope.integrationId, assistantId: params.assistant.id,
      userId: params.userId, incoming, sessionId: scope.sessionId,
    } : undefined)
    if (answer.kind === 'handled' && !params.abortController.signal.aborted) {
      await params.hooks.sendResponse(answer.reply)
    }
    return answer
  } finally {
    unregister?.()
  }
}
