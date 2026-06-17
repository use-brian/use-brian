/**
 * Types + validation for doc custom themes.
 *
 * A custom theme is generated from a user prompt: an LLM returns a small
 * {@link ThemeSeed} (a few anchor colours + a mood), and {@link buildThemeTokens}
 * deterministically expands it into a full {@link CustomThemePayload} — the ~27
 * core palette tokens for BOTH light and dark, mirroring the token set the brand
 * palettes define in `apps/app-web/src/app/globals.css` (PALETTE SYSTEM).
 *
 * Spec: docs/architecture/features/doc-custom-themes.md.
 *
 * [COMP:shared/doc-theme-builder]
 */

import { z } from 'zod'

/**
 * The core palette tokens, WITHOUT the leading `--`. The order is the canonical
 * authoring order from globals.css. Treatment tokens (`--btn-*`,
 * `--nav-active-*`, `--sidebar-surface-image`, `--selection-2`) are intentionally
 * absent — they're derived in CSS from these by the shared brand-treatment block,
 * which `[data-palette="custom"]` opts into.
 */
export const CORE_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'accent-2',
  'destructive',
  'border',
  'input',
  'ring',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
] as const

export type CoreToken = (typeof CORE_TOKENS)[number]

/** A full set of concrete colours for one mode — every {@link CORE_TOKENS} key. */
export type ThemeTokens = Record<CoreToken, string>

/** Light + dark token sets — what we store in `doc_themes.tokens` and inject. */
export type CustomThemePayload = {
  light: ThemeTokens
  dark: ThemeTokens
}

const hexColor = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour like #2383E2')

/**
 * The LLM output. Kept deliberately small + bounded so a cheap model nails it
 * reliably — the builder, not the model, guarantees harmony + contrast.
 *  - `primary`     — the brand hue (buttons, links, active states)
 *  - `accent`      — the second hue used for gradients/glow (the duotone partner)
 *  - `neutral`     — sets the temperature of the greys (backgrounds, text, borders)
 *  - `appearance`  — the LIGHTNESS axis: which mode the theme reads as by default
 *                    (a "dark theme" → `dark`). Drives the doc light/dark toggle
 *                    when the theme is applied. Optional for backward compatibility
 *                    with themes generated before this field existed.
 *  - `mood`        — the SATURATION axis: `vivid` (punchy) vs `muted` (soft). The
 *                    legacy `light`/`dark` values are still accepted for old seeds.
 *
 * `appearance` and `mood` are intentionally orthogonal — "fancy dark" is
 * `appearance: dark` + `mood: vivid`. Folding both into one field is what made a
 * "dark theme" render light (the picked mood only nudged saturation, never the
 * page background). See {@link seedAppearance}.
 */
export const themeSeedSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(160).optional(),
  primary: hexColor,
  accent: hexColor,
  neutral: hexColor,
  appearance: z.enum(['light', 'dark']).optional(),
  mood: z.enum(['light', 'dark', 'vivid', 'muted']).default('muted'),
})

export type ThemeSeed = z.infer<typeof themeSeedSchema>

/**
 * The light/dark mode a generated theme wants by default. Prefers the explicit
 * `appearance`; falls back to the `mood` for seeds generated before `appearance`
 * existed (where `dark` was the only signal of intent). Pure — callers use this
 * to set the doc mode when applying a theme so a "dark theme" actually renders
 * dark.
 */
export function seedAppearance(seed: Pick<ThemeSeed, 'appearance' | 'mood'>): 'light' | 'dark' {
  return seed.appearance ?? (seed.mood === 'dark' ? 'dark' : 'light')
}

/** A stored/generated custom theme (the wire shape the route returns). */
export type CustomTheme = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  description: string | null
  prompt: string
  seed: ThemeSeed
  tokens: CustomThemePayload
  createdAt: string
  updatedAt: string
}

/** Hard cap of custom themes per workspace (invisible — enforced server-side). */
export const MAX_CUSTOM_THEMES_PER_WORKSPACE = 5
