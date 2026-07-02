/**
 * Unit tests for the cross-assistant (callee) executor.
 * Component tag: [COMP:api/inter-assistant-executor].
 *
 * Mocks the DB lookups + billing resolver and stubs `queryLoop` with a
 * controllable async generator (the pure core helpers — prompt /
 * memory-context / tool-filter builders — run for real). Verifies the
 * callee/owner not-found throws, the assistant_turn-based final-text
 * assembly (leak-suppressed / retried turns contribute nothing), the
 * empty-response fallback, error-event propagation, and that free mode
 * injects getMemory into the callee's tool set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQueryLoop = vi.fn()
const mockRunPreflight = vi.fn()

// Override queryLoop + runPreflight; everything else (buildPreflightPrompt,
// prompt/memory-context builders, MODEL_MAP) runs for real so the system-prompt
// injection + model resolution are exercised end to end.
vi.mock('@sidanclaw/core', async (io) => ({
  ...(await io<typeof import('@sidanclaw/core')>()),
  queryLoop: (...a: unknown[]) => mockQueryLoop(...a),
  runPreflight: (...a: unknown[]) => mockRunPreflight(...a),
}))
vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(),
  findUserById: vi.fn(),
}))
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  addSessionMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  getSessionMessages: vi.fn().mockResolvedValue([]),
  toStampedMessages: vi.fn((m: unknown) => m),
}))
vi.mock('../../billing-party.js', () => ({
  billingPartyForAssistant: vi.fn(),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getConnectorUserId: vi.fn().mockResolvedValue('owner-1'),
  // injectMcpTools gates the owner-personal base load on this; `true`
  // (solo workspace) preserves the pre-gate load behavior these tests expect.
  isSoloWorkspaceSystem: vi.fn().mockResolvedValue(true),
  // Read-ceiling resolver for the brain retrieval actor. Returned shape mirrors
  // the real `min(member, assistant)` ceiling; the callee threads it onto the
  // query-loop ToolContext.
  resolveReadCeilingsSystem: vi
    .fn()
    .mockResolvedValue({ clearance: 'confidential', compartments: null }),
}))
vi.mock('../../mcp/inject.js', () => ({
  injectMcpTools: vi.fn().mockResolvedValue({ enrichConfirmation: async (_t: string, i: unknown) => i, unavailable: [] }),
}))
vi.mock('../../routes/proactive-compaction.js', () => ({
  runProactiveCompaction: vi.fn().mockResolvedValue({ messages: [], compacted: false, episodes: [] }),
}))
// Doc-tool injector — mocked so we can assert it fires (or not) for a callee.
// The host extra-tool injector (injectExtraTools) is passed per-test as a vi.fn
// since it is a generic seam, not a module import. The real prompt builder (the
// doc soul) runs for real, so the system-prompt assertions exercise the wiring.
vi.mock('../../doc/inject.js', () => ({
  injectDocTools: vi.fn().mockResolvedValue(undefined),
}))

import { createCalleeExecutor } from '../executor.js'
import { findAssistantById, findUserById } from '../../db/users.js'
import { findOrCreateSession, addSessionMessage } from '../../db/sessions.js'
import { billingPartyForAssistant } from '../../billing-party.js'
import { runProactiveCompaction } from '../../routes/proactive-compaction.js'
import { injectDocTools } from '../../doc/inject.js'

const mockInjectDoc = vi.mocked(injectDocTools)

const mockFindAssistant = vi.mocked(findAssistantById)
const mockFindUser = vi.mocked(findUserById)
const mockSession = vi.mocked(findOrCreateSession)
const mockAddMessage = vi.mocked(addSessionMessage)
const mockBilling = vi.mocked(billingPartyForAssistant)
const mockRunProactiveCompaction = vi.mocked(runProactiveCompaction)

const calleeAssistant = {
  id: 'callee-1',
  ownerUserId: 'owner-1',
  workspaceId: null,
  clearance: 'internal',
  name: 'Callee Bot',
}
const callerAssistant = { id: 'caller-1', name: 'Caller Bot' }

function memoryStore() {
  return {
    getSoul: vi.fn().mockResolvedValue(null),
    getIdentity: vi.fn().mockResolvedValue([]),
    getIndex: vi.fn().mockResolvedValue([]),
    getWorkspaceIdentity: vi.fn().mockResolvedValue([]),
    getWorkspaceIndex: vi.fn().mockResolvedValue([]),
  }
}

function executor() {
  return createCalleeExecutor({
    provider: {} as never,
    tools: new Map(),
    memoryStore: memoryStore() as never,
    capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
  })
}

const baseParams = {
  callerAssistantId: 'caller-1',
  calleeAssistantId: 'callee-1',
  mode: null,
  question: 'what is the status?',
  callerSessionId: 'caller-sess-1',
}

/** queryLoop stub yielding the given events as an async generator. */
function yields(events: Array<Record<string, unknown>>) {
  mockQueryLoop.mockImplementationOnce(async function* () {
    for (const e of events) yield e
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindAssistant.mockImplementation(async (id: string) =>
    (id === 'callee-1' ? calleeAssistant : id === 'caller-1' ? callerAssistant : null) as never,
  )
  mockFindUser.mockResolvedValue({ id: 'owner-1', timezone: 'UTC' } as never)
  mockBilling.mockResolvedValue('owner-1')
  mockSession.mockResolvedValue({ id: 'sess-1' } as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/inter-assistant-executor] createCalleeExecutor', () => {
  it('throws when the callee assistant does not exist', async () => {
    mockFindAssistant.mockResolvedValueOnce(null as never)
    await expect(executor()(baseParams)).rejects.toThrow('Callee assistant not found')
  })

  it('throws when the callee owner cannot be resolved', async () => {
    mockFindUser.mockResolvedValueOnce(null as never)
    await expect(executor()(baseParams)).rejects.toThrow('Callee owner not found')
  })

  it('assembles the returned response from finalised assistant_turn content, not raw deltas', async () => {
    // The stream and the finalised turn agree here — but the return must come
    // from the turn content (post leak-sanitiser), not the delta sum. See
    // docs/architecture/channels/inter-assistant.md → "Final-text assembly".
    yields([
      { type: 'text_delta', text: 'The status ' },
      { type: 'text_delta', text: 'is green.' },
      {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'The status is green.' }] },
        toolResults: [],
      },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'The status is green.' }] } },
    ])
    expect(await executor()(baseParams)).toBe('The status is green.')
  })

  it('joins multi-turn text with newlines and skips text-less tool turns', async () => {
    yields([
      { type: 'text_delta', text: 'Checking the brain.' },
      {
        type: 'assistant_turn',
        response: {
          content: [
            { type: 'text', text: 'Checking the brain.' },
            { type: 'tool_use', id: 't1', name: 'recentEpisodes', input: {} },
          ],
        },
        toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: [] }],
      },
      { type: 'text_delta', text: 'All clear.' },
      {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'All clear.' }] },
        toolResults: [],
      },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'All clear.' }] } },
    ])
    expect(await executor()(baseParams)).toBe('Checking the brain.\nAll clear.')
  })

  it('does not return re-streamed text from leak-suppressed + retried turns (2026-07-02 triplication)', async () => {
    // Repro of run 26d50608: the model's mandated fallback sentence streamed
    // on THREE attempts (initial + 2 EMPTY_RETRY re-prompts), each suppressed
    // by the turn-boundary leak sanitiser — so each assistant_turn carries no
    // text blocks. Raw delta accumulation returned all three concatenated
    // ("…hours.No recorded…"); the turn-based assembly returns none of them.
    const SENTENCE = 'No recorded GitHub activity in the last 24 hours.'
    yields([
      { type: 'text_delta', text: SENTENCE },
      { type: 'assistant_turn', response: { content: [] }, toolResults: [] },
      { type: 'text_delta', text: SENTENCE },
      { type: 'assistant_turn', response: { content: [] }, toolResults: [] },
      { type: 'text_delta', text: SENTENCE },
      { type: 'assistant_turn', response: { content: [] }, toolResults: [] },
      { type: 'turn_complete', response: { content: [] } },
    ])
    expect(await executor()(baseParams)).toBe('The assistant did not produce a response.')
  })

  it('falls back to a placeholder when the callee produces no text', async () => {
    yields([{ type: 'turn_complete', response: { content: [] } }])
    expect(await executor()(baseParams)).toBe('The assistant did not produce a response.')
  })

  it('persists the assistant turn on turn_complete', async () => {
    yields([
      { type: 'text_delta', text: 'done' },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'done' }] } },
    ])
    await executor()(baseParams)
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', role: 'assistant' }),
    )
  })

  it('records the callee turn cost to usage_tracking on turn_complete (COGS metering)', async () => {
    // The assistant-call metering gap: before this fix, A2A / workflow callee
    // turns ran the model but wrote ZERO main usage rows — invisible COGS.
    // Assert the terminal turn_complete records ONE main row attributed to the
    // callee billing party, COGS-only (non-`main_response` trigger, no
    // userMessageId → not credit-bearing), with a real (non-zero) cost.
    yields([
      { type: 'text_delta', text: 'done' },
      {
        type: 'turn_complete',
        response: { content: [{ type: 'text', text: 'done' }], model: 'gemini-3-flash-preview' },
        totalUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 },
      },
    ])
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      usageStore: { recordUsage } as never,
    })

    await callee(baseParams)

    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      userId: 'owner-1',
      assistantId: 'callee-1',
      sessionId: 'sess-1',
      model: 'gemini-3-flash-preview',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      source: 'included',
      triggerKey: 'a2a_consult',
    })
    // COGS-only: a userMessageId would pull it into the credit derivation.
    expect(recordUsage.mock.calls[0][0].userMessageId).toBeUndefined()
    // Real cost computed from the pricing table, not a zero.
    expect(recordUsage.mock.calls[0][0].actualCostUsd).toBeGreaterThan(0)
  })

  it('tags a workflow-origin callee turn with the workflow trigger key', async () => {
    yields([
      {
        type: 'turn_complete',
        response: { content: [], model: 'gemini-3-flash-preview' },
        totalUsage: { inputTokens: 10, outputTokens: 5 },
      },
    ])
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      usageStore: { recordUsage } as never,
    })

    await callee({ ...baseParams, callerChannelType: 'workflow' })

    expect(recordUsage.mock.calls[0][0].triggerKey).toBe('workflow_assistant_call')
  })

  it('does not record usage when no usageStore is wired (no crash)', async () => {
    // The store is optional; absent it, metering silently no-ops.
    yields([
      {
        type: 'turn_complete',
        response: { content: [], model: 'gemini-3-flash-preview' },
        totalUsage: { inputTokens: 10, outputTokens: 5 },
      },
    ])
    await expect(executor()(baseParams)).resolves.toBeDefined()
  })

  it('propagates an error event from the query loop', async () => {
    yields([{ type: 'error', error: new Error('callee model failed') }])
    await expect(executor()(baseParams)).rejects.toThrow('callee model failed')
  })

  it('injects getMemory into the callee tool set for free mode', async () => {
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await executor()(baseParams)
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('getMemory')).toBe(true)
  })

  it('keeps free-mode memory READ-ONLY for an ordinary (non-workflow) consult', async () => {
    // A plain askAssistant free-mode consult can read memory but must NOT get
    // the write tool — memory write is scoped to workflow origin.
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await executor()(baseParams)
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('getMemory')).toBe(true)
    expect(passedTools.has('saveMemory')).toBe(false)
  })

  it('injects saveMemory for a workflow-origin free-mode consult ("load to memory/brain")', async () => {
    // A workflow `assistant_call` step (and a scheduled-job reminder) arrives
    // with callerChannelType === 'workflow'. Without saveMemory in the tool
    // set, a "save this finding to memory" step has no tool to call and
    // silently no-ops — the structural hole this closes.
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await executor()({ ...baseParams, callerChannelType: 'workflow' })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('getMemory')).toBe(true)
    expect(passedTools.has('saveMemory')).toBe(true)
  })

  it('a per-step tools allow-list still composes over the workflow memory-write default', async () => {
    // The allow-list runs after injection, so an explicit `tools` that omits
    // saveMemory strips it back out even for a workflow consult (author intent
    // wins); a list naming it keeps it.
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await executor()({ ...baseParams, callerChannelType: 'workflow', allowedTools: ['getMemory'] })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('getMemory')).toBe(true)
    expect(passedTools.has('saveMemory')).toBe(false)
  })

  // ── Brain retrieval tools on the callee path (workflow assistant_call) ──
  // Regression: a workflow step prompted to call `recentEpisodes` (read the
  // company brain) found no such tool because the callee executor never
  // injected the retrieval surface the interactive chat route injects per-turn.
  const workspaceCallee = { ...calleeAssistant, workspaceId: 'ws-1', compartments: null }
  const RETRIEVAL_TOOL_NAMES = [
    'recentEpisodes', 'search', 'getEntity', 'provenance', 'aggregate', 'getRowHistory',
  ]
  function calleeWithRetrieval() {
    return createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      retrievalStore: {} as never,
    })
  }

  it('injects the 6 brain retrieval tools for a free-mode workspace consult when a retrievalStore is wired', async () => {
    mockFindAssistant.mockImplementation(async (id: string) =>
      (id === 'callee-1' ? workspaceCallee : id === 'caller-1' ? callerAssistant : null) as never,
    )
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await calleeWithRetrieval()({ ...baseParams, callerChannelType: 'workflow' })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    for (const name of RETRIEVAL_TOOL_NAMES) {
      expect(passedTools.has(name)).toBe(true)
    }
  })

  it('scopes the query-loop actor to the workspace + read ceiling when retrieval tools are injected', async () => {
    mockFindAssistant.mockImplementation(async (id: string) =>
      (id === 'callee-1' ? workspaceCallee : id === 'caller-1' ? callerAssistant : null) as never,
    )
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await calleeWithRetrieval()({ ...baseParams, callerChannelType: 'workflow' })
    const ctx = mockQueryLoop.mock.calls[0][0].context as Record<string, unknown>
    // actorFromContext requires a workspace bind; the read ceiling drives the
    // clearance/compartment projection.
    expect(ctx.workspaceId).toBe('ws-1')
    expect(ctx.clearance).toBe('confidential')
    expect(ctx.compartments).toBe(null)
  })

  it('omits the retrieval tools when no retrievalStore is wired (open build / unconfigured)', async () => {
    mockFindAssistant.mockImplementation(async (id: string) =>
      (id === 'callee-1' ? workspaceCallee : id === 'caller-1' ? callerAssistant : null) as never,
    )
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await executor()({ ...baseParams, callerChannelType: 'workflow' })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('recentEpisodes')).toBe(false)
    // The context stays unscoped for retrieval (no clearance forced on).
    const ctx = mockQueryLoop.mock.calls[0][0].context as Record<string, unknown>
    expect(ctx.clearance).toBeUndefined()
  })

  it('omits the retrieval tools for a personal (no-workspace) callee even with a store wired', async () => {
    // Default calleeAssistant has workspaceId: null — the retrieval actor's
    // permission predicate would only error in actorFromContext, so the tools
    // must not be injected at all.
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await calleeWithRetrieval()({ ...baseParams, callerChannelType: 'workflow' })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('recentEpisodes')).toBe(false)
  })

  it('a per-step tools allow-list composes over the injected retrieval tools', async () => {
    // The allow-list runs after injection: a step that names only recentEpisodes
    // keeps it and strips the sibling reads (search/getEntity/...).
    mockFindAssistant.mockImplementation(async (id: string) =>
      (id === 'callee-1' ? workspaceCallee : id === 'caller-1' ? callerAssistant : null) as never,
    )
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await calleeWithRetrieval()({
      ...baseParams,
      callerChannelType: 'workflow',
      allowedTools: ['recentEpisodes'],
    })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('recentEpisodes')).toBe(true)
    expect(passedTools.has('search')).toBe(false)
    expect(passedTools.has('getEntity')).toBe(false)
  })

  it('strips the delegation tools from a callee — leaf invariant, depth=1', async () => {
    // A delegated callee must be a terminal node: it can answer with its own
    // tools but can NOT initiate a further consult. Seed the base surface with
    // the delegation rail + a control tool, then assert only the rail is gone.
    // This is the structural single-hop bound (the transport's chain gates are
    // not fed accumulated state). See executor.ts step 4c.
    yields([{ type: 'turn_complete', response: { content: [] } }])
    const stub = (name: string) => [name, { name }] as const
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map([
        stub('askAssistant'),
        stub('listConnectedAssistants'),
        stub('search'),
      ]) as never,
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    })

    await callee(baseParams)

    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('askAssistant')).toBe(false)
    expect(passedTools.has('listConnectedAssistants')).toBe(false)
    // Non-delegation tools survive the strip — it is selective, not a wipe.
    expect(passedTools.has('search')).toBe(true)
  })

  describe('app callees execute end-to-end', () => {
    function asDistributionCallee() {
      mockFindAssistant.mockImplementation(async (id: string) =>
        (id === 'callee-1'
          ? { ...calleeAssistant, kind: 'app', appType: 'distribution', workspaceId: 'ws-1' }
          : id === 'caller-1' ? callerAssistant : null) as never,
      )
    }

    it('calls injectExtraTools with the callee context for an app callee', async () => {
      asDistributionCallee()
      yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'posted' }] } }])
      const injectExtraTools = vi.fn().mockResolvedValue(undefined)
      const callee = createCalleeExecutor({
        provider: {} as never,
        tools: new Map(),
        memoryStore: memoryStore() as never,
        capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
        injectExtraTools,
      })

      await callee(baseParams)

      expect(injectExtraTools).toHaveBeenCalledTimes(1)
      expect(injectExtraTools.mock.calls[0][0].assistant).toMatchObject({
        id: 'callee-1', kind: 'app', appType: 'distribution',
      })
      // The callee has no user session, so the host hook gets no session.
      expect(injectExtraTools.mock.calls[0][0].session).toBeUndefined()
      expect(mockInjectDoc).not.toHaveBeenCalled()
    })

    it('skips extra-tool injection when no injector is provided (no crash)', async () => {
      asDistributionCallee()
      yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'ok' }] } }])

      // The default executor() carries no injectExtraTools — the turn still runs.
      await executor()(baseParams)
      expect(mockQueryLoop).toHaveBeenCalled()
    })

    it('leaves a standard callee untouched (no doc injector, generic prompt)', async () => {
      yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'hi' }] } }])
      await executor()(baseParams)
      expect(mockInjectDoc).not.toHaveBeenCalled()
      const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
      expect(systemPrompt).toMatch(/responding to a question from another assistant/i)
    })
  })

  describe('page-anchored consults (workflow assistant_call.page)', () => {
    const PAGE_ID = '00000000-0000-4000-8000-00000000aaaa'

    function asWorkspaceCallee() {
      mockFindAssistant.mockImplementation(async (id: string) =>
        (id === 'callee-1'
          ? { ...calleeAssistant, workspaceId: 'ws-1' }
          : id === 'caller-1' ? callerAssistant : null) as never,
      )
    }

    function savedViewStoreWith(view: Record<string, unknown> | null) {
      return {
        getById: vi.fn().mockResolvedValue(view),
        setAutoPruneAt: vi.fn().mockResolvedValue(true),
      } as never
    }

    function anchoredExecutor(savedViewStore: unknown, tools = new Map()) {
      return createCalleeExecutor({
        provider: {} as never,
        tools: tools as never,
        memoryStore: memoryStore() as never,
        capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
        savedViewStore: savedViewStore as never,
      })
    }

    it('gates, injects doc tools, and runs the loop doc-anchored (happy path)', async () => {
      asWorkspaceCallee()
      yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'edited' }] } }])
      const store = savedViewStoreWith({ id: PAGE_ID, workspaceId: 'ws-1', clearance: 'internal' })
      const callee = anchoredExecutor(store)

      await callee({ ...baseParams, pageAnchorId: PAGE_ID })

      // Gate read under the callee's acting user.
      expect((store as { getById: ReturnType<typeof vi.fn> }).getById).toHaveBeenCalledWith('owner-1', PAGE_ID)
      // Doc tools injected with the anchor, doc-surface semantics.
      expect(mockInjectDoc).toHaveBeenCalledTimes(1)
      expect(mockInjectDoc.mock.calls[0][0]).toMatchObject({
        docSurface: true,
        pageId: PAGE_ID,
        userId: 'owner-1',
      })
      // The loop runs doc-anchored: docViewId set, workspaceId present
      // (regardless of the memory-mode conditional).
      const ctx = mockQueryLoop.mock.calls[0][0].context as Record<string, unknown>
      expect(ctx.docViewId).toBe(PAGE_ID)
      expect(ctx.workspaceId).toBe('ws-1')
      // The system prompt carries the page-first steering + anchor note.
      const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
      expect(systemPrompt).toContain('## Anchored page')
      expect(systemPrompt).toContain(PAGE_ID)
    })

    it('throws page_anchor_not_found before any session or LLM spend', async () => {
      asWorkspaceCallee()
      const callee = anchoredExecutor(savedViewStoreWith(null))
      await expect(callee({ ...baseParams, pageAnchorId: PAGE_ID })).rejects.toMatchObject({
        reason: 'page_anchor_not_found',
      })
      expect(mockSession).not.toHaveBeenCalled()
      expect(mockQueryLoop).not.toHaveBeenCalled()
      expect(mockInjectDoc).not.toHaveBeenCalled()
    })

    it('throws page_anchor_forbidden on a cross-workspace anchor', async () => {
      asWorkspaceCallee()
      const callee = anchoredExecutor(
        savedViewStoreWith({ id: PAGE_ID, workspaceId: 'ws-OTHER', clearance: 'internal' }),
      )
      await expect(callee({ ...baseParams, pageAnchorId: PAGE_ID })).rejects.toMatchObject({
        reason: 'page_anchor_forbidden',
      })
      expect(mockQueryLoop).not.toHaveBeenCalled()
    })

    it('throws page_anchor_forbidden when the page clearance exceeds the assistant clearance', async () => {
      asWorkspaceCallee() // calleeAssistant.clearance = 'internal'
      const callee = anchoredExecutor(
        savedViewStoreWith({ id: PAGE_ID, workspaceId: 'ws-1', clearance: 'confidential' }),
      )
      await expect(callee({ ...baseParams, pageAnchorId: PAGE_ID })).rejects.toMatchObject({
        reason: 'page_anchor_forbidden',
      })
      expect(mockQueryLoop).not.toHaveBeenCalled()
    })

    it('throws page_anchor_unavailable when no savedViewStore is configured', async () => {
      asWorkspaceCallee()
      await expect(executor()({ ...baseParams, pageAnchorId: PAGE_ID })).rejects.toMatchObject({
        reason: 'page_anchor_unavailable',
      })
      expect(mockQueryLoop).not.toHaveBeenCalled()
    })

    it('bumps autoPruneAt on a draft anchor (touch-on-use) but not on a saved page', async () => {
      asWorkspaceCallee()
      yields([{ type: 'turn_complete', response: { content: [] } }])
      const draftStore = savedViewStoreWith({
        id: PAGE_ID, workspaceId: 'ws-1', clearance: 'internal', state: 'draft',
      })
      await anchoredExecutor(draftStore)({ ...baseParams, pageAnchorId: PAGE_ID })
      const bump = (draftStore as { setAutoPruneAt: ReturnType<typeof vi.fn> }).setAutoPruneAt
      expect(bump).toHaveBeenCalledWith('owner-1', PAGE_ID, expect.any(Date))
      // ~30 days out.
      const when = bump.mock.calls[0][2] as Date
      expect(when.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)

      yields([{ type: 'turn_complete', response: { content: [] } }])
      const savedStore = savedViewStoreWith({
        id: PAGE_ID, workspaceId: 'ws-1', clearance: 'internal', state: 'saved',
      })
      await anchoredExecutor(savedStore)({ ...baseParams, pageAnchorId: PAGE_ID })
      expect(
        (savedStore as { setAutoPruneAt: ReturnType<typeof vi.fn> }).setAutoPruneAt,
      ).not.toHaveBeenCalled()
    })

    it('a draft-bump failure never fails the consult', async () => {
      asWorkspaceCallee()
      yields([
        { type: 'text_delta', text: 'done' },
        { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'done' }] }, toolResults: [] },
        { type: 'turn_complete', response: { content: [] } },
      ])
      const store = {
        getById: vi.fn().mockResolvedValue({
          id: PAGE_ID, workspaceId: 'ws-1', clearance: 'internal', state: 'draft',
        }),
        setAutoPruneAt: vi.fn().mockRejectedValue(new Error('db down')),
      }
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const out = await anchoredExecutor(store as never)({ ...baseParams, pageAnchorId: PAGE_ID })
      expect(out).toBe('done')
    })

    it('applies the step allow-list AFTER doc injection (tools compose over doc tools)', async () => {
      asWorkspaceCallee()
      yields([{ type: 'turn_complete', response: { content: [] } }])
      // Make the doc injector actually add a tool to the live map, like the
      // real one does — proving injection precedes filterToolsByAllowList.
      mockInjectDoc.mockImplementationOnce(async (opts: { tools: Map<string, unknown> }) => {
        opts.tools.set('patchPage', { name: 'patchPage' })
        return { injected: true, injectedCount: 1 } as never
      })
      const base = new Map([['search', { name: 'search' }]])
      const callee = anchoredExecutor(
        savedViewStoreWith({ id: PAGE_ID, workspaceId: 'ws-1', clearance: 'internal' }),
        base,
      )

      await callee({ ...baseParams, pageAnchorId: PAGE_ID, allowedTools: ['patchPage'] })

      const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
      expect(passedTools.has('patchPage')).toBe(true) // injected, then allowed
      expect(passedTools.has('search')).toBe(false) // narrowed away by the allow-list
    })
  })

  it('threads the episode ingestor + workspace into persistent-session compaction', async () => {
    // A workspace-scoped callee so the workspace id resolves non-null.
    mockFindAssistant.mockImplementation(async (id: string) =>
      (id === 'callee-1'
        ? { ...calleeAssistant, workspaceId: 'ws-1' }
        : id === 'caller-1'
          ? callerAssistant
          : null) as never,
    )
    yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'ok' }] } }])
    const ingestor = vi.fn()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      chatEpisodeIngestor: ingestor as never,
    })
    // A `sessionKey` marks a durable (persistent) session — the path that
    // runs proactive compaction and so feeds the brain.
    await callee({ ...baseParams, sessionKey: 'workflow:wf-1:step-1' })
    expect(mockRunProactiveCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ chatEpisodeIngestor: ingestor, workspaceId: 'ws-1' }),
    )
  })
})

