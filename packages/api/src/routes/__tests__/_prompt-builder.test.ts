import { describe, it, expect } from 'vitest'
import {
  buildFullSystemPrompt,
  buildSplitSystemPrompt,
  resolveLayer1Prompt,
  maybeAppendFollowupChips,
} from '../_prompt-builder.js'

const baseArgs = {
  basePrompt: 'LAYER1_BASE',
  currentDateTime: 'Monday, April 20, 2026 at 09:15 AM PDT',
  timezone: 'America/Los_Angeles',
  memoryContext: '## Memory Index\n[id:aaa] Food: vegetarian',
}

describe('[COMP:prompt/builder] Layer 2 — assistant custom instructions', () => {
  it('renders Layer 2 immediately after Layer 1 when provided', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      assistantInstructions: 'Always reply starting with "GM"',
    })

    const layer1Idx = out.indexOf('LAYER1_BASE')
    const layer2Idx = out.indexOf('# Assistant instructions')
    const memoryIdx = out.indexOf('## Memory Index')

    expect(layer1Idx).toBeGreaterThanOrEqual(0)
    expect(layer2Idx).toBeGreaterThan(layer1Idx)
    expect(memoryIdx).toBeGreaterThan(layer2Idx)
    // No content appears between Layer 1 and Layer 2 other than block separator.
    expect(out.slice(layer1Idx + 'LAYER1_BASE'.length, layer2Idx)).toBe('\n\n')
    // Layer 2 body renders verbatim under its header.
    expect(out).toContain('# Assistant instructions\nAlways reply starting with "GM"')
  })

  it('skips the Layer 2 block when instructions are null, undefined, or whitespace', () => {
    for (const instr of [null, undefined, '', '   ', '\n\n\t']) {
      const out = buildFullSystemPrompt({ ...baseArgs, assistantInstructions: instr })
      expect(out).not.toContain('# Assistant instructions')
    }
  })

  it('trims surrounding whitespace from Layer 2 body', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      assistantInstructions: '\n  Only respond in French  \n',
    })
    expect(out).toContain('# Assistant instructions\nOnly respond in French')
    // Trailing whitespace should not leak into the block.
    expect(out).not.toContain('French  \n')
  })
})

describe('[COMP:prompt/builder] Cache-aligned block order', () => {
  it('places the stable prefix (Layer 1 → Layer 2 → memory → skills) before the volatile suffix (datetime → …)', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      assistantInstructions: 'LAYER2_BODY',
      skillsFragment: '## Skills\nSKILLS_BODY',
      episodicContext: '# Relevant topic history\nEP_BODY',
      groupChatContext: '# Group chat\nGC_BODY',
      unavailableCapabilitiesPrompt: '# Unavailable capabilities\nUC_BODY',
      pendingMessagesFragment: '# Pending messages\nPM_BODY',
      preflightContext: '# Preflight\nPF_BODY',
    })

    const order = [
      'LAYER1_BASE',
      '# Assistant instructions',
      '## Memory Index',
      '## Skills',
      '# User Context',
      '# Relevant topic history',
      '# Group chat',
      '# Unavailable capabilities',
      '# Pending messages',
      '# Preflight',
    ]

    const positions = order.map((needle) => ({ needle, idx: out.indexOf(needle) }))
    for (const { needle, idx } of positions) {
      expect(idx, `missing block: ${needle}`).toBeGreaterThanOrEqual(0)
    }
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i].idx,
        `expected "${positions[i].needle}" to appear after "${positions[i - 1].needle}"`,
      ).toBeGreaterThan(positions[i - 1].idx)
    }
  })

  it('places episodic history immediately before the topic hint so the hint can reference it', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      episodicContext: '# Relevant topic history\nEP_BODY',
      topicHint: {
        topic_label: 'travel-planning',
        state: 'resume',
        confidence: 0.9,
        related_topics: [],
      },
    })
    const epIdx = out.indexOf('# Relevant topic history')
    const topicIdx = out.indexOf('# Current topic')
    expect(epIdx).toBeGreaterThan(0)
    expect(topicIdx).toBeGreaterThan(epIdx)
  })

  it('puts datetime (volatile) below memory (stable) for cache alignment', () => {
    const out = buildFullSystemPrompt(baseArgs)
    const memoryIdx = out.indexOf('## Memory Index')
    const datetimeIdx = out.indexOf('# User Context')
    expect(memoryIdx).toBeGreaterThan(0)
    expect(datetimeIdx).toBeGreaterThan(memoryIdx)
  })

  it('emits user context block unconditionally, even when all volatile tail blocks are absent', () => {
    const out = buildFullSystemPrompt(baseArgs)
    expect(out).toContain('# User Context')
    expect(out).toContain('Current date and time: Monday, April 20, 2026 at 09:15 AM PDT')
    expect(out).toContain('Timezone: America/Los_Angeles')
  })
})

