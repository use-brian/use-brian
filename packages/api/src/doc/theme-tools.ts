/**
 * `refineActiveTheme` — the doc chat tool for iterating on a custom theme
 * by voice ("make my theme warmer", "more contrast", "swap the accent to green").
 *
 * The theme the user currently has applied is a PER-USER CLIENT preference
 * (`localStorage["doc:customThemeId"]`), so the server can't know it on its
 * own — the doc client sends it as turn context (`activeDocThemeId`),
 * which `injectDocTools` threads in as `themeId`. The tool is only injected
 * when that id is present (and a provider exists), so it never appears when the
 * user is on a built-in palette — keeping it off the system prompt
 * (tool-awareness rule) and out of irrelevant turns.
 *
 * Live-apply: after a successful refine the tool calls `onRefined`, which the
 * chat route wires to a `doc_theme_update` SSE event → the client bridges it
 * to a `doc:theme-changed` window event → `CustomThemesProvider` applies the
 * new tokens. Mirrors the `doc_title_update` channel.
 *
 * See docs/architecture/features/doc-custom-themes.md → "Iterating (refine)".
 *
 * [COMP:doc-themes/refine-tool]
 */

import { z } from 'zod'
import { buildTool, type Tool, type LLMProvider } from '@use-brian/core'
import { seedAppearance, type CustomThemePayload } from '@use-brian/shared'

import type { DocThemeStore } from '../db/doc-themes-store.js'
import { refineCustomTheme, ThemeGenerationError } from './theme-generator.js'

export type RefineActiveThemeDeps = {
  /** Servable background-lane model; omitted = the generator's own default. */
  model?: string
  /** The custom theme the user currently has applied (from turn context). */
  themeId: string
  provider: LLMProvider
  store: DocThemeStore
  /** Fired after a successful refine so the route can stream the new tokens
   *  to the client for live apply. `appearance` carries the refined theme's
   *  light/dark intent so a "make it darker" flips the doc mode too. */
  onRefined?: (themeId: string, tokens: CustomThemePayload, appearance: 'light' | 'dark') => void
}

const inputSchema = z.object({
  instruction: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "The change to make, in natural language — e.g. 'make it warmer', 'more contrast', 'swap the accent to green', 'darker and more minimal'.",
    ),
})

export function createRefineActiveThemeTool(deps: RefineActiveThemeDeps): Tool {
  return buildTool({
    name: 'refineActiveTheme',
    description:
      'Adjust the doc colour theme the user CURRENTLY HAS APPLIED, from a natural-language instruction. ' +
      "Use when the user asks to tweak their current theme (e.g. 'make my theme warmer', 'more contrast', 'swap the accent to green', 'darker'). " +
      'It edits the existing applied theme in place — applies live and saves. It does NOT create a new theme or switch to a different one.',
    inputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const theme = await deps.store.getById(context.userId, deps.themeId)
      if (!theme) {
        return {
          data: "There's no custom theme applied right now. Create one from the Theme menu first, then I can refine it.",
          isError: true,
        }
      }

      let refined
      try {
        refined = await refineCustomTheme({
          provider: deps.provider,
          model: deps.model,
          currentSeed: theme.seed,
          instruction: input.instruction,
        })
      } catch (err) {
        if (err instanceof ThemeGenerationError) {
          return {
            data:
              "I couldn't turn that into a theme change. Try describing it differently — " +
              "e.g. 'warmer', 'more contrast', or 'swap the accent to green'.",
            isError: true,
          }
        }
        throw err
      }

      const updated = await deps.store.updateGenerated(context.userId, deps.themeId, {
        seed: refined.seed,
        tokens: refined.tokens,
        description: refined.description,
      })
      if (!updated) {
        return { data: 'Could not update the theme — it may have been deleted.', isError: true }
      }

      deps.onRefined?.(updated.id, updated.tokens, seedAppearance(updated.seed))
      return { data: `Refined "${updated.name}" and applied it live.` }
    },
  })
}
