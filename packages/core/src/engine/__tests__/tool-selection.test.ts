import { describe, expect, it, vi } from 'vitest'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'
import type { DecisionRequest } from '../../decisions/types.js'
import type { LLMProvider, ToolDefinition } from '../../providers/types.js'
import { selectInitialToolSchemas } from '../tool-selection.js'
import { createToolDiscovery } from '../tool-discovery.js'
import { queryLoop } from '../query-loop.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { buildTool } from '../../tools/types.js'
import { z } from 'zod'

const llm: LLMProvider = { name: 'fixture', models: ['fixture'],
  stream: async function* () { throw new Error('Unexpected LLM call') },
  createSession: () => { throw new Error('Unexpected session') } }
const definitions: ToolDefinition[] = [
  { name: 'listTasks', description: 'Read open tasks', parameters: { type: 'object', properties: { secretSchemaMarker: { type: 'string' } } } },
  { name: 'deleteTask', description: 'Delete a task', parameters: { type: 'object', properties: {} } },
]
const answers = (request: DecisionRequest, select: boolean) => ({
  providerId: 'fixture-decision', model: request.model,
  answers: request.questions.map((question, index) => ({ kind: 'choice' as const,
    questionId: question.id, value: select && index === 0 ? 't0' : 'none', evidence: { source: 'unavailable' as const } })),
})