describe('[COMP:prompt/builder] User Context — presence vs anchor (travel)', () => {
  it('renders the single-line form when anchor matches presence', () => {
    const out = buildFullSystemPrompt({ ...baseArgs, anchorTimezone: 'America/Los_Angeles' })
    expect(out).toContain('Current date and time: Monday, April 20, 2026 at 09:15 AM PDT')
    expect(out).toContain('Timezone: America/Los_Angeles')
    expect(out).not.toContain('Home timezone')
    expect(out).not.toContain('travelling')
  })

  it('renders the single-line form when anchor is null/empty', () => {
    const outNull = buildFullSystemPrompt({ ...baseArgs, anchorTimezone: null })
    expect(outNull).not.toContain('Home timezone')
    const outEmpty = buildFullSystemPrompt({ ...baseArgs, anchorTimezone: '' })
    expect(outEmpty).not.toContain('Home timezone')
  })

  it('renders the dual-line form when anchor differs from presence', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      currentDateTime: 'Monday, April 27, 2026 at 02:40 AM JST',
      timezone: 'Asia/Tokyo',
      anchorTimezone: 'Asia/Hong_Kong',
    })
    expect(out).toContain('Current local time (where the user is now): Monday, April 27, 2026 at 02:40 AM JST')
    expect(out).toContain('Local timezone: Asia/Tokyo')
    expect(out).toContain('Home timezone (used for recurring reminders / scheduled jobs): Asia/Hong_Kong')
    expect(out).toContain('The user is travelling.')
    expect(out).toContain('do not substitute a city from earlier conversation context')
  })

  it('the dual-line form names both zones in order (local first, home second)', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      timezone: 'Asia/Tokyo',
      anchorTimezone: 'Asia/Hong_Kong',
    })
    const tokyoIdx = out.indexOf('Asia/Tokyo')
    const hkIdx = out.indexOf('Asia/Hong_Kong')
    expect(tokyoIdx).toBeGreaterThan(0)
    expect(hkIdx).toBeGreaterThan(tokyoIdx)
  })
})

describe('[COMP:prompt/builder] Optional blocks', () => {
  it('omits reply context when input is null', () => {
    const out = buildFullSystemPrompt({ ...baseArgs, replyContext: null })
    expect(out).not.toContain('# Reply context')
  })

  it('renders reply context with the assistant/other-user distinction', () => {
    const fromAssistant = buildFullSystemPrompt({
      ...baseArgs,
      replyContext: { text: 'earlier response', fromAssistant: true },
    })
    expect(fromAssistant).toContain('you (the assistant)')

    const fromOther = buildFullSystemPrompt({
      ...baseArgs,
      replyContext: { text: 'earlier message', fromAssistant: false },
    })
    expect(fromOther).toContain('another user')
  })

  it('omits topic hint when confidence is zero or label is "(uncategorized)"', () => {
    const zeroConf = buildFullSystemPrompt({
      ...baseArgs,
      topicHint: { topic_label: 'x', state: 'continue', confidence: 0, related_topics: [] },
    })
    expect(zeroConf).not.toContain('# Current topic')

    const uncategorized = buildFullSystemPrompt({
      ...baseArgs,
      topicHint: { topic_label: '(uncategorized)', state: 'continue', confidence: 0.8, related_topics: [] },
    })
    expect(uncategorized).not.toContain('# Current topic')
  })
})

