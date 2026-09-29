import { executionToolContext } from '@use-brian/core'
import { runWithAgentAccess } from '../db/client.js'
import type { IncomingMessage } from '@use-brian/channels'
import type { ChannelPipelineParams } from './channel-pipeline.js'
import type { ApprovalBridgeDeps } from '../workflow/approval.js'
import { createChannelQuestionStore, type ChannelQuestionStore } from '../workflow/channel-questions.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { buildWorkflowToolRegistry } from '../workflow/mcp-bridge.js'
import { createDeferredConfirmationStore, type DeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import { maybeHandleChannelDeferredConfirmation } from './channel-deferred-confirmations.js'
import { maybeHandleChannelWorkflowReply } from './channel-workflow-replies.js'

let approvalBridge: ApprovalBridgeDeps | undefined
/** Boot calls once immediately after constructing approvalBridgeDeps. Undefined
 * disables approval execution (useful during shutdown/tests), never recognition. */
export function configureChannelWorkflowReplies(deps: ApprovalBridgeDeps | undefined): void {
  approvalBridge = deps
}

export type ChannelWorkflowContextParams = Pick<ChannelPipelineParams,
  'userId' | 'assistant' | 'isIdentified' | 'externalGuest' | 'connectorAuthority'
  | 'channelType' | 'channelId' | 'messageText' | 'connectorStore' | 'mcpSettingsStore'
  | 'assistantConnectorStore' | 'connectorGrantStore' | 'connectorInstanceStore'
  | 'workspaceToolPolicyStore' | 'sessionChannelId' | 'replyToMessageId' | 'replyRaw' | 'incomingChannelMessageId'> & Partial<Pick<ChannelPipelineParams, 'abortController'>> & {
  /** Verified integration UUID from route authentication, never webhook text. */
  integrationId?: string
  incoming?: Pick<IncomingMessage, 'text' | 'messageId' | 'replyToMessageId' | 'raw'>
  callback?: { data: string; messageId: string }
  quotedText?: string
  referenceToken?: string
  allowUnthreaded?: boolean
  questionStore?: ChannelQuestionStore
  deferredConfirmationStore?: DeferredConfirmationStore
  /** Verified INBOUND native thread root. Never an allocated outbound thread. */
  threadId?: string
}

/** Pipeline entry point, before session creation/query loop. Send a non-null
 * result through channel hooks and RETURN. Identity must be the resolved sender,
 * not assistant.ownerUserId; native callbacks must pass their original data.
 * channelId retains provider/topic addressing, not a synthesized session key.
 */
export async function maybeHandleChannelWorkflowContext(params: ChannelWorkflowContextParams): Promise<string | null> {
  const abortSignal = params.abortController?.signal
  const text = params.incoming?.text ?? params.messageText
  const raw = params.incoming?.raw ?? params.replyRaw
  const quotedText = params.quotedText ?? (raw as { reply_to_message?: { text?: string } } | undefined)?.reply_to_message?.text
  const referenceToken = params.referenceToken ?? quotedText?.match(/Question reference: wq:([\w-]{24})\s*$/)?.[1]
  const replyId = params.incoming?.replyToMessageId ?? params.replyToMessageId
  const nativeReplyId = replyId == null ? undefined : String(replyId)
  // Slack's normalized replyToMessageId is thread_ts, NOT the exact message
  // being answered. Treating it as an exact quote selects an old root question
  // ahead of the live question in its thread. Callbacks carry their own exact
  // source message separately and continue to resolve by their opaque token.
  const replyToMessageId = params.channelType === 'slack' ? undefined : nativeReplyId
  const feishu = raw as { rootId?: unknown; threadId?: unknown } | null | undefined
  const nativeId = (id: unknown) => typeof id === 'string' && id.length > 0 ? id : undefined
  const threadId = params.threadId ?? (params.channelType === 'slack' ? nativeReplyId
    : params.channelType === 'feishu'
      ? nativeId(feishu?.rootId) ?? nativeId(feishu?.threadId) ?? nativeReplyId
      : undefined)
  // Do not derive inbound provenance from sessionChannelId: reply-in-thread
  // routes allocate a NEW session rooted at a top-level answer's own message.
  const questionMessageId = replyToMessageId ?? threadId
  const answerId = params.incoming?.messageId ?? params.incomingChannelMessageId
  const recognized = /^\s*(approve|reject)\s+[a-f0-9-]{6,}(?:\s|$)/i.test(text)
    || /^\s*wq:/i.test(text) || !!referenceToken || !!params.callback?.data.startsWith('wq:') || !!params.callback?.data.startsWith('mcp_confirm:')
  const store = params.questionStore ?? createChannelQuestionStore()
  const workspaceId = params.assistant.workspaceId
  if (!workspaceId || !params.integrationId) {
    if (recognized) return 'This workflow reply is unavailable in this channel context.'
    if (params.integrationId && !params.integrationId.startsWith('system:') && questionMessageId
      && await store.isQuestionMessage(params.integrationId, params.channelId, questionMessageId)) {
      return 'This workflow question is unavailable in this channel context.'
    }
    return null
  }
  const authorized = async () => params.isIdentified && !params.externalGuest
    && !!await getWorkspaceRoleSystem(params.userId, workspaceId)
  const systemIntegration = params.integrationId.startsWith('system:')
  // Explicit durable-question answers are never interpreted as approval words.
  let explicitQuestion = /^\s*wq:/i.test(text) || !!referenceToken || !!params.callback?.data.startsWith('wq:')
  if (!explicitQuestion && !systemIntegration && questionMessageId) {
    try { explicitQuestion = await store.isQuestionMessage(params.integrationId, params.channelId, questionMessageId) }
    catch { return 'Workflow replies are temporarily unavailable.' }
  }
  if ((!explicitQuestion && params.allowUnthreaded !== false) || params.callback?.data.startsWith('mcp_confirm:')) {
    const deferred = await maybeHandleChannelDeferredConfirmation({
      scope: { workspaceId, assistantId: params.assistant.id, userId: params.userId,
        integrationId: params.integrationId, channelType: params.channelType, channelId: params.channelId,
        threadId,
      },
      event: params.callback ? { kind: 'action', data: params.callback.data } : { kind: 'text', text },
      messageId: params.callback?.messageId,
      store: params.deferredConfirmationStore ?? createDeferredConfirmationStore(), authorized, abortSignal,
    })
    if (deferred !== null) return deferred
  }
  // Capture boot configuration for this request, but never cache caller grants.
  const bridge = approvalBridge
  return maybeHandleChannelWorkflowReply({
    address: { workspaceId, assistantId: params.assistant.id, userId: params.userId,
      integrationId: params.integrationId, channelId: params.channelId },
    text, questionStore: store, approvals: bridge ? { approvalsStore: bridge.approvalsStore, bridgeDeps: bridge } : undefined,
    callback: params.callback, referenceToken, replyToMessageId, threadId,
    answerMessageId: answerId == null ? undefined : String(answerId),
    allowUnthreaded: params.allowUnthreaded, questionRepliesAvailable: !systemIntegration,
    authorized, abortSignal,
    loadResponseContext: async (binding) => {
      const { connectorStore, mcpSettingsStore } = params
      if (!connectorStore || !mcpSettingsStore || params.connectorAuthority === 'disabled') {
        throw new Error('Response action service unavailable')
      }
      // Always sender scope, even if conversational connectorAuthority is assistant.
      abortSignal?.throwIfAborted()
      const { turnScope: scope, executionContext } = await resolveExecutionContextSystem({ userId: params.userId, assistant: { ...params.assistant,
        compartments: params.assistant.compartments === undefined ? [] : params.assistant.compartments,
      }, workspaceId,
        identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: params.userId } },
        ownership: { kind: 'workspace', workspaceId },
        // Synthetic correlation ID only: no conversational session is created.
        lifecycle: { sessionId: `question:${binding.token}`, channelType: params.channelType,
          channelId: binding.channelId, abortSignal: abortSignal ?? new AbortController().signal },
      })
      const tools = await runWithAgentAccess(executionContext.security.ceiling, () =>
        executionContext.security.authority.execute(async () => {
          executionContext.lifecycle.abortSignal.throwIfAborted()
          return buildWorkflowToolRegistry({
            firstParty: new Map(), connectorStore, settingsStore: mcpSettingsStore,
            assistantConnectorStore: params.assistantConnectorStore, connectorGrantStore: params.connectorGrantStore,
            connectorInstanceStore: params.connectorInstanceStore, workspaceToolPolicyStore: params.workspaceToolPolicyStore,
          }, { workspaceId, assistantId: params.assistant.id, userId: params.userId, turnScope: scope })
        }))
      return { tools, context: {
        ...executionToolContext(executionContext, { appId: 'Use Brian' }),
        activeGroupId: scope.activeGroupId, activeProjectId: scope.activeProjectId,
      } }
    },
  })
}
