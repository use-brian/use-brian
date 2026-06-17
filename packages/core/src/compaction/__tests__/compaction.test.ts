import { describe, it, expect } from 'vitest'
import { estimateTokens, needsCompaction, getIdleCompactionLevel, createCompactionCircuitBreaker, parseMultiTopicOutput, modelToCompactionTier, CHANNEL_CLASS_MULTIPLIER } from '../compact.js'
import type { Message } from '../../providers/types.js'

describe('[COMP:compaction/full] estimateTokens', () => {
  it('estimates string content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello world' }, // 11 chars → ~3 tokens
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('estimates content block arrays', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Here is the weather' },
        { type: 'tool_use', id: '1', name: 'weather', input: { city: 'Tokyo' } },
      ]},
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(5)
  })
})

describe('[COMP:compaction/full] needsCompaction', () => {
  it('returns false for short conversations', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    expect(needsCompaction(messages, 'standard')).toBe(false)
  })

  it('returns true when exceeding the standard threshold', () => {
    // Create a message that exceeds 42K tokens (~168K chars)
    const longText = 'a'.repeat(200_000)
    const messages: Message[] = [{ role: 'user', content: longText }]
    expect(needsCompaction(messages, 'standard')).toBe(true)
  })

  it('stays under the pro threshold for the same message', () => {
    const longText = 'a'.repeat(200_000)
    const messages: Message[] = [{ role: 'user', content: longText }]
    expect(needsCompaction(messages, 'pro')).toBe(false)
  })
})

describe('[COMP:compaction/full] modelToCompactionTier', () => {
  it('maps flash aliases and provider ids to standard', () => {
    expect(modelToCompactionTier('gemini-flash')).toBe('standard')
    expect(modelToCompactionTier('gemini-flash-25')).toBe('standard')
    expect(modelToCompactionTier('gemini-3-flash-preview')).toBe('standard')
  })

  it('maps Flash Lite (current Standard tier) to standard', () => {
    expect(modelToCompactionTier('gemini-3.1-flash-lite')).toBe('standard')
    expect(modelToCompactionTier('gemini-3.1-flash-lite-preview')).toBe('standard')
  })

  it('maps pro / non-flash models to pro', () => {
    expect(modelToCompactionTier('gemini-pro')).toBe('pro')
    expect(modelToCompactionTier('gemini-3.1-pro-preview')).toBe('pro')
  })

  it('maps Flash 3.5 (Max-tier default) to pro despite the "flash" substring', () => {
    // Flash 3.5 is the Max-tier default with a 1M-token frontier window.
    // Compacting it at the Flash Lite threshold would shrink what the user
    // paid 5 credits for.
    expect(modelToCompactionTier('gemini-3.5-flash')).toBe('pro')
  })
})

describe('[COMP:compaction/full] getIdleCompactionLevel', () => {
  it('returns none for recent activity', () => {
    expect(getIdleCompactionLevel(new Date())).toBe('none')
  })

  it('returns soft for 4-24h idle', () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000)
    expect(getIdleCompactionLevel(sixHoursAgo)).toBe('soft')
  })

  it('returns hard for 24h+ idle', () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    expect(getIdleCompactionLevel(twoDaysAgo)).toBe('hard')
  })
})

describe('[COMP:compaction/full] Circuit breaker', () => {
  it('opens after 3 failures', () => {
    const cb = createCompactionCircuitBreaker()
    expect(cb.isOpen).toBe(false)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(false)
    cb.recordFailure()
    expect(cb.isOpen).toBe(true)
  })

  it('resets on success', () => {
    const cb = createCompactionCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen).toBe(false) // only 2 consecutive
  })
})

describe('[COMP:compaction/full] channel-class threshold', () => {
  it('applies 0.5x multiplier for messaging', () => {
    const longText = 'a'.repeat(90_000) // ~22.5K tokens — under standard (42K) but over standard*0.5 (21K)
    const messages: Message[] = [{ role: 'user', content: longText }]
    expect(needsCompaction(messages, 'standard')).toBe(false)
    expect(needsCompaction(messages, 'standard', 'messaging')).toBe(true)
  })

  it('leaves web at 1.0x (unchanged behavior)', () => {
    const longText = 'a'.repeat(90_000)
    const messages: Message[] = [{ role: 'user', content: longText }]
    expect(needsCompaction(messages, 'standard', 'web')).toBe(false)
  })

  it('exposes the multiplier table', () => {
    expect(CHANNEL_CLASS_MULTIPLIER.messaging).toBe(0.5)
    expect(CHANNEL_CLASS_MULTIPLIER.web).toBe(1.0)
    expect(CHANNEL_CLASS_MULTIPLIER.cron).toBe(1.0)
  })
})

describe('[COMP:compaction/multi-topic] parseMultiTopicOutput', () => {
  it('parses a three-topic output with one ACTIVE', () => {
    const out = `## TOPIC: brian cheng research [ACTIVE]

- User confirmed Brian is a Deloitte Tax Manager, CUHK grad
- Corrected earlier "Partner" mistake
- Open: user asked for more detail about Brian's clients

MESSAGE_SPAN: from=3 to=18 turns=16

## TOPIC: movie discussion

- Discussed Eternal Sunshine, plot and themes
- No follow-ups pending

MESSAGE_SPAN: from=19 to=28 turns=10

## TOPIC: korean 漢江 naming

- Explained "江" vs "河" distinction
- User was satisfied with the answer

MESSAGE_SPAN: from=29 to=33 turns=5`
    const sections = parseMultiTopicOutput(out)
    expect(sections).toHaveLength(3)
    expect(sections[0].topicLabel).toBe('brian cheng research')
    expect(sections[0].active).toBe(true)
    expect(sections[0].messageSpan).toEqual({ fromSequence: 3, toSequence: 18, turnCount: 16 })
    expect(sections[1].active).toBe(false)
    expect(sections[2].topicLabel).toBe('korean 漢江 naming')
  })

  it('handles single-topic output', () => {
    const out = `## TOPIC: ada price check [ACTIVE]

- User asked for current ADA price
- Answered with real-time data

MESSAGE_SPAN: from=1 to=4 turns=4`
    const sections = parseMultiTopicOutput(out)
    expect(sections).toHaveLength(1)
    expect(sections[0].topicLabel).toBe('ada price check')
    expect(sections[0].active).toBe(true)
  })

  it('tolerates missing ACTIVE marker', () => {
    const out = `## TOPIC: ada price check

- Content

MESSAGE_SPAN: from=1 to=2`
    const sections = parseMultiTopicOutput(out)
    expect(sections).toHaveLength(1)
    expect(sections[0].active).toBe(false)
    expect(sections[0].messageSpan.turnCount).toBe(0) // missing turns= default
  })

  it('returns empty array on garbage input', () => {
    expect(parseMultiTopicOutput('')).toEqual([])
    expect(parseMultiTopicOutput('just some prose with no headers')).toEqual([])
  })

  it('normalizes topic labels (lowercase, trimmed, no trailing punctuation)', () => {
    const out = `## TOPIC:  "Brian Cheng Research!"

- Content

MESSAGE_SPAN: from=1 to=2 turns=1`
    const sections = parseMultiTopicOutput(out)
    expect(sections[0].topicLabel).toBe('brian cheng research')
  })
})
