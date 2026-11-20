import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as v8 from 'node:v8'
vi.mock('node:v8', async importOriginal => {
  const actual = await importOriginal<typeof import('node:v8')>()
  return { ...actual, getHeapStatistics: vi.fn(actual.getHeapStatistics) }
})
import { queryLoop, assertModelOutputAuthority, type QueryEvent, type QueryLoopOptions } from '../query-loop.js'
import { createTurnOutputCollector } from '../turn-output.js'
import { applyOutputRevisions, createQueryOutputOwner, outputContentDigest, queryOutputProvenance, type QueryOutputProvenance, type OutputRecord } from '../output-provenance.js'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { buildTool, type Tool } from '../../tools/types.js'
import { askQuestionTool } from '../../tools/base/ask-question.js'
import type { AssistantResponse, LLMProvider, StopReason, StreamChunk } from '../../providers/types.js'

const usage = { inputTokens: 1, outputTokens: 1 }
const text = (value: string, stopReason: StopReason = 'end_turn'): StreamChunk[] => [
  { type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: value }, { type: 'message_end', stopReason, usage },
]
const call = (name: string, stopReason: StopReason = 'tool_use'): StreamChunk[] => [
  { type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: 'Checking.' },
  { type: 'tool_use_start', id: 'call-1', name }, { type: 'tool_use_delta', id: 'call-1', input: name === 'askQuestion' ? '{"question":"Which?","options":["A","B"]}' : '{}' },
  { type: 'tool_use_end', id: 'call-1' }, { type: 'message_end', stopReason, usage },
]
function stub(name: string, transient = false): Tool {
  return buildTool({ name, description: 'Fictional fixture', inputSchema: z.object({}), isReadOnly: true, isConcurrencySafe: true,
    async execute() { return { data: { value: 'Fictional observation' }, ...(transient ? { meta: { transientProviderContent: true } } : {}) } } })
}
async function run(scripts: StreamChunk[][], extra: Partial<QueryLoopOptions> = {}) {
  let calls = 0, admissions = 0
  const next = () => (async function* () { const chunks = scripts[calls++]; if (!chunks) throw new Error('Unexpected provider call'); yield* chunks })()
  const provider: LLMProvider = { name: 'fixture', models: ['fixture'], stream: next, createSession: () => ({ send: next }) }
  const collector = createTurnOutputCollector()
  const events: QueryEvent[] = [], metadata: QueryOutputProvenance[] = []
  const transcript = new Map<string, OutputRecord>()
  const options: QueryLoopOptions = { ledger: NOOP_TURN_LEDGER, provider, model: 'fixture', systemPrompt: 'Fixture',
    messages: [{ role: 'user', content: 'What is the current price?' }], tools: new Map(), maxTurns: scripts.length + 1,
    context: { userId: 'fictional-user', assistantId: 'fictional-assistant', sessionId: 'fictional-session', appId: 'fixture',
      channelType: 'web', channelId: 'fictional-channel', abortSignal: new AbortController().signal,
      admitModelOutput: async () => { admissions++ } }, ...extra }
  for await (const event of queryLoop({ ...options, dispatchOutput: async (context, event, provenance) => {
    await assertModelOutputAuthority(context)
    expect(provenance).toBeDefined()
    collector.observe(event, provenance)
    applyOutputRevisions(transcript, provenance!)
    events.push(event); metadata.push(provenance!)
  } })) throw new Error(`Unexpected dispatch yield ${event.type}`)
  return { collector, events, metadata, transcript, calls, admissions }
}

