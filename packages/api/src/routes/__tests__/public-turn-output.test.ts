import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { formatPublicTurnReply } from '../public-turn.js'

const source = readFileSync(new URL('../public-turn.ts', import.meta.url), 'utf8')

describe('[COMP:api/public-turn-output] final JSON reply', () => {
  it('renders the owner’s selected text and preserves the existing empty fallback', () => {
    expect(formatPublicTurnReply({ selection: { kind: 'text', text: 'Original answer' }, finalText: 'Clean answer.' }))
      .toBe('Clean answer.')
    expect(formatPublicTurnReply({ selection: { kind: 'empty', reason: 'no_model_output' }, finalText: null }))
      .toBe("I couldn't generate a reply — please rephrase or try again.")
  })

  it('formats a validated engine question instead of inferring one from a tool turn', () => {
    expect(formatPublicTurnReply({
      selection: { kind: 'question', question: { question: 'Which account?', options: ['Personal', 'Company'] } },
      finalText: null,
    })).toBe('Which account?\n1. Personal\n2. Company')
  })

  it('keeps SSE delta delivery separate and preserves publication authority and derivation checks', () => {
    expect(source).toContain('formatPublicTurnReply(turnLoopResult)')
    expect(source).not.toContain('createTurnOutputCollector')
    expect(source).toMatch(/event\.type === 'text_delta'[\s\S]*?sendEvent\?\.\('text_delta'/)
    expect(source).toMatch(/await assertDeliveryAudience\(\)[\s\S]*?res\.json\(/)
    // The reply publishes through the original owner with the turn's derivation
    // write and native transcript authority (turn-kernel.md "Reply publication").
    expect(source).toContain("turnOwner!.publish({ disposition: 'reply', write: publicationWrite(), native: nativeTranscriptAuthority,")
    expect(source).not.toMatch(/addSessionMessage\(\{[^}]*role: 'assistant'/)
  })
})
