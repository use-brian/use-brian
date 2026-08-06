/**
 * [COMP:brand/theme-seed] — brand colors → a doc `ThemeSeed`.
 *
 * The judgment being pinned is selection: which of a brand's colours becomes
 * the theme's primary, accent, and neutral. Two rules carry the weight —
 * `status: 'approved'` outranks an exploration (that is the entire point of
 * the status axis), and a non-hex value is skipped rather than guessed at.
 *
 * And the null case matters as much as the happy one: a partial brand must
 * produce NO theme rather than a misleading one.
 *
 * Fixture data is invented.
 */

import { describe, it, expect } from 'vitest'
import { brandThemeSeed } from '../brand/theme-seed.js'
import type { ColorToken } from '../brand/record.js'

const color = (over: Partial<ColorToken> & Pick<ColorToken, 'name' | 'value' | 'role'>): ColorToken => ({
  token: `--${over.name.toLowerCase().replace(/\s+/g, '-')}`,
  ...over,
})

describe('[COMP:brand/theme-seed] selection by role', () => {
  it('matches primary, accent, and neutral from role names', () => {
    const seed = brandThemeSeed({
      name: 'Northwind Ferry',
      colors: [
        color({ name: 'Deep channel', value: '#0F2233', role: 'primary surface' }),
        color({ name: 'Signal', value: '#F25C05', role: 'accent' }),
        color({ name: 'Paper', value: '#F5F5F4', role: 'neutral background' }),
      ],
    })!
    expect(seed.primary).toBe('#0F2233')
    expect(seed.accent).toBe('#F25C05')
    expect(seed.neutral).toBe('#F5F5F4')
  })

  it('names the theme after the brand', () => {
    const seed = brandThemeSeed({ name: 'Northwind Ferry', colors: [color({ name: 'Ink', value: '#0F2233', role: 'primary' })] })!
    expect(seed.name).toBe('Northwind Ferry')
    expect(seed.description).toContain('Northwind Ferry')
  })

  it('matches on the token name when the role does not say it', () => {
    const seed = brandThemeSeed({
      name: 'N',
      colors: [
        color({ name: 'Slate', value: '#334155', role: 'headings and rules' }),
        color({ name: 'Brand orange', value: '#F25C05', role: 'buttons' }),
      ],
    })!
    // "Brand orange" mentions a primary hint in its NAME.
    expect(seed.primary).toBe('#F25C05')
  })
})

describe('[COMP:brand/theme-seed] approved wins', () => {
  it('prefers an approved token over an exploration for the same role', () => {
    const seed = brandThemeSeed({
      name: 'N',
      colors: [
        color({ name: 'Candidate navy', value: '#111827', role: 'primary', status: 'open' }),
        color({ name: 'Settled navy', value: '#0F2233', role: 'primary', status: 'approved' }),
      ],
    })!
    // An exploration must not become the workspace's document theme just
    // because it sits first in the array.
    expect(seed.primary).toBe('#0F2233')
  })

  it('falls back to an approved token when no role hint matches', () => {
    const seed = brandThemeSeed({
      name: 'N',
      colors: [
        color({ name: 'One', value: '#111827', role: 'unlabelled', status: 'observed' }),
        color({ name: 'Two', value: '#0F2233', role: 'unlabelled', status: 'approved' }),
      ],
    })!
    expect(seed.primary).toBe('#0F2233')
  })
})

describe('[COMP:brand/theme-seed] value hygiene', () => {
  it('skips a non-hex value rather than guessing at it', () => {
    const seed = brandThemeSeed({
      name: 'N',
      colors: [
        color({ name: 'Token ref', value: 'var(--brand-ink)', role: 'primary' }),
        color({ name: 'Rgb', value: 'rgb(15, 34, 51)', role: 'primary' }),
        color({ name: 'Real', value: '#0F2233', role: 'accent' }),
      ],
    })!
    // Resolving a token reference would mean interpreting a design system
    // this module knows nothing about.
    expect(seed.primary).toBe('#0F2233')
  })

  it('accepts three-digit hex', () => {
    const seed = brandThemeSeed({ name: 'N', colors: [color({ name: 'Short', value: '#0F2', role: 'primary' })] })!
    expect(seed.primary).toBe('#0F2')
  })

  it('returns null when no colour is usable', () => {
    expect(brandThemeSeed({ name: 'N', colors: [color({ name: 'Ref', value: 'var(--x)', role: 'primary' })] })).toBeNull()
  })

  it('returns null when the brand has no colours at all', () => {
    expect(brandThemeSeed({ name: 'N', colors: [] })).toBeNull()
  })
})

describe('[COMP:brand/theme-seed] degrading gracefully', () => {
  it('works from a single colour', () => {
    // The builder derives harmony itself, so one recorded colour still yields
    // a coherent theme rather than nothing.
    const seed = brandThemeSeed({ name: 'N', colors: [color({ name: 'Only', value: '#0F2233', role: 'primary' })] })!
    expect(seed.primary).toBe('#0F2233')
    expect(seed.accent).toBe('#0F2233')
    expect(seed.neutral).toBe('#0F2233')
  })

  it('chooses the least saturated colour as neutral when none is labelled', () => {
    const seed = brandThemeSeed({
      name: 'N',
      colors: [
        color({ name: 'Vivid', value: '#FF0000', role: 'primary' }),
        color({ name: 'Muted', value: '#807F7F', role: 'supporting' }),
      ],
    })!
    // A neutral IS the least saturated colour; picking a vivid one would make
    // every page background shout.
    expect(seed.neutral).toBe('#807F7F')
  })

  it('does not reuse the primary as the accent when another colour exists', () => {
    const seed = brandThemeSeed({
      name: 'N',
      colors: [
        color({ name: 'Ink', value: '#0F2233', role: 'primary' }),
        color({ name: 'Other', value: '#F25C05', role: 'supporting' }),
      ],
    })!
    expect(seed.accent).toBe('#F25C05')
  })

  it('stays muted rather than vivid', () => {
    // The brand's own values are already the statement; punching their
    // saturation would move them off-brand, which is the one thing a
    // brand-derived theme must not do.
    const seed = brandThemeSeed({ name: 'N', colors: [color({ name: 'Ink', value: '#0F2233', role: 'primary' })] })!
    expect(seed.mood).toBe('muted')
  })

  it('truncates an over-long brand name to the seed schema cap', () => {
    const seed = brandThemeSeed({ name: 'x'.repeat(80), colors: [color({ name: 'Ink', value: '#0F2233', role: 'primary' })] })!
    expect(seed.name.length).toBeLessThanOrEqual(40)
  })
})
