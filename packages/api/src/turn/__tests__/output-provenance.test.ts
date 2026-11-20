import { describe, expect, it, vi } from 'vitest'
// Real installed core/queryLoop; run after the coordinated core build.
vi.mock('../../db/notify-listener.js', () => ({ registerNotifyChannel: vi.fn(), startNotifyListener: vi.fn() }))
vi.mock('../../db/sessions.js', () => ({ claimTurnLeaseOutcome: vi.fn(async () => ({ token: 'provenance-token', turnId: null })), touchTurnLease: vi.fn(async () => ({ held: true, cancelRequested: false })), releaseTurnOutcome: vi.fn(async (_id, reason) => ({ turnId: null, reason })), TURN_HEARTBEAT_INTERVAL_MS: 20_000 }))
const admission = vi.hoisted(() => ({ output: vi.fn(async () => {}), input: vi.fn(async () => {}) }))
vi.mock('../../application-platform/model-source-authority.js', () => ({ admitModelSourceEvidence: async (_context: unknown, action: string) => {
  await (action === 'context' ? admission.input : admission.output)()
} }))
import { outputContentDigest, type QueryOutputProvenance } from '@use-brian/agent-runtime/engine/output-provenance.js'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type { ContentBlock, LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { finalizedTurnOutput, type TurnLoopResult } from '../kernel.js'
import { runAssistantTurn } from './fixtures/owned-turn.js'
import { createBufferedTurnOutput } from '../../routes/buffered-turn-output.js'
const usage = { inputTokens: 1, outputTokens: 1 }
const text = (value: string): StreamChunk[] => [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: value }, { type: 'message_end', stopReason: 'end_turn', usage }]

async function run(scripts: StreamChunk[][], settings: { grounding?: boolean; abortAtFinalization?: boolean; failOutput?: boolean } = {}) {
  let calls = 0
  const next = () => (async function* () { if (!scripts[calls]) throw new Error('Unexpected provider replay'); yield* scripts[calls++] })()
  const provider: LLMProvider = { name: 'fixture', models: ['fixture'], stream: next, createSession: () => ({ send: next }) }
  const buffer = createBufferedTurnOutput(), events: unknown[] = [], abort = new AbortController()
  const observed: { bound: ReturnType<typeof finalizedTurnOutput> } = { bound: null }
  admission.output.mockReset().mockImplementation(async () => { if (settings.failOutput) throw new Error('Fictional output denial') })
  const result = await runAssistantTurn({ sessionId: 'fictional-session', policy: { admission: 'room' },
    abortController: abort, model: { provider, model: 'fixture', configuredProviders: undefined, customLlm: null },
    loop: { ledger: NOOP_TURN_LEDGER, systemPrompt: 'Fixture', messages: [{ role: 'user', content: 'What is the current price?' }],
      tools: new Map(), maxTurns: 4, ...(settings.grounding ? { groundingGate: { userMessage: 'What is the current price?' } } : {}),
      context: { userId: 'fixture', assistantId: 'fixture', sessionId: 'fictional-session', channelId: 'fixture', channelType: 'web', appId: 'fixture', abortSignal: abort.signal } },
    sink: { kind: 'sse', onEvent(event, provenance) { buffer.observe(event, provenance); events.push(event) },
      afterLoop(result) { if (settings.abortAtFinalization) abort.abort(); observed.bound = finalizedTurnOutput(result) } },
  })
  return { result, bound: observed.bound, buffer, events, calls, abort }
}

