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
 * Index filename aliases. Strict lookup also includes every exact path
 * and only accepts aliases that refer to one path.
 */
export function buildPathIndex(paths: string[], options?: { uniqueAliases: boolean }): Map<string, string> {
  const exact = new Set(paths)
  const strict = options?.uniqueAliases === true
  const index = new Map<string, string>(strict ? [...exact].map(path => [path, path]) : [])
  const ambiguousAliases = new Set<string>()
  for (const path of exact) {
    const filename = path.split('/').pop()
    if (!filename || (strict && exact.has(filename))) continue
    if (!index.has(filename)) index.set(filename, path)
    else if (strict) ambiguousAliases.add(filename)
  }
  for (const alias of ambiguousAliases) index.delete(alias)
  return index
}

export function resolveWikilink(
  link: string,
  currentPath: string,
  index: Map<string, string>,
): string | null {
  let cleaned = link.trim().replace(/\.md$/i, '')
  cleaned = cleaned.replace(/\/index$/i, '')

  const indexedPath = index.get(cleaned)
  if (indexedPath !== undefined) return indexedPath

  if (cleaned.startsWith('.')) {
    return posixPath.normalize(posixPath.join(currentPath, cleaned)).replace(/\/index$/i, '')
  }

  if (cleaned.includes('/')) {
    return cleaned.replace(/^\/+/, '')
  }

  return null
}
