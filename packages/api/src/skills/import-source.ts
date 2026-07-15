/**
 * Skill-import URL normalization + allowlisted raw fetch.
 *
 * The URL-paste import path only ever fetches known public code hosts —
 * that IS the SSRF stance: no arbitrary-host server-side fetch, so no
 * private-address guard is needed. GitHub browse (private repos) goes
 * through the connector PAT + `github/client.ts` instead, never here.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Importing skills
 * (GitHub / URL)" → "Sources".
 *
 * [COMP:api/skill-import]
 */

/** Hosts the raw fetcher may request. Extend deliberately, never wildcard. */
const ALLOWED_RAW_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
])

export type NormalizedImportUrl = {
  /** The URL the fetcher will actually request (always an allowlisted host). */
  fetchUrl: string
  /** Best-effort display file name for the dialect normalizer. */
  fileName: string
  /** Provenance fields recoverable from the URL shape. */
  provenance: {
    kind: 'url'
    url: string
    owner?: string
    repo?: string
    ref?: string
    path?: string
  }
}

export type ImportUrlError = { error: string }

/**
 * Normalize a pasted URL to an allowlisted raw fetch. Accepts:
 *
 *   - github.com/<owner>/<repo>/blob/<ref>/<path>   → raw.githubusercontent.com
 *   - github.com/<owner>/<repo>/raw/<ref>/<path>    → raw.githubusercontent.com
 *   - raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> (as-is)
 *   - gist.github.com/<user>/<id>                   → gist raw (first file)
 *   - gist.githubusercontent.com/... (as-is)
 *
 * Anything else is rejected with the allowlist named in the error.
 */
export function normalizeImportUrl(rawUrl: string): NormalizedImportUrl | ImportUrlError {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return { error: 'Not a valid URL.' }
  }
  if (url.protocol !== 'https:') {
    return { error: 'Only https URLs can be imported.' }
  }

  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)

  if (host === 'github.com') {
    // /<owner>/<repo>/(blob|raw)/<ref>/<path...>
    const [owner, repo, kind, ref, ...pathParts] = segments
    if (!owner || !repo || (kind !== 'blob' && kind !== 'raw') || !ref || pathParts.length === 0) {
      return {
        error:
          'GitHub URLs must point at a file (github.com/<owner>/<repo>/blob/<branch>/<path>).',
      }
    }
    const path = pathParts.join('/')
    return {
      fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
      fileName: pathParts[pathParts.length - 1]!,
      provenance: { kind: 'url', url: rawUrl.trim(), owner, repo, ref, path },
    }
  }

  if (host === 'gist.github.com') {
    // /<user>/<id> → the gist's raw endpoint serves its first file.
    const [user, id] = segments
    if (!user || !id) {
      return { error: 'Gist URLs must look like gist.github.com/<user>/<id>.' }
    }
    return {
      fetchUrl: `https://gist.githubusercontent.com/${user}/${id}/raw`,
      fileName: `${id}.md`,
      provenance: { kind: 'url', url: rawUrl.trim(), owner: user, path: id },
    }
  }

  if (ALLOWED_RAW_HOSTS.has(host)) {
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...> — parse
    // provenance when the shape matches; pass through otherwise.
    const [owner, repo, ref, ...pathParts] = segments
    const fileName = segments[segments.length - 1] || 'imported.md'
    const provenance: NormalizedImportUrl['provenance'] =
      host === 'raw.githubusercontent.com' && owner && repo && ref && pathParts.length > 0
        ? { kind: 'url', url: rawUrl.trim(), owner, repo, ref, path: pathParts.join('/') }
        : { kind: 'url', url: rawUrl.trim() }
    return { fetchUrl: url.toString(), fileName, provenance }
  }

  return {
    error:
      'Only GitHub file links, gists, and raw.githubusercontent.com URLs can be imported. For private repos, connect GitHub and use the repo browser instead.',
  }
}

export const IMPORT_FETCH_TIMEOUT_MS = 10_000
export const IMPORT_MAX_FILE_BYTES = 262_144 // 256 KB — same order as the folder-walk total cap

export type RawImportFetcher = (fetchUrl: string) => Promise<string>

/**
 * Fetch an allowlisted raw file with a timeout and a size cap. Redirects are
 * followed, then the FINAL url's host is re-checked against the allowlist so
 * a redirect cannot escape it.
 */
export async function fetchAllowlistedRaw(fetchUrl: string): Promise<string> {
  const res = await fetch(fetchUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS),
    headers: { Accept: 'text/plain, text/markdown, */*' },
  })
  const finalHost = new URL(res.url || fetchUrl).hostname.toLowerCase()
  if (!ALLOWED_RAW_HOSTS.has(finalHost)) {
    throw new Error(`Fetch was redirected off the allowed hosts (${finalHost}).`)
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'File not found. Check the URL (private files need the GitHub repo browser).'
        : `Fetch failed with status ${res.status}.`,
    )
  }
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > IMPORT_MAX_FILE_BYTES) {
    throw new Error(`File is too large to import (${contentLength} bytes; limit ${IMPORT_MAX_FILE_BYTES}).`)
  }
  const text = await res.text()
  if (text.length > IMPORT_MAX_FILE_BYTES) {
    throw new Error(`File is too large to import (limit ${IMPORT_MAX_FILE_BYTES} bytes).`)
  }
  return text
}
