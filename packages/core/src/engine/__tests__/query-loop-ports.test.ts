import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'
import type { DecisionRequest } from '../../decisions/types.js'
import { registeredToolDefinitions } from '@use-brian/agent-runtime/providers/tool-registration.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { buildTool, type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { queryLoop as runtimeQueryLoop, type QueryEvent, type QueryLoopOptions } from '@use-brian/agent-runtime/engine/query-loop.js'
import { queryLoop as composedQueryLoop } from '../query-loop-defaults.js'
import { queryLoop as barrelQueryLoop } from '../index.js'
import type { RoutineReadPhase, ToolSchemaSelector } from '@use-brian/agent-runtime/engine/query-loop-ports.js'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'

const tool = buildTool({ name: 'listTasks', description: 'Read open tasks', inputSchema: z.object({}),
  isReadOnly: true, isConcurrencySafe: true, execute: async () => ({ data: [] }) })

function fixture() {
  const seen: string[][] = []
  const provider: LLMProvider = { name: 'fixture', models: ['fixture'], toolSchemaMode: () => 'dynamic',
    stream: async function* () { throw new Error('Unexpected stream') },
    createSession: options => ({ async *send() {
      seen.push(registeredToolDefinitions(options, 'dynamic').map(definition => definition.name))
      yield { type: 'text_delta', text: 'Done.' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    } }) }
  const evaluate = vi.fn(async (request: DecisionRequest) => ({ providerId: 'fixture-decision', model: request.model,
    answers: request.questions.map((question, index) => ({ kind: 'choice' as const, questionId: question.id,
      value: index === 0 ? 't0' : 'none', evidence: { source: 'unavailable' as const } })) }))
  const runtime = executionFixture({ primary: fixtureDecisionProvider(evaluate), llm: provider })
  const context: ToolContext = { userId: 'u', assistantId: 'a', sessionId: 's', appId: 'test', channelType: 'web',
    channelId: 'c', abortSignal: new AbortController().signal }
  const options = (extra: Partial<QueryLoopOptions> = {}): QueryLoopOptions => ({ provider, model: 'fixture',
    systemPrompt: 'Test', messages: [{ role: 'user', content: 'Read my tasks' }], tools: new Map([[tool.name, tool]]),
    ledger: NOOP_TURN_LEDGER, deferToolSchemas: true, maxTurns: 1, context,
    toolSelection: { runtime, llm: { provider, modelId: 'fixture' } }, ...extra })
  return { seen, evaluate, options }
}

async function drain(events: AsyncGenerator<QueryEvent>): Promise<QueryEvent[]> {
  const out: QueryEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('[COMP:engine/query-loop-ports] injected query-loop ports', () => {
  it('exports the core-composed loop from the engine barrel', () => {
    expect(barrelQueryLoop).toBe(composedQueryLoop)
    expect(barrelQueryLoop).not.toBe(runtimeQueryLoop)
  })

  it('runs the core default selector through the composed loop', async () => {
    const f = fixture()
    await drain(composedQueryLoop(f.options()))
    expect(f.evaluate).toHaveBeenCalledOnce()
    expect(f.seen[0]).toEqual(['listTasks', 'discoverTools'])
  })

  it('refuses, rather than skipping, a selection that has no port on the raw loop', async () => {
    const f = fixture()
    await expect(drain(runtimeQueryLoop(f.options()))).rejects.toThrow(/ports\.selectToolSchemas/)
    expect(f.evaluate).not.toHaveBeenCalled()
    expect(f.seen).toEqual([])
  })

  it('needs no port when the host preselected the schemas', async () => {
    const f = fixture()
    await drain(runtimeQueryLoop(f.options({ toolSelection: { runtime: {} as never, llm: {} as never, preselected: ['listTasks'] } })))
    expect(f.seen[0]).toEqual(['listTasks', 'discoverTools'])
  })

  it('lets a caller port replace the default selector with the same input contract', async () => {
    const f = fixture()
    const onResult = vi.fn()
    const select = vi.fn<ToolSchemaSelector>(async input => {
      expect(input.definitions.map(definition => definition.name)).toEqual(['listTasks'])
      expect(input.messages).toEqual([{ role: 'user', content: 'Read my tasks' }])
      expect(input.runId).toMatch(/^chat-tools-s-/)
      await input.assertInputAuthority()
      return { names: [], model: null, usage: null, path: 'caller', durationMs: 0 }
    })
    const options = f.options({ ports: { selectToolSchemas: select } })
    options.toolSelection = { ...options.toolSelection!, onResult }
    await drain(composedQueryLoop(options))
    expect(select).toHaveBeenCalledOnce()
    expect(f.evaluate).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ path: 'caller' }))
    expect(f.seen[0]).toEqual(['discoverTools'])
  })

  it('refuses a routine read that has no port on the raw loop', async () => {
    const f = fixture()
    const options = f.options({ toolSelection: undefined, routineCalendarRead: {} as never })
    await expect(drain(runtimeQueryLoop(options))).rejects.toThrow(/ports\.routineRead/)
    expect(f.seen).toEqual([])
  })

  it('runs a supplied routine-read port with the loop state and replays its messages', async () => {
    const f = fixture()
    const config = { marker: 'routine' } as never
    const routineRead = vi.fn<RoutineReadPhase>(async function* (input) {
      expect(input.options.routineCalendarRead).toBe(config)
      expect(input.tools.has('listTasks')).toBe(true)
      expect(input.loopDetector.totalToolCalls).toBe(0)
      yield { type: 'status', message: 'host read' }
      return { messages: [{ role: 'user', content: 'host observation' }], complete: false, records: [], calls: 0 }
    })
    const events = await drain(runtimeQueryLoop(f.options({ toolSelection: undefined, routineCalendarRead: config, ports: { routineRead } })))
    expect(routineRead).toHaveBeenCalledOnce()
    expect(events.some(event => event.type === 'status' && event.message === 'host read')).toBe(true)
    expect(f.seen).toHaveLength(1)
  })

  it('does not call the routine port when no routine read is configured', async () => {
    const f = fixture()
    const routineRead = vi.fn<RoutineReadPhase>()
    await drain(composedQueryLoop(f.options({ toolSelection: undefined, ports: { routineRead } })))
    expect(routineRead).not.toHaveBeenCalled()
  })
})
