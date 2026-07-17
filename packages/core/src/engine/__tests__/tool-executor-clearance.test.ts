import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createToolExecutor } from '../tool-executor.js'
import { createLoopDetector } from '../loop-detector.js'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import type { ContentBlock } from '../../providers/types.js'
import { SensitivityAccumulator, type Sensitivity } from '../../security/sensitivity.js'

const baseCtx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

function ctxWithClearance(clearance: Sensitivity | undefined): ToolContext {
  return {
    ...baseCtx,
    clearance,
    sensitivity: new SensitivityAccumulator(),
  } as ToolContext
}

async function drainResults(executor: ReturnType<typeof createToolExecutor>): Promise<ContentBlock[]> {
  const all: ContentBlock[] = []
  for await (const batch of executor.getRemainingResults()) {
    all.push(...batch.blocks)
  }
  return all
}

function makeWriteTool(execute: (input: { sensitivity?: string }) => Promise<{ data: unknown; isError?: boolean }>): Tool {
  return buildTool({
    name: 'fake_write',
    description: 'Fake write tool with a sensitivity input',
    inputSchema: z.object({ sensitivity: z.string().optional(), payload: z.string().optional() }),
    isConcurrencySafe: true,
    async execute(input) {
      return execute(input as { sensitivity?: string })
    },
  })
}

describe('[COMP:brain/assistant-clearance-enforcement] tool-executor clearance gate', () => {
  it('rejects writes whose sensitivity exceeds the assistant clearance', async () => {
    const execute = vi.fn(async () => ({ data: 'should-not-run' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      context: ctxWithClearance('internal'),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'confidential', payload: 'secret' })
    const results = await drainResults(executor)

    expect(execute).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('sensitivity_exceeds_clearance')
    expect(String(r.content)).toContain("'confidential'")
    expect(String(r.content)).toContain("'internal'")
  })

  it('write gate uses assistantClearance (write ceiling), NOT the lowered read clearance', async () => {
    // Read-side clearance split (incident 2026-06-01): a member using a
    // confidential assistant reads at min(member, assistant) = 'internal',
    // but the assistant may still author confidential rows. The write gate
    // must key off assistantClearance, not the lowered read `clearance`.
    const execute = vi.fn(async () => ({ data: 'ok' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      context: {
        ...baseCtx,
        clearance: 'internal', // read ceiling (member-bounded)
        assistantClearance: 'confidential', // write ceiling (assistant's tier)
        sensitivity: new SensitivityAccumulator(),
      } as ToolContext,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'confidential' })
    const results = await drainResults(executor)

    expect(execute).toHaveBeenCalledTimes(1)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBeFalsy()
  })

  it('write gate still rejects sensitivity above assistantClearance', async () => {
    const execute = vi.fn(async () => ({ data: 'no' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      context: {
        ...baseCtx,
        clearance: 'internal',
        assistantClearance: 'internal',
        sensitivity: new SensitivityAccumulator(),
      } as ToolContext,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'confidential' })
    const results = await drainResults(executor)

    expect(execute).not.toHaveBeenCalled()
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('sensitivity_exceeds_clearance')
  })

  it('allows writes whose sensitivity equals the assistant clearance', async () => {
    const execute = vi.fn(async () => ({ data: 'ok' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      context: ctxWithClearance('internal'),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'internal' })
    const results = await drainResults(executor)

    expect(execute).toHaveBeenCalledTimes(1)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBeFalsy()
  })

  it('allows writes whose sensitivity is below the assistant clearance', async () => {
    const execute = vi.fn(async () => ({ data: 'ok' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      context: ctxWithClearance('confidential'),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'public' })
    await drainResults(executor)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not gate tools whose input has no sensitivity field (read tools)', async () => {
    const execute = vi.fn(async () => ({ data: 'rows' }))
    const readTool = buildTool({
      name: 'fake_read',
      description: 'A read tool with no sensitivity input',
      inputSchema: z.object({ query: z.string() }),
      isConcurrencySafe: true,
      async execute() {
        return execute()
      },
    })
    const executor = createToolExecutor({
      tools: new Map<string, Tool>([['fake_read', readTool]]),
      context: ctxWithClearance('internal'),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_read', { query: 'hello' })
    await drainResults(executor)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('bypasses the gate for system callers (context.clearance undefined)', async () => {
    const execute = vi.fn(async () => ({ data: 'system-write' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      // No clearance set — sync worker / cron path.
      context: ctxWithClearance(undefined),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'confidential' })
    await drainResults(executor)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('ignores non-Sensitivity sensitivity values rather than rejecting them', async () => {
    // A tool whose schema admits a `sensitivity` string but where the model
    // sent something that's not a Sensitivity tier — the gate must not fire
    // (the tool's own validation is the right place to reject malformed
    // tiers; the gate only enforces the clearance bound).
    const execute = vi.fn(async () => ({ data: 'ok' }))
    const tools = new Map<string, Tool>([['fake_write', makeWriteTool(execute)]])
    const executor = createToolExecutor({
      tools,
      context: ctxWithClearance('internal'),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'fake_write', { sensitivity: 'top-secret' })
    await drainResults(executor)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('propagates clearance and sensitivity accumulator into the tool execute context', async () => {
    let seenClearance: unknown
    let seenAccumulatorIsInstance = false
    const probe = buildTool({
      name: 'probe',
      description: 'Probe tool that reads the propagated context',
      inputSchema: z.object({}),
      isConcurrencySafe: true,
      async execute(_input, ctx) {
        seenClearance = ctx.clearance
        seenAccumulatorIsInstance = ctx.sensitivity instanceof SensitivityAccumulator
        return { data: 'ok' }
      },
    })
    const executor = createToolExecutor({
      tools: new Map<string, Tool>([['probe', probe]]),
      context: ctxWithClearance('confidential'),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'probe', {})
    await drainResults(executor)

    expect(seenClearance).toBe('confidential')
    expect(seenAccumulatorIsInstance).toBe(true)
  })
})
