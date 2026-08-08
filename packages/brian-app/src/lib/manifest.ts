/**
 * `brian-app.json` — the custom Home app manifest.
 *
 * ONE implementation, three consumers (the import/sync path, the assistant
 * authoring tools, and the public `brian-app lint` CLI), mirroring how
 * `@use-brian/brian-kb` serves the KB sync worker and the `kb` CLI. A second
 * copy of this schema is how an app that lints clean in CI gets rejected at
 * import, or worse, imports with permissions its author never saw.
 *
 * Deliberately dependency-free (no zod): this package is published for use in
 * app repos' CI, and a validator that drags a runtime dependency into every
 * template repo is a validator people skip.
 *
 * Spec: docs/architecture/features/home-apps.md → "Custom apps".
 */

/** Only version 1 exists. An unknown version is fatal, not tolerated: the
 *  manifest describes PERMISSIONS, and guessing at a shape we do not know is
 *  exactly where a permission model quietly fails open. */
export const MANIFEST_VERSION = 1

/** What an app may reach in the workspace brain. */
export type AppDataScope = 'read' | 'read_write'

/**
 * What an app may reach in a connected commerce store (currently Shopify).
 *
 * Deliberately a SEPARATE axis from `data`. Brain access and store access are
 * different decisions about different systems: a dashboard that reads a store
 * needs no brain at all, and store `write` reaches money and a public
 * storefront in a way no brain scope does. Folding the two into one tier is
 * how an admin approves more than the screen showed them.
 */
export type AppStoreScope = 'none' | 'read' | 'write'

/**
 * May the app hand a TASK to the workspace assistant?
 *
 * Separate from `data` and `store` because it is a different kind of power:
 * not "read this" or "write that" but "spend model time and act on my behalf".
 * The agent's tools are intersected with what the app itself may reach, so
 * this can never be a ladder to something the other two scopes denied.
 */
export type AppAgentScope = 'none' | 'ask'

/** Ordered so a drift check is a comparison, not a lookup table. */
const STORE_SCOPE_RANK: Record<AppStoreScope, number> = { none: 0, read: 1, write: 2 }

export type AppScopes = {
  /**
   * Brain access, gating the bridge's tool list exactly like a brain key's
   * scope. `read` reaches no write tool at all — not a filtered write, no
   * write.
   */
  data: AppDataScope
  /**
   * Commerce-store access, gating the bridge's store tool list. Default
   * `'none'` — omitted entirely from a normalized manifest, so every manifest
   * written before this scope existed keeps meaning exactly what it meant.
   *
   * `write` never reaches a DESTRUCTIVE tool. Refunds, cancellations,
   * completing a draft order and writing a theme template are excluded from
   * the bridge by construction, not by policy default; see
   * docs/architecture/features/home-apps.md → "Store scope".
   */
  store?: AppStoreScope
  /**
   * Hand a task to the workspace assistant. Default `'none'`.
   *
   * The turn runs with the app's OWN ceiling (`allowedTools` intersected with
   * `scopes.store`), never the assistant's full tool set — so an app cannot
   * ask the model to do what it was refused directly.
   */
  agent?: AppAgentScope
  /**
   * Release the viewer's display name to the app. A stable, opaque `userId`
   * claim is ALWAYS present (an app needs to tell viewers apart to key its own
   * per-user state); this flag is about the human-readable identity, which is
   * the part that is actually personal.
   */
  identity?: boolean
  /**
   * Origins the app may reach directly, folded into the serving CSP's
   * `connect-src`. Default: NONE. An app talks to the brain through the
   * bridge; anything else is an explicit, consented exception.
   */
  net?: string[]
}

export type AppManifest = {
  manifestVersion: typeof MANIFEST_VERSION
  name: string
  description?: string
  /** A lucide icon name. Unknown names fall back to a puzzle glyph at render. */
  icon?: string
  /** Entry HTML, relative to the bundle root. */
  entry: string
  scopes: AppScopes
  /**
   * Unknown top-level fields fall through here rather than failing the parse —
   * the KB parser's tolerance rule. Forward-compatibility belongs in the
   * fields a newer template might add, NOT in `scopes`, which is validated
   * closed.
   */
  metadata: Record<string, unknown>
}