describe('[COMP:engine/turn-output] producer revisions across actual cloned dispatch', () => {
  it('owns late grounding text once and sends only changed terminal snapshots', async () => {
    const r = await run([text('The current price is $42.')], { groundingGate: { userMessage: 'What is the current price?' } })
    const streamed = r.events.filter(e => e.type === 'text_delta').map(e => e.text).join('')
    expect(streamed).toContain('Not verified against a source')
    expect(r.collector.select()).toEqual({ kind: 'text', text: streamed })
    expect(r.transcript.size).toBe(1)
    expect([...r.transcript.values()][0].response.content).toEqual([{ type: 'text', text: streamed }])
    expect(r.collector.finalizedSelection()?.members[0].revision).toBe(2)
    expect(r.metadata.at(-1)?.updates.filter(update => update.response)).toHaveLength(1)
    expect(r.admissions).toBe(r.events.length)
    expect(JSON.stringify(r.events)).not.toContain('invocationId')
    const initial = r.events.find(e => e.type === 'assistant_turn')!
    expect(initial.type === 'assistant_turn' && JSON.stringify(initial.response)).not.toContain('Not verified')
  })
  it('seals unchanged snapshots with metadata and preserves distinct equal text', async () => {
    const r = await run([text('Same', 'max_tokens'), text('Same')])
    expect(r.collector.select()).toEqual({ kind: 'text', text: 'Same\nSame' })
    expect(r.collector.finalizedSelection()?.members).toHaveLength(2)
    expect(new Set(r.collector.finalizedSelection()?.members.map(m => m.origin)).size).toBe(2)
    expect(r.metadata.at(-1)?.updates.every(u => !u.response && u.sealed && u.revision === 1)).toBe(true)
  })
  it.each(['grounding', 'truncated'] as const)('retains full %s transcript while replacing only selected membership', async mode => {
    const tool = stub(mode === 'grounding' ? 'webSearch' : 'observe')
    const r = await run([text('Current price $42.', mode === 'truncated' ? 'incomplete' : 'end_turn'), call(tool.name), text('Verified synthesis.')], {
      tools: new Map([[tool.name, tool]]), ...(mode === 'grounding' ? { groundingGate: { userMessage: 'What is the current price?' } } : {}),
    })
    expect(r.transcript.size).toBe(3)
    expect(r.collector.select()).toEqual({ kind: 'text', text: 'Verified synthesis.' })
    expect(r.collector.finalizedSelection()?.members.map(m => m.origin)).toEqual([[...r.transcript.keys()][2]])
  })
  it('reprojects transient content without restoring provider tool/result pairs', async () => {
    const tool = stub('transientLookup', true)
    const r = await run([call(tool.name), text('Allowed answer.')], { tools: new Map([[tool.name, tool]]) })
    expect(JSON.stringify([...r.transcript.values()])).not.toContain('transientLookup')
    expect(r.collector.select()).toEqual({ kind: 'text', text: 'Checking.\nAllowed answer.' })
    expect(r.collector.finalizedSelection()?.members).toHaveLength(2)
  })
  it('finalizes a fresh isolated rescue origin without selecting tool narration', async () => {
    const tool = stub('observe')
    const usageSnapshots: import('../query-loop.js').QueryUsageSnapshot[]=[]
    const r = await run([call(tool.name, 'end_turn'), text('{"message":"Fictional handoff."}')], { tools: new Map([[tool.name, tool]]),observeUsage:s=>usageSnapshots.push(s) })
    expect(usageSnapshots.map(s=>s.totalUsage.inputTokens)).toEqual([1,2])
    expect(r.collector.select()).toEqual({ kind: 'text', text: 'Fictional handoff.' })
    expect(r.collector.finalizedSelection()?.members).toHaveLength(1)
    expect(r.transcript.size).toBe(2)
  })
  it.each([false, true])('question/suspend never qualifies (%s)', async suspend => {
    const context: QueryLoopOptions['context'] = { userId: 'fictional-user', assistantId: 'fictional-assistant', sessionId: 'fictional-session',
      appId: 'fixture', channelType: 'web', channelId: 'fictional-channel', abortSignal: new AbortController().signal, ...(suspend ? { createPendingQuestion: async () => 'fictional-approval' } : {}) }
    const r = await run([call('askQuestion')], { tools: new Map([['askQuestion', askQuestionTool]]), context, questionResumeEnabled: suspend })
    expect(r.collector.finalizedSelection()).toBeNull()
    expect(r.metadata.at(-1)?.disposition).toBe(suspend ? 'suspended' : 'question')
    expect([...r.transcript.values()].every(record => record.sealed)).toBe(true)
  })
  it('error and synthetic terminal tail cannot qualify earlier text', async () => {
    const exhausted = await run([text('Partial', 'max_tokens')], { maxTurns: 1 })
    expect(exhausted.collector.select().kind).toBe('text')
    expect(exhausted.collector.finalizedSelection()).toBeNull()
    const error = await run([text('Partial', 'incomplete'), []])
    expect(error.collector.finalizedSelection()).toBeNull()
  })
  it('Stop closes producer without minting a terminal selection', async () => {
    const abort = new AbortController()
    const provider: LLMProvider = { name: 'fixture', models: ['fixture'], async *stream() {}, createSession: () => ({ async *send() {
      yield { type: 'message_start', model: 'fixture' }; yield { type: 'text_delta', text: 'Partial' }; abort.abort()
      yield { type: 'message_end', stopReason: 'end_turn', usage }
    } }) }
    const r = await run([], { provider, context: { userId: 'fixture', assistantId: 'fixture', sessionId: 'fixture', appId: 'fixture', channelType: 'web', channelId: 'fixture', abortSignal: abort.signal } })
    expect(r.collector.finalizedSelection()).toBeNull()
  })
  it('same-emission heap replay updates one origin; distinct responses are not deduplicated', async () => {
    const heap = vi.spyOn(v8, 'getHeapStatistics')
    let n = 0
    const actual = v8.getHeapStatistics()
    heap.mockImplementation(() => ({ ...actual, used_heap_size: ++n >= 2 ? 900 : 1, heap_size_limit: 1000 }))
    try {
      const r = await run([text('Partial', 'max_tokens')])
      expect(r.metadata.filter(p => p.emission).map(p => p.emission?.replay)).toEqual([false, true])
      expect(r.transcript.size).toBe(1)
      expect(r.collector.select()).toEqual({ kind: 'text', text: 'Partial' })
      expect(r.collector.finalizedSelection()).toBeNull()
    } finally { heap.mockRestore() }
  })
  it('checkpoint callbacks cannot mutate the producer after observation', async () => {
    const r = await run([text('Original')], { stateless: true, onTurnEnd: (_turn, history) => {
      const last = history.at(-1)
      if (last && Array.isArray(last.content)) last.content.splice(0, last.content.length, { type: 'text', text: 'Mutated checkpoint' })
    } })
    expect(r.collector.select()).toEqual({ kind: 'text', text: 'Original' })
  })
  it('direct generator consumers get the same private event association', async () => {
    const response: AssistantResponse = { content: [{ type: 'text', text: 'Allowed' }], model: 'fixture', stopReason: 'end_turn', usage }
    const owner = createQueryOutputOwner(1)
    const projected = { ...response, content: [...response.content] }
    owner.register(response); owner.project(response, projected, () => ({ ...response, content: response.content.filter(b => b.type === 'text') }))
    const initial = owner.prepare({ type: 'assistant_turn', response: projected, toolResults: [] })
    response.content.push({ type: 'text', text: ' trailer' })
    const final = owner.prepare({ type: 'turn_complete', response, totalUsage: usage })
    expect(initial.provenance.emission?.origin).toBe(final.provenance.updates[0].origin)
    expect(final.provenance.updates[0].revision).toBe(2)
    expect(outputContentDigest({ a: 1, b: undefined })).toBe(outputContentDigest({ a: 1 }))
    expect(queryOutputProvenance(initial.event)).toBeUndefined() // Only the real wrapper associates events.
  })
})

