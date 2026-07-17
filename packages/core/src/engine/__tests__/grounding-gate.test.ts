import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import { buildTool, type Tool } from '../../tools/types.js'
import { EvidenceAccumulator } from '../../security/evidence.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'
import {
  matchFreshFactsQuestion,
  evaluateClaims,
  buildGroundingNudge,
  buildUnverifiedTrailer,
  hasWebVerificationTool,
  matchesDisputedFigure,
  buildDisputeContextNote,
} from '../grounding-gate.js'

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
      calls.push({ messages })
      return streamNext()
    },
  }
  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream: () => streamNext(),
      createSession: (_o: SessionOptions) => session,
    },
  }
}

const textTurn = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

const webSearchStub: Tool = buildTool({
  name: 'webSearch',
  description: 'stub',
  inputSchema: z.object({ query: z.string() }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute() {
    return { data: { results: [] } }
  },
})

function lastUserText(messages: Message[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function run(opts: {
  provider: LLMProvider
  userMessage: string
  groundingGate?: { userMessage: string; draftDelivered?: boolean }
  tools?: Map<string, Tool>
  evidence?: EvidenceAccumulator
}): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({
    provider: opts.provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: opts.userMessage }],
    tools: opts.tools ?? new Map([['webSearch', webSearchStub]]),
    context: {
      userId: 'u',
      assistantId: 'a',
      sessionId: 's',
      appId: 'test',
      channelType: 'web',
      channelId: 'c',
      abortSignal: new AbortController().signal,
      evidence: opts.evidence,
    },
    maxTurns: 10,
    groundingGate: opts.groundingGate,
  })) {
    events.push(e)
  }
  return events
}

// The 2026-07-16 incident message — Cantonese "what's the current welcome
// offer on the SC Cathay credit card", answered twice with confabulated
// figures and zero tool calls.
const INCIDENT_MESSAGE = 'cx sc credit card 而家個迎新係點'
const INCIDENT_DRAFT =
  '依家(2026年7月)渣打國泰卡嘅迎新優惠:簽滿 HK$20,000 送 40,000 里,7月23號前申請。'

const ledgerOf = (events: QueryEvent[]) =>
  events.filter((e) => e.type === 'claim_ledger').flatMap((e) => e.claims)

describe('[COMP:engine/grounding-gate] Fresh-facts heuristic', () => {
  it('matches the incident message (Cantonese freshness cue + volatile noun)', () => {
    expect(matchFreshFactsQuestion(INCIDENT_MESSAGE)).toBe('而家')
  })

  it('matches English current-offer questions', () => {
    expect(
      matchFreshFactsQuestion('what is the current welcome offer for the SC Cathay card?'),
    ).toBeTruthy()
    expect(matchFreshFactsQuestion('how much does the annual fee cost now?')).toBeTruthy()
  })

  it('requires BOTH halves — one alone is everyday chat', () => {
    expect(matchFreshFactsQuestion('call me now please')).toBeNull()
    expect(matchFreshFactsQuestion('而家得閒傾兩句嗎')).toBeNull()
    expect(matchFreshFactsQuestion('the offer we discussed sounds good')).toBeNull()
    expect(matchFreshFactsQuestion('remind me about the deadline tomorrow')).toBeNull()
  })
})

describe('[COMP:engine/grounding-gate] Claims evaluation', () => {
  it('marks every claim unbacked when no evidence accumulator exists', () => {
    const verdicts = evaluateClaims(INCIDENT_DRAFT, undefined)
    expect(verdicts.length).toBeGreaterThanOrEqual(3) // HK$20,000, 40,000 里, 7月23號
    expect(verdicts.every((v) => !v.backed)).toBe(true)
  })

  it('backs claims observed in a tool result, with source attribution', () => {
    const ev = new EvidenceAccumulator()
    ev.noteToolResult(
      '渣打國泰標準卡迎新: 簽 HK$20,000 送 40,000 里, 截止 7月23日',
      '{"query":"渣打國泰卡 迎新優惠"}',
      { toolUseId: 'tool_1', toolName: 'webSearch' },
    )
    const verdicts = evaluateClaims(INCIDENT_DRAFT, ev)
    expect(verdicts.every((v) => v.backed)).toBe(true)
    expect(verdicts[0]!.source).toEqual({ toolUseId: 'tool_1', toolName: 'webSearch' })
  })

  it('backs figures the user themselves supplied (seeded material), across formats', () => {
    const ev = new EvidenceAccumulator()
    ev.note('唔係要 look 11萬咩') // user wrote 11萬
    const verdicts = evaluateClaims('要簽夠十一萬先食盡個迎新', ev)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.backed).toBe(true)
    expect(verdicts[0]!.source).toBeNull() // seeded, not tool-backed
  })

  it('nudge copy names the exact values and never a tool name', () => {
    const channel = buildGroundingNudge({
      draftDelivered: false,
      unbackedValues: ['40,000 里', '7月23號'],
    })
    const web = buildGroundingNudge({ draftDelivered: true, unbackedValues: ['40,000 里'] })
    expect(channel).toContain('40,000 里')
    expect(channel).toContain('7月23號')
    expect(channel).toContain('NOT delivered')
    expect(web).toContain('already shown')
    for (const copy of [channel, web]) {
      expect(copy).not.toMatch(/webSearch|xSearch|urlReader/)
    }
  })

  it('trailer names the unbacked values', () => {
    expect(buildUnverifiedTrailer(['40,000 里'])).toContain('40,000 里')
  })

  it('hasWebVerificationTool checks the narrow web set', () => {
    expect(hasWebVerificationTool(new Map([['webSearch', webSearchStub]]))).toBe(true)
    expect(hasWebVerificationTool(new Map())).toBe(false)
  })
})

