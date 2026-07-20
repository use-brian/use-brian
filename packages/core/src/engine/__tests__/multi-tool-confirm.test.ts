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

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import { createConfirmationResolver, type ToolConfirmationRequest } from '../../mcp/types.js'
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
