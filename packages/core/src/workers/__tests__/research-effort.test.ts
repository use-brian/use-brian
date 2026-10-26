import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryLoop } from '../../engine/query-loop.js'
import type { LLMProvider } from '../../providers/types.js'
import type { ToolContext } from '../../tools/types.js'
import { createWorkerManager, type WorkerRunsStore } from '../worker.js'
import { RESEARCH_EFFORT_BUDGETS, researchEffortInstruction } from '../research-effort.js'

vi.mock('../../engine/query-loop.js', () => ({
  queryLoop: vi.fn(async function* () {
    yield { type: 'tool_start', name: 'urlReader', input: {} }
    yield { type: 'text_delta', text: '<worker-findings>Source-backed result</worker-findings>' }
  }),
}))

const context = {
  sessionId: 'session-fictional', workspaceId: 'workspace-fictional',
  assistantId: 'assistant-fictional', userId: 'user-fictional',
  channelType: 'web', channelId: 'channel-fictional', appId: 'Use Brian',
  abortSignal: new AbortController().signal,
} as ToolContext

function manager() {
  return createWorkerManager({ provider: {} as LLMProvider, model: 'standard-model', tools: new Map() })
}

describe('[COMP:workers/research-effort] automatic worker bounds', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['focused', 'standard', 'deep'] as const)('applies %s limits and the stronger model to research workers', async (effort) => {
    const workers = manager()
    workers.setResearchMode(true, context.sessionId)
    workers.setResearchModel('research-model', context.sessionId)
    workers.setResearchEffort(effort, context.sessionId)
    workers.spawn('Find independent evidence', context)
    await workers.waitForNext(context.sessionId)
    const options = vi.mocked(queryLoop).mock.calls[0][0]
    expect(options).toMatchObject({ model: 'research-model', maxTurns: RESEARCH_EFFORT_BUDGETS[effort].workerTurns, maxToolCalls: RESEARCH_EFFORT_BUDGETS[effort].workerToolCalls })
    expect(workers.drainNotifications(context.sessionId)[0]).toMatchObject({ status: 'completed', ownerSessionId: context.sessionId })
    expect(researchEffortInstruction(effort)).toContain('Stop and synthesize as soon as evidence is sufficient')
  })

  it('does not carry research effort or the model into another session or a reset turn', async () => {
    const workers = manager()
    workers.setResearchMode(true, context.sessionId)
    workers.setResearchModel('research-model', context.sessionId)
    workers.setResearchEffort('focused', context.sessionId)
    const other = { ...context, sessionId: 'other-fictional' }
    workers.spawn('Lookup', other)
    await workers.waitForNext(other.sessionId)
    expect(vi.mocked(queryLoop).mock.calls[0][0]).toMatchObject({ model: 'standard-model', maxTurns: 10 })
    workers.resetForSession(context.sessionId)
    workers.spawn('Lookup', context)
    await workers.waitForNext(context.sessionId)
    expect(vi.mocked(queryLoop).mock.calls[1][0]).toMatchObject({ model: 'standard-model', maxTurns: 10 })
  })

  it('persists and restores effort on a new manager even when its current profile differs', async () => {
    const recordSpawn = vi.fn(async () => {})
    const store = {
      recordSpawn, recordTurn: vi.fn(async () => {}), recordCompletion: vi.fn(async () => {}),
      loadForSession: vi.fn(), deleteTerminalOlderThan: vi.fn(), listRecentForWorkspace: vi.fn(),
    } as unknown as WorkerRunsStore
    const workers = manager()
    workers.setPersistence({ store, sessionId: context.sessionId, workspaceId: context.workspaceId! })
    workers.setResearchMode(true, context.sessionId)
    workers.setResearchEffort('focused', context.sessionId)
    workers.spawn('Find evidence', context)
    await workers.waitForNext(context.sessionId)
    const saved = vi.mocked(store.recordSpawn).mock.calls[0][0]
    expect(saved.prompt).toBe('[brian-research-effort:focused]\nFind evidence')
    vi.mocked(store.loadForSession).mockResolvedValue([{ ...saved, status: 'running', turnCount: 0, history: [], result: null }])
    const resumed = manager()
    resumed.setResearchEffort('deep', context.sessionId)
    resumed.setPersistence({ store, sessionId: context.sessionId, workspaceId: context.workspaceId! })
    await resumed.rehydrate(context.sessionId, context)
    await resumed.waitForNext(context.sessionId)
    expect(vi.mocked(queryLoop).mock.calls.at(-1)![0]).toMatchObject({ maxTurns: 12, maxToolCalls: 16 })
  })
})
