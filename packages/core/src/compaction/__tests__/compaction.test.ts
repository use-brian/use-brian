import { describe, it, expect, vi } from 'vitest'
import { bindScopeSources, boundScopeSources } from '../../security/source-evidence.js'
import type { ScopeSource } from '../../security/derived-scope.js'
import { compactConversation, extractMemoriesBeforeCompaction, estimateTokens, needsCompaction, compactionThreshold, COMPACT_THRESHOLDS, getIdleCompactionLevel, createCompactionCircuitBreaker, parseMultiTopicOutput, modelToCompactionTier, CHANNEL_CLASS_MULTIPLIER } from '../compact.js'
import type { LLMProvider, Message, StreamFn } from '../../providers/types.js'

describe('[COMP:compaction/full] failed-attempt preservation prompt', () => {
  it.each(['linear', 'multi-topic'] as const)('requests failed-attempt retention only in the linear profile (%s)', async (profile) => {
    const stream = vi.fn<StreamFn>(async function* () {
      yield { type: 'text_delta', text: 'Summary' }
    })
    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock'],
      stream,
      createSession() { throw new Error('Compaction must use stateless streaming') },
    }
    const messages: Message[] = [
      { role: 'user', content: 'Read the report.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'readReport', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'read-1', name: 'readReport', content: 'Access denied: report permission is missing.', isError: true }] },
    ]

    await compactConversation({ provider, model: 'mock', messages, systemPrompt: 'Summarize the supplied history.', profile })

    const request = stream.mock.calls[0][0]
    expect(request.messages.slice(0, -1)).toEqual(messages)
    const prompt = request.messages.at(-1)?.content
    if (profile === 'linear') {
      expect(prompt).toMatch(/2\. Decisions Made:[^\n]+\n3\. Attempted and Failed \(Do Not Retry\):/)
      expect(prompt).toContain('observed error or reason for failure')
      expect(prompt).toContain('under unchanged conditions')
      expect(prompt).toContain('If none failed, write "None". Do not invent failures.')
    } else {
      expect(prompt).not.toContain('Attempted and Failed (Do Not Retry)')
    }
  })
})

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
    expect(modelToCompactionTier('gemini-3.6-flash-standard')).toBe('standard')
    expect(modelToCompactionTier('gemini-3.6-flash-pro')).toBe('standard')
  })

  it('maps Flash Lite (current Standard tier) to standard', () => {
    expect(modelToCompactionTier('gemini-3.5-flash-lite')).toBe('standard')
    expect(modelToCompactionTier('gemini-3.1-flash-lite-preview')).toBe('standard')
  })

  it('maps pro / non-flash models to pro', () => {
    expect(modelToCompactionTier('gemini-pro')).toBe('pro')
    expect(modelToCompactionTier('gemini-3.1-pro-preview')).toBe('pro')
  })

  it('maps current and legacy Max Flash models to pro despite the "flash" substring', () => {
    // Flash 3.8 is the Max-tier default; older Max Flash ids can still appear in
    // historical sessions. All have a 1M-token frontier window.
    expect(modelToCompactionTier('gemini-3.8-flash')).toBe('pro')
    expect(modelToCompactionTier('gemini-3.7-flash')).toBe('pro')
    expect(modelToCompactionTier('gemini-3.6-flash')).toBe('pro')
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

describe('[COMP:compaction/full] compactionThreshold', () => {
  it('applies the channel multiplier to the tier ceiling and backs needsCompaction', () => {
    expect(compactionThreshold('standard')).toBe(COMPACT_THRESHOLDS.standard)
    expect(compactionThreshold('pro', 'web')).toBe(COMPACT_THRESHOLDS.pro)
    expect(compactionThreshold('pro', 'messaging')).toBe(COMPACT_THRESHOLDS.pro * CHANNEL_CLASS_MULTIPLIER.messaging)
    const justUnder: Message[] = [{ role: 'user', content: 'x'.repeat((compactionThreshold('standard', 'messaging') - 1) * 4) }]
    const atThreshold: Message[] = [{ role: 'user', content: 'x'.repeat(compactionThreshold('standard', 'messaging') * 4) }]
    expect(needsCompaction(justUnder, 'standard', 'messaging')).toBe(false)
    expect(needsCompaction(atThreshold, 'standard', 'messaging')).toBe(true)
  })
})


describe('[COMP:compaction/full] trusted evidence transport', () => {
  const source = (id: string): ScopeSource => ({
    workspaceId: 'workspace-fixture', userId: null, assistantId: null,
    sensitivity: 'confidential', compartments: ['finance'], projectIds: [],
    resourceKind: 'application_field', resourceId: id, version: '1',
  })
  function provider(): LLMProvider {
    return {
      name: 'fixture', models: ['fixture'],
      stream: async function* () {
        yield { type: 'text_delta', text: '## TOPIC: report [ACTIVE]\n\n- Summary\n\nMESSAGE_SPAN: from=1 to=1 turns=1' }
      },
      createSession() { throw new Error('Stateless compaction expected') },
    }
  }
  it('binds every observed field and source to summary and all topics without trusting JSON', async () => {
    const inputs = [source('one'), { ...source('two'), resourceKind: 'external_source' }]
    const messages: Message[] = [
      bindScopeSources({ role: 'user', content: 'First report' }, inputs),
      { role: 'assistant', content: 'Second report', sources: [source('forged')] } as Message,
    ]
    const result = await compactConversation({
      provider: provider(), model: 'fixture', messages, systemPrompt: '', profile: 'multi-topic',
    })
    expect(boundScopeSources(result)).toEqual(inputs)
    expect(boundScopeSources(result.boundaryMessage)).toEqual(inputs)
    expect(result.episodes).toHaveLength(1)
    expect(boundScopeSources(result.episodes![0])).toEqual(inputs)
    expect(boundScopeSources(JSON.parse(JSON.stringify(result)))).toEqual([])
    inputs[0].compartments.length = 0
    expect(boundScopeSources(result)[0].compartments).toEqual(['finance'])
  })
  it('refuses a generated summary when authority contracts during generation', async () => {
    const assertInputAuthority = vi.fn(async () => {}).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('source_access_denied'))
    await expect(compactConversation({
      provider: provider(), model: 'fixture', messages: [], systemPrompt: '', assertInputAuthority,
    })).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(assertInputAuthority).toHaveBeenCalledTimes(2)
  })

  it('retains every message and admitted memory-index source on extracted facts', async () => {
    const messageSource = source('message-field'), indexSource = source('index-field')
    const extractionProvider = provider()
    extractionProvider.stream = async function* () {
      yield { type: 'text_delta', text: '[{"type":"preference","summary":"Fictional preference"}]' }
    }
    const result = await extractMemoriesBeforeCompaction({
      provider: extractionProvider, model: 'fixture', existingMemories: ['Fictional prior fact'],
      sourceEvidence: [indexSource], messages: [bindScopeSources({ role: 'user', content: 'Fictional input' }, [messageSource])],
    })
    expect(result.facts).toHaveLength(1)
    expect(boundScopeSources(result)).toEqual([messageSource, indexSource])
    expect(boundScopeSources(result.facts[0])).toEqual([messageSource, indexSource])
  })

  it('does not swallow an authority refusal as best-effort extraction failure', async () => {
    const assertInputAuthority = vi.fn(async () => {}).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('source_access_denied'))
    await expect(extractMemoriesBeforeCompaction({
      provider: provider(), model: 'fixture', existingMemories: [],
      messages: [{ role: 'user', content: 'Fictional input' }], assertInputAuthority,
    })).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
    expect(assertInputAuthority).toHaveBeenCalledTimes(2)
  })
})