describe('[COMP:prompt/builder] Doc skill block', () => {
  const DOC_SKILL = '# Working on a Doc page\nAUTHORING_PROTOCOL'

  it('injects the doc skill block in the stable prefix (after skills, before User Context)', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      skillsFragment: '## Skills\nSKILLS_BODY',
      docSkillBlock: DOC_SKILL,
    })
    const skillsIdx = out.indexOf('## Skills')
    const docIdx = out.indexOf('# Working on a Doc page')
    const userCtxIdx = out.indexOf('# User Context')
    expect(skillsIdx).toBeGreaterThan(0)
    expect(docIdx).toBeGreaterThan(skillsIdx)
    expect(userCtxIdx).toBeGreaterThan(docIdx)
  })

  it('omits the block when null / undefined / empty / whitespace', () => {
    for (const block of [null, undefined, '', '   ', '\n\t']) {
      const out = buildFullSystemPrompt({ ...baseArgs, docSkillBlock: block })
      expect(out).not.toContain('# Working on a Doc page')
    }
  })
})

describe('[COMP:prompt/builder] Workspace memory-evolution snippet', () => {
  it('renders the snippet immediately after Layer 2 and before memory context', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      assistantInstructions: 'LAYER2_BODY',
      workspaceEvolutionSnippet:
        '# Workspace memory conventions\nRecent corrections in this workspace suggest the following biases for future memory saves:\n- evolution bullet',
    })

    const layer2Idx = out.indexOf('# Assistant instructions')
    const evoIdx = out.indexOf('# Workspace memory conventions')
    const memoryIdx = out.indexOf('## Memory Index')

    expect(layer2Idx).toBeGreaterThan(0)
    expect(evoIdx).toBeGreaterThan(layer2Idx)
    expect(memoryIdx).toBeGreaterThan(evoIdx)
  })

  it('skips the snippet block when null / undefined / empty / whitespace', () => {
    for (const snippet of [null, undefined, '', '   ', '\n\t']) {
      const out = buildFullSystemPrompt({
        ...baseArgs,
        workspaceEvolutionSnippet: snippet,
      })
      expect(out).not.toContain('# Workspace memory conventions')
    }
  })

  it('renders without a Layer 2 — the snippet appears between Layer 1 and memory', () => {
    const out = buildFullSystemPrompt({
      ...baseArgs,
      assistantInstructions: null,
      workspaceEvolutionSnippet: '# Workspace memory conventions\n- alone bullet',
    })
    const layer1Idx = out.indexOf('LAYER1_BASE')
    const evoIdx = out.indexOf('# Workspace memory conventions')
    const memoryIdx = out.indexOf('## Memory Index')
    expect(layer1Idx).toBeGreaterThanOrEqual(0)
    expect(evoIdx).toBeGreaterThan(layer1Idx)
    expect(memoryIdx).toBeGreaterThan(evoIdx)
  })
})

describe('[COMP:prompt/layer1-resolver] resolveLayer1Prompt', () => {
  const defaultPrompt = 'PERSONAL_LAYER_1_BASE'

  it('returns the default prompt unchanged for standard assistants', () => {
    const out = resolveLayer1Prompt({
      defaultPrompt,
      assistant: { kind: 'standard', name: 'Chad' },
      // resolveAppSoul must never be consulted for a non-app assistant.
      resolveAppSoul: () => 'SHOULD_NOT_BE_USED',
    })
    expect(out).toBe(defaultPrompt)
  })

  it('returns the soul from the injected resolveAppSoul hook for an app assistant', () => {
    const out = resolveLayer1Prompt({
      defaultPrompt,
      assistant: { kind: 'app', name: 'Acme App', appType: 'distribution' },
      team: { name: 'Acme', purpose: 'Ship rockets' },
      resolveAppSoul: (p) => `SOUL:${p.appType}:${p.name}`,
    })
    expect(out).toBe('SOUL:distribution:Acme App')
  })

  it('forwards appType, name, team, assistantBio and mode to resolveAppSoul', () => {
    let received: unknown
    resolveLayer1Prompt({
      defaultPrompt,
      assistant: { kind: 'app', name: 'Orbital', appType: 'distribution' },
      team: { name: 'T', purpose: 'P' },
      assistantBio: 'BIO',
      mode: 'publishing',
      resolveAppSoul: (p) => {
        received = p
        return 'X'
      },
    })
    expect(received).toEqual({
      appType: 'distribution',
      name: 'Orbital',
      team: { name: 'T', purpose: 'P' },
      assistantBio: 'BIO',
      mode: 'publishing',
    })
  })

  it('falls back to the default prompt when resolveAppSoul returns null (unknown appType)', () => {
    const out = resolveLayer1Prompt({
      defaultPrompt,
      assistant: { kind: 'app', name: 'A', appType: 'mystery' },
      resolveAppSoul: () => null,
    })
    expect(out).toBe(defaultPrompt)
  })

  it('falls back to the default prompt when no resolveAppSoul is wired (open build)', () => {
    const out = resolveLayer1Prompt({
      defaultPrompt,
      assistant: { kind: 'app', name: 'A', appType: 'distribution' },
    })
    expect(out).toBe(defaultPrompt)
  })

})

