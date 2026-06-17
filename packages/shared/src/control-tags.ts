/**
 * Strip a model-confabulated comment-thread reply wrapper from AI-authored
 * text. NO prompt defines this tag — when a doc assistant replies inside a
 * comment thread it sometimes invents an XML-ish element to "mark" its reply as
 * belonging to the thread, e.g.
 *
 *   <comment-thread-reply pageId="b3317b50-…">…actual reply…</comment-thread-reply>
 *
 * Left in the body the markers render as literal tag soup on the doc comment
 * surfaces (the markdown renderer escapes the unknown element), leak an internal
 * page UUID, and re-teach the model the pattern via history replay on the next
 * turn. This UNWRAPS the tag: the open/close markers are removed but the inner
 * reply prose is preserved. A dangling unclosed opener (a half-streamed tag) is
 * dropped too, so a partial frame can't survive.
 *
 * Sibling to `stripFollowUps` — the same "an AI-emitted control tag must never
 * render as text" defense, applied at the same `app`-surface persist boundary in
 * `packages/api/src/routes/chat.ts`. `apps/app-web` keeps an inline mirror
 * (in `lib/api/sessions.ts`) so the browser bundle doesn't pull the shared
 * barrel — the same reason the followup strip is mirrored there.
 *
 * Spec: `docs/architecture/features/doc-comments.md` → "Reply routing".
 */
export function stripCommentThreadReplyTag(text: string): string {
  return text
    .replace(/<\/?comment-thread-reply\b[^>]*>/gi, '')
    .replace(/<comment-thread-reply\b[^>]*$/i, '')
    .trimEnd()
}
