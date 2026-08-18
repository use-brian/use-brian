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
import { buildTool, toolFailure, type Tool, type LLMProvider } from '@use-brian/core'
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
        // `deps.themeId` is the doc client's applied-theme preference, not
        // something the model passed — so there is no argument to correct and
        // no sibling tool that lists themes. The remedy is entirely user-side.
        return {
          data:
            `The theme was not changed: custom theme ${deps.themeId} — the one this browser has applied — no longer exists for this user, so there is nothing to refine. ` +
            'It was deleted (or the applied-theme setting is stale from another account). ' +
            'There is no tool that can list or pick a theme; ask the user to open the doc Theme menu and apply or create a custom theme, then repeat the instruction. ' +
            'Retrying refineActiveTheme now will fail the same way.',
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
              `Theme "${theme.name}" was NOT changed: the generator could not turn the instruction ${JSON.stringify(input.instruction)} into a valid palette (${err.message}). ` +
              'Nothing was saved. Re-issue with a concrete visual adjustment - a temperature, a contrast level, or a named colour for the accent (for example "warmer", "more contrast", "swap the accent to green", "darker and more minimal"). ' +
              'Sending the same instruction again will fail the same way.',
            isError: true,
          }
        }
        return toolFailure(err, {
          tool: 'refineActiveTheme',
          action: `Refining custom theme "${theme.name}" from the instruction ${JSON.stringify(input.instruction)}`,
          mutating: true,
          next: 'The user\'s applied theme is unchanged - do not tell them it was updated.',
        })
      }

      const updated = await deps.store.updateGenerated(context.userId, deps.themeId, {
        seed: refined.seed,
        tokens: refined.tokens,
        description: refined.description,
      })
      if (!updated) {
        return {
          data:
            `Theme "${theme.name}" (${deps.themeId}) was NOT changed: the refined palette was generated, but the theme row disappeared before it could be written — it was deleted while this ran. ` +
            'Nothing was saved and the user still sees the old theme. Tell them the theme is gone and that a new one can be created from the doc Theme menu. ' +
            'Retrying refineActiveTheme against this theme will fail the same way.',
          isError: true,
        }
      }

      deps.onRefined?.(updated.id, updated.tokens, seedAppearance(updated.seed))
      return { data: `Refined "${updated.name}" and applied it live.` }
    },
  })
}