export type ManifestIssue = {
  /** Dotted path into the manifest, e.g. `scopes.net[0]`. */
  path: string
  message: string
}

export type ParseManifestResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; issues: ManifestIssue[] }

const NAME_MAX = 60
const DESCRIPTION_MAX = 280
const ICON_MAX = 40

/** `index.html`, `assets/app.js` — a relative POSIX path with no escape. */
export function isSafeBundlePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  // Reject Windows drive letters, protocol-ish prefixes, and any traversal.
  if (/^[a-zA-Z]:/.test(value) || value.includes('://')) return false
  if (value.includes('\\')) return false
  if (value.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false
  // NUL and control characters have no business in a path we will serve.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return true
}

/**
 * An allowlisted `connect-src` origin: an https scheme, a host, and NOTHING
 * else. A path, a wildcard, or a plain-http origin all get rejected — this
 * string is concatenated into a Content-Security-Policy header, so anything
 * that could carry a space or a semicolon is a header-injection vector.
 */
export function isSafeNetOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.pathname !== '/' || url.search || url.hash) return false
  // NO WILDCARDS. `https://*.example.com` is legal CSP meaning "any subdomain",
  // and `new URL` happily parses it — but the consent screen would show one
  // origin while granting a whole tree, which is the opposite of informed
  // consent. An explicit hostname charset is the only thing that catches it:
  // labels of [a-z0-9-], dot-separated, at least two of them.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(url.hostname)) {
    return false
  }
  // `new URL` already rejects whitespace inside the origin, but the CSP header
  // is built by joining these, so assert it directly rather than inferring it.
  return url.origin === value.replace(/\/$/, '') && !/[\s;,']/.test(value)
}

const KNOWN_KEYS = new Set([
  'manifestVersion',
  'name',
  'description',
  'icon',
  'entry',
  'scopes',
])

/**
 * Parse + validate a `brian-app.json`. Returns every issue at once rather than
 * the first: an author fixing a manifest should see the whole list, and the
 * consent screen has to be able to say precisely what is wrong.
 */
