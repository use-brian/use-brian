/**
 * Unit tests for the cross-assistant (callee) executor.
 * Component tag: [COMP:api/inter-assistant-executor].
 *
 * Mocks the DB lookups + billing resolver and stubs `queryLoop` with a
 * controllable async generator (the pure core helpers — prompt /
 * memory-context / tool-filter builders — run for real). Verifies the
 * callee/owner not-found throws, the assistant_turn-based final-text
 * assembly (leak-suppressed / retried turns contribute nothing), the
 * typed empty_response failure, the direct-execution framing block,
 * error-event propagation, and that free mode injects getMemory into
 * the callee's tool set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQueryLoop = vi.fn()
const mockRunPreflight = vi.fn()

// Override queryLoop + runPreflight; everything else (buildPreflightPrompt,
// prompt/memory-context builders, MODEL_MAP) runs for real so the system-prompt
// injection + model resolution are exercised end to end.
vi.mock('@use-brian/core', async (io) => ({
  ...(await io<typeof import('@use-brian/core')>()),
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
// Real (unmocked) core factories — the '@use-brian/core' mock above spreads the
// actual module, so everything but queryLoop/runPreflight resolves for real.
// Used by the goal-path browser-surface describes at the bottom of this file.
import {
  createComputerTools,
  createSkillRunnerTools,
  createBuFallbackTool,
  createLocalBrowserProvider,
  createCloudBrowserProvider,
  StubSandboxProvider,
  createSandboxOrchestrator,
  createInMemorySandboxTaskStore,
  createInMemoryBrowserProfileStore,
  createInMemorySessionVault,
  createInMemoryBrowserSkillStore,
  createInMemoryBrowserSkillGrantStore,
  createInMemoryBlockApprovals,
  extractEffectContract,
  RESULT_PATH,
} from '@use-brian/core'
import { findAssistantById, findUserById } from '../../db/users.js'
import { findOrCreateSession, addSessionMessage } from '../../db/sessions.js'
import { billingPartyForAssistant } from '../../billing-party.js'
import { runProactiveCompaction } from '../../routes/proactive-compaction.js'
import { injectDocTools } from '../../doc/inject.js'
import { injectMcpTools } from '../../mcp/inject.js'

const mockInjectDoc = vi.mocked(injectDocTools)
const mockInjectMcp = vi.mocked(injectMcpTools)

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

/**
 * Same, but with the two stores that gate MCP injection — without both,
 * `injectMcpTools` never runs, so anything derived from its result (the
 * unavailable-capabilities block) is silently absent.
 */
