/**
 * Decode a Threads/Instagram URL shortcode into the underlying numeric pk
 * and the post's creation timestamp.
 *
 * Shortcodes (e.g. `DX4FjS5Gl5x` in `threads.com/@user/post/DX4FjS5Gl5x`)
 * are a URL-safe base64 of the platform's internal 64-bit numeric id, using
 * the Instagram alphabet:
 *
 *     ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_
 *
 * The first 41 bits of that id are the post creation time in milliseconds
 * since the Instagram epoch (`2011-08-24T21:07:01.721Z`, i.e.
 * `1314220021721`).
 *
 * **Why this matters.** The Threads Graph API has no public "look up post
 * by URL" endpoint, but it does expose `GET /v1.0/profile_posts?username=…`
 * with `since` / `until` filters. By decoding the shortcode's embedded
 * timestamp locally (no network), we narrow the listing window to a
 * single day on the post-resolver path — turning what would be a 20-page
 * paginated walk back through someone's history into a one-page lookup.
 *
 * **What this does NOT do.** It does not call any network. It does not
 * confirm whether the resulting numeric id is the same as the Graph API
 * `id` field used for `reply_to_id` (Instagram historically uses
 * different ids on its public Graph API). The resolver pairs this decode
 * with a `profile_posts` lookup that filters by shortcode — so even if
 * the decoded pk diverges from the Graph API id, we still find the
 * correct post and use its real Graph API id.
 */

const SHORTCODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Instagram epoch in ms: 2011-08-24T21:07:01.721Z. Used by Instagram and
 * Threads alike (the two systems share a snowflake-shaped id space).
 */
export const INSTAGRAM_EPOCH_MS = 1_314_220_021_721

const SHORTCODE_PATTERN = /^[A-Za-z0-9_-]+$/

export type DecodedShortcode = {
  /** Internal 64-bit numeric id encoded in the shortcode. */
  pk: bigint
  /** ms since the Unix epoch — derived from the top 41 bits of `pk`. */
  timestampMs: number
}

/**
 * Decode a shortcode into its numeric pk + creation timestamp.
 * Returns `null` for any shortcode that contains characters outside the
 * alphabet, or that decodes to a timestamp that's clearly bogus
 * (before the IG epoch, or in the far future).
 */
export function decodeThreadsShortcode(shortcode: string): DecodedShortcode | null {
  if (!shortcode || !SHORTCODE_PATTERN.test(shortcode)) return null

  let pk = 0n
  for (const ch of shortcode) {
    const idx = SHORTCODE_ALPHABET.indexOf(ch)
    if (idx < 0) return null
    pk = (pk << 6n) | BigInt(idx)
  }

  // Top 41 bits = ms since IG epoch. Anything below the epoch or more than
  // a day in the future indicates either an unrelated id space or a bogus
  // shortcode — drop it so the caller falls back to a wider lookup.
  const sinceEpoch = Number(pk >> 23n)
  const timestampMs = sinceEpoch + INSTAGRAM_EPOCH_MS

  if (sinceEpoch < 0) return null
  if (timestampMs < INSTAGRAM_EPOCH_MS) return null
  if (timestampMs > Date.now() + 24 * 60 * 60 * 1000) return null

  return { pk, timestampMs }
}
