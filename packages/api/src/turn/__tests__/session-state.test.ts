import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindScopeSources, ContextScopeAccumulator, runSessionStateDiff, type ContentBlock, type SessionContextAuthority, type SessionStateStore } from '@use-brian/core'
import { assertSourceModelInputAuthority } from '../../application-platform/model-source-authority.js'
import { runTurnSessionStateDiff } from '../session-state.js'

vi.mock('@use-brian/core', async importOriginal => ({
  ...await importOriginal<typeof import('@use-brian/core')>(),
  executionToolContext: vi.fn(() => ({})),
  runSessionStateDiff: vi.fn(async () => ({ upserts: 0, resolves: 0, usage: null, model: null })),
}))
vi.mock('../../application-platform/model-source-authority.js', () => ({ assertSourceModelInputAuthority: vi.fn(async () => {}) }))

function fixture(user = 'hi', answer = 'Hey! What are we working on today?') {
  const controller = new AbortController(), current = vi.fn(async () => {})
  const authority = { accumulator: new ContextScopeAccumulator(), execution: {
    lifecycle: { sessionId: 'session', abortSignal: controller.signal },
    security: { access: { userId: 'actor' }, authority: { assertCurrent: current } },
    assistant: { id: 'assistant' },
  } } as unknown as SessionContextAuthority
  const source = { workspaceId: 'workspace', userId: 'actor', assistantId: null,
    resourceKind: 'session_message' as const, resourceId: 'message', version: '1', sensitivity: 'internal' as const,
    compartments: [], projectIds: [] }
  const listOpen = vi.fn<SessionStateStore['listOpenBySession']>(async () => [])
  const params = { authority, provider: {} as never, model: 'fixture',
    store: { listOpenBySession: listOpen } as unknown as SessionStateStore,
    userMessage: bindScopeSources({ role: 'user' as const, content: user }, [source]),
    assistantTurns: [{ content: [{ type: 'text', text: answer }] as ContentBlock[] }],
  }
  return { params, controller, current, listOpen }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/turn-session-state] completed exchange inference admission', () => {
  it.each(['Hey! What are we working on today?', 'Hey there! What can I help you with today?', 'Hello! How can I help you today?',
    "Hey there. What's on your mind?", 'Hello! What’s on your mind?', 'Hi! What is on your mind?'])('skips inference only for a plain greeting with no open commitments: %s', async answer => {
    const f = fixture('hi', answer)
    await expect(runTurnSessionStateDiff(f.params)).resolves.toMatchObject({ upserts: 0, resolves: 0, usage: null })
    expect(f.listOpen).toHaveBeenCalledWith('session', f.params.authority)
    expect(f.current).toHaveBeenCalledTimes(2)
    expect(runSessionStateDiff).not.toHaveBeenCalled()
    expect(assertSourceModelInputAuthority).not.toHaveBeenCalled()
  })

  it.each([
    ['hi', 'Hello! I will remind you tomorrow.'],
    ['hi', 'Hello! Your pending deadline is tomorrow.'],
    ['hi, remind me tomorrow', 'Hello!'],
    ['thanks', 'You are welcome.'],
    ['hi', 'Hello, a different response outside the grammar.'],
    ['hi', "Hey there. What's on your mind? I will remind you tomorrow."],
    ['hi', 'Hey there. Your deadline is on my mind.'],
    ['hi', "Hey there. What's on your task list?"],
  ])('retains inference when the exchange might change state', async (user, answer) => {
    const f = fixture(user, answer)
    await runTurnSessionStateDiff(f.params)
    expect(runSessionStateDiff).toHaveBeenCalledOnce()
    expect(assertSourceModelInputAuthority).toHaveBeenCalled()
  })

  it('retains inference for existing commitments even when both messages look like greetings', async () => {
    const f = fixture('hi', "Hey there. What's on your mind?")
    f.listOpen.mockResolvedValue([{ key: 'fixture:follow-up' } as never])
    await runTurnSessionStateDiff(f.params)
    expect(runSessionStateDiff).toHaveBeenCalledOnce()
    expect(f.listOpen).toHaveBeenCalledOnce()
  })

  it('retains inference after a tool-bearing turn', async () => {
    const f = fixture()
    f.params.assistantTurns.unshift({ content: [{ type: 'tool_use', id: 'call', name: 'listTasks', input: {} }] })
    await runTurnSessionStateDiff(f.params)
    expect(runSessionStateDiff).toHaveBeenCalledOnce()
  })

  it('never treats a failed current read, lost authority or cancellation as an empty commitment set', async () => {
    for (const mode of ['read', 'authority', 'cancel']) {
      const f = fixture(), failure = new Error('Fixture unavailable')
      if (mode === 'read') f.listOpen.mockRejectedValue(failure)
      if (mode === 'authority') f.current.mockRejectedValue(failure)
      if (mode === 'cancel') f.controller.abort()
      await expect(runTurnSessionStateDiff(f.params)).rejects.toThrow()
    }
    expect(runSessionStateDiff).not.toHaveBeenCalled()
  })
})
