import { describe, it, expect } from 'vitest'

import { buildThemeTokens } from '../build-tokens.js'
import { contrastRatio } from '../color.js'
import { CORE_TOKENS, seedAppearance, themeSeedSchema, type ThemeSeed } from '../types.js'

const HEX = /^#[0-9A-F]{6}$/

const SEEDS: ThemeSeed[] = [
  { name: 'Midnight Lab', primary: '#6366F1', accent: '#22D3EE', neutral: '#1E1B2E', mood: 'vivid' },
  { name: 'Warm Studio', primary: '#E11D48', accent: '#F59E0B', neutral: '#2A1D1A', mood: 'muted' },
  { name: 'Deep Ocean', primary: '#0EA5E9', accent: '#14B8A6', neutral: '#0F2A3A', mood: 'dark' },
  { name: 'Paper', primary: '#737373', accent: '#A3A3A3', neutral: '#F5F5F4', mood: 'light' },
  // Pale/low-contrast brand — the worst case the builder must still make readable.
  { name: 'Sunbeam', primary: '#FDE047', accent: '#FCA5A5', neutral: '#FFFBEB', mood: 'vivid' },
]

describe('[COMP:shared/doc-theme-builder] buildThemeTokens', () => {
  it('emits every core token as a valid 6-digit hex for both modes', () => {
    for (const seed of SEEDS) {
      const { light, dark } = buildThemeTokens(seed)
      for (const mode of [light, dark]) {
        const keys = Object.keys(mode).sort()
        expect(keys).toEqual([...CORE_TOKENS].sort())
        for (const token of CORE_TOKENS) {
          expect(mode[token], `${seed.name}/${token}`).toMatch(HEX)
        }
      }
    }
  })

  it('keeps foreground/surface pairs readable (WCAG ≥ 4.5, body text ≥ 7)', () => {
    const pairs: [string, string, number][] = [
      ['foreground', 'background', 7],
      ['card-foreground', 'card', 7],
      ['popover-foreground', 'popover', 7],
      ['muted-foreground', 'muted', 4.5],
      ['primary-foreground', 'primary', 4.5],
      ['secondary-foreground', 'secondary', 4.5],
      ['accent-foreground', 'accent', 4.5],
      ['sidebar-foreground', 'sidebar', 4.5],
      ['sidebar-primary-foreground', 'sidebar-primary', 4.5],
    ]
    for (const seed of SEEDS) {
      const built = buildThemeTokens(seed)
      for (const tokens of [built.light, built.dark]) {
        for (const [fg, bg, min] of pairs) {
          expect(
            contrastRatio(tokens[fg as keyof typeof tokens], tokens[bg as keyof typeof tokens]),
            `${seed.name} ${fg}-on-${bg}`,
          ).toBeGreaterThanOrEqual(min)
        }
      }
    }
  })

  it('is deterministic — same seed yields identical tokens', () => {
    for (const seed of SEEDS) {
      expect(buildThemeTokens(seed)).toEqual(buildThemeTokens(seed))
    }
  })

  it('light background is light and dark background is dark', () => {
    for (const seed of SEEDS) {
      const { light, dark } = buildThemeTokens(seed)
      // Contrast against white: a light bg is near-white (low ratio), dark is high.
      expect(contrastRatio(light.background, '#FFFFFF')).toBeLessThan(1.3)
      expect(contrastRatio(dark.background, '#FFFFFF')).toBeGreaterThan(7)
    }
  })

  it('seed schema applies the default mood', () => {
    const parsed = themeSeedSchema.parse({
      name: 'X',
      primary: '#2383E2',
      accent: '#8B5CF6',
      neutral: '#37352F',
    })
    expect(parsed.mood).toBe('muted')
  })

  it('seed schema accepts an optional appearance', () => {
    const parsed = themeSeedSchema.parse({
      name: 'X',
      appearance: 'dark',
      primary: '#2383E2',
      accent: '#8B5CF6',
      neutral: '#1A1A22',
      mood: 'vivid',
    })
    expect(parsed.appearance).toBe('dark')
  })
})

describe('[COMP:shared/doc-theme-builder] seedAppearance', () => {
  it('prefers the explicit appearance', () => {
    expect(seedAppearance({ appearance: 'dark', mood: 'muted' })).toBe('dark')
    expect(seedAppearance({ appearance: 'light', mood: 'dark' })).toBe('light')
  })

  it('falls back to dark for a dark mood when appearance is absent', () => {
    expect(seedAppearance({ mood: 'dark' })).toBe('dark')
  })

  it('falls back to light for any non-dark mood when appearance is absent', () => {
    expect(seedAppearance({ mood: 'muted' })).toBe('light')
    expect(seedAppearance({ mood: 'vivid' })).toBe('light')
    expect(seedAppearance({ mood: 'light' })).toBe('light')
  })
})
