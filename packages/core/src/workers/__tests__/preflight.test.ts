/**
 * Unit tests for the pre-flight parallel-research runner.
 * Component tag: [COMP:workers/preflight].
 *
 * Mocks the splitter (classifier) + the worker manager so the test exercises
 * runPreflight's wiring — not the worker LLM loop. Covers the workflow
 * research-step additions: the `forceResearch` single-worker fallback when the
 * splitter declines, and that `persistence` / `researchMode` / `maxConcurrent`
 * are wired onto the manager (and left untouched for the chat preflight path).
 * See docs/architecture/features/workflow.md → "assistant_call research fan-out".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../../tools/types.js'

const mockClassify = vi.fn()
vi.mock('../splitter.js', () => ({
  classifySplit: (...a: unknown[]) => mockClassify(...a),
}))

const mockCreate = vi.fn()
vi.mock('../worker.js', () => ({
  createWorkerManager: (...a: unknown[]) => mockCreate(...a),
}))

import { runPreflight } from '../preflight.js'

function makeManager() {
  return {
    setPersistence: vi.fn(),
    setResearchMode: vi.fn(),
    setMaxConcurrent: vi.fn(),
    setOnEvent: vi.fn(),
    spawn: vi.fn(),
    waitAll: vi.fn().mockResolvedValue(undefined),
    drainNotifications: vi.fn().mockReturnValue([{ workerId: 'w1' }]),
    formatNotification: vi.fn().mockReturnValue('FINDING'),
    getDescription: vi.fn().mockReturnValue('desc'),
  }
}

const ctx = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'Use Brian',
  channelType: 'assistant-call',
  channelId: 'c',
  workspaceId: 'ws',
  abortSignal: new AbortController().signal,
} as unknown as ToolContext

const base = { provider: {} as never, model: 'gemini-3-pro-research', message: 'research HK SME AI adoption', tools: new Map() }

beforeEach(() => vi.clearAllMocks())

describe('[COMP:workers/preflight] runPreflight', () => {
  it('passes through (no workers) when the splitter declines and forceResearch is off', async () => {
    mockClassify.mockResolvedValue({ tasks: null, usage: null, model: null })
    const mgr = makeManager()
    mockCreate.mockReturnValue(mgr)
    const res = await runPreflight({ ...base, context: ctx })
    expect(res.type).toBe('passthrough')
    expect(mgr.spawn).not.toHaveBeenCalled()
  })

  it('forceResearch runs one worker on the whole prompt when the splitter declines', async () => {
    mockClassify.mockResolvedValue({ tasks: null, usage: null, model: null })
    const mgr = makeManager()
    mockCreate.mockReturnValue(mgr)
    const res = await runPreflight({ ...base, context: ctx, forceResearch: true })
    expect(mgr.spawn).toHaveBeenCalledTimes(1)
    expect(mgr.spawn.mock.calls[0][0]).toBe('research HK SME AI adoption')
    expect(res.type).toBe('researched')
  })

  it('wires persistence + research mode + maxConcurrent onto the manager', async () => {
    mockClassify.mockResolvedValue({ tasks: ['q1', 'q2'], usage: null, model: null })
    const mgr = makeManager()
    mockCreate.mockReturnValue(mgr)
    const store = { recordSpawn: vi.fn() } as never
    await runPreflight({
      ...base,
      context: ctx,
      persistence: { store, sessionId: 's', workspaceId: 'ws' },
      researchMode: true,
      maxConcurrent: 5,
    })
    expect(mgr.setPersistence).toHaveBeenCalledWith({ store, sessionId: 's', workspaceId: 'ws' })
    expect(mgr.setResearchMode).toHaveBeenCalledWith(true)
    expect(mgr.setMaxConcurrent).toHaveBeenCalledWith(5)
    expect(mgr.spawn).toHaveBeenCalledTimes(2)
  })

  it('leaves persistence/research/maxConcurrent untouched when unset (chat preflight unchanged)', async () => {
    mockClassify.mockResolvedValue({ tasks: ['q1'], usage: null, model: null })
    const mgr = makeManager()
    mockCreate.mockReturnValue(mgr)
    await runPreflight({ ...base, context: ctx })
    expect(mgr.setPersistence).not.toHaveBeenCalled()
    expect(mgr.setResearchMode).not.toHaveBeenCalled()
    expect(mgr.setMaxConcurrent).not.toHaveBeenCalled()
  })
})
