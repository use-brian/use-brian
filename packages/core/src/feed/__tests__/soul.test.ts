import { describe, it, expect } from 'vitest'
import { buildFeedSystemPrompt } from '../threads/soul.js'

const baseParams = {
  teamName: 'Acme',
  teamPurpose: 'making widgets',
  assistantBio: 'voice of the team',
}

describe('[COMP:distribution/soul] feed system prompt builder', () => {
  it('grounds the team name, purpose, and assistant bio in the role block', () => {
    const out = buildFeedSystemPrompt({ mode: 'tuning', ...baseParams })
    expect(out).toContain('Acme')
    expect(out).toContain('making widgets')
    expect(out).toContain('voice of the team')
  })

  it('falls back to "the team" when teamName is empty/whitespace', () => {
    const out = buildFeedSystemPrompt({ mode: 'tuning', teamName: '   ' })
    expect(out).toContain('the team')
  })

  it('forbids narrating, recapping, or paraphrasing instructions in private replies', () => {
    // Regression: model was prefacing replies with "Be concise (1–3 sentences).
    // Check your brand voice rules." after long tool chains. Lock in the
    // explicit anti-recap rule so future edits don't drop it silently.
    const out = buildFeedSystemPrompt({ mode: 'tuning', ...baseParams })
    expect(out).toContain('Never preface a reply with a recap')
    expect(out).toMatch(/never narrate what you are about to do/i)
    expect(out).toMatch(/don't open with filler/i)
  })

  it('appends the publishing overlay only in publishing mode', () => {
    const tuning = buildFeedSystemPrompt({ mode: 'tuning', ...baseParams })
    const publishing = buildFeedSystemPrompt({ mode: 'publishing', ...baseParams })
    expect(tuning).not.toContain('# Publishing constraints')
    expect(publishing).toContain('# Publishing constraints')
  })

  it('appends the trust-boundary overlay only in reply-eval mode', () => {
    const tuning = buildFeedSystemPrompt({ mode: 'tuning', ...baseParams })
    const replyEval = buildFeedSystemPrompt({ mode: 'reply-eval', ...baseParams })
    expect(tuning).not.toContain('REPLY-EVAL')
    expect(replyEval).toContain('Trust boundary (REPLY-EVAL)')
    expect(replyEval).toContain('<<<UNTRUSTED>>>')
  })

  it('never names a specific platform or built-in tool (Tool-awareness rule)', () => {
    // Per root CLAUDE.md → Tool-awareness rule: L1 must not name specific
    // platforms or tool identifiers — those flow only through tool descriptions.
    for (const mode of ['tuning', 'publishing', 'reply-eval'] as const) {
      const out = buildFeedSystemPrompt({ mode, ...baseParams })
      expect(out).not.toMatch(/threads|twitter|\bx\.com\b/i)
      expect(out).not.toMatch(/threadsCreatePost|threadsReply|mcp_/)
    }
  })
})
