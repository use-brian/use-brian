import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createToolExecutor } from '../tool-executor.js'
import { createLoopDetector } from '../loop-detector.js'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import { EvidenceAccumulator } from '../../security/evidence.js'
import type { ContentBlock } from '../../providers/types.js'
import type { ConfirmationResolver, ToolConfirmationRequest } from '../../mcp/types.js'

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

function makeTool(opts: {
  name: string
  fn?: (input: Record<string, unknown>) => Promise<{ data: unknown; isError?: boolean }>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  abortSiblingsOnError?: boolean
}): Tool {
  return buildTool({
    name: opts.name,
    description: `Test tool ${opts.name}`,
    inputSchema: z.record(z.unknown()),
    isConcurrencySafe: opts.isConcurrencySafe ?? false,
    isReadOnly: opts.isReadOnly ?? false,
    abortSiblingsOnError: opts.abortSiblingsOnError ?? false,
    async execute(input) {
      return opts.fn ? opts.fn(input) : { data: `${opts.name}:ok` }
    },
  })
}

async function drainResults(executor: ReturnType<typeof createToolExecutor>): Promise<ContentBlock[]> {
  const all: ContentBlock[] = []
  for await (const batch of executor.getRemainingResults()) {
    all.push(...batch.blocks)
  }
  return all
}

