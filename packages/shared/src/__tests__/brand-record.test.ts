/**
 * [COMP:brand/record-schema] — the canonical brand record schema.
 *
 * Four independent writers validate against this one schema (Studio form,
 * `updateBrandDraft`, brain-MCP `saveBrandDraft`, the workspace routes), so a
 * loosened field here loosens all four at once. These tests pin the shape
 * that matters: what is required, what the enums admit, that unknown keys are
 * rejected rather than silently dropped, and that a patch replaces a group
 * whole rather than deep-merging it.
 *
 * All fixture data is invented (docs/plans/brand-primitive.md is about a real
 * agency engagement; none of that material appears here).
 */

import { describe, it, expect } from 'vitest'
import {
  APPLICATION_KINDS,
  BRAND_RECORD_GROUPS,
  BrandRecordPatchSchema,
  BrandRecordSchema,
  CLAIM_STATUSES,
  DECISION_STATUSES,
  LOGO_VARIANTS,
  emptyBrandRecord,
  mergeBrandRecordPatch,
} from '../brand/record.js'

/**
 * A fully-populated record touching every §4 group. Fictional throughout:
 * "Northwind Ferry" is an invented company on a reserved `.example` domain.
 */
const FULL_RECORD = {
  naming: {
    name: 'Northwind Ferry',
    publicName: 'Northwind',
    legalName: 'Northwind Ferry Holdings Ltd',
    descriptor: 'the coastal logistics network',
    capitalization: 'Northwind Ferry - two words, both capitalized, never NorthwindFerry',
    pronunciation: 'NORTH-wind',
    tagline: 'Every crossing, on the hour',
    domains: ['northwind-ferry.example'],
    handles: ['@northwindferry'],
    trademarkStatus: 'Registered, class 39, EU',
    restrictedTerms: ['unsinkable', 'cheapest'],
  },
  strategy: {
    purpose: 'Move freight between islands without the wait.',
    mission: 'Run a schedule people can plan a business around.',
    vision: 'Coastal freight that feels like a commuter line.',
    audience: ['Island wholesalers', 'Regional hauliers'],
    positioning: 'The scheduled alternative to chartered crossings.',
    promise: 'If the sailing is listed, it sails.',
    differentiators: ['Fixed hourly departures', 'Published on-time record'],
    personality: ['Punctual', 'Plain-spoken'],
    notPersonality: ['Nautical-whimsical', 'Luxury'],
  },
  messaging: {
    oneLine: 'Scheduled coastal freight you can plan around.',
    elevator: 'Northwind runs hourly freight crossings on a published timetable.',
    supportingLine: 'Book the hour, not the boat.',
    pillars: [
      {
        title: 'Schedule first',
        statement: 'The timetable is the product.',
        proof: ['Hourly departures since 2019'],
      },
    ],
    voice: [
      { trait: 'Punctual', means: 'Lead with the time and the fact', avoid: 'Scene-setting openers' },
      { trait: 'Plain', means: 'Use the word a dockhand would use', avoid: 'Logistics jargon' },
    ],
    toneNotes: ['Never apologise for weather; state the reschedule.'],
    preferred: ['crossing', 'sailing', 'timetable'],
    avoid: ['voyage', 'journey'],
    localeNotes: { ja: 'Use the 24-hour clock in all timetable copy.' },
  },
  colors: [
    {
      name: 'Deep channel',
      token: '--brand-ink',
      value: '#0F2233',
      role: 'primary surface',
      status: 'approved',
      contrastPairs: [
        { foreground: '--brand-paper', background: '--brand-ink', ratio: '14.2:1', usage: 'body copy' },
      ],
    },
    { name: 'Signal', token: '--brand-signal', value: '#F25C05', role: 'accent', status: 'recommended' },
  ],
  typography: [
    {
      role: 'display',
      family: 'Inter Tight',
      treatment: '600 weight, -2% tracking',
      fallback: 'Helvetica Neue, Arial, sans-serif',
      licence: 'SIL Open Font License 1.1',
      source: 'Google Fonts',
    },
  ],
  logoVariants: [
    {
      variant: 'primary',
      fileId: '11111111-2222-4333-8444-555555555555',
      minSize: '18px tall on screen',
      backgrounds: ['paper', 'deep channel'],
      clearSpace: 'one cap-height on all sides',
      notes: 'Never re-tint',
    },
    { variant: 'favicon' },
  ],
  visual: {
    logoRules: ['Never rotate the mark'],
    visualPrinciples: ['Timetable grid over photography'],
    imagery: ['Working dock photography, no drone shots'],
    motion: ['Cuts, never dissolves'],
  },
  applications: [
    {
      name: 'Sailing manifest',
      kind: 'letterhead',
      status: 'approved',
      binding: { fileId: '66666666-7777-4888-8999-aaaaaaaaaaaa' },
      notes: 'Printed duplex',
    },
    {
      name: 'Quarterly review deck',
      kind: 'presentation',
      status: 'open',
      binding: { officeTemplateId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', version: 3 },
    },
    { name: 'Booking site', kind: 'web', status: 'observed', binding: { url: 'https://northwind-ferry.example' } },
  ],
  claims: [
    { text: '98% of sailings depart within ten minutes of schedule.', status: 'approved', evidence: 'Port authority log, 2025' },
    { text: 'The largest coastal operator in the region.', status: 'unverified' },
    { text: 'The safest crossing available.', status: 'prohibited', evidence: 'Unsubstantiable comparative safety claim.' },
  ],
  rights: [
    {
      asset: 'Dock photography set',
      creator: 'Invented Studio Ltd',
      licence: 'Perpetual, non-exclusive, marketing use',
      restrictions: 'No resale, no third-party sublicensing',
      evidenceFileId: 'cccccccc-dddd-4eee-8fff-000000000000',
    },
  ],
  governance: {
    owner: 'Head of Commercial',
    reviewCadence: 'quarterly',
    nextReview: '2026-11-01',
    rules: ['Timetable copy is never rewritten by anyone outside Commercial.'],
    openDecisions: ['Whether the compact mark replaces the primary on the app icon'],
  },
  sources: [
    { label: 'Positioning brief', kbPath: 'brand/northwind-positioning', contribution: 'strategy and messaging' },
    { label: 'Type licence PDF', fileId: 'dddddddd-eeee-4fff-8000-111111111111', contribution: 'typography licensing' },
  ],
}

describe('[COMP:brand/record-schema] full record', () => {
  it('accepts a record populated across every §4 group', () => {
    const parsed = BrandRecordSchema.parse(FULL_RECORD)
    expect(parsed.naming.name).toBe('Northwind Ferry')
    expect(parsed.colors).toHaveLength(2)
    expect(parsed.claims.map((c) => c.status)).toEqual(['approved', 'unverified', 'prohibited'])
  })

  it('covers every declared group in the fixture', () => {
    for (const group of BRAND_RECORD_GROUPS) {
      expect(FULL_RECORD).toHaveProperty(group)
    }
  })

  it('rejects an unknown top-level key rather than dropping it', () => {
    // Silent-drop is the failure mode this guards: a Studio form that posts
    // `messagng` (typo) would otherwise appear to save and lose the content.
    const result = BrandRecordSchema.safeParse({ ...FULL_RECORD, designSystem: { tokens: [] } })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown key nested inside a group', () => {
    const result = BrandRecordSchema.safeParse({
      naming: { name: 'Northwind Ferry', nickname: 'NW' },
    })
    expect(result.success).toBe(false)
  })
})

describe('[COMP:brand/record-schema] required shape', () => {
  it('requires naming.name and nothing else', () => {
    const parsed = BrandRecordSchema.parse({ naming: { name: 'Northwind Ferry' } })
    expect(parsed.naming.name).toBe('Northwind Ferry')
    // Absent groups stay absent; array groups default to empty so a partial
    // record still has a uniform shape for consumers.
    expect(parsed.strategy).toBeUndefined()
    expect(parsed.colors).toEqual([])
    expect(parsed.sources).toEqual([])
  })

  it('rejects a record with no naming group at all', () => {
    expect(BrandRecordSchema.safeParse({ colors: [] }).success).toBe(false)
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(BrandRecordSchema.safeParse({ naming: { name: '' } }).success).toBe(false)
    expect(BrandRecordSchema.safeParse({ naming: { name: '   ' } }).success).toBe(false)
  })

  it('emptyBrandRecord produces a valid seed', () => {
    const seed = emptyBrandRecord('Northwind Ferry')
    expect(BrandRecordSchema.safeParse(seed).success).toBe(true)
    expect(seed.messaging).toBeUndefined()
  })
})

describe('[COMP:brand/record-schema] per-group item shapes', () => {
  it('requires the full {trait, means, avoid} triple on a voice trait', () => {
    // A bare trait name is decoration; the triple is what makes voice
    // actionable in the L1 digest.
    const partial = { naming: { name: 'N' }, messaging: { voice: [{ trait: 'Punctual' }] } }
    expect(BrandRecordSchema.safeParse(partial).success).toBe(false)
  })

  it('requires name/token/value/role on a color token', () => {
    const missingRole = {
      naming: { name: 'N' },
      colors: [{ name: 'Deep channel', token: '--brand-ink', value: '#0F2233' }],
    }
    expect(BrandRecordSchema.safeParse(missingRole).success).toBe(false)
  })

  it('requires role/family/treatment/fallback on a type role', () => {
    const missingFallback = {
      naming: { name: 'N' },
      typography: [{ role: 'body', family: 'Inter', treatment: '400 weight' }],
    }
    expect(BrandRecordSchema.safeParse(missingFallback).success).toBe(false)
  })

  it('requires asset/creator/licence on a rights entry', () => {
    const missingLicence = { naming: { name: 'N' }, rights: [{ asset: 'Photos', creator: 'Studio' }] }
    expect(BrandRecordSchema.safeParse(missingLicence).success).toBe(false)
  })

  it('requires a source to carry at least one locator', () => {
    const noLocator = {
      naming: { name: 'N' },
      sources: [{ label: 'Brief', contribution: 'strategy' }],
    }
    expect(BrandRecordSchema.safeParse(noLocator).success).toBe(false)

    const withKbPath = {
      naming: { name: 'N' },
      sources: [{ label: 'Brief', kbPath: 'brand/brief', contribution: 'strategy' }],
    }
    expect(BrandRecordSchema.safeParse(withKbPath).success).toBe(true)
  })

  it('requires a logo variant fileId to be a uuid, not a path', () => {
    const pathBinding = {
      naming: { name: 'N' },
      logoVariants: [{ variant: 'primary', fileId: '/brand/northwind/primary.svg' }],
    }
    // Binding by id (not path) is what makes "attach the approved logo"
    // deterministic — decision D7.
    expect(BrandRecordSchema.safeParse(pathBinding).success).toBe(false)
  })
})

describe('[COMP:brand/record-schema] enums', () => {
  it('admits exactly the four decision statuses', () => {
    expect([...DECISION_STATUSES]).toEqual(['observed', 'recommended', 'approved', 'open'])
    for (const status of DECISION_STATUSES) {
      const ok = BrandRecordSchema.safeParse({
        naming: { name: 'N' },
        applications: [{ name: 'Deck', kind: 'presentation', status }],
      })
      expect(ok.success).toBe(true)
    }
    const bad = BrandRecordSchema.safeParse({
      naming: { name: 'N' },
      applications: [{ name: 'Deck', kind: 'presentation', status: 'shortlisted' }],
    })
    expect(bad.success).toBe(false)
  })

  it('keeps claim status on its own evidentiary axis', () => {
    expect([...CLAIM_STATUSES]).toEqual(['approved', 'unverified', 'prohibited'])
    // `prohibited` is load-bearing: the future Office release gate reads it.
    const withProhibited = BrandRecordSchema.parse({
      naming: { name: 'N' },
      claims: [{ text: 'The safest crossing available.', status: 'prohibited' }],
    })
    expect(withProhibited.claims[0].status).toBe('prohibited')
    // A DecisionStatus value must not leak into the claim axis.
    expect(
      BrandRecordSchema.safeParse({
        naming: { name: 'N' },
        claims: [{ text: 'x', status: 'recommended' }],
      }).success,
    ).toBe(false)
  })

  it('constrains logo variants and application kinds to the declared sets', () => {
    expect([...LOGO_VARIANTS]).toContain('reversed')
    expect([...APPLICATION_KINDS]).toContain('businessCard')
    expect(
      BrandRecordSchema.safeParse({ naming: { name: 'N' }, logoVariants: [{ variant: 'watermark' }] })
        .success,
    ).toBe(false)
    expect(
      BrandRecordSchema.safeParse({
        naming: { name: 'N' },
        applications: [{ name: 'Van livery', kind: 'vehicle', status: 'open' }],
      }).success,
    ).toBe(false)
  })

  it('accepts each application binding variant and rejects a mixed one', () => {
    const base = { naming: { name: 'N' } }
    const mk = (binding: unknown) => ({
      ...base,
      applications: [{ name: 'A', kind: 'web', status: 'open', binding }],
    })
    expect(BrandRecordSchema.safeParse(mk({ fileId: '11111111-2222-4333-8444-555555555555' })).success).toBe(true)
    expect(BrandRecordSchema.safeParse(mk({ url: 'https://northwind-ferry.example' })).success).toBe(true)
    // A binding must name ONE target; the union has no combined member.
    expect(
      BrandRecordSchema.safeParse(
        mk({ fileId: '11111111-2222-4333-8444-555555555555', url: 'https://northwind-ferry.example' }),
      ).success,
    ).toBe(false)
  })

  it('requires governance.nextReview to be an ISO date', () => {
    expect(
      BrandRecordSchema.safeParse({ naming: { name: 'N' }, governance: { nextReview: 'next quarter' } })
        .success,
    ).toBe(false)
    expect(
      BrandRecordSchema.safeParse({ naming: { name: 'N' }, governance: { nextReview: '2026-11-01' } })
        .success,
    ).toBe(true)
  })
})

describe('[COMP:brand/record-schema] patch merge', () => {
  const base = BrandRecordSchema.parse(FULL_RECORD)

  it('replaces a group whole rather than deep-merging it', () => {
    const patch = BrandRecordPatchSchema.parse({
      messaging: { oneLine: 'Hourly crossings, published in advance.' },
    })
    const merged = BrandRecordSchema.parse(mergeBrandRecordPatch(base, patch))
    expect(merged.messaging?.oneLine).toBe('Hourly crossings, published in advance.')
    // The rest of `messaging` is gone, deliberately — a deep merge over
    // arrays has no defensible semantics, so the tool tells the model to read
    // first and send the whole group.
    expect(merged.messaging?.voice).toEqual([])
    // Untouched groups survive intact.
    expect(merged.colors).toHaveLength(2)
    expect(merged.naming.tagline).toBe('Every crossing, on the hour')
  })

  it('leaves omitted groups alone (absent ≠ empty)', () => {
    const patch = BrandRecordPatchSchema.parse({ colors: [] })
    const merged = BrandRecordSchema.parse(mergeBrandRecordPatch(base, patch))
    expect(merged.colors).toEqual([])
    expect(merged.typography).toHaveLength(1)
  })

  it('merges onto a null base for a first write', () => {
    const patch = BrandRecordPatchSchema.parse({ naming: { name: 'Northwind Ferry' } })
    const merged = BrandRecordSchema.parse(mergeBrandRecordPatch(null, patch))
    expect(merged.naming.name).toBe('Northwind Ferry')
  })

  it('rejects an unknown group in a patch', () => {
    expect(BrandRecordPatchSchema.safeParse({ designSystem: {} }).success).toBe(false)
  })

  it('produces an invalid record when a patch would remove naming', () => {
    // A patch cannot delete a group, but merging onto a null base without
    // naming must not validate — the chokepoint is the record schema, and
    // this is the assertion that it still runs after a merge.
    const patch = BrandRecordPatchSchema.parse({ colors: [] })
    expect(BrandRecordSchema.safeParse(mergeBrandRecordPatch(null, patch)).success).toBe(false)
  })
})
