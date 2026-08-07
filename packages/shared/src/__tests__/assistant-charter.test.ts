import { describe, it, expect } from 'vitest'
import {
  parseCharter,
  resolveCharter,
  renderCharterBlock,
  charterIsEmpty,
  charterMission,
  CHARTER_FIELD_LIMITS,
} from '../assistant-charter.js'

describe('[COMP:shared/assistant-charter] Assistant charter', () => {
  describe('parseCharter', () => {
    it('accepts the four known fields and trims values', () => {
      expect(
        parseCharter({
          mission: '  Own weekly investor updates  ',
          audience: 'The founder',
          success: 'Numbers before narrative',
          instructions: 'Be terse.',
        }),
      ).toEqual({
        mission: 'Own weekly investor updates',
        audience: 'The founder',
        success: 'Numbers before narrative',
        instructions: 'Be terse.',
      })
    })

    it('drops unknown keys, non-strings, and whitespace-only values', () => {
      expect(
        parseCharter({
          mission: '   ',
          audience: 42,
          instructions: 'Keep this',
          playbook: 'not yet a field',
        }),
      ).toEqual({ instructions: 'Keep this' })
    })

    it('degrades malformed input to an empty charter instead of throwing', () => {
      expect(parseCharter(null)).toEqual({})
      expect(parseCharter('a string')).toEqual({})
      expect(parseCharter(['array'])).toEqual({})
      expect(parseCharter(undefined)).toEqual({})
    })
  })

  describe('resolveCharter (authoritative-if-present, §2 D4)', () => {
    it('treats a non-null charter as the whole truth - legacy columns are ignored', () => {
      const resolved = resolveCharter({
        charter: { mission: 'New mission' },
        systemPrompt: 'stale legacy prompt',
        bio: 'stale legacy bio',
      })
      expect(resolved).toEqual({ mission: 'New mission' })
    })

    it('a present-but-empty charter object does not resurrect legacy text', () => {
      expect(
        resolveCharter({ charter: {}, systemPrompt: 'legacy', bio: 'legacy bio' }),
      ).toEqual({})
    })

    it('falls back to bio→mission and system_prompt→instructions only when charter is NULL', () => {
      expect(
        resolveCharter({ charter: null, systemPrompt: 'Answer from store data.', bio: 'Shopify operator' }),
      ).toEqual({ mission: 'Shopify operator', instructions: 'Answer from store data.' })
      expect(resolveCharter({ charter: undefined, systemPrompt: null, bio: null })).toEqual({})
    })
  })

  describe('renderCharterBlock', () => {
    it('renders only non-empty sections in fixed order under # Charter', () => {
      const block = renderCharterBlock({
        instructions: 'Be terse.',
        mission: 'Own the weekly digest',
      })
      expect(block).toBe('# Charter\n## Mission\nOwn the weekly digest\n\n## Instructions\nBe terse.')
    })

    it('renders all four sections with success as "What good looks like"', () => {
      const block = renderCharterBlock({
        mission: 'M',
        audience: 'A',
        success: 'S',
        instructions: 'I',
      })
      expect(block).toBe(
        '# Charter\n## Mission\nM\n\n## Audience\nA\n\n## What good looks like\nS\n\n## Instructions\nI',
      )
    })

    it('returns null for an empty charter so callers skip the block', () => {
      expect(renderCharterBlock({})).toBeNull()
    })

    it('renders admitted playbook rules as a trailing ## Playbook bullet list', () => {
      const block = renderCharterBlock(
        { mission: 'M' },
        { playbookRules: ['Check the policy doc first', 'Numbers before narrative'] },
      )
      expect(block).toContain('## Playbook')
      expect(block).toContain('- Check the policy doc first\n- Numbers before narrative')
      // The dedup line stops the rules being re-learned as memories.
      expect(block).toContain('do not save them as memories')
      // Playbook comes after every charter section.
      expect(block!.indexOf('## Playbook')).toBeGreaterThan(block!.indexOf('## Mission'))
    })

    it('renders a playbook even when the charter fields are all empty', () => {
      const block = renderCharterBlock({}, { playbookRules: ['Only rule'] })
      expect(block).toContain('# Charter')
      expect(block).toContain('- Only rule')
    })

    it('drops whole rules beyond the char cap, never truncating mid-rule (newest-first survive)', () => {
      const long = 'x'.repeat(250)
      const rules = Array.from({ length: 12 }, (_, i) => `${i}-${long}`)
      const block = renderCharterBlock({ mission: 'M' }, { playbookRules: rules })!
      // ~252 chars per bullet against a 2000 cap → the first ~7 fit.
      expect(block).toContain('- 0-')
      expect(block).not.toContain('- 11-')
      const playbookSection = block.slice(block.indexOf('## Playbook'))
      expect(playbookSection.length).toBeLessThanOrEqual(2000 + '## Playbook\n'.length + 200)
      for (const line of playbookSection.split('\n').filter((l) => l.startsWith('- '))) {
        expect(line.length).toBe('- '.length + 2 + 250)
      }
    })

    it('empty/whitespace rule lists leave the block unchanged', () => {
      expect(renderCharterBlock({ mission: 'M' }, { playbookRules: [] })).not.toContain('## Playbook')
      expect(renderCharterBlock({ mission: 'M' }, { playbookRules: ['  '] })).not.toContain('## Playbook')
      expect(renderCharterBlock({}, { playbookRules: [] })).toBeNull()
    })
  })

  it('charterIsEmpty / charterMission helpers', () => {
    expect(charterIsEmpty({})).toBe(true)
    expect(charterIsEmpty({ mission: 'x' })).toBe(false)
    expect(charterMission({ mission: 'x' })).toBe('x')
    expect(charterMission({})).toBeNull()
  })

  it('field limits keep instructions at the legacy 10k cap and mission at bio-scale', () => {
    expect(CHARTER_FIELD_LIMITS.instructions).toBe(10000)
    expect(CHARTER_FIELD_LIMITS.mission).toBeGreaterThanOrEqual(200)
  })
})
