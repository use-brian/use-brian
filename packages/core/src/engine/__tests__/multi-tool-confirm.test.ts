/**
 * Multi-tool serial confirmation — both prompts must fire in parallel,
 * execution must still serialize for isConcurrencySafe=false tools.
 *
 * Surfaced 2026-05-27 (HinsonSIDAN, Telegram BYO): the model emitted two
 * `googleCalendarCreateEvent` calls in one turn. The user saw Tool 1's
 * confirmation prompt + tapped Allow at 7:51 PM, but Tool 2's prompt
 * didn't appear until 7:56 PM — exactly `confirmationTimeoutMs`
 * (300_000 ms) later, meaning Tool 2's `waitForDecision` had timed out
 * and the model retried. Pre-fix `canExecute` blocked any new tool from
 * starting (even just its confirmation gate) while a prior tool was in
 * `pending_confirmation`, so the second prompt couldn't appear until
 * the first tool finished executing. The Calendar client doesn't honor
 * the AbortSignal, so a slow Google API hang stretched into ages.
 *
 * Post-fix: confirmation runs in parallel for all tools; execution
 * serialises via a post-confirmation `awaiting_slot` wait inside
 * executeTool.
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import { createConfirmationResolver, type ToolConfirmationRequest } from '../../mcp/types.js'
import type { McpServerConfig, McpSettingsStore } from '../../mcp/types.js'
import { buildToolIndex, createMcpSearchTools } from '../../mcp/tool-search.js'
import { createToolExecutor } from '../tool-executor.js'
import { createLoopDetector } from '../loop-detector.js'
import type { ContentBlock } from '../../providers/types.js'

const ctx: ToolContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

function makeCalendarTool(delayMs: number): Tool {
  return buildTool({
    name: 'gcalCreate',
    description: 'create cal event',
    inputSchema: z.record(z.unknown()),
    isConcurrencySafe: false,
    requiresConfirmation: true,
    async execute(input) {
      await new Promise((r) => setTimeout(r, delayMs))
      return { data: `event:${(input as { idx: number }).idx}` }
    },
  })
}

describe('[COMP:engine/tool-executor] multi-tool parallel confirmation, serial execution', () => {
  it('fires onConfirmationRequired for both tools before either runs', async () => {
    const tools = new Map<string, Tool>([['gcalCreate', makeCalendarTool(50)]])
    const resolver = createConfirmationResolver()
    const confirmationOrder: string[] = []
    const startOrder: string[] = []
    const endOrder: string[] = []

    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
      confirmationResolver: resolver,
      confirmationTimeoutMs: 60_000,
      onConfirmationRequired: (req: ToolConfirmationRequest) => {
        confirmationOrder.push(req.toolCallId)
      },
      onToolStart: (id) => startOrder.push(id),
      onToolEnd: (id) => endOrder.push(id),
    })

    executor.addTool('call_1', 'gcalCreate', { idx: 1 })
    executor.addTool('call_2', 'gcalCreate', { idx: 2 })

    // Both confirmation prompts must have fired SYNCHRONOUSLY during addTool —
    // the executor pushes the request before any await. This is the heart of
    // the fix: pre-fix only call_1 would have prompted at this point.
    expect(confirmationOrder).toEqual(['call_1', 'call_2'])
    // Neither tool has STARTED EXECUTING yet — both are at the confirmation gate.
    expect(startOrder).toEqual([])

    const drained: ContentBlock[] = []
    const drainPromise = (async () => {
      for await (const batch of executor.getRemainingResults()) {
        drained.push(...batch.blocks)
      }
    })()

    // User taps Allow on call_1 first.
    resolver.resolve('call_1', 'allow')
    // …then on call_2 quickly (before call_1 even finishes executing).
    await new Promise((r) => setTimeout(r, 5))
    resolver.resolve('call_2', 'allow')

    await drainPromise

    // Execution serialised — at no point did both tools execute concurrently
    // (we'd see start-1, start-2 before any end if they ran in parallel).
    expect(startOrder).toEqual(['call_1', 'call_2'])
    expect(endOrder).toEqual(['call_1', 'call_2'])

    // Results preserve insertion order regardless of confirmation tap order.
    const ids = drained.map((b) => (b as { toolUseId: string }).toolUseId)
    expect(ids).toEqual(['call_1', 'call_2'])
  })

  it('serial execution slot blocks tool 2 when tool 1 is mid-execute', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const slowTool = buildTool({
      name: 'slowWrite',
      description: 'slow non-concurrency-safe',
      inputSchema: z.record(z.unknown()),
      isConcurrencySafe: false,
      requiresConfirmation: true,
      async execute() {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 50))
        concurrent--
        return { data: 'ok' }
      },
    })

    const tools = new Map<string, Tool>([['slowWrite', slowTool]])
    const resolver = createConfirmationResolver()

    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
      confirmationResolver: resolver,
      confirmationTimeoutMs: 60_000,
    })

    executor.addTool('a', 'slowWrite', {})
    executor.addTool('b', 'slowWrite', {})

    resolver.resolve('a', 'allow')
    resolver.resolve('b', 'allow')

    const drained: ContentBlock[] = []
    for await (const batch of executor.getRemainingResults()) {
      drained.push(...batch.blocks)
    }

    expect(maxConcurrent).toBe(1)
    expect(drained).toHaveLength(2)
  })

  it("does not block tool 2's confirmation when tool 1 is still in pending_confirmation", async () => {
    const tools = new Map<string, Tool>([['gcalCreate', makeCalendarTool(10)]])
    const resolver = createConfirmationResolver()
    const confirmationOrder: string[] = []

    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
      confirmationResolver: resolver,
      confirmationTimeoutMs: 60_000,
      onConfirmationRequired: (req: ToolConfirmationRequest) => {
        confirmationOrder.push(req.toolCallId)
      },
    })

    executor.addTool('first', 'gcalCreate', { idx: 1 })
    // Pre-fix: this addTool would have left `second` queued because
    // `first` was still in pending_confirmation. Post-fix: `second`
    // immediately also enters pending_confirmation and fires its prompt.
    executor.addTool('second', 'gcalCreate', { idx: 2 })

    expect(confirmationOrder).toEqual(['first', 'second'])

    resolver.resolve('first', 'allow')
    resolver.resolve('second', 'allow')
    for await (const _ of executor.getRemainingResults()) { /* drain */ }
  })
})

