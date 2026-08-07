/**
 * Brand colors → a doc `ThemeSeed`.
 *
 * The doc theme generator's normal path asks a model to invent three anchor
 * colours from a prose prompt. A workspace with an approved brand already has
 * those colours decided, written down, and governed — asking a model to guess
 * them is both a waste and a way to end up with a theme that is *nearly* the
 * brand, which is worse than one that obviously is not.
 *
 * This derives the seed directly. No model, no cost, exact values.
 *
 * ## Only hex values are usable
 *
 * `colors[].value` is "the value as authored" — a hex, an `rgb()`, or a token
 * reference. The theme seed schema takes hex only, and resolving a token
 * reference would mean interpreting a design system this module knows nothing
 * about. Non-hex entries are skipped rather than guessed at.
 *
 * ## Approved tokens win
 *
 * A color carrying `status: 'approved'` outranks one that is `recommended`,
 * `observed`, or `open`. That is the whole point of the status axis — an
 * exploration must not become the workspace's document theme just because it
 * happens to sit first in the array.
 *
 * Returns `null` when no usable colour exists. A partial brand should produce
 * no theme rather than a misleading one.
 *
 * [COMP:brand/theme-seed]
 */

import type { ColorToken } from './record.js'
import type { ThemeSeed } from '../doc-theme/types.js'

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** Role keywords, in the order a match is preferred. */
const PRIMARY_HINTS = ['primary', 'brand', 'main', 'core']
const ACCENT_HINTS = ['accent', 'secondary', 'highlight', 'signal', 'cta']
const NEUTRAL_HINTS = ['neutral', 'grey', 'gray', 'surface', 'background', 'paper', 'ink', 'text', 'base']

type Candidate = { token: ColorToken; approved: boolean }

function usable(colors: readonly ColorToken[]): Candidate[] {
  return colors
    .filter((c) => HEX.test(c.value.trim()))
    .map((token) => ({ token, approved: token.status === 'approved' }))
}

/** Does this token's role or name mention any of `hints`? */
function mentions(candidate: Candidate, hints: readonly string[]): boolean {
  const haystack = `${candidate.token.role} ${candidate.token.name} ${candidate.token.token}`.toLowerCase()
  return hints.some((hint) => haystack.includes(hint))
}

/**
 * Best match for a role: an approved token whose role mentions a hint, then any
 * token whose role mentions a hint, then — only when `fallbackToAny` — the
 * first approved token, then the first token at all.
 */
function pick(
  candidates: Candidate[],
  hints: readonly string[],
  opts: { fallbackToAny: boolean },
): ColorToken | null {
  const hinted = candidates.filter((c) => mentions(c, hints))
  const approvedHinted = hinted.find((c) => c.approved)
  if (approvedHinted) return approvedHinted.token
  if (hinted.length > 0) return hinted[0].token
  if (!opts.fallbackToAny) return null
  const approved = candidates.find((c) => c.approved)
  if (approved) return approved.token
  return candidates[0]?.token ?? null
}

/** Rough saturation of a hex colour, 0-1. Used to choose a neutral. */
function saturation(hex: string): number {
  const raw = hex.trim().slice(1)
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === 0) return 0
  return (max - min) / max
}

export type BrandThemeSeedInput = {
  /** Display name for the theme. Usually the brand's name. */
  name: string
  colors: readonly ColorToken[]
}

export function brandThemeSeed(input: BrandThemeSeedInput): ThemeSeed | null {
  const candidates = usable(input.colors)
  if (candidates.length === 0) return null

  // Primary falls back to any colour: a brand with one recorded colour still
  // yields a coherent theme, because the builder derives harmony itself.
  const primary = pick(candidates, PRIMARY_HINTS, { fallbackToAny: true })
  if (!primary) return null

  const remaining = candidates.filter((c) => c.token.value !== primary.value)
  const accent =
    pick(remaining, ACCENT_HINTS, { fallbackToAny: false }) ??
    remaining.find((c) => c.approved)?.token ??
    remaining[0]?.token ??
    primary

  // Neutral is chosen from the colours the primary did NOT claim. Searching
  // the whole set instead lets a weak hint collide with a strong one: a token
  // whose role is "primary surface" matches `surface`, so the primary would
  // come back as the neutral too and the theme would have one colour.
  //
  // Prefer a hinted candidate; otherwise the least saturated one, which is
  // what a neutral actually is — picking a vivid colour would make every page
  // background shout.
  const neutral =
    pick(remaining, NEUTRAL_HINTS, { fallbackToAny: false }) ??
    [...remaining].sort((a, b) => saturation(a.token.value) - saturation(b.token.value))[0]?.token ??
    primary

  return {
    name: input.name.trim().slice(0, 40),
    description: `Derived from the ${input.name.trim()} brand record`.slice(0, 160),
    primary: primary.value.trim(),
    accent: accent.value.trim(),
    neutral: neutral.value.trim(),
    // `muted` rather than `vivid`: the brand's own values are already the
    // statement, and punching their saturation would move them off-brand,
    // which is the one thing a brand-derived theme must not do.
    mood: 'muted',
  }
}
