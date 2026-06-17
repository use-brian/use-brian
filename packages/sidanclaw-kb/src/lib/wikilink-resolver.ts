/**
 * Wikilink resolver — canonical interface used by the sync worker.
 *
 * Takes string-level inputs (link, currentPath, path index) and returns a
 * resolved path string or null. Lint builds a richer LintIndex on top (see
 * kb-index.ts) but uses the same three-step algorithm.
 *
 * Resolution order:
 *   1. Exact path match against the index's known paths
 *   2. Relative path (./ or ../) resolved against currentPath
 *   3. Filename-only match against the filename → path map
 */

import * as posixPath from 'node:path/posix'

/**
 * Build a filename → path index from all known KB paths.
 * When multiple paths share the same filename, first wins.
 */
export function buildPathIndex(paths: string[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const p of paths) {
    const filename = p.split('/').pop()
    if (filename && !index.has(filename)) {
      index.set(filename, p)
    }
  }
  return index
}

export function resolveWikilink(
  link: string,
  currentPath: string,
  index: Map<string, string>,
): string | null {
  let cleaned = link.trim().replace(/\.md$/i, '')
  cleaned = cleaned.replace(/\/index$/i, '')

  if (index.has(cleaned) || [...index.values()].includes(cleaned)) {
    if ([...index.values()].includes(cleaned)) return cleaned
    return index.get(cleaned) ?? null
  }

  if (cleaned.startsWith('.')) {
    const resolved = posixPath.normalize(posixPath.join(currentPath, cleaned))
      .replace(/\/index$/i, '')
    if ([...index.values()].includes(resolved)) return resolved
    return resolved
  }

  if (cleaned.includes('/')) {
    if ([...index.values()].includes(cleaned)) return cleaned
    const stripped = cleaned.replace(/^\/+/, '')
    if ([...index.values()].includes(stripped)) return stripped
    return stripped
  }

  if (index.has(cleaned)) return index.get(cleaned)!
  return null
}
