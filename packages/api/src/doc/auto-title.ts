/**
 * `runDocAutoTitle` — the single auto-title orchestration both triggers
 * share (see docs/architecture/features/doc.md → "Auto-title"):
 *
 *   - the **human** trigger via `POST /api/saved-views/:id/auto-title`
 *     (`routes/views.ts`), and
 *   - the **AI** trigger in the chat route's post-turn block (`routes/chat.ts`).
 *
 * It is the one place that reads the merged page, gates on
 * `name_origin === 'placeholder'` + a min-size floor, generates a title
 * (`generatePageTitle`), and commits through the guarded
 * `SavedViewStore.setAutoTitle` (placeholder → auto). Keeping it here — not
 * duplicated in two routes — means the "untouched → auto" transition has one
 * implementation.
 *
 * Returns `usage`/`model` even when it no-ops past generation so the caller
 * can attribute the overhead cost; the human endpoint skips attribution (no
 * assistant/session context), the AI path records it.
 *
 * [COMP:api/doc-auto-title]
 */

import {
  generatePageTitle,
  type DocPageStore,
  type LLMProvider,
  type SavedViewStore,
  type TokenUsage,
} from '@use-brian/core'
import { pageToPlaintext } from '@use-brian/doc-model'

export type RunDocAutoTitleParams = {
  userId: string
  pageId: string
  provider: LLMProvider
  docPageStore: DocPageStore
  savedViewStore: SavedViewStore
  /**
   * Minimum body plaintext length before titling. The human endpoint passes
   * `AUTO_TITLE_MIN_CHARS` (a developed page); the AI path passes
   * `AUTO_TITLE_AI_MIN_CHARS` (its first edit is intentional).
   */
  minChars: number
}

export type RunDocAutoTitleResult = {
  /** True iff the title was generated AND the guarded commit landed it. */
  applied: boolean
  /** The committed title, or null when skipped / not generated. */
  title: string | null
  /**
   * The committed page icon — the generator's suggested emoji when the commit
   * filled a previously-empty icon, the user's existing emoji when one was
   * already set, or null. Only meaningful when `applied` is true.
   */
  icon: string | null
  /** For overhead-cost attribution (null when no model call happened). */
  usage: TokenUsage | null
  model: string | null
}

const SKIPPED: RunDocAutoTitleResult = {
  applied: false,
  title: null,
  icon: null,
  usage: null,
  model: null,
}

export async function runDocAutoTitle(
  params: RunDocAutoTitleParams,
): Promise<RunDocAutoTitleResult> {
  const { userId, pageId, provider, docPageStore, savedViewStore, minChars } = params

  // 1. Read the merged page (prefers the live Yjs snapshot). `nameOrigin`
  //    rides along — only 'placeholder' pages are eligible.
  const read = await docPageStore.getVersionedPage(userId, pageId)
  if (!read || read.nameOrigin !== 'placeholder') return SKIPPED

  // 2. Size gate. Below the floor → leave the placeholder; the next crossing
  //    (human) or the AI path retries while still 'placeholder'.
  const text = pageToPlaintext(read.page)
  if (text.length < minChars) return SKIPPED

  // 3. Generate. Null when the model can't produce a meaningful title — keep
  //    the placeholder rather than overwrite it (attribution still returned).
  //    `gen.icon` is a suggested emoji (may be null).
  const gen = await generatePageTitle(provider, text)
  if (!gen.title) {
    return { applied: false, title: null, icon: null, usage: gen.usage, model: gen.model }
  }

  // 4. Commit through the guarded transition. A concurrent rename / the other
  //    trigger may have flipped name_origin since the read — setAutoTitle's
  //    `WHERE name_origin = 'placeholder'` makes that a clean no-op (null).
  //    The icon rides the same statement (COALESCE — never clobbers a
  //    user-chosen emoji).
  const committed = await savedViewStore.setAutoTitle(userId, pageId, gen.title, gen.icon)
  return {
    applied: committed !== null,
    title: committed?.name ?? null,
    icon: committed?.icon ?? null,
    usage: gen.usage,
    model: gen.model,
  }
}