describe('[COMP:engine/grounding-gate] Dispute pre-pass helpers', () => {
  it("matches the incident's dispute turn — negation cue + figure", () => {
    expect(matchesDisputedFigure('唔係要 look 11萬咩')).toBe(true)
    expect(matchesDisputedFigure("isn't it HK$110,000?")).toBe(true)
  })

  it('requires both the cue and a figure', () => {
    expect(matchesDisputedFigure('唔係啩')).toBe(false) // cue, no figure
    expect(matchesDisputedFigure('要簽 11萬')).toBe(false) // figure, no cue
    expect(matchesDisputedFigure('thanks, looks right')).toBe(false)
  })

  it('the context note names each claim with its provenance', () => {
    const note = buildDisputeContextNote([
      { claim: '40,000 里', status: 'unverified' },
      { claim: 'HK$5,000', status: 'backed', backedByToolName: 'webSearch' },
    ])
    expect(note).toContain('40,000 里')
    expect(note).toContain('UNVERIFIED')
    expect(note).toContain('webSearch')
    expect(note).toContain('Never re-assert')
  })
})

describe('[COMP:engine/grounding-gate] Query-loop wiring', () => {
  it('injects one nudge naming the unbacked values, then ships the honest rewrite', async () => {
    const { provider, calls } = scriptedProvider([
      textTurn(INCIDENT_DRAFT),
      textTurn('我而家未搵到經核實嘅迎新數字,唔想靠估 — 你想我用網上資料查證一次嗎?'),
    ])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE, draftDelivered: false },
      evidence: new EvidenceAccumulator(),
    })
    expect(calls).toHaveLength(2)
    const nudge = lastUserText(calls[1].messages)
    expect(nudge).toContain('40,000 里')
    expect(nudge).toContain('not verified')
    const nudgeEvents = events.filter((e) => e.type === 'grounding_nudge')
    expect(nudgeEvents).toHaveLength(1)
    expect(nudgeEvents[0]).toMatchObject({ matchedCue: '而家' })
    expect((nudgeEvents[0] as { unbackedCount: number }).unbackedCount).toBeGreaterThanOrEqual(3)
    expect(events.find((e) => e.type === 'turn_complete')).toBeDefined()
  })

  it('backed claims ship untouched, with a backed ledger', async () => {
    const ev = new EvidenceAccumulator()
    ev.noteToolResult(
      '標準卡迎新: HK$5,000 簽賬送 20,000 里',
      '{"query":"sc cathay welcome offer"}',
      { toolUseId: 'tool_9', toolName: 'webSearch' },
    )
    const { provider, calls } = scriptedProvider([
      textTurn('而家標準卡迎新係簽 HK$5,000 送 20,000 里。'),
    ])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE },
      evidence: ev,
    })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
    const ledger = ledgerOf(events)
    expect(ledger.length).toBeGreaterThanOrEqual(2)
    expect(ledger.every((c) => c.status === 'backed')).toBe(true)
    expect(ledger[0]!.backedByToolName).toBe('webSearch')
  })

  it('a stubborn model gets the trailer annotation and an unverified ledger', async () => {
    const { provider, calls } = scriptedProvider([
      textTurn(INCIDENT_DRAFT),
      textTurn(INCIDENT_DRAFT), // ignores the nudge, same confabulated figures
    ])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE },
      evidence: new EvidenceAccumulator(),
    })
    expect(calls).toHaveLength(2)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(1)
    // Trailer streamed as a delta AND baked into the final turn content.
    const deltas = events
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(deltas).toContain('⚠ Not verified against a source')
    const complete = events.find((e) => e.type === 'turn_complete')!
    const finalText = complete.response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(finalText).toContain('⚠ Not verified against a source')
    expect(ledgerOf(events).every((c) => c.status === 'unverified')).toBe(true)
  })

  it('generative (non-fresh-facts) turns are never nudged but still get a ledger', async () => {
    const { provider, calls } = scriptedProvider([
      textTurn('Proposed tiers: $29, $99 and $299 per month, or HK$2,000 yearly.'),
    ])
    const events = await run({
      provider,
      userMessage: 'please draft pricing tiers for our product',
      groundingGate: { userMessage: 'please draft pricing tiers for our product' },
      evidence: new EvidenceAccumulator(),
    })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
    const deltas = events
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(deltas).not.toContain('⚠ Not verified')
    expect(ledgerOf(events).length).toBeGreaterThan(0)
  })

  it('no verification tool bound: annotates immediately instead of nudging', async () => {
    const { provider, calls } = scriptedProvider([textTurn(INCIDENT_DRAFT)])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE },
      tools: new Map(),
      evidence: new EvidenceAccumulator(),
    })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
    const deltas = events
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(deltas).toContain('⚠ Not verified against a source')
  })

  it('does nothing when the lane did not opt in (default behavior preserved)', async () => {
    const { provider, calls } = scriptedProvider([textTurn(INCIDENT_DRAFT)])
    const events = await run({ provider, userMessage: INCIDENT_MESSAGE })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'claim_ledger')).toHaveLength(0)
  })

  it('figure-less replies (clarifying questions) never trip the gate', async () => {
    const { provider, calls } = scriptedProvider([textTurn('你想問邊張卡嘅迎新?等我幫你查下先。')])
    const events = await run({
      provider,
      userMessage: INCIDENT_MESSAGE,
      groundingGate: { userMessage: INCIDENT_MESSAGE },
      evidence: new EvidenceAccumulator(),
    })
    expect(calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'grounding_nudge')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'claim_ledger')).toHaveLength(0)
  })
})