describe('[COMP:engine/tool-executor] basic execution', () => {
  it('executes a single tool and returns its result', async () => {
    const tools = new Map<string, Tool>([
      ['greet', makeTool({ name: 'greet', isConcurrencySafe: true })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'greet', {})
    const results = await drainResults(executor)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: 'greet:ok',
    })
  })

  it('preserves the order of tool results matching the order added', async () => {
    const tools = new Map<string, Tool>([
      ['a', makeTool({ name: 'a', isConcurrencySafe: true })],
      ['b', makeTool({ name: 'b', isConcurrencySafe: true })],
      ['c', makeTool({ name: 'c', isConcurrencySafe: true })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'a', {})
    executor.addTool('call_2', 'b', {})
    executor.addTool('call_3', 'c', {})
    const results = await drainResults(executor)
    expect(results.map((r) => 'toolUseId' in r ? r.toolUseId : null)).toEqual(['call_1', 'call_2', 'call_3'])
  })

  it('returns a tool_result with isError when the tool is unknown', async () => {
    const executor = createToolExecutor({
      tools: new Map(),
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'ghost_tool', {})
    const results = await drainResults(executor)
    expect(results).toHaveLength(1)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('Unknown tool')
  })

  it('returns an error result when the tool execute throws', async () => {
    const tools = new Map<string, Tool>([
      ['boom', makeTool({
        name: 'boom',
        fn: async () => { throw new Error('kaboom') },
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'boom', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('kaboom')
  })
})

describe('[COMP:engine/tool-executor] result size caps', () => {
  // The global token-budget cap is fixed at 25k tokens in the executor.
  // estimateStringTokens weighs ASCII at ~4 chars/token, so each "x" below
  // costs 0.25 tokens (rounded up per the helper's char-by-char loop).
  // Helpers — keep payload sizes loud about which cap they're targeting.
  const GLOBAL_TOKEN_BUDGET = 25_000
  // Leading "\n\n" included — the executor prepends a blank line so the
  // marker renders distinct from the truncated payload.
  const TRUNCATION_MARKER =
    '\n\n[Response truncated at 25k tokens — narrow your query or paginate.]'

  function asciiOfTokens(approxTokens: number): string {
    // 4 ASCII chars ≈ 1 token under estimateStringTokens. Multiply by 4
    // for the target char length.
    return 'x'.repeat(approxTokens * 4)
  }

  it('passes through a tool result under the global token budget unchanged', async () => {
    // ~10k tokens of ASCII content ≈ 40k chars. Well under 25k budget.
    const payload = asciiOfTokens(10_000)
    const tools = new Map<string, Tool>([
      ['under', makeTool({
        name: 'under',
        isConcurrencySafe: true,
        fn: async () => ({ data: payload }),
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'under', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.content).toBe(payload)
    expect(String(r.content)).not.toContain(TRUNCATION_MARKER)
    // Tool reports no error; executor passes `result.isError` through
    // unchanged (omitted → undefined). Capacity caps must NOT flip this
    // to true — assert falsy, allow either undefined or false.
    expect(r.isError).toBeFalsy()
  })

  it('truncates over-budget tool results and appends the marker without flipping isError', async () => {
    // ~30k tokens of ASCII content ≈ 120k chars. Over the 25k budget.
    const payload = asciiOfTokens(30_000)
    const tools = new Map<string, Tool>([
      ['over', makeTool({
        name: 'over',
        isConcurrencySafe: true,
        fn: async () => ({ data: payload }),
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'over', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const content = String(r.content)
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(content.length).toBeLessThan(payload.length)
    // Capacity guard — not a failure.
    expect(r.isError).toBeFalsy()
    // Sliced body alone (marker removed) should be at or just over the
    // budget by at most one char's worth of tokens. The walker cuts at
    // the index that crosses the budget, so the body is ≤ BUDGET + 1.
    const body = content.slice(0, content.length - TRUNCATION_MARKER.length)
    // ASCII at 4 chars/token → body chars / 4 ≈ token count.
    const bodyTokens = Math.ceil(body.length / 4)
    expect(bodyTokens).toBeLessThanOrEqual(GLOBAL_TOKEN_BUDGET + 1)
  })

  it('truncates over-budget CJK content safely (1 char ≈ 1 token, naive slice would leak)', async () => {
    // CJK weighs 1 char/token. 30k Chinese chars = 30k tokens — over budget.
    // A naive slice(0, 25_000 * 4) on this would leave ~100k chars =
    // 100k tokens, blowing the budget 4x.
    const payload = '中'.repeat(30_000)
    const tools = new Map<string, Tool>([
      ['cjk_over', makeTool({
        name: 'cjk_over',
        isConcurrencySafe: true,
        fn: async () => ({ data: payload }),
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'cjk_over', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const content = String(r.content)
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true)
    const body = content.slice(0, content.length - TRUNCATION_MARKER.length)
    // 1 char ≈ 1 token for CJK → body length ≈ token count. The walker
    // cuts at the index that crosses the budget, so body is ≤ BUDGET.
    // Without CJK-aware truncation, a naive 4 chars/token slice would
    // leave ~100k chars here — a 4× budget leak.
    expect(body.length).toBeLessThanOrEqual(GLOBAL_TOKEN_BUDGET)
  })

  it('per-tool maxResultSizeChars fires first, leaving the global budget a no-op (no double marker)', async () => {
    // 100k chars of ASCII. Per-tool cap at 50k slices first → 50k chars
    // ≈ 12.5k tokens, comfortably under the 25k global budget. Only
    // the per-tool marker should remain.
    const payload = 'x'.repeat(100_000)
    const tools = new Map<string, Tool>([
      ['both_caps', buildTool({
        name: 'both_caps',
        description: 'Tool with per-tool char cap below the global token budget.',
        inputSchema: z.record(z.unknown()),
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultSizeChars: 50_000,
        async execute() { return { data: payload } },
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'both_caps', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const content = String(r.content)
    // Per-tool marker present.
    expect(content).toContain('[Result truncated]')
    // Global marker NOT present — sliced content is already under budget.
    expect(content).not.toContain(TRUNCATION_MARKER)
    // Exactly one truncation marker.
    expect(content.match(/\[Result truncated\]/g)?.length).toBe(1)
    expect(r.isError).toBeFalsy()
  })
})

describe('[COMP:engine/tool-executor] error result caps', () => {
  // The catch path is a tool_result finalization site too — a thrown error is
  // unbounded, tool-produced content. Before the cap, a recursive ZodError
  // dumped ~60k tokens through here (2026-06-01 "AI Trading").
  const TRUNCATION_MARKER =
    '\n\n[Response truncated at 25k tokens — narrow your query or paginate.]'
  const GLOBAL_TOKEN_BUDGET = 25_000

  it('caps an over-budget thrown Error message and flips isError to true', async () => {
    // ~30k tokens of ASCII in the thrown message ≈ 120k chars — over budget.
    const huge = 'E'.repeat(GLOBAL_TOKEN_BUDGET * 4 + 4_000)
    const tools = new Map<string, Tool>([
      ['boom', makeTool({
        name: 'boom',
        isConcurrencySafe: true,
        fn: async () => { throw new Error(huge) },
      })],
    ])
    const executor = createToolExecutor({ tools, context: ctx, loopDetector: createLoopDetector() })
    executor.addTool('call_1', 'boom', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const content = String(r.content)
    expect(r.isError).toBe(true)
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true)
    // Capped far below the raw thrown message length.
    expect(content.length).toBeLessThan(huge.length)
    const body = content.slice(0, content.length - TRUNCATION_MARKER.length)
    expect(Math.ceil(body.length / 4)).toBeLessThanOrEqual(GLOBAL_TOKEN_BUDGET + 1)
  })

  it('compacts a ZodError thrown from execute() instead of dumping the recursive union tree', async () => {
    const tools = new Map<string, Tool>([
      ['validate', makeTool({
        name: 'validate',
        isConcurrencySafe: true,
        fn: async () => {
          // invalid_union — ZodError.message would JSON.stringify every branch
          // under `unionErrors`. formatToolError must collapse it.
          z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]).parse({ c: true })
          return { data: 'unreachable' }
        },
      })],
    ])
    const executor = createToolExecutor({ tools, context: ctx, loopDetector: createLoopDetector() })
    executor.addTool('call_1', 'validate', {})
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const content = String(r.content)
    expect(r.isError).toBe(true)
    expect(content).toContain('Validation failed')
    // The raw ZodError JSON dump carries this key; the compacted form must not.
    expect(content).not.toContain('unionErrors')
    // Comfortably small — never anywhere near the cap.
    expect(content.length).toBeLessThan(2_000)
    expect(content).not.toContain(TRUNCATION_MARKER)
  })

  it('compacts an inputSchema validation failure to path: message lines', async () => {
    const tools = new Map<string, Tool>([
      ['strict', buildTool({
        name: 'strict',
        description: 'Tool with a strict input schema.',
        inputSchema: z.object({ count: z.number() }),
        isConcurrencySafe: true,
        isReadOnly: true,
        async execute() { return { data: 'ok' } },
      })],
    ])
    const executor = createToolExecutor({ tools, context: ctx, loopDetector: createLoopDetector() })
    // Wrong type for `count` → inputSchema.parse throws a ZodError into the catch.
    executor.addTool('call_1', 'strict', { count: 'not-a-number' })
    const results = await drainResults(executor)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const content = String(r.content)
    expect(r.isError).toBe(true)
    expect(content).toContain('Validation failed')
    // The failing field path is surfaced, not buried.
    expect(content).toContain('count:')
  })
})

describe('[COMP:engine/tool-executor] loop detector integration', () => {
  it('blocks a tool after 5 identical calls with an action-oriented message', async () => {
    const tools = new Map<string, Tool>([
      ['repeat', makeTool({ name: 'repeat', isConcurrencySafe: true })],
    ])
    const loopDetector = createLoopDetector()
    const executor = createToolExecutor({ tools, context: ctx, loopDetector })

    for (let i = 0; i < 5; i++) {
      executor.addTool(`call_${i}`, 'repeat', { x: 'y' })
    }
    const results = await drainResults(executor)
    const blocked = results.filter(
      (r): r is ContentBlock & { type: 'tool_result' } =>
        r.type === 'tool_result' && r.isError === true,
    )
    expect(blocked.length).toBeGreaterThan(0)
    // The action-oriented copy names the tool, the trigger (5+ identical
    // calls), and gives a concrete next step. Earlier ambiguous copy
    // ("repeated calls with identical input exceeded the per-turn limit")
    // produced meta-narration leaks like " Then, answer the user's
    // question." as the model's final text (Anson / GRI 2026-05-27).
    const msg = String(blocked[0].content)
    expect(msg).toContain('"repeat"')
    expect(msg).toMatch(/5\+ times with these exact arguments/)
    expect(msg).toMatch(/change the input|write a direct reply/)
  })

  it('hard_stop fires a budget-exhausted message (distinct from block)', async () => {
    const tools = new Map<string, Tool>([
      ['ping', makeTool({ name: 'ping', isConcurrencySafe: true })],
    ])
    // Small hard limit so we trip it without also tripping the
    // per-input block threshold (BLOCK_THRESHOLD=5).
    const loopDetector = createLoopDetector({ hardLimit: 3 })
    const executor = createToolExecutor({ tools, context: ctx, loopDetector })

    // 3 distinct inputs — none repeats — so any block must be the
    // hard-stop branch, not the per-input block branch.
    executor.addTool('call_1', 'ping', { i: 1 })
    executor.addTool('call_2', 'ping', { i: 2 })
    executor.addTool('call_3', 'ping', { i: 3 })
    const results = await drainResults(executor)
    const hardStopped = results.filter(
      (r): r is ContentBlock & { type: 'tool_result' } =>
        r.type === 'tool_result' &&
        r.isError === true &&
        String(r.content).includes('tool-call budget for this turn is exhausted'),
    )
    expect(hardStopped.length).toBe(1)
    expect(String(hardStopped[0].content)).toMatch(/write a direct reply to the user now/i)
    // The evidence-pinning clause: a research-shaped consult stopped
    // mid-gather must name unverified items instead of filling them from
    // memory (the 2026-07-13 HKTVmall prospect fabrications).
    expect(String(hardStopped[0].content)).toMatch(/name it plainly as not verified/i)
    expect(String(hardStopped[0].content)).toMatch(/never fill a gap/i)
  })
})

describe('[COMP:engine/tool-executor] concurrency rules', () => {
  it('runs concurrency-safe tools in parallel', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const tools = new Map<string, Tool>([
      ['slow_safe', makeTool({
        name: 'slow_safe',
        isConcurrencySafe: true,
        fn: async () => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise((r) => setTimeout(r, 10))
          concurrent--
          return { data: 'done' }
        },
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'slow_safe', { a: 1 })
    executor.addTool('call_2', 'slow_safe', { a: 2 })
    executor.addTool('call_3', 'slow_safe', { a: 3 })
    await drainResults(executor)
    expect(maxConcurrent).toBeGreaterThan(1)  // At least 2 ran in parallel
  })

  it('runs non-concurrency-safe tools serially', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const tools = new Map<string, Tool>([
      ['slow_unsafe', makeTool({
        name: 'slow_unsafe',
        isConcurrencySafe: false,
        fn: async () => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise((r) => setTimeout(r, 10))
          concurrent--
          return { data: 'done' }
        },
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'slow_unsafe', { a: 1 })
    executor.addTool('call_2', 'slow_unsafe', { a: 2 })
    await drainResults(executor)
    expect(maxConcurrent).toBe(1)  // Never more than 1 at a time
  })
})

describe('[COMP:engine/tool-executor] lifecycle callbacks', () => {
  it('invokes onToolStart and onToolEnd hooks', async () => {
    const starts: string[] = []
    const ends: string[] = []
    const tools = new Map<string, Tool>([
      ['hook_test', makeTool({ name: 'hook_test', isConcurrencySafe: true })],
    ])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
      onToolStart: (id, name) => starts.push(`${id}:${name}`),
      onToolEnd: (id, name) => ends.push(`${id}:${name}`),
    })
    executor.addTool('call_1', 'hook_test', {})
    await drainResults(executor)
    expect(starts).toEqual(['call_1:hook_test'])
    expect(ends).toEqual(['call_1:hook_test'])
  })
})

describe('[COMP:engine/tool-executor] requiresCapability gate', () => {
  const privilegedTool = buildTool({
    name: 'triage_reader',
    description: 'Capability-gated tool',
    inputSchema: z.record(z.unknown()),
    requiresCapability: 'bug_triage',
    isConcurrencySafe: true,
    async execute() { return { data: 'leaked' } },
  })

  it('rejects gated tools when context.activeCapabilities is not set', async () => {
    const tools = new Map<string, Tool>([['triage_reader', privilegedTool]])
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'triage_reader', {})
    const results = await drainResults(executor)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolUseId: 'call_1', isError: true })
    expect((results[0] as { content: string }).content).toContain("'bug_triage'")
  })

  it('rejects gated tools when the capability is absent from the active set', async () => {
    const tools = new Map<string, Tool>([['triage_reader', privilegedTool]])
    const executor = createToolExecutor({
      tools,
      context: { ...ctx, activeCapabilities: new Set(['cost_audit']) },
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'triage_reader', {})
    const results = await drainResults(executor)
    expect((results[0] as { isError?: boolean }).isError).toBe(true)
  })

  it('allows gated tools when the capability is present', async () => {
    const tools = new Map<string, Tool>([['triage_reader', privilegedTool]])
    const executor = createToolExecutor({
      tools,
      context: { ...ctx, activeCapabilities: new Set(['bug_triage']) },
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'triage_reader', {})
    const results = await drainResults(executor)
    expect(results[0]).toMatchObject({ content: 'leaked' })
  })
})

// ── WU-6.3: tool_invocation approval port ──────────────────────

function makeResolverThatAllows(): ConfirmationResolver {
  return {
    resolve: () => {},
    waitForDecision: async () => 'allow',
  }
}

function makeConfirmationTool(opts?: {
  displayLines?: string[]
  describeThrows?: boolean
  allowPersistentApproval?: boolean
}): Tool {
  return buildTool({
    name: 'sensitiveTool',
    description: 'A tool that requires user confirmation before running.',
    inputSchema: z.record(z.unknown()),
    isConcurrencySafe: true,
    requiresConfirmation: true,
    allowPersistentApproval: opts?.allowPersistentApproval,
    async describeConfirmation() {
      if (opts?.describeThrows) throw new Error('describe failed')
      return opts?.displayLines
    },
    async execute() {
      return { data: 'sensitiveTool:ok' }
    },
  })
}

describe('[COMP:engine/tool-executor-approval-refactor] tool_invocation approval port', () => {
  it('calls createToolInvocationApproval with the expected params and forwards approvalId', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => 'approval_abc')
    const onConfirmationRequired = vi.fn<(req: ToolConfirmationRequest) => void>()

    const context: ToolContext = {
      ...ctx,
      createToolInvocationApproval: port,
    }
    const tools = new Map<string, Tool>([
      [
        'sensitiveTool',
        makeConfirmationTool({
          displayLines: ['line A', 'line B'],
          allowPersistentApproval: true,
        }),
      ],
    ])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
      confirmationResolver: makeResolverThatAllows(),
      confirmationTimeoutMs: 300_000,
      onConfirmationRequired,
    })

    const before = Date.now()
    executor.addTool('call_1', 'sensitiveTool', { hello: 'world' })
    const results = await drainResults(executor)

    expect(port).toHaveBeenCalledTimes(1)
    const portArg = port.mock.calls[0]![0]
    expect(portArg.toolName).toBe('sensitiveTool')
    expect(portArg.toolInput).toEqual({ hello: 'world' })
    expect(portArg.description).toBe('A tool that requires user confirmation before running.')
    expect(portArg.displayLines).toEqual(['line A', 'line B'])
    expect(portArg.allowPersistentApproval).toBe(true)
    // expiresAt should be within the timeout window from "now".
    const expectedMin = before + 300_000 - 5_000
    const expectedMax = before + 300_000 + 5_000
    expect(portArg.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin)
    expect(portArg.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax)

    expect(onConfirmationRequired).toHaveBeenCalledTimes(1)
    const req = onConfirmationRequired.mock.calls[0]![0]
    expect(req.approvalId).toBe('approval_abc')
    expect(req.toolCallId).toBe('call_1')
    expect(req.displayLines).toEqual(['line A', 'line B'])

    // Tool executed after the allow resolution.
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolUseId: 'call_1', content: 'sensitiveTool:ok' })
  })

  it('falls back to in-memory-only mode when the port is absent (no approvalId on the event)', async () => {
    const onConfirmationRequired = vi.fn<(req: ToolConfirmationRequest) => void>()

    const tools = new Map<string, Tool>([['sensitiveTool', makeConfirmationTool()]])
    const executor = createToolExecutor({
      tools,
      context: ctx,  // no createToolInvocationApproval
      loopDetector: createLoopDetector(),
      confirmationResolver: makeResolverThatAllows(),
      onConfirmationRequired,
    })

    executor.addTool('call_1', 'sensitiveTool', {})
    const results = await drainResults(executor)

    expect(onConfirmationRequired).toHaveBeenCalledTimes(1)
    expect(onConfirmationRequired.mock.calls[0]![0].approvalId).toBeUndefined()
    // Tool still executed (Path A).
    expect(results[0]).toMatchObject({ toolUseId: 'call_1', content: 'sensitiveTool:ok' })
  })

  it('fails open when the port throws — emits the event with approvalId undefined and still executes', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => {
      throw new Error('db down')
    })
    const onConfirmationRequired = vi.fn<(req: ToolConfirmationRequest) => void>()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const context: ToolContext = {
      ...ctx,
      createToolInvocationApproval: port,
    }
    const tools = new Map<string, Tool>([['sensitiveTool', makeConfirmationTool()]])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
      confirmationResolver: makeResolverThatAllows(),
      onConfirmationRequired,
    })

    executor.addTool('call_1', 'sensitiveTool', {})
    const results = await drainResults(executor)

    expect(port).toHaveBeenCalledTimes(1)
    expect(onConfirmationRequired).toHaveBeenCalledTimes(1)
    expect(onConfirmationRequired.mock.calls[0]![0].approvalId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(results[0]).toMatchObject({ toolUseId: 'call_1', content: 'sensitiveTool:ok' })

    warnSpy.mockRestore()
  })

  it('skips the port entirely for tools that do not require confirmation', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => 'should_not_be_used')

    const context: ToolContext = {
      ...ctx,
      createToolInvocationApproval: port,
    }
    const tools = new Map<string, Tool>([
      ['greet', makeTool({ name: 'greet', isConcurrencySafe: true })],
    ])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
      confirmationResolver: makeResolverThatAllows(),
    })

    executor.addTool('call_1', 'greet', {})
    await drainResults(executor)

    expect(port).not.toHaveBeenCalled()
  })
})

// ── Posture A: autonomous approvals-row fallback (no resolver) ──
// write-gating-decision-brief.md §4 — a needs-confirmation tool on an
// autonomous path (no confirmationResolver) MUST NOT execute. With the
// createToolInvocationApproval port present it PARKS (approvals row +
// honest tool result); with no port either it hard-REJECTS.

describe('[COMP:engine/tool-executor-approval-refactor] autonomous approvals-row fallback', () => {
  it('parks (not rejects) a needs-confirmation tool when the port is present and no resolver', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => 'approval_auto_1')

    const context: ToolContext = {
      ...ctx,
      channelType: 'workflow', // autonomous — no live human
      createToolInvocationApproval: port,
    }
    const tools = new Map<string, Tool>([
      ['sensitiveTool', makeConfirmationTool({ displayLines: ['merge X <- Y'] })],
    ])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
      // NO confirmationResolver — this is the autonomous path.
    })

    executor.addTool('call_1', 'sensitiveTool', { hello: 'world' })
    const results = await drainResults(executor)

    // The approvals row was persisted with the enriched preview lines.
    expect(port).toHaveBeenCalledTimes(1)
    const portArg = port.mock.calls[0]![0]
    expect(portArg.toolName).toBe('sensitiveTool')
    expect(portArg.toolInput).toEqual({ hello: 'world' })
    expect(portArg.displayLines).toEqual(['merge X <- Y'])

    // The tool did NOT execute (no 'sensitiveTool:ok'); it parked with an
    // honest isError result that names the approval id and the queue.
    expect(results).toHaveLength(1)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).not.toContain('sensitiveTool:ok')
    expect(String(r.content)).toContain('PARKED FOR APPROVAL')
    expect(String(r.content)).toContain('approval_auto_1')
    expect(String(r.content)).toContain('merge X <- Y')
  })

  it('fires onAwaitingApproval with the parked call for the durability checkpoint', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => 'approval_auto_2')
    type AwaitFn = NonNullable<Parameters<typeof createToolExecutor>[0]['onAwaitingApproval']>
    const onAwaitingApproval = vi.fn<AwaitFn>()

    const context: ToolContext = {
      ...ctx,
      channelType: 'assistant-call',
      createToolInvocationApproval: port,
    }
    const tools = new Map<string, Tool>([
      ['sensitiveTool', makeConfirmationTool({ displayLines: ['line A'] })],
    ])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
      onAwaitingApproval,
    })

    executor.addTool('call_1', 'sensitiveTool', { a: 1 })
    await drainResults(executor)

    expect(onAwaitingApproval).toHaveBeenCalledTimes(1)
    const ev = onAwaitingApproval.mock.calls[0]![0]
    expect(ev.approvalId).toBe('approval_auto_2')
    expect(ev.toolCallId).toBe('call_1')
    expect(ev.toolName).toBe('sensitiveTool')
    expect(ev.describeText).toBe('line A')
  })

  it('hard-rejects (fail-closed) when neither a resolver nor the port is present', async () => {
    const tools = new Map<string, Tool>([['sensitiveTool', makeConfirmationTool()]])
    const executor = createToolExecutor({
      tools,
      context: { ...ctx, channelType: 'workflow' }, // no port, no resolver
      loopDetector: createLoopDetector(),
    })

    executor.addTool('call_1', 'sensitiveTool', {})
    const results = await drainResults(executor)

    expect(results).toHaveLength(1)
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).not.toContain('sensitiveTool:ok')
    expect(String(r.content)).toContain('no confirmation channel is available')
    expect(String(r.content)).toContain('NOT executed')
  })

  it('rejects fail-closed when the port throws — never falls through to execute', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => {
      throw new Error('db down')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const context: ToolContext = {
      ...ctx,
      channelType: 'workflow',
      createToolInvocationApproval: port,
      // No resolver — autonomous path.
    }
    const tools = new Map<string, Tool>([['sensitiveTool', makeConfirmationTool()]])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
    })

    executor.addTool('call_1', 'sensitiveTool', {})
    const results = await drainResults(executor)

    expect(port).toHaveBeenCalledTimes(1)
    // Fail-CLOSED (unlike the interactive path's fail-OPEN): the tool did
    // NOT execute; it fell through to the hard rejection.
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(r.isError).toBe(true)
    expect(String(r.content)).not.toContain('sensitiveTool:ok')
    expect(String(r.content)).toContain('no confirmation channel is available')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('leaves the interactive resolver path unchanged when a resolver IS present (ignores the port fallback)', async () => {
    type PortFn = NonNullable<ToolContext['createToolInvocationApproval']>
    const port = vi.fn<PortFn>(async () => 'approval_interactive')

    const context: ToolContext = {
      ...ctx,
      channelType: 'web', // interactive
      createToolInvocationApproval: port,
    }
    const tools = new Map<string, Tool>([['sensitiveTool', makeConfirmationTool()]])
    const executor = createToolExecutor({
      tools,
      context,
      loopDetector: createLoopDetector(),
      confirmationResolver: makeResolverThatAllows(), // human says allow
    })

    executor.addTool('call_1', 'sensitiveTool', {})
    const results = await drainResults(executor)

    // The interactive branch (resolver present) ran: the tool executed
    // after the allow, and did NOT take the autonomous "parked" path.
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolUseId: 'call_1', content: 'sensitiveTool:ok' })
    const r = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    expect(String(r.content)).not.toContain('PARKED FOR APPROVAL')
    // The port was still used (interactive branch persists a row too), but
    // exactly once, and the tool ran — proving no double-park.
    expect(port).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:engine/tool-executor] image tool results', () => {
  it('emits ToolResult.images as image blocks right after the tool_result', async () => {
    const framesTool = buildTool({
      name: 'getFrames',
      description: 'returns frames',
      inputSchema: z.record(z.unknown()),
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() {
        return {
          data: '[returned 2 image(s)]',
          images: [
            { mimeType: 'image/jpeg', data: 'AAA' },
            { mimeType: 'image/png', data: 'BBB' },
          ],
        }
      },
    })
    const executor = createToolExecutor({
      tools: new Map<string, Tool>([['getFrames', framesTool]]),
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'getFrames', {})
    const results = await drainResults(executor)

    // tool_result first, then one image block per returned frame, in order.
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call_1' })
    expect(results[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'AAA' })
    expect(results[2]).toEqual({ type: 'image', mimeType: 'image/png', data: 'BBB' })
  })

  it('drops images with empty data', async () => {
    const tool = buildTool({
      name: 'mixed',
      description: 'mixed images',
      inputSchema: z.record(z.unknown()),
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() {
        return {
          data: 'ok',
          images: [
            { mimeType: 'image/jpeg', data: 'GOOD' },
            { mimeType: 'image/png', data: '' }, // empty data -> dropped
          ],
        }
      },
    })
    const executor = createToolExecutor({
      tools: new Map<string, Tool>([['mixed', tool]]),
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'mixed', {})
    const results = await drainResults(executor)

    expect(results).toHaveLength(2)
    expect(results[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'GOOD' })
  })
})

describe('[COMP:engine/tool-executor] identifier-provenance write-gate', () => {
  function gatedCtx() {
    const evidence = new EvidenceAccumulator({ gatedTools: ['saveContact'] })
    return { ...ctx, evidence }
  }

  it('rejects a gated write whose identifier was never observed, without executing it', async () => {
    const executed = vi.fn()
    const tools = new Map<string, Tool>([
      ['saveContact', makeTool({
        name: 'saveContact',
        fn: async () => {
          executed()
          return { data: 'saved' }
        },
      })],
    ])
    const executor = createToolExecutor({
      tools,
      context: gatedCtx(),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'saveContact', {
      name: 'Vicky Chen',
      email: 'vicky.chen@slowood.hk',
    })
    const results = await drainResults(executor)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ type: 'tool_result', isError: true })
    const content = (results[0] as { content: string }).content
    expect(content).toContain('identifier_not_in_evidence')
    expect(content).toContain('vicky.chen@slowood.hk')
    expect(content).toContain('not verified')
    expect(executed).not.toHaveBeenCalled()
  })

  it('allows the write once the identifier appeared in an earlier tool result', async () => {
    const context = gatedCtx()
    const tools = new Map<string, Tool>([
      ['urlReader', makeTool({
        name: 'urlReader',
        isConcurrencySafe: true,
        fn: async () => ({ data: 'Contact page: write to vicky.chen@slowood.hk' }),
      })],
      ['saveContact', makeTool({ name: 'saveContact' })],
    ])
    const readExecutor = createToolExecutor({ tools, context, loopDetector: createLoopDetector() })
    readExecutor.addTool('call_1', 'urlReader', { url: 'https://slowood.hk/contact' })
    await drainResults(readExecutor)

    // Fresh per-turn executor, same threaded context — mirrors queryLoop.
    const writeExecutor = createToolExecutor({ tools, context, loopDetector: createLoopDetector() })
    writeExecutor.addTool('call_2', 'saveContact', { email: 'vicky.chen@slowood.hk' })
    const results = await drainResults(writeExecutor)
    expect(results[0]).toMatchObject({ type: 'tool_result', content: 'saveContact:ok' })
  })

  it('does not count a query echo or an error result as evidence', async () => {
    const context = gatedCtx()
    const tools = new Map<string, Tool>([
      ['webSearch', makeTool({
        name: 'webSearch',
        isConcurrencySafe: true,
        fn: async (input) => ({ data: { query: input.query, results: [] } }),
      })],
      ['failingReader', makeTool({
        name: 'failingReader',
        isConcurrencySafe: true,
        fn: async () => ({ data: 'fetch failed for https://instagram.com/slowoodx', isError: true }),
      })],
      ['saveContact', makeTool({ name: 'saveContact' })],
    ])
    const gather = createToolExecutor({ tools, context, loopDetector: createLoopDetector() })
    gather.addTool('call_1', 'webSearch', { query: 'vicky.chen@slowood.hk' })
    gather.addTool('call_2', 'failingReader', { url: 'https://instagram.com/slowoodx' })
    await drainResults(gather)

    const write = createToolExecutor({ tools, context, loopDetector: createLoopDetector() })
    write.addTool('call_3', 'saveContact', {
      email: 'vicky.chen@slowood.hk',
      instagram: 'https://instagram.com/slowoodx',
    })
    const results = await drainResults(write)
    expect(results[0]).toMatchObject({ type: 'tool_result', isError: true })
    const content = (results[0] as { content: string }).content
    expect(content).toContain('vicky.chen@slowood.hk')
    expect(content).toContain('instagram.com/slowoodx')
  })

  it('leaves non-gated tools untouched even with unobserved identifiers', async () => {
    const tools = new Map<string, Tool>([
      ['draftNote', makeTool({ name: 'draftNote' })],
    ])
    const executor = createToolExecutor({
      tools,
      context: gatedCtx(),
      loopDetector: createLoopDetector(),
    })
    executor.addTool('call_1', 'draftNote', { text: 'try hello@nowhere.com' })
    const results = await drainResults(executor)
    expect(results[0]).toMatchObject({ type: 'tool_result', content: 'draftNote:ok' })
  })

  it('accepts identifiers seeded from caller-provided material', async () => {
    const context = gatedCtx()
    context.evidence.note('Step instruction: follow up with ops@fls.com.hk')
    const tools = new Map<string, Tool>([
      ['saveContact', makeTool({ name: 'saveContact' })],
    ])
    const executor = createToolExecutor({ tools, context, loopDetector: createLoopDetector() })
    executor.addTool('call_1', 'saveContact', { email: 'ops@fls.com.hk' })
    const results = await drainResults(executor)
    expect(results[0]).toMatchObject({ type: 'tool_result', content: 'saveContact:ok' })
  })

  it('runs normally when no accumulator is threaded (feature off)', async () => {
    const tools = new Map<string, Tool>([
      ['saveContact', makeTool({ name: 'saveContact' })],
    ])
    const executor = createToolExecutor({ tools, context: ctx, loopDetector: createLoopDetector() })
    executor.addTool('call_1', 'saveContact', { email: 'anyone@anywhere.com' })
    const results = await drainResults(executor)
    expect(results[0]).toMatchObject({ type: 'tool_result', content: 'saveContact:ok' })
  })
})