describe('[COMP:api/inter-assistant-executor] workflow research fan-out + memory continuity', () => {
  // A workspace-scoped callee — research fan-out + prior-run memory both
  // require a workspace. No pageAnchorId, so the page gate is skipped.
  const wsCallee = { id: 'callee-1', ownerUserId: 'owner-1', workspaceId: 'ws-1', clearance: 'internal', name: 'Callee Bot' }

  function wsMemoryStore(overrides: Record<string, unknown> = {}) {
    return {
      getSoul: vi.fn().mockResolvedValue(null),
      getIdentity: vi.fn().mockResolvedValue([]),
      getIndex: vi.fn().mockResolvedValue([]),
      getWorkspaceIdentity: vi.fn().mockResolvedValue([]),
      getWorkspaceIndex: vi.fn().mockResolvedValue([]),
      getWorkspaceMemoriesByCategory: vi.fn().mockResolvedValue([]),
      ...overrides,
    }
  }

  const workerRunsStore = { recordSpawn: vi.fn(), recordTurn: vi.fn(), recordCompletion: vi.fn(), loadForSession: vi.fn() }

  beforeEach(() => {
    mockFindAssistant.mockImplementation(async (id: string) =>
      (id === 'callee-1' ? wsCallee : id === 'caller-1' ? callerAssistant : null) as never,
    )
    yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'brief' }] } }])
  })

  it('runs research fan-out on the research tier and injects findings (deep, no page, workspace, store wired)', async () => {
    mockRunPreflight.mockResolvedValue({ type: 'researched', context: 'HK SME stat: 62% adoption', usage: null, model: null })
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
    })
    await callee({ ...baseParams, depth: { tier: 'deep' }, callerChannelType: 'workflow', workflowId: 'wf-1' })

    expect(mockRunPreflight).toHaveBeenCalledTimes(1)
    expect(mockRunPreflight.mock.calls[0][0]).toMatchObject({ model: 'gemini-3-pro-research', researchMode: true, forceResearch: true })
    const loopArg = mockQueryLoop.mock.calls[0][0] as { model: string; systemPrompt: string }
    expect(loopArg.model).toBe('gemini-3-pro-research')
    expect(loopArg.systemPrompt).toContain('HK SME stat: 62% adoption')
    expect(loopArg.systemPrompt).toContain('Pre-Researched Context')
  })

  it('skips research fan-out when no workerRunsStore is wired', async () => {
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      // no workerRunsStore
    })
    await callee({ ...baseParams, depth: { tier: 'deep' }, callerChannelType: 'workflow', workflowId: 'wf-1' })
    expect(mockRunPreflight).not.toHaveBeenCalled()
    expect((mockQueryLoop.mock.calls[0][0] as { systemPrompt: string }).systemPrompt).not.toContain('Pre-Researched Context')
  })

  it('skips research fan-out on a page-anchored step (authoring path preserved)', async () => {
    // pageAnchorId set → the executor takes the doc-authoring path, never fan-out.
    // The page gate needs a savedViewStore returning a same-workspace page.
    const savedViewStore = { getById: vi.fn().mockResolvedValue({ id: 'page-1', workspaceId: 'ws-1', clearance: 'internal', state: 'saved' }), setAutoPruneAt: vi.fn() }
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
      savedViewStore: savedViewStore as never,
    })
    await callee({ ...baseParams, depth: { tier: 'deep' }, pageAnchorId: 'page-1', callerChannelType: 'workflow', workflowId: 'wf-1' })
    expect(mockRunPreflight).not.toHaveBeenCalled()
  })

  it('injects prior-run workflow memories with a save-only-new instruction', async () => {
    const store = wsMemoryStore({
      getWorkspaceMemoriesByCategory: vi.fn().mockResolvedValue([
        { id: 'abcd1234-0000-0000-0000-000000000000', summary: 'HK TVP subsidy fact' },
      ]),
    })
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: store as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
    })
    // No depth → no fan-out; exercises the memory-continuity path in isolation.
    await callee({ ...baseParams, callerChannelType: 'workflow', workflowId: 'wf-1' })

    expect(store.getWorkspaceMemoriesByCategory).toHaveBeenCalledWith(expect.anything(), 'workflow:wf-1')
    const sp = (mockQueryLoop.mock.calls[0][0] as { systemPrompt: string }).systemPrompt
    expect(sp).toContain('Already recorded by this workflow')
    expect(sp).toContain('HK TVP subsidy fact')
    expect(sp).toContain('[id:abcd1234]')
  })

  it('does not fetch prior-run memories for an ordinary (non-workflow) consult', async () => {
    const store = wsMemoryStore()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: store as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
    })
    await callee(baseParams) // no workflowId
    expect(store.getWorkspaceMemoriesByCategory).not.toHaveBeenCalled()
  })

  // ── Structural-synthesis P4: the RESEARCH fill ──
  // A research-tier step carrying a blueprintId + a page anchor runs the fan-out
  // as the gather, then fills the blueprint into the anchored page via the
  // injected synthesizer INSTEAD of the free-form authoring loop.
  const anchoredSavedViewStore = () => ({
    getById: vi.fn().mockResolvedValue({ id: 'page-1', workspaceId: 'ws-1', clearance: 'internal', state: 'saved' }),
    setAutoPruneAt: vi.fn(),
  })
  const blueprintParams = {
    ...baseParams,
    depth: { tier: 'deep' as const },
    pageAnchorId: 'page-1',
    blueprintId: 'my-blueprint',
    callerChannelType: 'workflow' as const,
    workflowId: 'wf-1',
  }

  it('runs fan-out then synthesizes the blueprint into the anchored page (no authoring loop)', async () => {
    mockRunPreflight.mockResolvedValue({ type: 'researched', context: 'finding: 62% adoption (census.gov.hk)', usage: null, model: null })
    const researchSynthesize = vi.fn().mockResolvedValue({ pageId: 'page-1' })
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
      savedViewStore: anchoredSavedViewStore() as never,
      researchSynthesize: researchSynthesize as never,
    })

    const out = await callee(blueprintParams)

    // The fan-out gather ran (the page-anchored exception), then synthesis filled it.
    expect(mockRunPreflight).toHaveBeenCalledTimes(1)
    expect(researchSynthesize).toHaveBeenCalledTimes(1)
    expect(researchSynthesize.mock.calls[0][0]).toMatchObject({
      blueprintSlug: 'my-blueprint',
      findings: 'finding: 62% adoption (census.gov.hk)',
      pageId: 'page-1',
      workspaceId: 'ws-1',
      sourceRef: 'workflow:wf-1',
    })
    // The structured synthesis REPLACES the free-form authoring loop.
    expect(mockQueryLoop).not.toHaveBeenCalled()
    expect(out).toContain('Filled the blueprint into the anchored page')
  })

  it('falls back to the authoring loop when the synthesizer returns null (unresolved blueprint)', async () => {
    mockRunPreflight.mockResolvedValue({ type: 'researched', context: 'some findings', usage: null, model: null })
    yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'authored' }] } }])
    const researchSynthesize = vi.fn().mockResolvedValue(null) // blueprint unresolved
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
      savedViewStore: anchoredSavedViewStore() as never,
      researchSynthesize: researchSynthesize as never,
    })

    await callee(blueprintParams)

    expect(researchSynthesize).toHaveBeenCalledTimes(1)
    // Failure isolation: the step still authors via the normal loop.
    expect(mockQueryLoop).toHaveBeenCalledTimes(1)
  })

  it('falls back to the authoring loop when the synthesizer throws (failure isolation)', async () => {
    mockRunPreflight.mockResolvedValue({ type: 'researched', context: 'some findings', usage: null, model: null })
    yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'authored' }] } }])
    const researchSynthesize = vi.fn().mockRejectedValue(new Error('synthesis boom'))
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
      savedViewStore: anchoredSavedViewStore() as never,
      researchSynthesize: researchSynthesize as never,
    })

    // A synthesis throw must not fail the step.
    await expect(callee(blueprintParams)).resolves.toBeTruthy()
    expect(mockQueryLoop).toHaveBeenCalledTimes(1)
  })

  it('does NOT run fan-out or synthesis on a page-anchored step WITHOUT a blueprintId (authoring preserved)', async () => {
    const researchSynthesize = vi.fn()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
      savedViewStore: anchoredSavedViewStore() as never,
      researchSynthesize: researchSynthesize as never,
    })
    // pageAnchorId but no blueprintId → the existing authoring path, no fan-out.
    await callee({ ...blueprintParams, blueprintId: undefined })
    expect(mockRunPreflight).not.toHaveBeenCalled()
    expect(researchSynthesize).not.toHaveBeenCalled()
  })

  it('does NOT synthesize when the gather found nothing (no source → author normally)', async () => {
    mockRunPreflight.mockResolvedValue({ type: 'passthrough', usage: null, model: null })
    yields([{ type: 'turn_complete', response: { content: [{ type: 'text', text: 'authored' }] } }])
    const researchSynthesize = vi.fn().mockResolvedValue({ pageId: 'page-1' })
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      workerRunsStore: workerRunsStore as never,
      savedViewStore: anchoredSavedViewStore() as never,
      researchSynthesize: researchSynthesize as never,
    })
    await callee(blueprintParams)
    // Fan-out ran but yielded no findings → no synthesis, author via the loop.
    expect(mockRunPreflight).toHaveBeenCalledTimes(1)
    expect(researchSynthesize).not.toHaveBeenCalled()
    expect(mockQueryLoop).toHaveBeenCalledTimes(1)
  })
})
