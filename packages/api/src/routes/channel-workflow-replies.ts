import type { Tool, ToolContext } from '@use-brian/core'
import { maybeHandleApprovalReply } from '../workflow/approval-replies.js'
import { handleChannelQuestionReply, type ChannelQuestion, type ChannelQuestionStore, type QuestionAddress } from '../workflow/channel-questions.js'
import { dispatchQuestionResponse } from '../workflow/question-response.js'

/** Call after verified identity + assistant routing, before conversational ask/LLM.
 * null alone means continue; otherwise send the returned text and stop, including
 * failures. Never supply webhook-selected tools/arguments or cached policy here.
 * A native conversational-ask callback must be handled by its own surface first.
 */
export async function maybeHandleChannelWorkflowReply(params: {
  address: QuestionAddress
  text: string
  questionStore: ChannelQuestionStore
  approvals?: Parameters<typeof maybeHandleApprovalReply>[0]
  authorized: () => Promise<boolean>
  abortSignal?: AbortSignal
  /** Must rebuild the scoped registry and ToolContext using current grants/policy. */
  loadResponseContext: (binding: ChannelQuestion) => Promise<{ tools: Map<string, Tool>; context: ToolContext }>
  callback?: { data: string; messageId: string }
  replyToMessageId?: string
  /** Native thread root for implicit question matching. */
  threadId?: string
  referenceToken?: string
  quotedText?: string
  answerMessageId?: string
  /** False when a conversational ask owns unthreaded text. */
  allowUnthreaded?: boolean
  /** Shared transports have no UUID-backed durable question store. */
  questionRepliesAvailable?: boolean
}): Promise<string | null> {
  if (params.callback && !params.callback.data.startsWith('wq:')) return null
  const referenceToken = params.referenceToken
    ?? params.quotedText?.match(/Question reference: wq:([\w-]{24})\s*$/)?.[1]
  const questionMessageId = params.replyToMessageId ?? params.threadId
  let explicitQuestion: boolean
  try { explicitQuestion = /^\s*wq:/i.test(params.text) || !!params.callback?.data.startsWith('wq:') || !!referenceToken
    || !!(params.questionRepliesAvailable !== false && questionMessageId && await params.questionStore.isQuestionMessage(
      params.address.integrationId, params.address.channelId, questionMessageId))
  } catch { return 'Workflow replies are temporarily unavailable.' }
  // Explicit question answers are literal text, even "approve abc123".
  if (!explicitQuestion && /^\s*(approve|reject)\s+[a-f0-9-]{6,}(?:\s|$)/i.test(params.text)) {
    if (!params.approvals) return 'Workflow approvals are unavailable here. Use the approvals page.'
    try {
      const result = await maybeHandleApprovalReply(params.approvals, params.address.userId, params.text, {
        workspaceId: params.address.workspaceId, assistantId: params.address.assistantId,
        authorized: params.authorized,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      })
      if (result?.status === 'cancelled') return 'Stopped. No approval was submitted.'
      return result?.status === 'unavailable'
        ? 'This approval is unavailable or ambiguous. Use the full ID from the approvals page.'
        : `Approval reply processed (${result?.status ?? 'unavailable'}).`
    } catch { return 'The approval reply could not be processed. Check the approvals page before retrying.' }
  }
  if (params.questionRepliesAvailable === false) return explicitQuestion ? 'This workflow question is unavailable.' : null
  try {
    return await handleChannelQuestionReply({
      ...params, referenceToken, store: params.questionStore,
      dispatch: async (binding, answer, claim) => {
        const { tools, context } = await params.loadResponseContext(binding)
        if (context.userId !== binding.userId || context.workspaceId !== binding.workspaceId
          || context.assistantId !== binding.assistantId || context.channelId !== binding.channelId) {
          return 'The response action scope could not be verified. No action was run.'
        }
        return dispatchQuestionResponse(binding, answer, tools, context, claim)
      },
    })
  } catch {
    // An unavailable store must not turn a potentially bound answer into chat.
    return 'Workflow replies are temporarily unavailable. No automatic retry will run.'
  }
}