function executorWithMcp() {
  return createCalleeExecutor({
    provider: {} as never,
    tools: new Map(),
    memoryStore: memoryStore() as never,
    capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    connectorStore: {} as never,
    mcpSettingsStore: {} as never,
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

/**
 * Minimal healthy stream: one finalised text turn + terminal turn_complete.
 * The consult text is assembled from `assistant_turn` events, and an all-empty
 * consult now THROWS `empty_response` — so tests that only assert on wiring
 * (tool injection, actor scoping, analytics) still need a turn with text.
 */
function yieldsText(text = 'ok') {
  yields([
    { type: 'assistant_turn', response: { content: [{ type: 'text', text }] }, toolResults: [] },
    { type: 'turn_complete', response: { content: [{ type: 'text', text }] } },
  ])
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

  it('never enables KB writes on the A2A callee path (D2 chat-only)', async () => {
    yieldsText()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      connectorStore: {} as never,
      mcpSettingsStore: {} as never,
    })
    await callee(baseParams)
    expect(mockInjectMcp).toHaveBeenCalledOnce()
    expect(mockInjectMcp.mock.calls[0][0].allowKnowledgeWrites).toBe(false)
  })

  it('drops narration riding alongside a tool call, keeping only terminal-turn text', async () => {
    // A turn carrying a tool_use block is mid-reasoning: the loop feeds the
    // result back and the model speaks again. "Checking the brain." is
    // narration addressed to no one, not the consult's answer.
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
    expect(await executor()(baseParams)).toBe('All clear.')
  })

  it('joins text across multiple terminal turns with newlines', async () => {
    yields([
      {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'First finding.' }] },
        toolResults: [],
      },
      {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'Second finding.' }] },
        toolResults: [],
      },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'Second finding.' }] } },
    ])
    expect(await executor()(baseParams)).toBe('First finding.\nSecond finding.')
  })

  it('never delivers a mid-reasoning tool-hunting spiral (2026-07-20 chain-of-thought leak)', async () => {
    // Repro of session b8e567d6: the job's instructions hardcoded
    // `googleCalendarListEvents`, but its assistant held no connector grant for
    // it (Google Calendar was connected, just granted to no assistant), so the
    // tool was never on the surface. The model narrated its search for the
    // missing tool — including a verbatim dump of
    // its own tool list — in turns that each also carried a tool_use block, and
    // never reached a terminal turn. That narration became finalText and shipped
    // to the user's Telegram. sanitizeDeliveryText cannot catch this (it matches
    // known scaffolding phrasings; free-form reasoning has none), so the
    // executor must refuse to treat non-terminal text as deliverable: an
    // all-narration consult is a typed FAILURE, not a delivery.
    const SPIRAL =
      'Wait, I see "Available connectors: gmail, github, knowledge" in my search results, ' +
      'but `listConnectorInstances` only showed GitHub. There are NO `googleCalendarListEvents` ' +
      'in the direct tool list. Let me try to `listConnectors` to see what is configured.'
    yields([
      { type: 'text_delta', text: SPIRAL },
      {
        type: 'assistant_turn',
        response: {
          content: [
            { type: 'text', text: SPIRAL },
            { type: 'tool_use', id: 'call_127', name: 'listConnectors', input: {} },
          ],
        },
        toolResults: [{ type: 'tool_result', tool_use_id: 'call_127', content: [] }],
      },
      { type: 'turn_complete', response: { content: [] } },
    ])
    await expect(executor()(baseParams)).rejects.toMatchObject({ reason: 'empty_response' })
  })

  it('does not return re-streamed text from leak-suppressed + retried turns (2026-07-02 triplication)', async () => {
    // Repro of run 26d50608: the model's mandated fallback sentence streamed
    // on THREE attempts (initial + 2 EMPTY_RETRY re-prompts), each suppressed
    // by the turn-boundary leak sanitiser — so each assistant_turn carries no
    // text blocks. Raw delta accumulation returned all three concatenated
    // ("…hours.No recorded…"); the turn-based assembly keeps none of them,
    // and an all-empty consult is a typed FAILURE, never a placeholder.
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
    await expect(executor()(baseParams)).rejects.toMatchObject({ reason: 'empty_response' })
  })

  it('throws a typed empty_response error when the callee produces no text (2026-07-07 send-step incident)', async () => {
    // A placeholder here made a produced-nothing consult indistinguishable
    // from success: the workflow step recorded `completed` and downstream
    // steps + chat asserted work that never happened. The typed reason is
    // hoisted by the workflow run-loop into a failed step run.
    yields([{ type: 'turn_complete', response: { content: [] } }])
    await expect(executor()(baseParams)).rejects.toMatchObject({
      reason: 'empty_response',
      message: expect.stringContaining('produced no output'),
    })
  })

  it('injects the direct-execution framing for a confirmation-stripped consult', async () => {
    // Ordinary A2A strips tool confirmations; without this block the callee
    // read prompts describing an Approve/Deny UI and refused granted tools
    // ("manual confirmation not available in this automated context" — the
    // 2026-07-07 Gmail send refusal, zero tool_use).
    yields([
      {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'done' }] },
        toolResults: [],
      },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'done' }] } },
    ])
    await executor()(baseParams)
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('## Automated context — tools execute directly')
  })

  it('omits the direct-execution framing when confirmations are deferred (deliverTarget set)', async () => {
    // A scheduled-origin step keeps `ask` confirmations live (surfaced to the
    // delivery channel), so the "everything is pre-authorized" framing would
    // be a lie there.
    yields([
      {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'done' }] },
        toolResults: [],
      },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'done' }] } },
    ])
    await executor()({
      ...baseParams,
      deliverTarget: { channelType: 'telegram', channelId: 'tg-1' },
    })
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('## Automated context — tools execute directly')
  })

  it('tells the callee which capabilities are unavailable (2026-07-19/20 GM Bro incident)', async () => {
    // The two interactive paths (chat.ts, channel-pipeline.ts) have always
    // appended `buildUnavailableCapabilitiesPrompt`; the callee path discarded
    // injectMcpTools' `unavailable` list entirely. A scheduled job whose
    // instructions named `googleCalendarListEvents` — for a connector its
    // assistant held no grant for — therefore had no way to know the tool was
    // off its surface. It fabricated the result one day ("No events were found
    // on your Google Calendar", zero tool calls) and burned the whole run
    // hunting for the tool the next. The entry carries the user-actionable fix,
    // so the callee can report something the user can act on.
    const notice =
      'Google Calendar & Tasks (not connected or disabled for this assistant) — ' +
      'if the user asks to add/check tasks, calendar events, or reminders, reply: ' +
      '"I\'ll need Calendar access first. Type /connect gcal to authorize."'
    mockInjectMcp.mockResolvedValueOnce({
      enrichConfirmation: async (_t: string, i: unknown) => i,
      unavailable: [notice],
    } as never)
    yieldsText()
    // MCP injection only runs when both stores are wired — the bare `executor()`
    // helper omits them, so this path needs the store-ful construction.
    await executorWithMcp()(baseParams)
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('# Unavailable capabilities')
    expect(systemPrompt).toContain('Type /connect gcal to authorize')
    // The directive half matters as much as the list: without it the model
    // treats absence as "keep looking".
    expect(systemPrompt).toContain('Do not attempt to use them or search for them')
  })

  it('omits the unavailable-capabilities block when everything is reachable', async () => {
    // Same wiring, but the default mock returns `unavailable: []` — a callee
    // with every connector live must see no such section.
    yieldsText()
    await executorWithMcp()(baseParams)
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('# Unavailable capabilities')
  })

  it('emits a tool_executed analytics event for each tool a consult runs', async () => {
    // Callee tool observability: before this, callee turns wrote NOTHING to
    // analytics_events per tool call — a step that never called its tool was
    // indistinguishable from one that ran it (2026-07-07 send-step incident).
    yields([
      {
        type: 'tool_result',
        id: '',
        results: [
          { type: 'tool_result', toolUseId: 't1', name: 'gmailSendMessage', content: 'sent', isError: false },
        ],
      },
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'done' }] }, toolResults: [] },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'done' }] } },
    ])
    const logEvent = vi.fn()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      analytics: { logEvent } as never,
    })
    await callee(baseParams)
    const toolEvents = logEvent.mock.calls.map((c) => c[0]).filter((e) => e.eventName === 'tool_executed')
    expect(toolEvents).toHaveLength(1)
    expect(toolEvents[0]).toMatchObject({
      userId: 'owner-1',
      assistantId: 'callee-1',
      sessionId: 'sess-1',
      channelType: 'assistant-call',
      metadata: { tool_name: 'gmailSendMessage', success: true },
    })
  })

  it('attributes workflow-origin tool_executed events to the workflow channel', async () => {
    yields([
      {
        type: 'tool_result',
        id: '',
        results: [
          { type: 'tool_result', toolUseId: 't1', name: 'saveMemory', content: 'ok', isError: false },
        ],
      },
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'saved' }] }, toolResults: [] },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'saved' }] } },
    ])
    const logEvent = vi.fn()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      analytics: { logEvent } as never,
    })
    await callee({ ...baseParams, callerChannelType: 'workflow' })
    const toolEvents = logEvent.mock.calls.map((c) => c[0]).filter((e) => e.eventName === 'tool_executed')
    expect(toolEvents).toHaveLength(1)
    expect(toolEvents[0].channelType).toBe('workflow')
  })

  it('records a failed tool call with success=false and a single-line error excerpt', async () => {
    yields([
      {
        type: 'tool_result',
        id: '',
        results: [
          {
            type: 'tool_result',
            toolUseId: 't1',
            name: 'gmailSendMessage',
            content: `401 Unauthorized\n  at dispatch\n${'x'.repeat(300)}`,
            isError: true,
          },
        ],
      },
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'failed' }] }, toolResults: [] },
      { type: 'turn_complete', response: { content: [{ type: 'text', text: 'failed' }] } },
    ])
    const logEvent = vi.fn()
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      analytics: { logEvent } as never,
    })
    await callee(baseParams)
    const evt = logEvent.mock.calls.map((c) => c[0]).find((e) => e.eventName === 'tool_executed')
    expect(evt.metadata.success).toBe(false)
    const excerpt = evt.metadata.error_message as string
    expect(excerpt.startsWith('401 Unauthorized at dispatch')).toBe(true)
    expect(excerpt).not.toContain('\n')
    expect(excerpt.length).toBeLessThanOrEqual(200)
  })

  // ── Ask-policy tools on the workflow lane (2026-07-07 send-step incident) ──
  // A workflow-origin consult has no interactive approver: silently
  // auto-allowing ask-policy tools let a workflow fire user-approval-gated
  // side-effects with no approval anywhere. They are DROPPED from the surface
  // and the callee is told which and why; the approved path is a `tool_call`
  // step (pauses in the unified Approvals queue). Ordinary A2A keeps the
  // legacy strip.
  function executorWithTools(baseTools: Map<string, unknown>) {
    return createCalleeExecutor({
      provider: {} as never,
      tools: baseTools as never,
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    })
  }
  const askTool = () => ({
    name: 'gmailSendMessage',
    description: 'send an email',
    inputSchema: { parse: (v: unknown) => v },
    execute: vi.fn(),
    requiresConfirmation: true,
  })
  const plainTool = (name = 'searchThings') => ({
    name,
    description: 'a read tool',
    inputSchema: { parse: (v: unknown) => v },
    execute: vi.fn(),
    requiresConfirmation: false,
  })

  it('drops ask-policy tools from a workflow-origin consult and injects the drop note', async () => {
    yieldsText()
    const tools = new Map<string, unknown>([
      ['gmailSendMessage', askTool()],
      ['searchThings', plainTool()],
    ])
    await executorWithTools(tools)({ ...baseParams, callerChannelType: 'workflow' })
    const call = mockQueryLoop.mock.calls[0][0]
    const passedTools = call.tools as Map<string, unknown>
    expect(passedTools.has('gmailSendMessage')).toBe(false)
    expect(passedTools.has('searchThings')).toBe(true)
    const systemPrompt = call.systemPrompt as string
    expect(systemPrompt).toContain('## Approval-gated tools are NOT available in this step')
    expect(systemPrompt).toContain('gmailSendMessage')
    expect(systemPrompt).toContain('tool_call')
  })

  it('drops a dynamic resolveConfirmation=ask tool on the workflow lane (MCP-injected shape)', async () => {
    yieldsText()
    const dynamicAsk = {
      ...plainTool('notionCreatePage'),
      resolveConfirmation: vi.fn().mockResolvedValue(true),
    }
    await executorWithTools(new Map([['notionCreatePage', dynamicAsk]]))({
      ...baseParams,
      callerChannelType: 'workflow',
    })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('notionCreatePage')).toBe(false)
  })

  it('keeps the legacy strip on ordinary A2A: ask tools stay callable, no drop note', async () => {
    yieldsText()
    const tool = askTool()
    await executorWithTools(new Map([['gmailSendMessage', tool]]))(baseParams)
    const call = mockQueryLoop.mock.calls[0][0]
    const passedTools = call.tools as Map<string, { requiresConfirmation?: boolean }>
    expect(passedTools.has('gmailSendMessage')).toBe(true)
    expect(passedTools.get('gmailSendMessage')?.requiresConfirmation).toBe(false)
    expect(call.systemPrompt as string).not.toContain(
      '## Approval-gated tools are NOT available in this step',
    )
  })

  it('the confirmation strip NEVER mutates the shared tool singletons (chat gates survive consults)', async () => {
    // `options.tools` is boot's shared allTools map — the same Tool objects the
    // interactive chat surface dispatches. The strip must clone per consult:
    // an in-place `tool.resolveConfirmation = undefined` would permanently
    // disarm chat's confirmation gates (browserClick's send gate, every
    // policy-'ask' resolver) after the first A2A/workflow consult.
    yieldsText()
    const sharedAsk = askTool() // requiresConfirmation: true
    const resolver = vi.fn().mockResolvedValue(false) // dynamic allow → KEPT on the workflow lane
    const sharedDynamic = { ...plainTool('browserNavigateish'), resolveConfirmation: resolver }
    await executorWithTools(
      new Map<string, unknown>([
        ['gmailSendMessage', sharedAsk],
        ['browserNavigateish', sharedDynamic],
      ]),
    )(baseParams) // ordinary A2A lane: strips every kept tool's flags
    const passed = mockQueryLoop.mock.calls[0][0].tools as Map<
      string,
      { requiresConfirmation?: boolean; resolveConfirmation?: unknown }
    >
    // The consult's own surface is stripped…
    expect(passed.get('gmailSendMessage')?.requiresConfirmation).toBe(false)
    expect(passed.get('browserNavigateish')?.resolveConfirmation).toBeUndefined()
    // …but the shared singletons are untouched.
    expect(sharedAsk.requiresConfirmation).toBe(true)
    expect(sharedDynamic.resolveConfirmation).toBe(resolver)

    // Workflow lane: the kept-allow tool is stripped on a clone too.
    mockQueryLoop.mockClear()
    yieldsText()
    await executorWithTools(new Map<string, unknown>([['browserNavigateish', sharedDynamic]]))({
      ...baseParams,
      callerChannelType: 'workflow',
    })
    const wfPassed = mockQueryLoop.mock.calls[0][0].tools as Map<string, { resolveConfirmation?: unknown }>
    expect(wfPassed.get('browserNavigateish')?.resolveConfirmation).toBeUndefined()
    expect(sharedDynamic.resolveConfirmation).toBe(resolver)
  })

  // ── Record-creation restraint (Pattern 2 of the duplicate-task incident) ──
  // A recurring summary/overview workflow step kept opening a task that merely
  // restated its own instruction each fire, accumulating near-identical tasks.
  // The workflow-lane system prompt now steers the callee off that behavior.
  it('injects the record-creation restraint block on the workflow lane', async () => {
    yieldsText()
    await executorWithTools(new Map())({ ...baseParams, callerChannelType: 'workflow' })
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain("## Produce this step's output, do not restate it as a record")
    expect(systemPrompt).toContain('near-duplicate every fire')
  })

  it('omits the record-creation restraint block on ordinary A2A consults', async () => {
    yieldsText()
    await executorWithTools(new Map())(baseParams)
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain("## Produce this step's output, do not restate it as a record")
  })

  // ── Anti-fabrication guard, identifier-provenance widening ──
  // A research-shaped workflow step that exhausted its tool budget mid-gather
  // used to fill the prompt's required contact fields (emails, IG handles,
  // LinkedIn URLs, addresses) from parametric memory; the next step then
  // persisted the guesses as CRM records (fls.com.hk HKTVmall prospect runs,
  // 2026-07-13). The guard now binds specific identifiers to THIS run's tool
  // results, not just the tool-failure case.
  it('injects the identifier-provenance fabrication guard on the workflow lane', async () => {
    yieldsText()
    await executorWithTools(new Map())({ ...baseParams, callerChannelType: 'workflow' })
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('## Automated run — do not fabricate')
    expect(systemPrompt).toContain('unless it appears in a tool result from THIS run')
    expect(systemPrompt).toContain('write "not verified" for that field')
  })

  it('omits the fabrication guard on ordinary A2A consults', async () => {
    yieldsText()
    await executorWithTools(new Map())(baseParams)
    const systemPrompt = mockQueryLoop.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('## Automated run — do not fabricate')
  })

  // ── Mechanical half of the fabrication guard: the evidence gate ──
  // The prompt guard alone could not make "never persist an invented
  // identifier" a guarantee (the HKTVmall runs shipped fabricated contacts
  // THROUGH the widened prompt). The workflow lane now threads an
  // EvidenceAccumulator on ToolContext: the tool executor feeds every
  // successful tool result and hard-rejects a gated record write whose
  // email / URL / handle / phone was observed nowhere this run.
  it('threads a seeded, gated EvidenceAccumulator on the workflow lane', async () => {
    yieldsText()
    await executorWithTools(new Map())({
      ...baseParams,
      callerChannelType: 'workflow',
      question: 'Follow up with ops@fls.com.hk about the pilot.',
    })
    const call = mockQueryLoop.mock.calls[0][0]
    const evidence = call.context.evidence
    expect(evidence).toBeDefined()
    // Gated set derives from the brain-write registry + the extras.
    expect(evidence.shouldGate('saveContact')).toBe(true)
    expect(evidence.shouldGate('saveCompany')).toBe(true)
    expect(evidence.shouldGate('saveBlueprintRecord')).toBe(true)
    expect(evidence.shouldGate('saveMemory')).toBe(true)
    expect(evidence.shouldGate('gmailSendMessage')).toBe(true)
    expect(evidence.shouldGate('saveFileBytes')).toBe(false)
    expect(evidence.shouldGate('webSearch')).toBe(false)
    // Caller-provided identifiers are seeded as legitimate provenance…
    expect(evidence.findUnverified('{"email":"ops@fls.com.hk"}')).toEqual([])
    // …while an unobserved one is flagged.
    expect(evidence.findUnverified('{"email":"vicky.chen@slowood.hk"}')).toHaveLength(1)
    // And the prompt guard names the mechanical rejection so the model
    // reacts to it correctly instead of retrying the same value.
    expect(call.systemPrompt as string).toContain('identifier_not_in_evidence')
  })

  it('threads no EvidenceAccumulator on ordinary A2A consults', async () => {
    yieldsText()
    await executorWithTools(new Map())(baseParams)
    expect(mockQueryLoop.mock.calls[0][0].context.evidence).toBeUndefined()
  })

  it('fails fast with tools_unavailable when the pinned allow-list survives as nothing (run 0477b50d)', async () => {
    // The incident's second run: `tools: ["gmailSendMessage"]` on an
    // assistant_call step → ask-drop left a zero-tool surface → the model
    // collapsed into empty responses and the step recorded `completed`. Now
    // the consult refuses to run at all, naming the pin and the fix.
    const tools = new Map<string, unknown>([['gmailSendMessage', askTool()]])
    await expect(
      executorWithTools(tools)({
        ...baseParams,
        callerChannelType: 'workflow',
        allowedTools: ['gmailSendMessage'],
      }),
    ).rejects.toMatchObject({
      reason: 'tools_unavailable',
      message: expect.stringContaining('gmailSendMessage'),
    })
    expect(mockQueryLoop).not.toHaveBeenCalled()
  })

  // ── The pinned built-in must survive injection ──
  // `injectMcpTools` folds every built-in connector tool behind
  // `mcp_search`/`mcp_call` unless `keepBuiltinsDirect` is set — it DELETES
  // `githubListPullRequests` from the map. A step pinning that name then
  // filtered to nothing (`tools_unavailable`), and a step that also pinned a
  // first-party tool was worse: it ran with silently zero GitHub access.
  // Injection only runs when the connector stores are wired, so these build
  // the callee the way the KB-writes test above does.
  function injectingExecutor(baseTools: Map<string, unknown>) {
    return createCalleeExecutor({
      provider: {} as never,
      tools: baseTools as never,
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      connectorStore: {} as never,
      mcpSettingsStore: {} as never,
    })
  }

  it('keeps built-ins direct when the caller pins an allow-list', async () => {
    yieldsText()
    const tools = new Map<string, unknown>([
      ['githubListPullRequests', plainTool('githubListPullRequests')],
      ['listTasks', plainTool('listTasks')],
    ])
    await injectingExecutor(tools)({
      ...baseParams,
      callerChannelType: 'workflow',
      allowedTools: ['githubListPullRequests', 'listTasks'],
    })
    expect(mockInjectMcp.mock.calls[0][0].keepBuiltinsDirect).toBe(true)
    // …and the pinned built-in actually survives to the loop.
    const passed = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passed.has('githubListPullRequests')).toBe(true)
  })

  it('leaves built-ins behind mcp_search on an unpinned consult (token win preserved)', async () => {
    yieldsText()
    await injectingExecutor(new Map([['searchThings', plainTool()]]))(baseParams)
    expect(mockInjectMcp.mock.calls[0][0].keepBuiltinsDirect).toBe(false)
  })

  it('persists the assistant turn on turn_complete', async () => {
    yields([
      { type: 'text_delta', text: 'done' },
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'done' }] }, toolResults: [] },
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
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'done' }] }, toolResults: [] },
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
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'ok' }] }, toolResults: [] },
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
      { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'ok' }] }, toolResults: [] },
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
    yieldsText()
    await executor()(baseParams)
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('getMemory')).toBe(true)
  })

  it('keeps free-mode memory READ-ONLY for an ordinary (non-workflow) consult', async () => {
    // A plain askAssistant free-mode consult can read memory but must NOT get
    // the write tool — memory write is scoped to workflow origin.
    yieldsText()
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
    yieldsText()
    await executor()({ ...baseParams, callerChannelType: 'workflow' })
    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('getMemory')).toBe(true)
    expect(passedTools.has('saveMemory')).toBe(true)
  })

  it('a per-step tools allow-list still composes over the workflow memory-write default', async () => {
    // The allow-list runs after injection, so an explicit `tools` that omits
    // saveMemory strips it back out even for a workflow consult (author intent
    // wins); a list naming it keeps it.
    yieldsText()
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
    yieldsText()
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
    yieldsText()
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
    yieldsText()
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
    yieldsText()
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
    yieldsText()
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
    yieldsText()
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

  it('strips the background-worker rail from a callee — no drain on this path', async () => {
    // A callee cannot defer to background work it can't await: the callee query
    // loop never sets ToolContext.workerManager, so Phase 4b never drains an
    // in-loop spawnWorker and the model's "please hold" turn would leak out as
    // the step output (the workflow-wait-worker incident). The sanctioned
    // parallel-research path is the executor-managed runPreflight fan-out, which
    // does not use these tools. See executor.ts step 4c-bis.
    yieldsText()
    const stub = (name: string) => [name, { name }] as const
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map([
        stub('spawnWorker'),
        stub('sendWorkerMessage'),
        stub('stopWorker'),
        stub('search'),
      ]) as never,
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    })

    await callee(baseParams)

    const passedTools = mockQueryLoop.mock.calls[0][0].tools as Map<string, unknown>
    expect(passedTools.has('spawnWorker')).toBe(false)
    expect(passedTools.has('sendWorkerMessage')).toBe(false)
    expect(passedTools.has('stopWorker')).toBe(false)
    // The strip is selective — a callee's own in-loop tools survive.
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
      yieldsText('posted')
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
      yieldsText('ok')

      // The default executor() carries no injectExtraTools — the turn still runs.
      await executor()(baseParams)
      expect(mockQueryLoop).toHaveBeenCalled()
    })

    it('leaves a standard callee untouched (no doc injector, generic prompt)', async () => {
      yieldsText('hi')
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
      yieldsText('edited')
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
      yieldsText()
      const draftStore = savedViewStoreWith({
        id: PAGE_ID, workspaceId: 'ws-1', clearance: 'internal', state: 'draft',
      })
      await anchoredExecutor(draftStore)({ ...baseParams, pageAnchorId: PAGE_ID })
      const bump = (draftStore as { setAutoPruneAt: ReturnType<typeof vi.fn> }).setAutoPruneAt
      expect(bump).toHaveBeenCalledWith('owner-1', PAGE_ID, expect.any(Date))
      // ~30 days out.
      const when = bump.mock.calls[0][2] as Date
      expect(when.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)

      yieldsText()
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
      yieldsText()
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
    yieldsText('ok')
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
    yieldsText('brief')
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
    yieldsText('authored')
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
    yieldsText('authored')
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
    yieldsText('authored')
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

  // ── Output-contract binding (blueprint-output-contract plan §7) ──
  // A step carrying a blueprintId whose record was NOT produced by the
  // research-synthesis arm directs the callee to persist its deliverable as
  // the blueprint's typed record, and the run id threads onto ToolContext so
  // the save stamps `source_id=<runId>` ({{lastRun.output.*}} provenance).
  const recordToolStub = { name: 'saveBlueprintRecord', description: 'stub', execute: vi.fn() }

  it('directs a blueprint-bound (non-research) step to save the typed record + threads the run id', async () => {
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      blueprintRecordTools: [recordToolStub as never],
    })
    // This scripted model authors prose and never saves — the bound-record
    // enforcement below correctly fails the consult typed. The directive +
    // run-id threading assertions read the captured loop call either way.
    await expect(
      callee({
        ...baseParams,
        blueprintId: 'bp-9',
        callerChannelType: 'workflow',
        workflowId: 'wf-1',
        workflowRunId: 'run-77',
      }),
    ).rejects.toMatchObject({ reason: 'blueprint_record_missing' })
    const loopArg = mockQueryLoop.mock.calls[0][0] as {
      systemPrompt: string
      tools: Map<string, unknown>
      context: { workflowRunId?: string | null }
    }
    expect(loopArg.tools.has('saveBlueprintRecord')).toBe(true)
    expect(loopArg.systemPrompt).toContain('## Output contract')
    expect(loopArg.systemPrompt).toContain('bp-9')
    expect(loopArg.context.workflowRunId).toBe('run-77')
  })

  it('adds no output-contract directive when the record tools are absent', async () => {
    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    })
    await callee({ ...baseParams, blueprintId: 'bp-9', callerChannelType: 'workflow', workflowId: 'wf-1' })
    const loopArg = mockQueryLoop.mock.calls[0][0] as { systemPrompt: string; context: { workflowRunId?: string | null } }
    expect(loopArg.systemPrompt).not.toContain('## Output contract')
    expect(loopArg.context.workflowRunId).toBeNull()
  })

  // ── Bound-record enforcement (the silent-lie guard) ──
  // A bound consult that was GIVEN the save tool but finished without one
  // successful record write fails typed (`blueprint_record_missing`) instead
  // of recording a `completed` step with nothing persisted — reply prose is
  // not the deliverable. Sibling of the `empty_response` guard.

  const enforcementTools = (
    over: Partial<{ save: () => Promise<unknown>; fill: () => Promise<unknown> }> = {},
  ) => [
    {
      name: 'saveBlueprintRecord',
      description: 'stub',
      execute: over.save ?? vi.fn().mockResolvedValue({ data: { saved: true } }),
    },
    {
      name: 'fillBlueprintFromBrain',
      description: 'stub',
      execute: over.fill ?? vi.fn().mockResolvedValue({ data: { recordId: null, pageId: null } }),
    },
  ]

  function boundCallee(tools: ReturnType<typeof enforcementTools>) {
    return createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      blueprintRecordTools: tools as never,
    })
  }
  const boundParams = {
    ...baseParams,
    blueprintId: 'bp-9',
    callerChannelType: 'workflow' as const,
    workflowId: 'wf-1',
    workflowRunId: 'run-77',
  }

  it('fails a bound consult typed when the model never saves the record', async () => {
    mockQueryLoop.mockReset()
    yieldsText('I researched it thoroughly. Here is the summary in prose.')
    await expect(boundCallee(enforcementTools())(boundParams)).rejects.toMatchObject({
      reason: 'blueprint_record_missing',
    })
  })

  it('a FAILED save does not satisfy the binding', async () => {
    const failingSave = vi.fn().mockResolvedValue({ data: { error: 'bad key' }, isError: true })
    mockQueryLoop.mockReset()
    mockQueryLoop.mockImplementationOnce(async function* (opts: {
      tools: Map<string, { execute: (i: unknown, c: unknown) => Promise<unknown> }>
      context: Record<string, unknown>
    }) {
      await opts.tools.get('saveBlueprintRecord')!.execute({ blueprint: 'bp-9' }, opts.context)
      yield { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'tried' }] }, toolResults: [] }
      yield { type: 'turn_complete', response: { content: [{ type: 'text', text: 'tried' }] } }
    })
    await expect(boundCallee(enforcementTools({ save: failingSave }))(boundParams)).rejects.toMatchObject({
      reason: 'blueprint_record_missing',
    })
    expect(failingSave).toHaveBeenCalledTimes(1)
  })

  it('a successful fill (recordId returned) satisfies the binding', async () => {
    const fill = vi.fn().mockResolvedValue({ data: { recordId: 'rec-9', pageId: null } })
    mockQueryLoop.mockReset()
    mockQueryLoop.mockImplementationOnce(async function* (opts: {
      tools: Map<string, { execute: (i: unknown, c: unknown) => Promise<unknown> }>
      context: Record<string, unknown>
    }) {
      await opts.tools.get('fillBlueprintFromBrain')!.execute({ blueprint: 'bp-9', subject: 'Acme' }, opts.context)
      yield { type: 'assistant_turn', response: { content: [{ type: 'text', text: 'Filled.' }] }, toolResults: [] }
      yield { type: 'turn_complete', response: { content: [{ type: 'text', text: 'Filled.' }] } }
    })
    await expect(boundCallee(enforcementTools({ fill }))(boundParams)).resolves.toBe('Filled.')
  })

  it('no enforcement without the binding, and none when the tool was never available', async () => {
    // Unbound consult with the tools present: prose completes normally.
    // (Reset first: this section's beforeEach queues its own one-shot loop.)
    mockQueryLoop.mockReset()
    yieldsText('just prose')
    await expect(
      boundCallee(enforcementTools())({ ...baseParams, callerChannelType: 'workflow', workflowId: 'wf-1' }),
    ).resolves.toBe('just prose')

    // Bound consult whose allow-list stripped the save tool: the directive
    // never fired, so enforcement must not demand the impossible.
    yieldsText('prose only')
    await expect(
      boundCallee(enforcementTools())({ ...boundParams, allowedTools: ['getMemory'] }),
    ).resolves.toBe('prose only')
  })

  // ── End-to-end proof: the skill+blueprint+workflow premise ──
  // Drives the REAL record tools through the executor: a workflow-origin
  // consult bound to a blueprint, whose "model" executes the injected
  // saveBlueprintRecord with the loop's own ToolContext — asserting the
  // record lands validated, merged (not reset), and stamped with the RUN id
  // (the {{lastRun.output.*}} provenance). This is the executable version of
  // the audit chain: dispatch → injection → directive → tool → store.
  it('workflow-bound step saves a validated, run-stamped record through the real tool', async () => {
    const { createBlueprintRecordTools, blueprintSubjectAnchorKey } = await import(
      '../../synthesis/blueprint-record-tools.js'
    )
    const spec = {
      fields: [
        { key: 'summary', heading: 'Summary', instruction: 's', type: 'markdown', required: true },
        { key: 'budget', heading: 'Budget', instruction: 'b', type: 'number', required: false },
      ],
      capture: [],
    }
    const pageTemplateStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'bp-9', workspaceId: 'ws-1', name: 'Research Brief', description: null, extraction: spec },
      ]),
      getById: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    }
    const ensured = { id: 'rec-1', fields: {} }
    const blueprintRecordStore = {
      ensure: vi.fn().mockResolvedValue(ensured),
      mergeFields: vi.fn().mockResolvedValue(true),
      finalize: vi.fn().mockResolvedValue(null),
      getById: vi.fn(),
      getByAnchor: vi.fn(),
      getLatestForSource: vi.fn(),
      getLatestBySubject: vi.fn(),
      listForBlueprint: vi.fn(),
    }
    const realTools = createBlueprintRecordTools({
      pageTemplateStore: pageTemplateStore as never,
      blueprintRecordStore: blueprintRecordStore as never,
    })

    // The scripted "model": obey the Output-contract directive — call the
    // injected tool with the loop context, exactly as the real loop would.
    // (Reset first: this section's beforeEach queues its own one-shot loop.)
    mockQueryLoop.mockReset()
    mockQueryLoop.mockImplementationOnce(async function* (opts: {
      tools: Map<string, { execute: (i: unknown, c: unknown) => Promise<{ isError?: boolean }> }>
      context: Record<string, unknown>
      systemPrompt: string
    }) {
      expect(opts.systemPrompt).toContain('## Output contract')
      const save = opts.tools.get('saveBlueprintRecord')
      expect(save).toBeDefined()
      const result = await save!.execute(
        { blueprint: 'bp-9', subject: 'Acme Q3', fields: { summary: 'Findings…', budget: '120' } },
        opts.context,
      )
      expect(result.isError).toBeFalsy()
      yield {
        type: 'assistant_turn',
        response: { content: [{ type: 'text', text: 'Saved the brief.' }] },
        toolResults: [],
      }
      yield { type: 'turn_complete', response: { content: [{ type: 'text', text: 'Saved the brief.' }] } }
    })

    const callee = createCalleeExecutor({
      provider: {} as never,
      tools: new Map(),
      memoryStore: wsMemoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
      blueprintRecordTools: realTools,
    })
    const out = await callee({
      ...baseParams,
      blueprintId: 'bp-9',
      callerChannelType: 'workflow',
      workflowId: 'wf-1',
      workflowRunId: 'run-77',
    })
    expect(out).toBe('Saved the brief.')

    // The record write: workflow provenance stamped with the RUN id, the
    // shared subject anchor, merge semantics (never a fresh-fill reset).
    expect(blueprintRecordStore.ensure).toHaveBeenCalledTimes(1)
    expect(blueprintRecordStore.ensure.mock.calls[0][1]).toMatchObject({
      blueprintId: 'bp-9',
      subject: 'Acme Q3',
      anchorKey: blueprintSubjectAnchorKey('ws-1', 'bp-9', 'Acme Q3'),
      sourceKind: 'workflow',
      sourceId: 'run-77',
      resetFields: false,
    })
    // Typed validation ran: the numeric string coerced to a number.
    expect(blueprintRecordStore.mergeFields).toHaveBeenCalledWith(expect.any(String), 'rec-1', {
      summary: 'Findings…',
      budget: 120,
    })
    // Completeness stamped from required coverage.
    expect(blueprintRecordStore.finalize.mock.calls[0][2]).toMatchObject({ status: 'complete', missing: [] })
  })
})

