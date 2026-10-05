import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { billableTurnUsage, createTurnOutputCollector, type QueryEvent } from '@use-brian/core'
import { formatPublicTurnReply } from '../public-turn.js'

const source = readFileSync(new URL('../public-turn.ts', import.meta.url), 'utf8')

function observe(events: QueryEvent[]) {
  const collector = createTurnOutputCollector({ format: 'compact' })
  for (const event of events) collector.observe(event)
  return collector.select()
}

const response = (content: Extract<QueryEvent, { type: 'assistant_turn' }>['response']['content']) => ({
  content,
  stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' as const : 'end_turn' as const,
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'fixture-model',
})

describe('[COMP:api/public-turn-output] final JSON reply', () => {
  it('drops tool narration and renders the terminal response through the real JSON formatter', () => {
    const selected = observe([
      {
        type: 'assistant_turn',
        response: response([
          { type: 'text', text: 'I will inspect that.' },
          { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
        ]),
        toolResults: [],
      },
      {
        type: 'assistant_turn',
        response: response([{ type: 'text', text: 'The verified answer.' }]),
        toolResults: [],
      },
    ])

    expect(formatPublicTurnReply(selected)).toBe('The verified answer.')
  })

  it('sanitizes selected text and preserves the existing empty fallback', () => {
    const selected = observe([{
      type: 'assistant_turn',
      response: response([{
        type: 'text',
        text: 'Ready to reply? Yes.\n\nMessage body:\nClean answer. (Word count: ~2)',
      }]),
      toolResults: [],
    }])

    expect(formatPublicTurnReply(selected)).toBe('Clean answer.')
    expect(formatPublicTurnReply({ kind: 'empty', reason: 'no_model_output' }))
      .toBe("I couldn't generate a reply — please rephrase or try again.")
  })

  it('formats a validated engine question instead of inferring one from a tool turn', () => {
    expect(formatPublicTurnReply({
      kind: 'question',
      question: { question: 'Which account?', options: ['Personal', 'Company'] },
    })).toBe('Which account?\n1. Personal\n2. Company')
  })

  it('keeps SSE delta delivery separate and preserves publication authority and derivation checks', () => {
    expect(source).toContain('const turnOutput = createTurnOutputCollector({ format: \'compact\' })')
    expect(source).toContain('turnOutput.observe(event)')
    expect(source).toMatch(/event\.type === 'text_delta'[\s\S]*?sendEvent\?\.\('text_delta'/)
    expect(source).toMatch(/await assertDeliveryAudience\(\)[\s\S]*?res\.json\(/)
    expect(source).toContain('...currentTurnWrite()')
  })
})


describe('public-turn native-image billing projection', () => {
  it.each([false, true])('separates billing from observed model and metrics (mixed=%s)', (mixed) => {
    const event = {
      response: {
        ...response([{ type: 'text', text: 'Verified answer.' }]),
        model: 'unknown-native-image-model', usageAccounting: 'native_image' as const,
        usage: { inputTokens: 100, outputTokens: 20 },
        ...(mixed ? { billableModel: 'gemini-flash' } : {}),
      },
      totalUsage: mixed ? { inputTokens: 13, outputTokens: 7 } : { inputTokens: 0, outputTokens: 0 },
    }
    const original = structuredClone(event)
    expect(billableTurnUsage(event)).toEqual(mixed ? { model: 'gemini-flash', usage: event.totalUsage } : null)
    expect(event).toEqual(original)
    // Pin the real public consumer: only the projection reaches recordUsage;
    // the observed model still feeds the public reply / served-model telemetry.
    expect(source).toContain('ordinaryBilling = billableTurnUsage(event)')
    expect(source).toContain('if (deps.usageStore && ordinaryBilling)')
    expect(source).toContain('const { model: billableModel, usage } = ordinaryBilling')
    expect(source).toContain('calculateCost(billableModel, usage)')
    expect(source).toMatch(/recordUsage\(\{[\s\S]*?model: billableModel,/)
    expect(source).toContain('responseModel = event.response.model')
    expect(source).toContain('const finalModel = responseModel ?? model')
  })
})
