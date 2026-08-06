/**
 * [COMP:brand/prompt-context] — the `# Brand` L1 digest.
 *
 * This block is added to the STABLE prefix of every turn in a workspace that
 * has an approved brand, so two things have to hold. It must be absent — not
 * empty, absent — when there is no approved brand, or every existing
 * workspace and OSS install pays for a feature it does not use. And it must
 * stay under its cap by dropping whole sections in priority order, not by
 * truncating mid-sentence, because a half-quoted brand rule is worse than a
 * missing one.
 *
 * Fixture data is invented throughout.
 */

import { describe, it, expect } from 'vitest'
import { BrandRecordSchema, type BrandRecord } from '@use-brian/shared'
import { BRAND_DIGEST_CHAR_CAP, buildBrandContext } from '../context-builder.js'

function record(overrides: Record<string, unknown> = {}): BrandRecord {
  return BrandRecordSchema.parse({
    naming: {
      name: 'Northwind Ferry',
      tagline: 'Every crossing, on the hour',
      capitalization: 'Northwind Ferry - two words, both capitalized',
      restrictedTerms: ['unsinkable', 'cheapest'],
    },
    messaging: {
      oneLine: 'Scheduled coastal freight you can plan around.',
      voice: [
        { trait: 'Punctual', means: 'Lead with the time and the fact', avoid: 'Scene-setting openers' },
      ],
      preferred: ['crossing', 'sailing'],
      avoid: ['voyage'],
    },
    ...overrides,
  })
}

const input = (r: BrandRecord = record()) => ({
  name: 'Northwind Ferry',
  slug: 'northwind',
  record: r,
  version: 3,
})

describe('[COMP:brand/prompt-context] presence', () => {
  it('returns null when there is no approved brand', () => {
    // Not an empty block, not a "no brand configured" placeholder: a
    // placeholder would change the stable prefix of every workspace on earth
    // to advertise a feature almost none of them have configured.
    expect(buildBrandContext(null)).toBeNull()
  })

  it('emits a header and the approved version pointer when a brand exists', () => {
    const block = buildBrandContext(input())!
    expect(block.startsWith('# Brand\n')).toBe(true)
    expect(block).toContain('brand "northwind"')
    expect(block).toContain('approved version 3')
  })
})

describe('[COMP:brand/prompt-context] content', () => {
  it('carries the per-turn writing rules', () => {
    const block = buildBrandContext(input())!
    expect(block).toContain('Northwind Ferry - two words, both capitalized')
    expect(block).toContain('unsinkable, cheapest')
    expect(block).toContain('Scheduled coastal freight you can plan around.')
    expect(block).toContain('Punctual: Lead with the time and the fact. Avoid: Scene-setting openers')
    expect(block).toContain('Prefer: crossing, sailing')
  })

  it('leaves out the groups only code can act on', () => {
    const withTokens = record({
      colors: [{ name: 'Deep channel', token: '--brand-ink', value: '#0F2233', role: 'primary surface' }],
      typography: [{ role: 'body', family: 'Inter', treatment: '400', fallback: 'Arial' }],
      rights: [{ asset: 'Photos', creator: 'Studio', licence: 'Perpetual' }],
    })
    const block = buildBrandContext(input(withTokens))!
    // A hex value is 2,500 characters of stable prefix spent on something the
    // model cannot apply to prose. It reaches the model through getBrand.
    expect(block).not.toContain('#0F2233')
    expect(block).not.toContain('--brand-ink')
    expect(block).not.toContain('Perpetual')
  })

  it('carries the memory-dedup guard, last', () => {
    const block = buildBrandContext(input())!
    // Without it "our primary color is navy" accumulates as a memory and the
    // workspace ends up with two sources of truth that drift.
    expect(block).toContain('do not save them as memories')
    const dedupIndex = block.indexOf('do not save them as memories')
    expect(dedupIndex).toBeGreaterThan(block.indexOf('# Brand'))
    // It is an instruction about everything above it, so nothing follows it.
    expect(block.slice(dedupIndex)).not.toContain('\n\n')
  })

  it('names knowledge-base sources but no tools', () => {
    const withSources = record({
      sources: [
        { label: 'Positioning brief', kbPath: 'brand/northwind-positioning', contribution: 'strategy' },
        { label: 'Licence PDF', fileId: '11111111-2222-4333-8444-555555555555', contribution: 'typography' },
      ],
    })
    const block = buildBrandContext(input(withSources))!
    expect(block).toContain('brand/northwind-positioning')
    // Layer 1 stays tool-agnostic: an assistant may hold the capability and
    // still have the tool blocked by policy, and a block that told it to
    // "call getBrand" would send it hunting for a tool it cannot reach.
    expect(block).not.toContain('getBrand')
    expect(block).not.toContain('updateBrandDraft')
    expect(block).not.toContain('searchKnowledge')
  })

  it('omits the sources line when no source has a KB path', () => {
    const fileOnly = record({
      sources: [{ label: 'Licence PDF', fileId: '11111111-2222-4333-8444-555555555555', contribution: 'typography' }],
    })
    expect(buildBrandContext(input(fileOnly))!).not.toContain('knowledge base at')
  })

  it('prefers publicName over the legal-ish name', () => {
    const r = record({ naming: { name: 'Northwind Ferry Holdings Ltd', publicName: 'Northwind' } })
    expect(buildBrandContext(input(r))!).toContain('Name: Northwind\n')
  })
})