/**
 * Same regression class as above, reached through the OTHER confirmation
 * gate — the one every connector write actually uses.
 *
 * Surfaced 2026-07-21 (yanyuk.tom, "Personal agents" workspace, Telegram
 * channel MarkMyCalendar): the calendar assistant created exactly ONE event
 * per message and then went silent for 5-6 minutes. The model routinely
 * fans out 3-4 `googleCalendarCreateEvent` calls per turn; only the first
 * ever showed an Allow button, the rest sat invisible and each burned the
 * full 300s `confirmationTimeoutMs`, and the first timeout's
 * `blockedTools.add()` hard-rejected the remainder with "blocked for this
 * session". The 300s park then blew the query loop's 90s empty-response
 * wall-clock budget, so the turn exited with no text and the channel sent
 * nothing at all.
 *
 * Root cause: the fix above only covers tools the EXECUTOR gates
 * (`requiresConfirmation: true` → status `pending_confirmation`, which
 * `canExecute` deliberately ignores). Connector tools reach the model
 * through `mcp_call`, which declares `requiresConfirmation: false` and
 * `isConcurrencySafe: false`, and raises its prompt INSIDE `execute()` —
 * after the exclusive execution slot is already claimed. So a parked
 * `mcp_call` holds the slot for the entire human wait, and
 * `tryStartQueued` never starts its siblings.
 *
 * The invariant is the same for both gates: a sibling the user was never
 * shown cannot be approved, so every prompt must reach them before any
 * decision is required.
 */
