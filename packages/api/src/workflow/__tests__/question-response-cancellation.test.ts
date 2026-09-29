import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, createExecutionContext, executionToolContext, type ToolContext } from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { dispatchQuestionResponse } from '../question-response.js'
import type { ChannelQuestion } from '../channel-questions.js'

const binding: ChannelQuestion = {
  token: 'token', integrationId: 'integration', workspaceId: 'workspace', assistantId: 'assistant', userId: 'actor',
  channelId: 'channel', messageId: 'prompt', question: { question: 'Where?' },
  response: { toolName: 'answer_action', arguments: {}, answerField: 'answer' },
}

describe('workflow response cancellation boundaries', () => {
  it.each(['preflight policy', 'claim', 'execution policy'] as const)('never executes after abort during %s', async stage => {
    const controller = new AbortController()
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pause = async () => { enter(); await paused }
    const execute = vi.fn(async () => ({ data: 'done' })) // deliberately ignores AbortSignal
    let policyCalls = 0
    const tool = buildTool({ name: 'answer_action', description: '', inputSchema: z.object({ answer: z.string() }),
      isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: false, execute })
    tool.resolveConfirmation = async () => {
      policyCalls++
      if ((stage === 'preflight policy' && policyCalls === 1) || (stage === 'execution policy' && policyCalls === 2)) await pause()
      return false
    }
    const claim = vi.fn(async () => { if (stage === 'claim') await pause(); return true })
    const access = { userId: 'actor', workspaceId: 'workspace', assistantId: 'assistant',
      assistantKind: 'standard' as const, clearance: 'internal' as const, compartments: [],
      mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant'] }
    const context: ToolContext = executionToolContext(createExecutionContext({
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor' } },
      ownership: { kind: 'workspace', workspaceId: 'workspace' }, access,
      writeDefaults: { compartments: [], projectIds: [] },
      authority: createAuthorityLease(access, async () => access),
      lifecycle: { sessionId: 'question:token', channelType: 'slack', channelId: 'channel', abortSignal: controller.signal },
    }), { appId: 'Use Brian' })
    const result = dispatchQuestionResponse(binding, 'prod', new Map([[tool.name, tool]]), context, claim)
    await entered
    controller.abort()
    release()
    expect(await result).not.toBe('Your answer was sent.')
    expect(execute).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledTimes(stage === 'preflight policy' ? 0 : 1)
  })
})