describe('[COMP:prompt/builder] maybeAppendFollowupChips — chip addendum gating', () => {
  const base = 'BASE_PROMPT'

  it('appends the chip addendum for a standard assistant when the client opts in', () => {
    const out = maybeAppendFollowupChips(base, {
      followupChips: true,
      assistantKind: 'standard',
    })
    expect(out).not.toBe(base)
    expect(out).toContain(base)
    expect(out).toContain('<followup>')
    expect(out).toContain('Follow-up questions')
  })

  it('does NOT append when the client did not opt in (the doc-editor case)', () => {
    expect(maybeAppendFollowupChips(base, { assistantKind: 'standard' })).toBe(base)
    expect(
      maybeAppendFollowupChips(base, { followupChips: false, assistantKind: 'standard' }),
    ).toBe(base)
  })

  it('never appends for app assistants even when the flag is set (doc/feed souls)', () => {
    expect(
      maybeAppendFollowupChips(base, { followupChips: true, assistantKind: 'app' }),
    ).toBe(base)
  })

  it('appends for a primary assistant when opted in', () => {
    const out = maybeAppendFollowupChips(base, {
      followupChips: true,
      assistantKind: 'primary',
    })
    expect(out).toContain('<followup>')
  })
})

describe('[COMP:prompt/builder] buildSplitSystemPrompt — cache-stable split', () => {
  it('keeps stablePrompt byte-identical across turns that differ only in volatile sections', () => {
    const turnA = buildSplitSystemPrompt({
      ...baseArgs,
      assistantInstructions: 'Persona',
      currentDateTime: 'Monday, April 20, 2026 at 09:15 AM PDT',
      sessionStateBlock: '# Open commitments\n- book flights',
      episodicContext: '# Relevant topic history\ntravel planning',
    })
    const turnB = buildSplitSystemPrompt({
      ...baseArgs,
      assistantInstructions: 'Persona',
      currentDateTime: 'Monday, April 20, 2026 at 09:16 AM PDT', // clock ticked
      sessionStateBlock: '# Open commitments\n- (none)',
      episodicContext: '# Relevant topic history\ncooking',
    })
    // The whole point of the split: per-turn churn must not touch the
    // system-prompt half, or the provider's implicit-cache prefix (system
    // prompt + history) breaks on every turn.
    expect(turnA.stablePrompt).toBe(turnB.stablePrompt)
    expect(turnA.turnContext).not.toBe(turnB.turnContext)
  })

  it('routes volatile sections to turnContext and stable sections to stablePrompt', () => {
    const out = buildSplitSystemPrompt({
      ...baseArgs,
      assistantInstructions: 'Persona',
      docSkillBlock: '# Working on a Doc page\nprotocol',
      episodicContext: '# Relevant topic history\nstuff',
      replyContext: { text: 'earlier message', fromAssistant: true },
    })
    expect(out.stablePrompt).toContain('LAYER1_BASE')
    expect(out.stablePrompt).toContain('# Assistant instructions')
    expect(out.stablePrompt).toContain('# Working on a Doc page')
    expect(out.stablePrompt).toContain('## Memory Index')
    expect(out.stablePrompt).not.toContain('Current date and time')
    expect(out.turnContext).toContain('Current date and time')
    expect(out.turnContext).toContain('# Relevant topic history')
    expect(out.turnContext).toContain('# Reply context')
    expect(out.turnContext).not.toContain('LAYER1_BASE')
  })

  it('recombines to exactly buildFullSystemPrompt', () => {
    const args = {
      ...baseArgs,
      assistantInstructions: 'Persona',
      episodicContext: '# Relevant topic history\nstuff',
      anchorTimezone: 'Asia/Hong_Kong',
    }
    const combined = buildFullSystemPrompt(args)
    const split = buildSplitSystemPrompt(args)
    expect([split.stablePrompt, split.turnContext].join('\n\n')).toBe(combined)
  })
})