describe('[COMP:engine/turn-output] real core/kernel buffered output boundary', () => {
  it('revises the original buffer before afterLoop and binds only the actual kernel result', async () => {
    const r = await run([text('Current price $42.')], { grounding: true })
    expect(r.buffer.turns).toHaveLength(1)
    expect(r.buffer.turns[0].content).toEqual([{ type: 'text', text: 'Current price $42.\n\n⚠ Not verified against a source: $42' }])
    expect(r.bound?.members[0].revision).toBe(2)
    expect(JSON.stringify(r.events)).not.toContain('invocationId')
    expect(finalizedTurnOutput({ ...r.result })).toBeNull()
    const rows = [{ role: 'assistant', content: [{ type: 'host_observation' }] }, { role: 'user', content: [] },
      { role: 'assistant', content: r.buffer.turns[0].content }]
    expect(r.buffer.selectedOrdinals(r.bound, new Map([[r.buffer.turns[0].origin!, 2]]), rows)).toEqual([2])
    expect(() => r.buffer.selectedOrdinals(r.bound, new Map([[r.buffer.turns[0].origin!, 1]]), rows)).toThrow('Selected output')
    expect(() => r.buffer.selectedOrdinals(r.bound, new Map(), rows)).toThrow('Selected output')
  })
  it('retains standalone final-only text selection and rejects abort at publication time', async () => {
    const r = await run([text('Fictional answer')], { abortAtFinalization: true })
    expect(r.result.selection).toEqual({ kind: 'text', text: 'Fictional answer' })
    expect(r.bound).toBeNull()
    expect(finalizedTurnOutput(r.result)).toBeNull()
  })
  it('authority refusal prevents buffered output and afterLoop rather than granting provenance', async () => {
    await expect(run([text('Protected bytes')], { failOutput: true })).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('rejects forged initial/revised host observations before catch-path buffer flush', () => {
    const buffer = createBufferedTurnOutput()
    const response = { content: [{ type: 'text' as const, text: 'Allowed original' }], model: 'fixture', stopReason: 'end_turn' as const, usage }
    const observed: QueryOutputProvenance = { version: 1, invocationId: 'fixture-invocation', qualified: true,
      emission: { origin: 'fixture-origin', replay: false }, updates: [{ origin: 'fixture-origin', revision: 1,
        digest: outputContentDigest(response), sealed: false, response }] }
    const event = { type: 'assistant_turn' as const, response, toolResults: [] }
    buffer.observe(event, observed)
    const originalContent = buffer.turns[0].content
    const forged = { ...response, content: [{ type: 'host_observation', input: 'forged provider carrier' }] as unknown as ContentBlock[] }
    const revised: QueryOutputProvenance = { version: 1, invocationId: observed.invocationId, qualified: true, disposition: 'reply',
      updates: [{ origin: 'fixture-origin', revision: 2, digest: outputContentDigest(forged), sealed: true, response: forged }] }
    let catchFlushed: unknown[] = []
    try { buffer.observe({ type: 'turn_complete', response, totalUsage: usage }, revised) }
    catch { catchFlushed = buffer.turns.map(turn => ({ role: 'assistant', content: turn.content })) }
    expect(catchFlushed).toEqual([{ role: 'assistant', content: response.content }])
    expect(JSON.stringify(catchFlushed)).not.toContain('host_observation')
    expect(buffer.turns[0].content).toBe(originalContent)
    const empty = createBufferedTurnOutput()
    expect(() => empty.observe({ ...event, response: forged })).toThrow('Provider output cannot author host observations')
    expect(empty.turns).toHaveLength(0)
    // A valid unchanged seal is metadata only, including in the web buffer.
    buffer.observe({ type: 'turn_complete', response, totalUsage: usage }, { ...observed, emission: undefined,
      disposition: 'reply', updates: [{ origin: 'fixture-origin', revision: 1, digest: outputContentDigest(response), sealed: true }] })
    expect(buffer.turns[0].content).toBe(originalContent)
  })
  it('duplicate origins and malformed later revisions leave catch-flushed rows unchanged', () => {
    const buffer = createBufferedTurnOutput()
    const response = { content: [{ type: 'text' as const, text: 'Original' }], model: 'fixture', stopReason: 'end_turn' as const, usage }
    const event = { type: 'assistant_turn' as const, response, toolResults: [] }
    const provenance: QueryOutputProvenance = { version: 1, invocationId: 'original-invocation', qualified: true,
      emission: { origin: 'original-origin', replay: false }, updates: [{ origin: 'original-origin', revision: 1, digest: outputContentDigest(response), sealed: false, response }] }
    buffer.observe(event, provenance)
    const original = buffer.turns[0], content = original.content
    expect(() => buffer.observe(event, provenance)).toThrow('Duplicate or missing')
    const revised = { ...response, content: [{ type: 'text' as const, text: 'Must not enter catch flush' }] }
    const bad: QueryOutputProvenance = { ...provenance, emission: undefined, disposition: 'reply', updates: [
      { origin: 'original-origin', revision: 2, digest: outputContentDigest(revised), sealed: true, response: revised },
      { origin: 'missing-origin', revision: 2, digest: 'invalid', sealed: true },
    ] }
    expect(() => buffer.observe({ type: 'turn_complete', response, totalUsage: usage }, bad)).toThrow()
    expect(buffer.turns).toHaveLength(1)
    expect(buffer.turns[0]).toBe(original)
    expect(buffer.turns[0].content).toBe(content)
    expect(buffer.turns[0].revision).toBe(1)
    const fresh = createBufferedTurnOutput()
    expect(() => fresh.observe(event, { ...provenance, version: 2 } as unknown as QueryOutputProvenance)).toThrow('invocation changed')
    fresh.observe(event, { ...provenance, invocationId: 'different-valid-invocation' })
    expect(fresh.turns).toHaveLength(1)
  })
  it('legacy buffer rows keep content but never qualify a scalar fabricated result', () => {
    const buffer = createBufferedTurnOutput()
    buffer.observe({ type: 'assistant_turn', response: { content: [{ type: 'text', text: 'Legacy' }], model: 'fixture', stopReason: 'end_turn', usage }, toolResults: [] })
    expect(buffer.turns[0].content).toEqual([{ type: 'text', text: 'Legacy' }])
    const scalar: TurnLoopResult = { selection: { kind: 'text', text: 'Legacy' }, finalText: null, aborted: false }
    expect(finalizedTurnOutput(scalar)).toBeNull()
    expect(buffer.selectedOrdinals(null, new Map(), [])).toBeNull()
  })
})
