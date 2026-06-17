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
import { buildMemoryContext, type VoiceRuleEntry } from '../context-builder.js'

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
