/**
 * The build this extension was assembled from.
 *
 * Read from `build-info.json` rather than compiled in: the stamp is written by
 * `scripts/assemble.mjs` AFTER `tsc`, so baking it into a `.ts` constant would
 * mean rewriting compiled output, and a `.ts` constant is also something a
 * human could edit into a lie. A file the build writes and the runtime reads
 * cannot disagree with the build.
 *
 * A missing or unreadable file resolves to null, which the relay treats as
 * stale — correct, because only a build predating the stamp has no file.
 */

type RuntimeLike = { getURL(path: string): string }

let cached: string | null | undefined

function runtime(explicit?: RuntimeLike): RuntimeLike | null {
  if (explicit) return explicit
  const g = globalThis as { chrome?: { runtime?: RuntimeLike }; browser?: { runtime?: RuntimeLike } }
  return g.chrome?.runtime ?? g.browser?.runtime ?? null
}

/** Cached after the first read: the file cannot change without a reload. */
export async function readBuildStamp(explicit?: RuntimeLike): Promise<string | null> {
  if (cached !== undefined) return cached
  cached = null
  try {
    const rt = runtime(explicit)
    if (!rt) return cached
    const res = await fetch(rt.getURL('build-info.json'))
    const body = (await res.json()) as { build?: unknown }
    if (typeof body.build === 'string' && body.build) cached = body.build
  } catch {
    // Unreadable reads as absent, which reads as stale. Failing loud here would
    // take down the relay connection over a diagnostic.
  }
  return cached
}

/** Test seam: drop the memo so a fresh stamp can be read. */
export function resetBuildStampCache(): void {
  cached = undefined
}