describe('[COMP:engine/tool-executor] connector (mcp_call) sibling confirmation', () => {
  const settingsStore: McpSettingsStore = {
    async getPolicy() { return null },
    async setPolicy() {},
    async recordUsage() {},
    async recordUsageAndGetCount() { return { timesAllowed: 0, timesDenied: 0 } },
  }

  /**
   * Mirrors the real `googleCalendarCreateEvent`
   * (`packages/core/src/tools/base/google-calendar.ts`): a first-party
   * built-in with `requiresConfirmation: true` + `isConcurrencySafe: false`,
   * reached through `mcp_call` because `inject.ts` plucks built-ins into a
   * `kind: 'local'` search source rather than leaving them direct.
   */
  function makeExecutor() {
    const created: string[] = []
    const createEvent = buildTool({
      name: 'googleCalendarCreateEvent',
      description: 'Create a new Google Calendar event',
      inputSchema: z.object({ summary: z.string() }),
      isConcurrencySafe: false,
      requiresConfirmation: true,
      async execute(input) {
        created.push((input as { summary: string }).summary)
        return { data: 'created' }
      },
    })

    const index = buildToolIndex([
      { kind: 'local', serverName: 'gcal', tools: [createEvent] },
    ])
    const [, mcpCall] = createMcpSearchTools({
      index,
      settingsStore,
      assistantId: 'a',
      userId: 'u',
      callMcpTool: async () => ({}), // local dispatch never reaches the wire
    })

    const resolver = createConfirmationResolver()
    const prompts: ToolConfirmationRequest[] = []
    const executor = createToolExecutor({
      tools: new Map<string, Tool>([['mcp_call', mcpCall]]),
      context: ctx,
      loopDetector: createLoopDetector(),
      confirmationResolver: resolver,
      confirmationTimeoutMs: 60_000,
      onConfirmationRequired: (req: ToolConfirmationRequest) => { prompts.push(req) },
    })
    return { executor, resolver, prompts, created }
  }

  it('prompts for every sibling mcp_call before any decision is given', async () => {
    const { executor, resolver, prompts, created } = makeExecutor()

    executor.addTool('call_1', 'mcp_call', {
      server: 'gcal', tool: 'googleCalendarCreateEvent', args: { summary: '天文學會 Check-out' },
    })
    executor.addTool('call_2', 'mcp_call', {
      server: 'gcal', tool: 'googleCalendarCreateEvent', args: { summary: '返蔡宿瞓' },
    })

    const drained: ContentBlock[] = []
    const drainPromise = (async () => {
      for await (const batch of executor.getRemainingResults()) drained.push(...batch.blocks)
    })()

    // The heart of it: BOTH prompts must reach the user while both calls are
    // still unanswered. Pre-fix only call_1 ever prompted — call_2 stayed
    // `queued` behind the slot call_1 was holding while parked on a human,
    // so the user could not have approved it even in principle.
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 2000 })

    // The user taps Allow on each card. Note each needs its own tap: on the
    // local path a plain `allow` is deliberately per-call (each event is a
    // distinct entity), so N events legitimately means N prompts — they just
    // have to arrive together instead of 300s apart.
    for (const p of prompts) resolver.resolve(p.toolCallId, 'allow')
    await drainPromise

    expect(created).toEqual(['天文學會 Check-out', '返蔡宿瞓'])
    expect(drained.filter((b) => (b as { isError?: boolean }).isError)).toEqual([])
  })

  it('releases the slot in a chain, so a 4-call fan-out prompts for all four', async () => {
    // The reported turn emitted four creates. Releasing the slot only once
    // would surface two prompts and strand calls 3-4, so this pins that each
    // park hands off to the next.
    const { executor, resolver, prompts, created } = makeExecutor()

    const summaries = ['ZJU check-in', 'ZJU check-out', '出門準備', '返蔡宿瞓']
    summaries.forEach((summary, i) => {
      executor.addTool(`call_${i + 1}`, 'mcp_call', {
        server: 'gcal', tool: 'googleCalendarCreateEvent', args: { summary },
      })
    })

    const drainPromise = (async () => {
      for await (const _ of executor.getRemainingResults()) { /* drain */ }
    })()

    await vi.waitFor(() => expect(prompts).toHaveLength(4), { timeout: 2000 })

    for (const p of prompts) resolver.resolve(p.toolCallId, 'allow')
    await drainPromise

    expect(created).toEqual(summaries)
  })
})