describe('[COMP:engine/tool-selection] bounded initial schema decisions', () => {
  const base = { definitions, messages: [{ role: 'user' as const, content: 'Read my tasks' }],
    runId: 'fixture-selection', signal: new AbortController().signal,
    assertInputAuthority: vi.fn(async () => {}), llm: { provider: llm, modelId: 'fixture' } }

  it('asks the configured decision model using compact descriptions and eagerly loads only its choice', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => answers(request, true))
    const runtime = executionFixture({ primary: fixtureDecisionProvider(evaluate), llm })
    const result = await selectInitialToolSchemas({ ...base, runtime })
    expect(result).toMatchObject({ names: ['listTasks'], path: 'primary_complete' })
    expect(JSON.stringify(evaluate.mock.calls[0][0])).not.toContain('secretSchemaMarker')
    expect(base.assertInputAuthority).toHaveBeenCalled()
    const discovery = createToolDiscovery(definitions, result.names)
    expect(discovery.definitions.map(tool => tool.name)).toEqual(['listTasks'])
    expect(discovery.tool.description).toContain('deleteTask')
  })

  it('allows a conversational turn to select no schemas', async () => {
    const runtime = executionFixture({ primary: fixtureDecisionProvider(async request => answers(request, false)), llm })
    expect((await selectInitialToolSchemas({ ...base, messages: [{ role: 'user', content: 'Thanks for the explanation' }], runtime })).names).toEqual([])
  })

  it('skips the extra decision for bare greetings but still classifies a greeting with a request', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => answers(request, true))
    const runtime = executionFixture({ primary: fixtureDecisionProvider(evaluate), llm })
    expect(await selectInitialToolSchemas({ ...base, messages: [{ role: 'user', content: 'Hi!' }], runtime })).toMatchObject({ names: [], path: 'greeting' })
    expect(evaluate).not.toHaveBeenCalled()
    expect((await selectInitialToolSchemas({ ...base, messages: [{ role: 'user', content: 'Hi, list my tasks' }], runtime })).names).toEqual(['listTasks'])
    expect(evaluate).toHaveBeenCalledOnce()
  })

  it('covers the complete catalog in one bounded batch without exceeding choice limits', async () => {
    const catalog = Array.from({ length: 341 }, (_, index) => ({ ...definitions[0], name: `readRecord${index}` }))
    const evaluate = vi.fn(async (request: DecisionRequest) => answers(request, false))
    const runtime = executionFixture({ primary: fixtureDecisionProvider(evaluate), llm })
    await selectInitialToolSchemas({ ...base, definitions: catalog, runtime })
    expect(evaluate).toHaveBeenCalledOnce()
    const questions = evaluate.mock.calls[0][0].questions
    expect(questions).toHaveLength(6)
    const vocabulary = new Set(questions.flatMap(question => question.kind === 'choice' ? question.options.map(option => option.value) : []))
    expect(vocabulary.size).toBe(342)
    expect(questions.every(question => question.kind === 'choice' && question.options.length <= 255)).toBe(true)
    const oversized = await selectInitialToolSchemas({ ...base, definitions: Array.from({ length: 509 }, () => definitions[0]), runtime })
    expect(oversized).toMatchObject({ names: [], path: 'catalog_limit' })
    expect(evaluate).toHaveBeenCalledOnce()
  })

  it('keeps discovery after a provider failure and propagates source authority loss', async () => {
    const runtime = executionFixture({ primary: fixtureDecisionProvider(async () => { throw new Error('offline') }), llm })
    expect((await selectInitialToolSchemas({ ...base, runtime })).names).toEqual([])
    const denied = Object.assign(new Error('authority changed'), { reason: 'authority_changed', retrySafe: false })
    await expect(selectInitialToolSchemas({ ...base, runtime, assertInputAuthority: async () => { throw denied } })).rejects.toBe(denied)
  })

  it('caps eager schema bytes and ignores fabricated names without losing discovery', () => {
    const large = { ...definitions[0], name: 'largeTool', description: 'x'.repeat(25 * 1024) }
    const discovery = createToolDiscovery([...definitions, large], ['fabricated', 'largeTool', 'listTasks', 'listTasks'])
    expect(discovery.definitions.map(tool => tool.name)).toEqual(['listTasks'])
    expect(discovery.tool.description).toContain('largeTool')
  })

  it('times out a stalled selector and propagates parent cancellation', async () => {
    const evaluate = vi.fn((request: DecisionRequest) => new Promise<never>((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
    }))
    const runtime = executionFixture({ primary: fixtureDecisionProvider(evaluate), llm })
    const start = Date.now()
    expect((await selectInitialToolSchemas({ ...base, runtime })).names).toEqual([])
    expect(evaluate.mock.calls[0][0].deadlineAt).toBeLessThanOrEqual(start + 2000)
    const controller = new AbortController()
    const pending = selectInitialToolSchemas({ ...base, runtime, signal: controller.signal })
    controller.abort(new Error('User stopped'))
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('executes the selected canonical tool on the first main-model turn', async () => {
    const execute = vi.fn(async () => ({ data: [] }))
    const tool = buildTool({ name: 'listTasks', description: 'Read tasks', inputSchema: z.object({}),
      isReadOnly: true, isConcurrencySafe: true, execute })
    const evaluate = vi.fn(async (request: DecisionRequest) => answers(request, true))
    const runtime = executionFixture({ primary: fixtureDecisionProvider(evaluate), llm })
    const selectionGuard = vi.fn(async () => {}), mainGuard = vi.fn(async () => {})
    const seen: string[][] = []
    let turn = 0
    const provider: LLMProvider = { ...llm, createSession: options => ({
      async *send() {
        seen.push(options.tools!.map(tool => tool.name))
        if (turn++ === 0) {
          yield { type: 'tool_use_start', id: 'read', name: 'listTasks' }
          yield { type: 'tool_use_delta', id: 'read', input: '{}' }
          yield { type: 'tool_use_end', id: 'read' }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
        } else {
          yield { type: 'text_delta', text: 'No open tasks.' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        }
      },
    }) }
    for await (const _ of queryLoop({ provider, model: 'fixture', systemPrompt: 'Test', messages: [{ role: 'user', content: 'Ambient content excluded from selector' }],
      tools: new Map([[tool.name, tool]]), ledger: NOOP_TURN_LEDGER, deferToolSchemas: true,
      toolSelection: { runtime, llm: base.llm, input: { messages: base.messages, assertInputAuthority: selectionGuard } }, context: {
        userId: 'u', assistantId: 'a', sessionId: 's', appId: 'test', channelType: 'web', channelId: 'c', assertModelInputAuthority: mainGuard,
        abortSignal: new AbortController().signal,
      } })) { /* drain */ }
    expect(JSON.stringify(evaluate.mock.calls[0][0].state)).not.toContain('Ambient content')
    expect(selectionGuard).toHaveBeenCalled()
    expect(mainGuard).toHaveBeenCalled()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual(['listTasks', 'discoverTools'])
    expect(execute).toHaveBeenCalledOnce()
  })
})
