/**
 * The one parser for a draft's `media` payload.
 *
 * The save-draft body is parsed twice by hand -- once by the open
 * `parseContentDraftBody` (`routes/content-planning.ts`) and once by the
 * hosted `SaveDraftPayload` parser (`api-platform/routes/feed-draft-sessions.ts`).
 * That fork is a known manual-parity site (docs/plans/feed-revamp-depth.md §5),
 * and `pnpm check`'s connector-route-parity invariant does not cover it: it
 * scopes to `/api/connectors`. A media field added to one edition and not the
 * other would drop images silently in whichever one was missed, and both
 * editions would still typecheck and unit-test green.
 *
 * So the shape lives here once and both callers import it. The hosted package
 * already depends on `@use-brian/api`, so this costs nothing and removes the
 * drift rather than asking two test suites to notice it.
 *
 * [COMP:feed/post-media-parse]
 */

import type { PostMedia } from '../db/content-planning-store.js'

/** Per-post ceiling. Threads carousels top out at 20; nobody needs more. */
export const MAX_POST_MEDIA = 10

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only still images. Video is excluded upstream by the upload mime allowlist. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export type ParsedMedia =
  | { ok: true; media: PostMedia[] }
  | { ok: false; reason: string }

/**
 * `undefined` means "not in this request" and yields an empty list, which is
 * also the column default -- an omitted field must never look like a deletion
 * to one edition and a no-op to the other.
 *
 * Every other malformed input is rejected loudly rather than filtered down to
 * the valid entries: silently dropping one image of three would tell the
 * operator the post has media while publishing something different.
 */
export function parsePostMedia(raw: unknown): ParsedMedia {
  if (raw === undefined || raw === null) return { ok: true, media: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'media must be an array' }
  if (raw.length > MAX_POST_MEDIA) {
    return { ok: false, reason: `media accepts at most ${MAX_POST_MEDIA} items` }
  }

  const media: PostMedia[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, reason: 'each media entry must be an object' }
    }
    const { fileId, mimeType, alt } = entry as Record<string, unknown>
    if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) {
      return { ok: false, reason: 'media.fileId must be a workspace file id' }
    }
    if (typeof mimeType !== 'string' || !ALLOWED_MIME.has(mimeType)) {
      return {
        ok: false,
        reason: `media.mimeType must be one of ${[...ALLOWED_MIME].join(', ')}`,
      }
    }
    if (alt !== undefined && typeof alt !== 'string') {
      return { ok: false, reason: 'media.alt must be a string when present' }
    }
    media.push({
      fileId,
      mimeType,
      ...(typeof alt === 'string' && alt.trim()
        ? { alt: alt.trim().slice(0, 1_000) }
        : {}),
    })
  }

  // A post cannot carry the same image twice; the platforms render it as two
  // slides of the same picture and the operator reads it as a bug.
  const seen = new Set(media.map((m) => m.fileId))
  if (seen.size !== media.length) {
    return { ok: false, reason: 'media cannot repeat the same file' }
  }
  return { ok: true, media }
}
