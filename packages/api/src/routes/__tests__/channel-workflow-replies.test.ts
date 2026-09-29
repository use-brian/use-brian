import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../../workflow/approval-replies.js', () => ({ maybeHandleApprovalReply: vi.fn() }))
vi.mock('../../workflow/channel-questions.js', () => ({ handleChannelQuestionReply: vi.fn() }))
vi.mock('../../workflow/question-response.js', () => ({ dispatchQuestionResponse: vi.fn(async () => 'sent') }))
import { maybeHandleChannelWorkflowReply } from '../channel-workflow-replies.js'
import { maybeHandleApprovalReply } from '../../workflow/approval-replies.js'
import { handleChannelQuestionReply, type ChannelQuestion } from '../../workflow/channel-questions.js'
import { dispatchQuestionResponse } from '../../workflow/question-response.js'

type Params = Parameters<typeof maybeHandleChannelWorkflowReply>[0]
function fixture(): Params {
  return {
    address: { workspaceId: 'ws', assistantId: 'asst', userId: 'user', integrationId: 'integration', channelId: 'peer' },
    text: 'hello', questionStore: { isQuestionMessage: vi.fn(async () => false) } as unknown as Params['questionStore'],
    approvals: {} as Params['approvals'], authorized: vi.fn(async () => true),
    loadResponseContext: vi.fn(async () => ({ tools: new Map(), context: {
      workspaceId: 'ws', assistantId: 'asst', userId: 'user', channelId: 'peer', channelType: 'slack',
      sessionId: 'session', appId: 'Use Brian', abortSignal: new AbortController().signal,
    } })) as Params['loadResponseContext'],
  }
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(handleChannelQuestionReply).mockResolvedValue(null) })
describe('common workflow interception', () => {
  it('passes ordinary text through only when no workflow question claims it', async () => {
    expect(await maybeHandleChannelWorkflowReply(fixture())).toBeNull()
    expect(maybeHandleApprovalReply).not.toHaveBeenCalled()
  })
  it.each(['unavailable', 'approved', 'rejected'])('consumes recognized approval %s and passes verified scope', async (status) => {
    vi.mocked(maybeHandleApprovalReply).mockResolvedValue({ decision: 'approved', approvalId: 'abc123', status, runId: null })
    const params = { ...fixture(), text: 'approve abc123' }
    expect(await maybeHandleChannelWorkflowReply(params)).not.toBeNull()
    expect(maybeHandleApprovalReply).toHaveBeenCalledWith(params.approvals, 'user', params.text,
      { workspaceId: 'ws', assistantId: 'asst', authorized: params.authorized })
    expect(handleChannelQuestionReply).not.toHaveBeenCalled()
  })
  it('never lets missing approval deps or approval errors fall into chat', async () => {
    expect(await maybeHandleChannelWorkflowReply({ ...fixture(), text: 'reject abc123', approvals: undefined })).toContain('unavailable')
    vi.mocked(maybeHandleApprovalReply).mockRejectedValueOnce(new Error('private'))
    expect(await maybeHandleChannelWorkflowReply({ ...fixture(), text: 'approve abc123' })).toContain('could not')
  })
  it('treats explicit question answers as literal text, not approval commands', async () => {
    vi.mocked(handleChannelQuestionReply).mockResolvedValueOnce('sent')
    expect(await maybeHandleChannelWorkflowReply({ ...fixture(), text: 'approve abc123', referenceToken: 'a'.repeat(24) })).toBe('sent')
    expect(maybeHandleApprovalReply).not.toHaveBeenCalled()
  })
  it('keeps conversational ask callbacks separate', async () => {
    expect(await maybeHandleChannelWorkflowReply({ ...fixture(), callback: { data: 'ask:other', messageId: '42' } })).toBeNull()
    expect(handleChannelQuestionReply).not.toHaveBeenCalled()
  })
  it('loads fresh tools and dispatches only the pinned response binding', async () => {
    const params = fixture()
    await maybeHandleChannelWorkflowReply(params)
    const handler = vi.mocked(handleChannelQuestionReply).mock.calls[0][0]
    const binding = { ...params.address, token: 'token', messageId: '42', question: { question: '?' } } as ChannelQuestion
    const claim = vi.fn(async () => true)
    expect(await handler.dispatch(binding, 'literal', claim)).toBe('sent')
    expect(params.loadResponseContext).toHaveBeenCalledWith(binding)
    expect(dispatchQuestionResponse).toHaveBeenCalledWith(binding, 'literal', expect.any(Map), expect.objectContaining({ workspaceId: 'ws' }), claim)
    expect(await handler.dispatch({ ...binding, assistantId: 'other' }, 'literal', claim)).toContain('scope')
    expect(dispatchQuestionResponse).toHaveBeenCalledTimes(1)
  })
  it('fails closed when question storage is unavailable', async () => {
    vi.mocked(handleChannelQuestionReply).mockRejectedValueOnce(new Error('private'))
    expect(await maybeHandleChannelWorkflowReply(fixture())).toContain('temporarily unavailable')
  })
})

it('passes native thread scope to question lookup and keeps thread answers literal', async () => {
  const params = fixture()
  vi.mocked(params.questionStore.isQuestionMessage).mockResolvedValue(true)
  await maybeHandleChannelWorkflowReply({ ...params, text: 'approve abc123', threadId: 'root' })
  expect(params.questionStore.isQuestionMessage).toHaveBeenCalledWith('integration', 'peer', 'root')
  expect(maybeHandleApprovalReply).not.toHaveBeenCalled()
  expect(handleChannelQuestionReply).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'root', text: 'approve abc123' }))
})
