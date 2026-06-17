/**
 * `generateCustomTheme` — turn a user's prompt ("calm deep-ocean blues,
 * focused") into a full doc theme.
 *
 * The model does the SMALL, creative part: pick a few anchor colours + a mood
 * (a {@link ThemeSeed}). The deterministic builder
 * (`@sidanclaw/shared` `buildThemeTokens`) does the rest — it expands the seed
 * into the full light+dark token set with contrast guarantees. Asking the model
 * for ~4 hexes instead of ~50 mutually-harmonious, accessible ones is why a
 * cheap model is enough here and why results stay on-brand regardless of model
 * quality.
 *
 * Mirrors the single-shot LLM call shape of `doc/auto-title.ts`
 * (`generatePageTitle`). Pure orchestration: no DB, no Express — the route
 * (`routes/doc-themes.ts`) calls this then persists via the store.
 *
 * [COMP:doc/theme-generator]
 */

import { collectStream, type LLMProvider, type Message, type TokenUsage } from '@sidanclaw/core'
import {
  buildThemeTokens,
  seedAppearance,
  themeSeedSchema,
  type CustomThemePayload,
  type ThemeSeed,
} from '@sidanclaw/shared'

/** The model couldn't produce a usable seed (unparseable / failed validation). */
export class ThemeGenerationError extends Error {
  constructor(message = 'Could not generate a theme from that description') {
    super(message)
    this.name = 'ThemeGenerationError'
  }
}

/** Standard-tier extraction model — same routing as the page auto-title. */
const THEME_MODEL = 'gemini-3.1-flash-lite'

/** Hard cap on the prompt we forward to the model. */
const MAX_PROMPT_CHARS = 600

const THEME_SYSTEM_PROMPT = `You are a senior product designer creating a colour theme for a Notion-style document app (a clean page surface, subtle greys, one brand accent). The user describes a mood, feeling, or palette. Return ONE JSON object and NOTHING else — no markdown fences, no commentary.

Shape:
{
  "name": "<ONE word; two at most>",
  "description": "<one short sentence>",
  "appearance": "light" | "dark",
  "primary": "#RRGGBB",
  "accent": "#RRGGBB",
  "neutral": "#RRGGBB",
  "mood": "vivid" | "muted"
}

Field rules:
- "name": invent a fresh, SINGLE evocative word grounded in THIS theme's actual colours and feeling — a teal calm → "Tideglass", an amber energy → "Ember", a slate minimal → "Graphite". Two words maximum, never three. Title Case, no punctuation, no emoji. Do NOT reach for the overused defaults "Midnight", "Velvet", "Midnight Velvet", "Twilight", "Aurora", "Eclipse", "Obsidian", "Nebula" — those are BANNED unless the user's own words literally contain them. Make the name specific to the palette so two different prompts never land on the same name.
- "appearance": the page's overall lightness. Use "dark" whenever the user asks for a dark / night / midnight / moody / black theme — this makes the page background dark. Use "light" otherwise. THIS is what decides light-vs-dark; never leave a "dark theme" as "light".
- "primary": the main brand colour (buttons, links, active states).
- "accent": a SECOND, distinct hue used for gradients and highlights — pick one that harmonises with primary (analogous or complementary), never the same hue.
- "neutral": NOT a colour used directly — it only carries the HUE/temperature that tints the greys (backgrounds, text, borders). For a dark theme this should be a deep near-black tinted toward the brand temperature.
- "mood": ONLY the saturation — "vivid" = punchy and saturated, "muted" = soft and calm. It does NOT control light/dark (that's "appearance").

Examples:
"calm deep-ocean blues, focused" -> {"name":"Tidewater","description":"Calm oceanic blues for deep work.","appearance":"light","primary":"#0EA5E9","accent":"#14B8A6","neutral":"#0F2A3A","mood":"muted"}
"warm sunset, energetic startup" -> {"name":"Ember","description":"Warm rose-to-amber energy.","appearance":"light","primary":"#E11D48","accent":"#F59E0B","neutral":"#2A1D1A","mood":"vivid"}
"fancy dark theme" -> {"name":"Amethyst","description":"Sleek dark surface with a jewel-toned accent.","appearance":"dark","primary":"#8B5CF6","accent":"#22D3EE","neutral":"#1A1A22","mood":"vivid"}
"minimal, calm, lots of paper-white" -> {"name":"Paper","description":"Quiet, paper-light minimalism.","appearance":"light","primary":"#525252","accent":"#A8A29E","neutral":"#F5F5F4","mood":"muted"}`

export type GeneratedTheme = {
  name: string
  description: string | null
  seed: ThemeSeed
  tokens: CustomThemePayload
  usage: TokenUsage | null
  model: string
}

/**
 * Generate a theme seed from the prompt and expand it to tokens. Throws
 * {@link ThemeGenerationError} when the model output can't be parsed/validated
 * into a {@link ThemeSeed}; the route maps that to a 422 so the user can rephrase.
 */
