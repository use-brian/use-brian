/**
 * Unit tests for the team voice-category memory loader / renderer.
 * Component tag: [COMP:memory/category-loader].
 *
 * Covers the `## Voice Rules` block of buildMemoryContext — the render
 * half of the category='voice' loader (the DB half is
 * memories.getWorkspaceMemoriesByCategory). Verifies the block renders
 * only when voice rules exist, the guidance preamble, the id-truncated
 * rule lines + indented detail, and that it sits after Team Context.
 */

import { describe, it, expect } from 'vitest'
import {
  buildMemoryContext,
  voicePlatformFromDraftTitle,
  VOICE_PLATFORM_TAGS,
  type VoiceRuleEntry,
} from '../context-builder.js'

function rule(over: Partial<VoiceRuleEntry> = {}): VoiceRuleEntry {
  return {
    id: '11111111-2222-3333',
    summary: 'Use active voice',
    detail: null,
    confidence: 0.9,
    ...over,
  }
}

describe('[COMP:memory/category-loader] buildMemoryContext voice rules', () => {
  it('omits the Voice Rules block when no voice rules are supplied', () => {
    const out = buildMemoryContext({ identityMemories: [], memoryIndex: [] })
    expect(out).not.toContain('## Voice Rules')
  })

  it('omits the Voice Rules block for an empty voice-rule list', () => {
    const out = buildMemoryContext({ identityMemories: [], memoryIndex: [], teamVoiceRules: [] })
    expect(out).not.toContain('## Voice Rules')
  })

  it('renders the Voice Rules block with the guidance preamble', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamVoiceRules: [rule()],
    })
    expect(out).toContain('## Voice Rules')
    expect(out).toContain("brand's published voice")
    expect(out).toContain('[id:11111111] Use active voice')
  })

  it('renders a rule detail indented under the rule head', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamVoiceRules: [rule({ detail: 'Avoid passive constructions.' })],
    })
    expect(out).toContain('[id:11111111] Use active voice\n  Avoid passive constructions.')
  })

  it('filters other-platform rules in a draft session targeting one platform', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      voiceTargetPlatform: 'xhs',
      teamVoiceRules: [
        rule({ id: 'aaaaaaaa-1', summary: 'General warmth', tags: ['voice'] }),
        rule({ id: 'bbbbbbbb-1', summary: 'Emoji-heavy hooks', tags: ['voice', 'xhs'] }),
        rule({ id: 'cccccccc-1', summary: 'Terse and dry', tags: ['voice', 'twitter'] }),
      ],
    })
    expect(out).toContain('General warmth')
    expect(out).toContain('[xhs] Emoji-heavy hooks')
    expect(out).not.toContain('Terse and dry')
  })

  it('renders every rule with platform labels when no target platform is set (tuning chat)', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamVoiceRules: [
        rule({ id: 'aaaaaaaa-1', summary: 'General warmth' }),
        rule({ id: 'bbbbbbbb-1', summary: 'Emoji-heavy hooks', tags: ['voice', 'xhs'] }),
        rule({ id: 'cccccccc-1', summary: 'Terse and dry', tags: ['voice', 'twitter', 'threads'] }),
      ],
    })
    expect(out).toContain('[id:aaaaaaaa] General warmth')
    expect(out).toContain('[xhs] Emoji-heavy hooks')
    expect(out).toContain('[twitter, threads] Terse and dry')
    expect(out).toContain('applies only when writing for that platform')
  })

  it('omits the platform-label preamble sentence when no rule is scoped', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamVoiceRules: [rule({ tags: ['voice'] })],
    })
    expect(out).not.toContain('applies only when writing for that platform')
  })

  it('omits the block entirely when the target platform filters out every rule', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      voiceTargetPlatform: 'instagram',
      teamVoiceRules: [rule({ tags: ['voice', 'twitter'] })],
    })
    expect(out).not.toContain('## Voice Rules')
  })

  it('voicePlatformFromDraftTitle reads the draft title prefix', () => {
    expect(voicePlatformFromDraftTitle('[xhs] New draft')).toBe('xhs')
    expect(voicePlatformFromDraftTitle('[twitter] Reply to @jane')).toBe('twitter')
    expect(voicePlatformFromDraftTitle('[mastodon] New draft')).toBeNull()
    expect(voicePlatformFromDraftTitle('New Chat')).toBeNull()
    expect(voicePlatformFromDraftTitle(null)).toBeNull()
    // The tag set mirrors the feed target platforms.
    expect(VOICE_PLATFORM_TAGS).toEqual(['instagram', 'threads', 'twitter', 'xhs'])
  })

  it('places the Voice Rules block after the Team Context block', () => {
    const out = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamPurpose: 'Ship the brand newsletter',
      teamVoiceRules: [rule()],
    })
    expect(out.indexOf('## Team Context')).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('## Voice Rules')).toBeGreaterThan(out.indexOf('## Team Context'))
  })
})