export function parseManifest(raw: unknown): ParseManifestResult {
  const issues: ManifestIssue[] = []
  const push = (path: string, message: string) => issues.push({ path, message })

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '', message: 'manifest must be a JSON object' }] }
  }
  const obj = raw as Record<string, unknown>

  if (obj.manifestVersion !== MANIFEST_VERSION) {
    push(
      'manifestVersion',
      `must be ${MANIFEST_VERSION} (got ${JSON.stringify(obj.manifestVersion)})`,
    )
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (name.length === 0) push('name', 'is required')
  else if (name.length > NAME_MAX) push('name', `must be ${NAME_MAX} characters or fewer`)

  if (obj.description !== undefined) {
    if (typeof obj.description !== 'string') push('description', 'must be a string')
    else if (obj.description.length > DESCRIPTION_MAX) {
      push('description', `must be ${DESCRIPTION_MAX} characters or fewer`)
    }
  }

  if (obj.icon !== undefined) {
    if (typeof obj.icon !== 'string' || obj.icon.length > ICON_MAX) {
      push('icon', `must be a lucide icon name of ${ICON_MAX} characters or fewer`)
    }
  }

  const entry = typeof obj.entry === 'string' ? obj.entry : 'index.html'
  if (!isSafeBundlePath(entry)) {
    push('entry', 'must be a relative path inside the bundle')
  } else if (!entry.toLowerCase().endsWith('.html')) {
    push('entry', 'must be an .html file')
  }

  // ── scopes — validated CLOSED ────────────────────────────────────────
  // Unknown top-level fields fall through to metadata, but an unknown SCOPE
  // key is fatal. Tolerating one means an app could request something this
  // build does not understand, an admin could consent to a screen that never
  // showed it, and a later build could start honouring it.
  const scopesRaw = obj.scopes
  let scopes: AppScopes = { data: 'read' }
  if (!scopesRaw || typeof scopesRaw !== 'object' || Array.isArray(scopesRaw)) {
    push('scopes', 'is required')
  } else {
    const s = scopesRaw as Record<string, unknown>
    for (const key of Object.keys(s)) {
      if (
        key !== 'data' &&
        key !== 'store' &&
        key !== 'agent' &&
        key !== 'identity' &&
        key !== 'net'
      ) {
        push(`scopes.${key}`, 'is not a scope this version understands')
      }
    }
    if (s.data !== 'read' && s.data !== 'read_write') {
      push('scopes.data', "must be 'read' or 'read_write'")
    }
    if (
      s.store !== undefined &&
      s.store !== 'none' &&
      s.store !== 'read' &&
      s.store !== 'write'
    ) {
      push('scopes.store', "must be 'none', 'read' or 'write'")
    }
    if (s.agent !== undefined && s.agent !== 'none' && s.agent !== 'ask') {
      push('scopes.agent', "must be 'none' or 'ask'")
    }
    if (s.identity !== undefined && typeof s.identity !== 'boolean') {
      push('scopes.identity', 'must be a boolean')
    }
    const net: string[] = []
    if (s.net !== undefined) {
      if (!Array.isArray(s.net)) {
        push('scopes.net', 'must be an array of https origins')
      } else {
        s.net.forEach((origin, i) => {
          if (!isSafeNetOrigin(origin)) {
            push(
              `scopes.net[${i}]`,
              'must be a bare https origin with no path (e.g. https://api.example.com)',
            )
          } else {
            net.push(origin)
          }
        })
      }
    }
    scopes = {
      data: s.data === 'read_write' ? 'read_write' : 'read',
      ...(s.store === 'read' || s.store === 'write' ? { store: s.store } : {}),
      ...(s.agent === 'ask' ? { agent: 'ask' as const } : {}),
      ...(s.identity === true ? { identity: true } : {}),
      ...(net.length > 0 ? { net } : {}),
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_KEYS.has(key)) metadata[key] = value
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      name,
      ...(typeof obj.description === 'string' && obj.description.trim()
        ? { description: obj.description.trim() }
        : {}),
      ...(typeof obj.icon === 'string' && obj.icon.trim() ? { icon: obj.icon.trim() } : {}),
      entry,
      scopes,
      metadata,
    },
  }
}

/**
 * Normalize a possibly-absent store scope to its tier rank.
 *
 * Exported because the bridge's tool gate compares the same two values and a
 * second copy of this ordering is how `write` quietly becomes reachable from a
 * `read` grant.
 */
export function storeScopeRank(scope: AppStoreScope | undefined): number {
  return STORE_SCOPE_RANK[scope ?? 'none']
}

/**
 * Does `requested` ask for anything `granted` does not already cover?
 *
 * This is the T3 drift rule in one function. A sync that widens scopes must
 * drop the app to `needs_consent` — the grant an admin gave was for a specific
 * set of powers, and silently carrying it forward onto a broader set is the
 * failure this whole consent model exists to prevent.
 *
 * `granted === null` (never consented) always exceeds.
 */
export function scopesExceedGrant(
  requested: AppScopes,
  granted: AppScopes | null,
): boolean {
  if (!granted) return true
  if (requested.data === 'read_write' && granted.data !== 'read_write') return true
  if (storeScopeRank(requested.store) > storeScopeRank(granted.store)) return true
  if (requested.agent === 'ask' && granted.agent !== 'ask') return true
  if (requested.identity === true && granted.identity !== true) return true
  const grantedNet = new Set(granted.net ?? [])
  return (requested.net ?? []).some((origin) => !grantedNet.has(origin))
}