describe('[COMP:brand/prompt-context] cap', () => {
  /** A brand with far more voice and vocabulary than any digest can hold. */
  function oversized(): BrandRecord {
    return record({
      messaging: {
        oneLine: 'Scheduled coastal freight you can plan around.',
        voice: Array.from({ length: 12 }, (_, i) => ({
          trait: `Trait ${i}`,
          means: 'x'.repeat(180),
          avoid: 'y'.repeat(180),
        })),
        preferred: Array.from({ length: 40 }, (_, i) => `preferred-term-${i}`),
        avoid: Array.from({ length: 40 }, (_, i) => `avoided-term-${i}`),
      },
      strategy: {
        audience: Array.from({ length: 20 }, (_, i) => `Audience segment ${i} `.repeat(8)),
        differentiators: Array.from({ length: 20 }, (_, i) => `Differentiator ${i} `.repeat(8)),
      },
    })
  }

  it('stays within the cap', () => {
    const block = buildBrandContext(input(oversized()))!
    expect(block.length).toBeLessThanOrEqual(BRAND_DIGEST_CHAR_CAP)
  })

  it('drops whole sections in priority order rather than truncating text', () => {
    const block = buildBrandContext(input(oversized()))!
    // Identity and the mechanical writing rules survive; positioning — the
    // group that only changes the rare turn arguing about positioning — is
    // the first to go.
    expect(block).toContain('## Writing rules')
    expect(block).not.toContain('## Positioning')
    // Nothing was cut mid-sentence: every kept line is whole.
    expect(block.endsWith('…')).toBe(false)
    expect(block).not.toMatch(/x{170,}y/)
  })

  it('keeps the pointer lines and the dedup guard even when every section overflows', () => {
    // Deliberately NOT schema-validated: the record schema's per-field caps
    // mean a validated record's identity section always fits, so this branch
    // is unreachable through the normal path today. It is the guard for the
    // day a cap is raised — the block must still route the model to the
    // record rather than silently dropping the brand from the turn.
    const huge = {
      naming: {
        name: 'z'.repeat(BRAND_DIGEST_CHAR_CAP * 2),
        domains: [], handles: [], restrictedTerms: [],
      },
      colors: [], typography: [], logoVariants: [],
      applications: [], claims: [], rights: [], sources: [],
    } as unknown as BrandRecord
    const block = buildBrandContext(input(huge))!
    expect(block).toContain('brand "northwind"')
    expect(block).toContain('do not save them as memories')
    expect(block).not.toContain('zzzz')
    expect(block.length).toBeLessThanOrEqual(BRAND_DIGEST_CHAR_CAP)
  })
})
