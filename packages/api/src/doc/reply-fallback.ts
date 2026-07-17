/**
 * Reply-to-page safety net for doc "New draft" builds.
 *
 * A doc build anchored to an empty page — the "New draft" / blank-tab
 * landing chatter (see `docs/architecture/features/doc.md` →
 * "Default-viewer landing") — is meant to author the page IN PLACE via
 * `patchPage`, never answer in the floating chat. "The page is the surface":
 * the chat route injects an explicit "this page is open and EMPTY, build it
 * in place" instruction to that end.
 *
 * But a build can still end with only a text reply and NO page op — e.g. the
 * model researched all the way to the per-turn tool-call budget and was
 * forced to synthesize a chat answer, or it answered conversationally
 * instead of authoring. Left alone, that reply lands only in the chat
 * session (`session_messages`) and the page snaps back to its "New draft"
 * placeholder: the silent-failure the user sees — the doc streams events
 * for a few seconds, then "nothing happened".
 *
 * This helper is the backstop the chat route runs post-turn: when the
 * anchored page is STILL EMPTY and the AI wrote nothing to it this turn,
 * write the reply onto the page as a text block through the SAME live
 * `patchPage` path (the Yjs gateway), so the answer appears where the user
 * is looking instead of only in the collapsed chat dock. It deliberately
 * no-ops on a non-empty page, so it can never clobber an established page
 * where an edit turn legitimately answered in chat.
 *
 * [COMP:api/doc-reply-fallback] — docs/architecture/features/doc.md
 * → "Reply-to-page safety net".
 */

import type { DocPageStore, Tool, ToolContext } from '@use-brian/core'

export type PlaceReplyOnEmptyPageParams = {
  /** The anchored doc page (the open "New draft"). */
  pageId: string
  /** The assistant's final reply text for the turn (may carry Markdown). */
  replyText: string
  /** Version-aware page read (RLS-scoped) — used to gate on emptiness. */
  docPageStore: DocPageStore
  /**
   * The already-wired `patchPage` tool pulled from the per-turn tool map. It
   * carries the live Yjs gateway, the markdown normalizer, the `<followup>`
   * sanitizer, and the `onEvent` hook that records the page into the chat
   * route's `docWrittenPageIds` (so the post-turn auto-title pass then
   * names the now-non-empty page).
   */
  patchPageTool: Tool
  /** Tool context for the synthetic patch (drives the userId + workspace gate). */
  context: ToolContext
}

export type PlaceReplyResult =
  | { placed: true; pageId: string }
  | {
      placed: false
      reason:
        | 'no-text'
        | 'page-not-found'
        | 'page-not-empty'
        | 'anchor-missing'
        | 'patch-failed'
    }

/**
 * Write `replyText` onto `pageId` as a text block — but only when the page is
 * still empty. Returns a structured result so the caller can log why it did
 * or didn't fire (the `reason` doubles as a monitoring signal: a spike in
 * `page-not-empty` is healthy authoring; a spike in placed-true means builds
 * are routinely failing to author and answering in chat instead).
 */
export async function placeReplyOnEmptyPage(
  params: PlaceReplyOnEmptyPageParams,
): Promise<PlaceReplyResult> {
  const text = params.replyText.trim()
  if (!text) return { placed: false, reason: 'no-text' }

  const current = await params.docPageStore.getVersionedPage(
    params.context.userId,
    params.pageId,
  )
  if (!current) return { placed: false, reason: 'page-not-found' }
  // Only auto-place onto a still-empty page. A non-empty page means either
  // the build DID author (the caller's `docWrittenPageIds` gate already
  // covers that) or it's an established page an edit turn touched — never
  // overwrite those by dumping the chat reply at the end.
  if (current.page.blocks.length > 0) {
    return { placed: false, reason: 'page-not-empty' }
  }

  // Append the reply as a single text block. `patchPage`'s markdown
  // normalizer expands any `### heading` / list / `**bold**` the model
  // emitted into the canonical blocks, and the `<followup>` sanitizer strips
  // chat-only chip tags — so a conversational answer becomes a clean,
  // readable page rather than a literal-Markdown blob.
  const result = await params.patchPageTool.execute(
    {
      pageId: params.pageId,
      expectedVersion: current.version,
      ops: [{ op: 'add', block: { id: 'tmp-reply', kind: 'text', text } }],
    },
    params.context,
  )
  if (result.isError) return { placed: false, reason: 'patch-failed' }
  return { placed: true, pageId: params.pageId }
}

/**
 * Anchored sibling of {@link placeReplyOnEmptyPage} for the app-web
 * "Space for AI" inline trigger (`ai-space-trigger.ts`). There the user parks
 * the cursor on a specific (empty) block of a possibly-POPULATED page and asks
 * the AI to generate content right there — the request rides in as
 * `docAnchorBlockId` and the chat route injects an "Insertion anchor → use
 * `patchPage` `after:<id>`" instruction to that end.
 *
 * The failure this guards: the model answers with only a text reply and never
 * calls `patchPage` (model non-compliance — observed on the weaker doc-tier
 * models). The empty-page net above no-ops on a populated page
 * (`page-not-empty`), so the generated answer is stranded in the collapsed
 * chat dock and the user, staring at the anchor line, sees "nothing
 * generated" (prod 2026-06-11 repro: a "fill this section as toggles" inline
 * ask answered as a Markdown chat reply on a 74-block page).
 *
 * Unlike the empty-page net this deliberately does NOT gate on emptiness — the
 * whole point is to land content on an established page — but it requires the
 * anchor block to STILL EXIST on the page (the model may have rewritten or
 * removed it this turn). A vanished anchor returns `anchor-missing` so the
 * caller can fall through to the empty-page net rather than dump content at a
 * surprising spot. The shared caller gate (`!docWrittenPageIds.has(pageId)`)
 * guarantees this only fires when the AI wrote nothing to the page this turn,
 * so it can never double-write a page the build already authored.
 *
 * [COMP:api/doc-reply-fallback] — docs/architecture/features/doc.md
 * → "Reply-to-page safety net".
 */
export async function placeReplyAtAnchor(
  params: PlaceReplyOnEmptyPageParams & {
    /** The block the user invoked AI on; the reply lands immediately after it. */
    anchorBlockId: string
  },
): Promise<PlaceReplyResult> {
  const text = params.replyText.trim()
  if (!text) return { placed: false, reason: 'no-text' }

  const current = await params.docPageStore.getVersionedPage(
    params.context.userId,
    params.pageId,
  )
  if (!current) return { placed: false, reason: 'page-not-found' }
  // The anchor must still be on the page. If the model rewrote or removed it
  // this turn we can't anchor — signal the caller to fall back to the
  // empty-page net rather than append the reply at an arbitrary position.
  if (!current.page.blocks.some((b) => b.id === params.anchorBlockId)) {
    return { placed: false, reason: 'anchor-missing' }
  }

  // Append the reply as a single text block immediately AFTER the anchor — the
  // exact spot the user invoked AI. Same live `patchPage` path as the
  // empty-page net (markdown normalizer expands the reply, `<followup>`
  // sanitizer strips chat-only chips, `onEvent` records the page for
  // auto-title).
  const result = await params.patchPageTool.execute(
    {
      pageId: params.pageId,
      expectedVersion: current.version,
      ops: [
        {
          op: 'add',
          after: params.anchorBlockId,
          block: { id: 'tmp-reply', kind: 'text', text },
        },
      ],
    },
    params.context,
  )
  if (result.isError) return { placed: false, reason: 'patch-failed' }
  return { placed: true, pageId: params.pageId }
}
