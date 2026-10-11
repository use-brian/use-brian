/**
 * Can a web page be framed by the Chat side pane (chat-parity T9)?
 *
 * Most sites refuse to be framed, and a refused iframe renders as an empty
 * grey box with no explanation. So the pane asks first: the link-preview
 * probe (`POST /api/doc/og-preview`, `routes/doc-og.ts`, SSRF-guarded with
 * per-hop redirect re-validation) already fetches the page for its title and
 * favicon, and reports `embeddable` from the FINAL response's headers:
 *
 *   - `X-Frame-Options` of any value (`DENY`, `SAMEORIGIN`, the obsolete
 *     `ALLOW-FROM`) refuses: none of them can name the Chat app's origin in
 *     a way every browser honours;
 *   - CSP `frame-ancestors` refuses unless it allows any origin (`*`, or a
 *     bare `https:` / `http:` scheme source). A list naming specific origins
 *     refuses too: the probe's answer is cached per URL, not per embedder,
 *     and a site naming the Chat app's own origin is not a case worth a
 *     per-origin cache;
 *   - no header at all allows.
 *
 * A `url` tab that is embeddable renders in a sandboxed iframe; otherwise it
 * renders a link card (title, favicon, domain, Open in browser). On the
 * desktop app every `url` tab is a native browser tab instead (T7).
 *
 * Pure. [COMP:api/url-embeddable]
 */

export type FrameEmbedding = {
  embeddable: boolean
  reason: 'allowed' | 'x_frame_options' | 'frame_ancestors'
}

/** The `frame-ancestors` sources of a CSP header value, or null when absent. */
export function frameAncestors(csp: string | null | undefined): string[] | null {
  if (!csp) return null
  // Several policies may be joined with commas; every one applies.
  let sources: string[] | null = null
  for (const policy of csp.split(',')) {
    for (const directive of policy.split(';')) {
      const parts = directive.trim().split(/\s+/).filter(Boolean)
      if (parts[0]?.toLowerCase() !== 'frame-ancestors') continue
      const list = parts.slice(1).map((source) => source.toLowerCase())
      // The strictest policy wins: intersecting "anything" with a list is the list.
      sources = sources === null || isWildcard(sources) ? list : isWildcard(list) ? sources : list
    }
  }
  return sources
}

function isWildcard(sources: string[]): boolean {
  return sources.some((source) => source === '*' || source === 'https:' || source === 'http:')
}

export function decideFrameEmbedding(headers: {
  xFrameOptions?: string | null
  contentSecurityPolicy?: string | null
}): FrameEmbedding {
  if (headers.xFrameOptions && headers.xFrameOptions.trim()) {
    return { embeddable: false, reason: 'x_frame_options' }
  }
  const ancestors = frameAncestors(headers.contentSecurityPolicy)
  if (ancestors !== null && !isWildcard(ancestors)) {
    return { embeddable: false, reason: 'frame_ancestors' }
  }
  return { embeddable: true, reason: 'allowed' }
}
