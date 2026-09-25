import { describe, it, expect } from 'vitest'
import { createPlanTools } from '../../memory/plan-tools.js'
import type { PlanStore } from '../../memory/plan-types.js'
import type { Tool } from '../../tools/types.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'

type SendCall = { messages: Message[] }

function scriptedProvider(scripts: StreamChunk[][]): {
  provider: LLMProvider
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  let turn = 0
  function streamNext(): AsyncIterable<StreamChunk> {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(messages: Message[], _opts?: SendOptions) {
      calls.push({ messages: structuredClone(messages) })
      return streamNext()
    },
  }
  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream: (options) => {
        calls.push({ messages: structuredClone(options.messages) })
        return streamNext()
      },
      createSession: (_o: SessionOptions) => session,
    },
  }
}

const textTurn = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

const baseContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

function lastUserText(messages: Message[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

type GateStatus =
  | { open: number; total: number; openSteps: { key: string; description: string }[] }
  | null

async function run(
  provider: LLMProvider,
  planGate: { status: (sid: string) => Promise<GateStatus> } | undefined,
  opts: { maxTurns?: number; planNudgeCap?: number; tools?: Map<string, Tool>; stateless?: boolean } = {},
): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({ ledger: NOOP_TURN_LEDGER,
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'do the multi-step task' }],
    tools: opts.tools ?? new Map([['updatePlanStep', createPlanTools({} as PlanStore).updatePlanStep]]),
    stateless: opts.stateless,
    context: baseContext,
    maxTurns: opts.maxTurns ?? 10,
    planGate,
    planNudgeCap: opts.planNudgeCap,
  })) {
    events.push(e)
  }
  return events
}

describe('[COMP:plan/gate] Completeness gate', () => {
  it('keeps working while steps are open, then completes when the plan is done', async () => {
    const { provider, calls } = scriptedProvider([
      textTurn('working on it'),
      textTurn('all done'),
    ])
    let n = 0
    const planGate = {
      status: async (): Promise<GateStatus> => {
        n++
        return n === 1
          ? { open: 1, total: 2, openSteps: [{ key: 'step:verify', description: 'check the sources' }] }
          : null
      },
    }
    const events = await run(provider, planGate)
    // Gate forced a second turn instead of stopping after the first.
    expect(calls).toHaveLength(2)
    // The continuation nudge lists the open step, with its description.
    expect(lastUserText(calls[1].messages)).toContain('call updatePlanStep')
    expect(lastUserText(calls[1].messages)).toContain('still open')
    expect(lastUserText(calls[1].messages)).toContain('step:verify')
    expect(lastUserText(calls[1].messages)).toContain('check the sources')
    expect(events.find((e) => e.type === 'turn_complete')).toBeDefined()
  })

  it.each(['absent', 'hidden', 'denied', 'stateless'] as const)('hands off once when updater is %s without changing the plan', async kind => {
    const { provider, calls } = scriptedProvider([textTurn('Results recorded; plan unresolved.')])
    const tool = createPlanTools({} as PlanStore).updatePlanStep
    if (kind === 'hidden') tool.hiddenFromModel = true
    if (kind === 'denied') tool.requiresCapability = 'plan-test-grant'
    const tools = new Map<string, Tool>()
    if (kind === 'hidden' || kind === 'denied') tools.set(tool.name, tool)
    const status = { open: 1, total: 1, openSteps: [{ key: 'step:verify', description: 'verify results' }] }
    const original = structuredClone(status)
    const events = await run(provider, { status: async () => status }, { tools, stateless: kind === 'stateless' })
    expect(calls).toHaveLength(2)
    const handoff = lastUserText(calls[1].messages)
    expect(handoff).toContain('Plan updates are unavailable')
    expect(handoff).toContain('remain recorded as open')
    expect(handoff).toContain('Do not claim unfinished work is done')
    expect(handoff).not.toContain('call updatePlanStep')
    expect(status).toEqual(original)
    expect(events.some(e => e.type === 'turn_complete')).toBe(true)
  })

  it('finishes without impossible nudges when no handoff budget remains', async () => {
    const { provider, calls } = scriptedProvider([textTurn('Incomplete; cannot update the plan.')])
    await run(provider, { status: async () => ({ open: 1, total: 1, openSteps: [] }) },
      { tools: new Map(), maxTurns: 1 })
    expect(calls).toHaveLength(1)
  })

  it('is a no-op when there is no active plan', async () => {
    const { provider, calls } = scriptedProvider([textTurn('hi')])
    const planGate = { status: async (): Promise<GateStatus> => null }
    await run(provider, planGate)
    expect(calls).toHaveLength(1)
  })

  it('does nothing at all when no planGate is wired (default behavior preserved)', async () => {
    const { provider, calls } = scriptedProvider([textTurn('hi')])
    await run(provider, undefined)
    expect(calls).toHaveLength(1)
  })

  it('fires a resumable handoff when budget is nearly spent', async () => {
    const { provider, calls } = scriptedProvider([textTurn('a'), textTurn('b')])
    const planGate = {
      status: async (): Promise<GateStatus> => ({
        open: 2,
        total: 3,
        openSteps: [
          { key: 'step:x', description: 'x' },
          { key: 'step:y', description: 'y' },
        ],
      }),
    }
    // maxTurns=2: no room to nudge (turn+2 < 2 false), so the handoff branch
    // fires once, then the loop completes.
    const events = await run(provider, planGate, { maxTurns: 2 })
    expect(calls).toHaveLength(2)
    expect(lastUserText(calls[1].messages).toLowerCase()).toContain('continue')
    expect(events.find((e) => e.type === 'turn_complete')).toBeDefined()
  })
})