// ── Browser tools on the goal path (task+goal → workflow-origin consult) ──
// A task's goal works through the workflow executor: the goal driver runs a
// one-step assistant_call each iteration (callerChannelType 'workflow'), and
// THAT consult's tool surface is what a "spin up the browser for this task"
// goal actually holds. Two contracts, per computer-use.md → "Working a task's
// goal": (1) the one-call-in-VM tools (runBrowserSkill / browserExplore) and
// the flat READ tools survive the ask-drop, while browserClick — the
// click-altitude primitive — drops fail-closed (its send gate cannot resolve
// a label with no live session), so autonomous acting happens through the
// governed runner, never a model-driven click loop; (2) with Barrier 2 + the
// paid gate satisfied, a goal-shaped context executes a read-only skill end
// to end, and with the flag off it refuses honestly.
describe('[COMP:sandbox/browser-tools] browser surface on the goal path (workflow-origin consult)', () => {
  function browserExecutor(baseTools: Map<string, unknown>) {
    return createCalleeExecutor({
      provider: {} as never,
      tools: baseTools as never,
      memoryStore: memoryStore() as never,
      capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    })
  }

  async function realBrowserTools(opts: { unattended: boolean }) {
    const provider = new StubSandboxProvider()
    const profileStore = createInMemoryBrowserProfileStore()
    const skillStore = createInMemoryBrowserSkillStore()
    const orchestrator = createSandboxOrchestrator({
      provider,
      taskStore: createInMemorySandboxTaskStore(),
      vault: createInMemorySessionVault(),
      profileStore,
    })
    const profiles = {
      store: profileStore,
      vault: null,
      assistantClearance: async () => 'confidential' as const,
    }
    const unattendedEnabled = () => opts.unattended
    const getWorkspacePlan = async () => 'pro'
    const computer = createComputerTools({
      local: createLocalBrowserProvider({ transport: null }),
      cloud: createCloudBrowserProvider({ provider, binding: orchestrator.binding }),
      cloudAvailable: () => true,
      profiles,
      unattendedEnabled,
      getWorkspacePlan,
    })
    const skillTools = createSkillRunnerTools({
      provider,
      binding: orchestrator.binding,
      skills: skillStore,
      grants: createInMemoryBrowserSkillGrantStore(),
      approvals: createInMemoryBlockApprovals(),
      profiles,
      unattendedEnabled,
      getWorkspacePlan,
      approvalWaitMs: 300,
      pollMs: 5,
    })
    const bu = createBuFallbackTool({
      provider,
      binding: orchestrator.binding,
      skills: skillStore,
      profiles,
      unattendedEnabled,
      getWorkspacePlan,
    })
    const tools = new Map<string, unknown>([
      ['browserNavigate', computer.browserNavigate],
      ['browserSnapshot', computer.browserSnapshot],
      ['browserClick', computer.browserClick],
      ['browserType', computer.browserType],
      ['browserCurrentUrl', computer.browserCurrentUrl],
      ['runBrowserSkill', skillTools.runBrowserSkill],
      ['listBrowserSkills', skillTools.listBrowserSkills],
      ['listBrowserProfiles', skillTools.listBrowserProfiles],
      ['browserExplore', bu.browserExplore],
    ])
    return { tools, provider, profileStore, skillStore }
  }

  type RunnableTool = {
    execute: (input: never, context: never) => Promise<{ data: unknown; isError?: boolean }>
    inputSchema: { parse: (v: unknown) => unknown }
  }

  /** The ToolContext shape a goal iteration's callee turn stamps. */
  const goalContext = () => ({
    userId: 'owner-1',
    assistantId: 'callee-1',
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'assistant-call',
    channelId: 'caller-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
  })

  it('workflow-origin consults keep the one-call browser tools and drop browserClick (fail-closed)', async () => {
    yieldsText()
    const { tools } = await realBrowserTools({ unattended: true })
    await browserExecutor(tools)({ ...baseParams, callerChannelType: 'workflow' })
    const call = mockQueryLoop.mock.calls[0][0]
    const passed = call.tools as Map<string, unknown>
    for (const name of [
      'browserNavigate',
      'browserSnapshot',
      'browserType',
      'browserCurrentUrl',
      'runBrowserSkill',
      'listBrowserSkills',
      'listBrowserProfiles',
      'browserExplore',
    ]) {
      expect(passed.has(name), `expected ${name} on the goal-path surface`).toBe(true)
    }
    expect(passed.has('browserClick')).toBe(false)
    // The drop note names the tool so the callee steers to the governed paths.
    expect(call.systemPrompt as string).toContain('browserClick')
  })

  it('a goal iteration executes a read-only browser skill end-to-end (unattended + paid)', async () => {
    yieldsText()
    const { tools, provider, profileStore, skillStore } = await realBrowserTools({ unattended: true })
    await profileStore.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'Ops',
      defaultBackend: 'cloud',
      enabledAssistantIds: ['callee-1'],
    })
    const code = 'def run(runner, params):\n    runner.open("https://www.example.com/")\n    return "collected"\n'
    await skillStore.create({
      workspaceId: 'ws-1',
      name: 'collect-example',
      site: 'example.com',
      code,
      contract: extractEffectContract({ code, site: 'example.com' }),
      recording: [{ step: 1, action: 'open', url: 'https://www.example.com/' }],
      origin: 'assistant',
    })
    provider.scriptSkillRun(async (io) => {
      io.writeFile(RESULT_PATH, JSON.stringify({ ok: true, summary: 'collected 3 items' }))
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    await browserExecutor(tools)({ ...baseParams, callerChannelType: 'workflow' })
    const passed = mockQueryLoop.mock.calls[0][0].tools as Map<string, RunnableTool>
    const runSkill = passed.get('runBrowserSkill')!
    const res = await runSkill.execute(
      runSkill.inputSchema.parse({ skill: 'collect-example' }) as never,
      goalContext() as never,
    )
    expect(res.isError ?? false).toBe(false)
    expect(String(res.data)).toContain('collected 3 items')
  })

  it('the same surface refuses honestly on the goal path while unattended computer-use is OFF', async () => {
    yieldsText()
    const { tools } = await realBrowserTools({ unattended: false })
    await browserExecutor(tools)({ ...baseParams, callerChannelType: 'workflow' })
    const passed = mockQueryLoop.mock.calls[0][0].tools as Map<string, RunnableTool>
    const runSkill = passed.get('runBrowserSkill')!
    const res = await runSkill.execute(
      runSkill.inputSchema.parse({ skill: 'whatever' }) as never,
      goalContext() as never,
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('unattended')
  })
})
