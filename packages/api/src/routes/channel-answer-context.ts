import type { ChannelPipelineParams } from './channel-pipeline.js'
import { channelQuestions, resolveChannelQuestion, type QuestionBinding } from './channel-questions.js'
import { createChannelQuestionStore } from '../workflow/channel-questions.js'
import { maybeHandleChannelWorkflowContext } from './channel-workflow-context.js'

type AnswerContext = { kind: 'continue'; questionAnswer?: string } | { kind: 'handled'; reply: string }

/** Keep conversational choices out of every business-action interpreter. Native
 * provenance is route-owned; typed choices win unless explicitly addressed to a
 * durable question. Never infer provenance just from a label's spelling.
 */
export async function resolveChannelAnswerContext(params: ChannelPipelineParams, binding?: QuestionBinding): Promise<AnswerContext> {
  const incoming = params.incomingMessage ?? params.archiveIncoming
  if (params.conversationalAnswer) {
    return { kind: 'continue', questionAnswer: incoming?.text ?? params.messageText }
  }

  if (binding && channelQuestions.has(binding) && !params.workflowCallback) {
    const text = incoming?.text ?? params.messageText
    const quoted = ((incoming?.raw ?? params.replyRaw) as { reply_to_message?: { text?: string } } | undefined)?.reply_to_message?.text
    let explicitDurable = /^\s*wq:/i.test(text) || /Question reference: wq:[\w-]{24}\s*$/.test(quoted ?? '')
    const replyId = incoming?.replyToMessageId ?? params.replyToMessageId
    if (!explicitDurable && replyId && params.questionIntegrationId && !params.questionIntegrationId.startsWith('system:')) {
      try {
        explicitDurable = await (params.questionStore ?? createChannelQuestionStore()).isQuestionMessage(
          params.questionIntegrationId, params.channelId, String(replyId),
        )
      } catch { return { kind: 'handled', reply: 'Workflow replies are temporarily unavailable.' } }
    }
    if (!explicitDurable) {
      const choice = channelQuestions.resolve(binding, undefined, true)
      if (choice) return { kind: 'continue', questionAnswer: choice.answer }
    }
  }

  if (params.interactionScope) {
    const reply = await maybeHandleChannelWorkflowContext({
      ...params, integrationId: params.questionIntegrationId, incoming, callback: params.workflowCallback,
      allowUnthreaded: !binding || !channelQuestions.has(binding),
    })
    if (reply !== null) return { kind: 'handled', reply }
    if (params.workflowCallback) return { kind: 'handled', reply: 'This interaction is unavailable.' }
  }
  if (binding) {
    const answer = resolveChannelQuestion(binding)
    if (answer.kind === 'unavailable') return { kind: 'handled', reply: 'This question is unavailable. Please type your answer.' }
    if (answer.kind === 'answer') return { kind: 'continue', questionAnswer: answer.incoming.text }
  }
  return { kind: 'continue' }
}
