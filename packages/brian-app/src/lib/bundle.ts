/**
 * Bundle shape + caps for a custom Home app.
 *
 * A bundle is: `brian-app.json` (the manifest) + an entry HTML + optional
 * static assets. Nothing else — no server, no build step, no npm install at
 * import time. That is what makes "someone else's code, hosted by us" a
 * tractable thing to run at all.
 *
 * The caps are not performance tuning. They are what keeps the per-blob GitHub
 * fetch acceptable (no tarball path exists in this codebase, and v1 does not
 * add one) and what stops an import from being a storage-exhaustion lever.
 *
 * Spec: docs/architecture/features/home-apps.md → "Custom apps".
 */

import { isSafeBundlePath, parseManifest, type AppManifest } from './manifest.js'

export const MANIFEST_FILENAME = 'brian-app.json'

/** v1 caps. Import fails — loudly — rather than truncating past any of these. */
export const BUNDLE_MAX_FILES = 100
export const BUNDLE_MAX_TOTAL_BYTES = 5 * 1024 * 1024
export const BUNDLE_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Content types the bundle route will serve, keyed by lowercase extension.
 *
 * PINNED, not sniffed. The bytes are third-party, so letting the response
 * content-type be derived from content would let an app choose how the browser
 * interprets its own file — the exact move that turns "static asset" into
 * "script running on our origin". An extension outside this table is REJECTED
 * AT IMPORT rather than served as `application/octet-stream`: a file we would
 * not serve has no business in the bundle, and shipping it silently means the
 * author debugs a 404 that the import could have explained.
 */
export const BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
}

/** The pinned content type for a bundle path, or `null` if we would not serve it. */
export function contentTypeFor(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return BUNDLE_CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] ?? null
}

/** One file in a bundle. `bytes` is the size; the body itself is not needed here. */
export type BundleFile = {
  /** POSIX path relative to the bundle root. */
  path: string
  bytes: number
}

export type BundleIssue = {
  path: string
  message: string
}

export type ValidateBundleResult =
  | { ok: true; manifest: AppManifest; files: BundleFile[]; totalBytes: number }
  | { ok: false; issues: BundleIssue[] }

/**
 * Validate a bundle's file list against the caps and the manifest.
 *
 * `manifestJson` is passed separately (already read) because the caller has
 * very different ways of getting it — a GitHub blob fetch, a zip entry, an
 * assistant tool argument — and none of them should have to fake a filesystem
 * to run this.
 */
export function validateBundle(params: {
  files: readonly BundleFile[]
  manifestJson: unknown
}): ValidateBundleResult {
  const issues: BundleIssue[] = []

  const parsed = parseManifest(params.manifestJson)
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((i) => ({
        path: i.path ? `${MANIFEST_FILENAME}#${i.path}` : MANIFEST_FILENAME,
        message: i.message,
      })),
    }
  }
  const manifest = parsed.manifest

  const seen = new Set<string>()
  let totalBytes = 0
  const files: BundleFile[] = []

  for (const file of params.files) {
    if (!isSafeBundlePath(file.path)) {
      issues.push({ path: file.path, message: 'is not a safe relative bundle path' })
      continue
    }
    // Case-insensitive: the bundle is served from object storage but authored
    // on filesystems that may not distinguish `App.js` from `app.js`, and two
    // entries that collide on one of them is an ambiguity we would resolve
    // arbitrarily at serve time.
    const key = file.path.toLowerCase()
    if (seen.has(key)) {
      issues.push({ path: file.path, message: 'is a duplicate path' })
      continue
    }
    seen.add(key)

    if (!Number.isFinite(file.bytes) || file.bytes < 0) {
      issues.push({ path: file.path, message: 'has an invalid size' })
      continue
    }
    if (file.bytes > BUNDLE_MAX_FILE_BYTES) {
      issues.push({
        path: file.path,
        message: `is larger than the ${BUNDLE_MAX_FILE_BYTES / 1024 / 1024} MB per-file limit`,
      })
      continue
    }
    if (file.path !== MANIFEST_FILENAME && contentTypeFor(file.path) === null) {
      issues.push({
        path: file.path,
        message: 'has a file type this bundle format does not serve',
      })
      continue
    }
    totalBytes += file.bytes
    files.push({ path: file.path, bytes: file.bytes })
  }

  if (files.length > BUNDLE_MAX_FILES) {
    issues.push({
      path: '',
      message: `has ${files.length} files, over the ${BUNDLE_MAX_FILES} file limit`,
    })
  }
  if (totalBytes > BUNDLE_MAX_TOTAL_BYTES) {
    issues.push({
      path: '',
      message: `is ${Math.round(totalBytes / 1024)} KB, over the ${
        BUNDLE_MAX_TOTAL_BYTES / 1024 / 1024
      } MB bundle limit`,
    })
  }

  const paths = new Set(files.map((f) => f.path))
  if (!paths.has(MANIFEST_FILENAME)) {
    issues.push({ path: MANIFEST_FILENAME, message: 'is missing' })
  }
  if (!paths.has(manifest.entry)) {
    issues.push({
      path: manifest.entry,
      message: 'is named as the manifest entry but is not in the bundle',
    })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, manifest, files, totalBytes }
}

export type LintFinding = {
  path: string
  message: string
  /** Advisory — never fails an import. Schema violations are the fatal half. */
  severity: 'warning'
}

/**
 * Advisory checks. Findings here are HINTS: they surface in `brian-app lint`
 * and in the import result, but they never block. Schema violations
 * (`validateBundle`) are the fatal half; conflating the two would mean a
 * stylistic nit could stop a working app from being installed.
 */
export function lintBundle(params: {
  files: readonly BundleFile[]
  manifest: AppManifest
}): LintFinding[] {
  const findings: LintFinding[] = []
  const warn = (path: string, message: string) =>
    findings.push({ path, message, severity: 'warning' })

  if (!params.manifest.description) {
    warn(MANIFEST_FILENAME, 'has no description — the consent screen will look bare')
  }
  if (!params.manifest.icon) {
    warn(MANIFEST_FILENAME, 'has no icon — the app-bar will show a generic puzzle glyph')
  }
  if (params.manifest.scopes.data === 'read_write') {
    warn(
      MANIFEST_FILENAME,
      'requests read_write. Ask for read unless the app genuinely writes — a wider scope is a harder consent to get',
    )
  }
  if (params.manifest.scopes.store === 'write') {
    findings.push({
      path: '',
      severity: 'warning',
      message:
        'requests scopes.store=write — it can create products, change prices and publish to ' +
        'the live storefront. It can never refund, cancel an order, or write a theme template',
    })
  }
  if (params.manifest.scopes.agent === 'ask') {
    findings.push({
      path: '',
      severity: 'warning',
      message:
        'requests scopes.agent=ask — it can spend model time and act through your assistant. ' +
        'The turn is capped at this app\'s own tools, so it cannot exceed scopes.store',
    })
  }
  for (const origin of params.manifest.scopes.net ?? []) {
    warn(
      MANIFEST_FILENAME,
      `allowlists ${origin}. Each net origin is one more place workspace data can go — drop it if the bridge covers the need`,
    )
  }
  const total = params.files.reduce((sum, f) => sum + f.bytes, 0)
  if (total > BUNDLE_MAX_TOTAL_BYTES * 0.8) {
    warn('', 'is close to the bundle size limit — the next asset may not fit')
  }
  return findings
}
