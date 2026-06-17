/**
 * Deterministic palette builder: {@link ThemeSeed} → {@link CustomThemePayload}.
 *
 * Given a few anchor colours (primary brand hue, an accent hue for gradients,
 * a neutral hue for the greys) and a mood, derive the full light + dark core
 * token sets. Neutrals are tinted toward `neutral`; brand tokens come off
 * `primary`/`accent`; every `*-foreground` is contrast-checked against its
 * surface so arbitrary seeds stay readable. Pure + deterministic (same seed ⇒
 * same tokens) — no randomness, no clock.
 *
 * The output token names match the brand palettes in
 * `apps/app-web/src/app/globals.css`; the client injects them under
 * `[data-palette="custom"]` (light) / `.dark[data-palette="custom"]` (dark) and
 * the shared brand-treatment block derives the gradients/glow on top.
 *
 * [COMP:shared/doc-theme-builder]
 */

import { contrastRatio, ensureReadable, hexToHsl, hsl } from './color.js'
import type { CustomThemePayload, ThemeSeed, ThemeTokens } from './types.js'

/** Mood → (brand-saturation multiplier, neutral-tint multiplier). */
const MOOD: Record<ThemeSeed['mood'], { sat: number; tint: number }> = {
  muted: { sat: 0.82, tint: 1.0 },
  vivid: { sat: 1.18, tint: 1.3 },
  light: { sat: 0.95, tint: 0.8 },
  dark: { sat: 1.0, tint: 1.15 },
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)

/** Black-or-white (nudged) that reads on `bg`. */
function readableOn(bg: string): string {
  const white = '#FFFFFF'
  const ink = '#171717'
  const pick = contrastRatio(white, bg) >= contrastRatio(ink, bg) ? white : ink
  return ensureReadable(pick, bg, 4.5)
}

function buildLight(seed: ThemeSeed): ThemeTokens {
  const p = hexToHsl(seed.primary)
  const a = hexToHsl(seed.accent)
  const n = hexToHsl(seed.neutral)
  const { sat, tint } = MOOD[seed.mood]
  const nS = clamp(6 * tint, 0, 16) // neutral grey saturation
  const brandS = clamp(p.s * sat, 30, 95)

  const background = hsl(n.h, nS * 0.7, 99)
  const card = hsl(n.h, nS * 0.4, 100)
  const foreground = ensureReadable(hsl(n.h, clamp(nS * 2.6, 0, 26), 18), background, 8)
  const muted = hsl(n.h, nS, 96)
  const accentSurface = hsl(p.h, clamp(brandS * 0.55, 14, 45), 93)
  const secondary = hsl(p.h, clamp(brandS * 0.5, 12, 40), 95)
  const primary = hsl(p.h, brandS, clamp(p.l, 38, 56))
  const accent2 = hsl(a.h, clamp(a.s * sat, 30, 92), clamp(a.l, 40, 58))
  const sidebar = hsl(n.h, nS * 1.2, 97)
  const border = hsl(n.h, nS * 1.3, 90.5)

  return {
    background,
    foreground,
    card,
    'card-foreground': foreground,
    popover: card,
    'popover-foreground': foreground,
    primary,
    'primary-foreground': readableOn(primary),
    secondary,
    'secondary-foreground': ensureReadable(hsl(p.h, brandS, 34), secondary, 4.5),
    muted,
    'muted-foreground': ensureReadable(hsl(n.h, clamp(nS * 1.2, 0, 18), 44), muted, 4.5),
    accent: accentSurface,
    'accent-foreground': ensureReadable(hsl(p.h, brandS, 40), accentSurface, 4.5),
    'accent-2': accent2,
    destructive: '#E5484D',
    border,
    input: border,
    ring: primary,
    sidebar,
    'sidebar-foreground': ensureReadable(hsl(n.h, clamp(nS * 1.6, 0, 24), 26), sidebar, 6),
    'sidebar-primary': primary,
    'sidebar-primary-foreground': readableOn(primary),
    'sidebar-accent': hsl(n.h, nS * 1.5, 92),
    'sidebar-accent-foreground': foreground,
    'sidebar-border': hsl(n.h, nS * 1.4, 91),
    'sidebar-ring': primary,
  }
}

function buildDark(seed: ThemeSeed): ThemeTokens {
  const p = hexToHsl(seed.primary)
  const a = hexToHsl(seed.accent)
  const n = hexToHsl(seed.neutral)
  const { sat, tint } = MOOD[seed.mood]
  const nS = clamp(8 * tint, 0, 18)
  const brandS = clamp(p.s * sat, 35, 90)

  const background = hsl(n.h, nS, 9)
  const card = hsl(n.h, nS * 0.9, 12)
  const foreground = ensureReadable(hsl(n.h, clamp(nS * 1.3, 0, 20), 86), background, 8)
  const muted = hsl(n.h, nS, 16)
  const accentSurface = hsl(p.h, clamp(brandS * 0.5, 12, 40), 20)
  const secondary = hsl(p.h, clamp(brandS * 0.4, 10, 34), 18)
  // Brand hue brightens on dark so it pops against the deep background.
  const primary = hsl(p.h, brandS, clamp(p.l + 12, 58, 72))
  const accent2 = hsl(a.h, clamp(a.s * sat, 35, 88), clamp(a.l + 10, 55, 72))
  const sidebar = hsl(n.h, nS, 11)
  const border = hsl(n.h, nS, 22)

  return {
    background,
    foreground,
    card,
    'card-foreground': foreground,
    popover: card,
    'popover-foreground': foreground,
    primary,
    'primary-foreground': readableOn(primary),
    secondary,
    'secondary-foreground': ensureReadable(hsl(p.h, clamp(brandS * 0.7, 20, 60), 80), secondary, 4.5),
    muted,
    'muted-foreground': ensureReadable(hsl(n.h, clamp(nS * 0.9, 0, 16), 62), muted, 4.5),
    accent: accentSurface,
    'accent-foreground': ensureReadable(hsl(p.h, clamp(brandS * 0.8, 30, 70), 78), accentSurface, 4.5),
    'accent-2': accent2,
    destructive: '#F87171',
    border,
    input: hsl(n.h, nS, 24),
    ring: primary,
    sidebar,
    'sidebar-foreground': ensureReadable(hsl(n.h, nS, 80), sidebar, 6),
    'sidebar-primary': primary,
    'sidebar-primary-foreground': readableOn(primary),
    'sidebar-accent': hsl(n.h, nS, 20),
    'sidebar-accent-foreground': foreground,
    'sidebar-border': border,
    'sidebar-ring': primary,
  }
}

/** Expand a seed into the full light + dark token sets. */
export function buildThemeTokens(seed: ThemeSeed): CustomThemePayload {
  return { light: buildLight(seed), dark: buildDark(seed) }
}
