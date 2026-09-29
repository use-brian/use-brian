import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn(async () => 'owner') }))
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../workflow/approval.js', async original => ({
  ...await original<typeof import('../../workflow/approval.js')>(), resumeFromApproval: vi.fn(),
}))
vi.mock('../../workflow/question-response.js', () => ({ dispatchQuestionResponse: vi.fn() }))
import { resolveSlackSender } from '../slack.js'
import { maybeHandleChannelWorkflowContext, configureChannelWorkflowReplies } from '../channel-workflow-context.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { query } from '../../db/client.js'
import { resumeFromApproval } from '../../workflow/approval.js'
import { dispatchQuestionResponse } from '../../workflow/question-response.js'

afterEach(() => { vi.clearAllMocks(); configureChannelWorkflowReplies(undefined) })

describe('Slack fallback identity cannot authorize owner workflow actions', () => {
  for (const missing of [true, false]) {
    for (const durable of [false, true]) {
      it(`${missing ? 'missing' : 'failed'} identity services reject ${durable ? 'durable answer' : 'approval text'} even when fallback owner is a workspace owner`, async () => {
        const sender = await resolveSlackSender({
          slackUserId: 'provider-stranger', assistantId: 'assistant', ownerId: 'owner', workspaceId: 'workspace',
          fetchProfile: async () => ({ email: null, displayName: null }),
          ...(!missing ? { channelUserStore: {} as never,
            deps: { resolveByEmail: vi.fn(async () => { throw new Error('offline') }) as never } } : {}),
        })
        expect(sender).toMatchObject({ userId: 'owner', isIdentified: false })
        const consume = vi.fn()
        const binding = { token: 'a'.repeat(24), integrationId: 'integration', channelId: 'room', workspaceId: 'workspace',
          assistantId: 'assistant', userId: 'owner', messageId: 'question', question: { question: '?' },
          response: { toolName: 'execute', arguments: {}, answerField: 'answer' } }
        const store = { isQuestionMessage: vi.fn(async () => durable), find: vi.fn(async () => [binding]), consume }
        configureChannelWorkflowReplies({ approvalsStore: {} } as never)
        const result = await maybeHandleChannelWorkflowContext({
          userId: sender.userId, isIdentified: sender.isIdentified,
          assistant: { id: 'assistant', ownerUserId: 'owner', workspaceId: 'workspace', name: 'Assistant', kind: 'standard', systemPrompt: null, clearance: 'internal' },
          channelType: 'slack', channelId: 'room', integrationId: 'integration',
          messageText: durable ? 'answer' : 'approve abc123',
          replyToMessageId: durable ? 'question' : undefined,
          questionStore: store as never,
        })
        expect(result).not.toBeNull()
        expect(getWorkspaceRoleSystem).not.toHaveBeenCalled()
        expect(query).not.toHaveBeenCalled()
        expect(resumeFromApproval).not.toHaveBeenCalled()
        expect(dispatchQuestionResponse).not.toHaveBeenCalled()
        expect(consume).not.toHaveBeenCalled()
      })
    }
  }
})