export async function generateCustomTheme(params: {
  provider: LLMProvider
  prompt: string
  model?: string
}): Promise<GeneratedTheme> {
  const prompt = params.prompt.trim().slice(0, MAX_PROMPT_CHARS)
  if (!prompt) throw new ThemeGenerationError('Describe the theme you want first')

  const model = params.model ?? THEME_MODEL
  const response = await collectStream(
    params.provider.stream({
      model,
      systemPrompt: THEME_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }] as Message[],
      maxTokens: 400,
      // Higher temperature for lexical variety in the NAME — the small model
      // otherwise collapses onto cliché names ("Midnight Velvet") for any
      // dark/luxe prompt. Colour harmony + contrast are guaranteed downstream by
      // the deterministic builder, so a punchier sampler here is safe.
      temperature: 0.95,
    }),
  )

  // Normalise the model's seed: cap the name at two words and pin a concrete
  // `appearance` (model value, else derived from mood) so the stored theme always
  // carries the light/dark intent that drives the doc mode on apply.
  const extracted = extractSeed(responseText(response))
  const seed: ThemeSeed = {
    ...extracted,
    name: tidyThemeName(extracted.name),
    appearance: seedAppearance(extracted),
  }
  return {
    name: seed.name,
    description: seed.description ?? null,
    seed,
    tokens: buildThemeTokens(seed),
    usage: response.usage,
    model,
  }
}

/**
 * Keep generated theme names neat: collapse whitespace and cap at two words.
 * A code-side backstop so the "one word, two at most" rule holds even if the
 * model gets chatty. Title-casing is left to the model (the prompt asks for it).
 */
function tidyThemeName(raw: string): string {
  return raw.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
}

const THEME_REFINE_SYSTEM_PROMPT = `You are refining an EXISTING colour theme for a Notion-style document app. You are given the current theme seed as JSON and an adjustment instruction. Return ONE JSON object — the FULL updated seed (same shape) — applying the adjustment while keeping everything the user did NOT ask to change. No markdown fences, no commentary.

Shape:
{
  "name": "<keep the current name unless told to rename>",
  "description": "<one short sentence describing the refined theme>",
  "appearance": "light" | "dark",
  "primary": "#RRGGBB",
  "accent": "#RRGGBB",
  "neutral": "#RRGGBB",
  "mood": "vivid" | "muted"
}

Apply the instruction faithfully and minimally:
- "warmer" → shift hues toward red/orange/amber; "cooler" → toward blue/teal.
- "more contrast" / "punchier" → "vivid"; "softer" / "calmer" → "muted".
- "darker" / "make it dark" → "appearance":"dark"; "lighter" / "make it light" → "appearance":"light". "appearance" is the page lightness; "mood" is only saturation.
- "swap the accent to <colour>" → change only "accent"; "different brand colour" → change "primary".
- "primary" is the brand hue, "accent" is the second hue used for gradients (keep them distinct), "neutral" only carries the grey temperature.
- Preserve fields the instruction doesn't touch; the app re-derives both light and dark from this seed.`

/** Collapse a provider response's text blocks into one string. */
function responseText(response: { content: { type: string; text?: string }[] }): string {
  return response.content
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim()
}

/**
 * Forgiving seed extraction: strip ```json fences, grab the first {…} block,
 * parse + validate as a {@link ThemeSeed}. Throws {@link ThemeGenerationError}
 * on anything unparseable. Shared by generate + refine.
 */
function extractSeed(rawText: string): ThemeSeed {
  const cleaned = rawText.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new ThemeGenerationError()
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    throw new ThemeGenerationError()
  }
  const parsed = themeSeedSchema.safeParse(raw)
  if (!parsed.success) throw new ThemeGenerationError()
  return parsed.data
}

/**
 * Refine an existing theme: feed the current seed + an adjustment instruction
 * to the model, get back an adjusted full seed, rebuild tokens. The theme's
 * `name` is held stable (the user named it) regardless of what the model
 * returns. Throws {@link ThemeGenerationError} on unusable output.
 */
export async function refineCustomTheme(params: {
  provider: LLMProvider
  currentSeed: ThemeSeed
  instruction: string
  model?: string
}): Promise<GeneratedTheme> {
  const instruction = params.instruction.trim().slice(0, MAX_PROMPT_CHARS)
  if (!instruction) throw new ThemeGenerationError('Describe the change you want first')

  const model = params.model ?? THEME_MODEL
  const userMessage = `Current theme seed:\n${JSON.stringify(params.currentSeed)}\n\nAdjustment: ${instruction}`
  const response = await collectStream(
    params.provider.stream({
      model,
      systemPrompt: THEME_REFINE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }] as Message[],
      maxTokens: 400,
      temperature: 0.6,
    }),
  )

  // Keep the user's existing name stable across refinements, and pin a concrete
  // `appearance` — the model's, else the theme's prior intent, else mood-derived —
  // so a "make it darker" instruction actually flips the doc to dark.
  const adjusted = extractSeed(responseText(response))
  const refined: ThemeSeed = {
    ...adjusted,
    name: params.currentSeed.name,
    appearance: seedAppearance({
      appearance: adjusted.appearance ?? params.currentSeed.appearance,
      mood: adjusted.mood,
    }),
  }
  return {
    name: refined.name,
    description: refined.description ?? null,
    seed: refined,
    tokens: buildThemeTokens(refined),
    usage: response.usage,
    model,
  }
}