describe('[COMP:engine/turn-output] protocol JSON and atomic revision controls', () => {
  it.each([new Date(), { toJSON: () => 'forged' }, { value: () => 'forged' }, { value: Symbol('fixture') },
    [undefined], [() => 'forged'], [Symbol('fixture')], [Number.NaN], { [Symbol('fixture')]: true }])('rejects unsupported values before serializer transformations (%j)', value => {
    expect(() => outputContentDigest(value)).toThrow('Unsupported output')
  })
  it('validates a complete update packet before replacing any prior snapshot', () => {
    const owner = createQueryOutputOwner(2)
    const raw: AssistantResponse = { content: [{ type: 'text', text: 'Original' }], model: 'fixture', stopReason: 'end_turn', usage }
    owner.register(raw)
    const first = owner.prepare({ type: 'assistant_turn', response: raw, toolResults: [] })
    const records = new Map<string, OutputRecord>()
    applyOutputRevisions(records, first.provenance)
    const before = structuredClone([...records])
    raw.content = [{ type: 'text', text: 'Changed' }]
    const final = owner.prepare({ type: 'turn_complete', response: raw, totalUsage: usage })
    const malformed: QueryOutputProvenance = { ...final.provenance, updates: [...final.provenance.updates, { origin: 'missing', revision: 2, digest: 'wrong', sealed: true }] }
    expect(() => applyOutputRevisions(records, malformed)).toThrow()
    expect([...records]).toEqual(before)
  })
})
