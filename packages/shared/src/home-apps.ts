/**
 * Home apps — the canonical operator-app key vocabulary, shared by the API
 * (route Zod schema + `workspaces.home_apps` store setter) and app-web
 * (`lib/operator-apps.ts`, the app-bar, the Studio "Mini apps" tab).
 *
 * The list lives here rather than in app-web because BOTH sides validate it
 * and a forked copy is how a newer client and an older server drift. app-web's
 * `operator-apps.ts` consumes `BUILTIN_HOME_APP_KEYS` and layers the
 * route-segment / surface / icon mappings on top; the API never needs those.
 *
 * Naming: `homeApps` / `home_apps` / `HOME_APP_*` internally — never "mini
 * app", which collides with the Telegram Mini App and the dormant `MINI_APPS`
 * registry in this same package (chat-miniapp-home-config.md T13). Only the
 * user-facing Studio tab label says "Mini apps".
 *
 * Two entry kinds share one array:
 *
 *   - a **built-in** key from `BUILTIN_HOME_APP_KEYS` (`'page'`, `'chat'`, …)
 *   - a **custom** app, `custom:<uuid>`, pointing at a `workspace_home_apps`
 *     row (custom-home-apps.md T12)
 *
 * The additive contract: unknown entries are FILTERED ON READ, never rejected.
 * A newer server (or a teammate on a newer client) may write a key this build
 * has never heard of, and a deleted custom app leaves a dangling `custom:<id>`
 * behind — in both cases the strip must simply not render it. `[]` means
 * "unset" and resolves to `DEFAULT_HOME_APPS`.
 *
 * Spec: docs/architecture/features/home-apps.md.
 *
 * [COMP:shared/home-apps]
 */

/**
 * Every built-in operator app, in DEFAULT strip order.
 *
 * This is where a workspace starts, NOT how the strip renders: the render
 * order is the stored `home_apps` array order, which an owner/admin drags in
 * Studio → Mini apps. Nothing here or downstream sorts by this list — it seeds
 * the default and orders the "Hidden" group in the configurator, and that is
 * all. `validateHomeApps` accepts any permutation, which is what made
 * user-defined ordering a client-only change (home-apps.md → "Ordering").
 */
export const BUILTIN_HOME_APP_KEYS = [
  'page',
  'office',
  'tasks',
  'crm',
  'feed',
  'browsers',
  'chat',
  // Added 2026-08-10. NOT appended to existing workspaces by migration, unlike
  // Office: `HOME_APPS_MAX` is 7 and this is the 8th, so they cannot all sit on
  // one strip anyway — and a store app on the Home of a workspace with no store
  // is noise. It ships discoverable in Studio → Mini apps "Hidden" and the page
  // itself explains what to connect. See docs/architecture/integrations/shopify.md.
  'shopify',
] as const

export type HomeAppKey = (typeof BUILTIN_HOME_APP_KEYS)[number]

/** Prefix marking a custom (workspace-built) app entry: `custom:<uuid>`. */
export const CUSTOM_HOME_APP_PREFIX = 'custom:'

/** A single entry in `workspaces.home_apps`. */
export type HomeAppEntry = HomeAppKey | `${typeof CUSTOM_HOME_APP_PREFIX}${string}`

/**
 * Config default for a workspace that has never been configured (`[]`).
 * Migration 385 grandfathered the original six apps; Office migration 3941
 * appends its reserved key. New rows resolve to the minimal three-app set.
 */
export const DEFAULT_HOME_APPS: readonly HomeAppEntry[] = ['page', 'office', 'chat']

/** Upper bound on the strip. Custom apps count against it (T12). */
export const HOME_APPS_MAX = 7

const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_HOME_APP_KEYS)

export function isBuiltinHomeAppKey(value: unknown): value is HomeAppKey {
  return typeof value === 'string' && BUILTIN_SET.has(value)
}

/** True for a well-formed `custom:<id>` entry (non-empty id). */
export function isCustomHomeAppEntry(
  value: unknown,
): value is `${typeof CUSTOM_HOME_APP_PREFIX}${string}` {
  return (
    typeof value === 'string' &&
    value.startsWith(CUSTOM_HOME_APP_PREFIX) &&
    value.length > CUSTOM_HOME_APP_PREFIX.length
  )
}

/** The `workspace_home_apps` row id inside a `custom:<id>` entry, or null. */
export function customHomeAppId(value: unknown): string | null {
  return isCustomHomeAppEntry(value) ? value.slice(CUSTOM_HOME_APP_PREFIX.length) : null
}

/** Build the config entry for a custom app row id. */
export function customHomeAppEntry(appId: string): HomeAppEntry {
  return `${CUSTOM_HOME_APP_PREFIX}${appId}`
}

/** Structural check only — is this a shape the config array may hold at all? */
export function isHomeAppEntry(value: unknown): value is HomeAppEntry {
  return isBuiltinHomeAppKey(value) || isCustomHomeAppEntry(value)
}

export type NormalizeHomeAppsOptions = {
  /**
   * Ids of the workspace's *renderable* custom apps (`status='active'` with a
   * live grant). A `custom:<id>` entry outside this set is dropped — that is
   * the T3 "scope drift voids the grant" rule reaching the strip: a re-synced
   * app whose manifest widened its scopes goes `needs_consent`, leaves this
   * set, and disappears until an admin re-grants. Omit the option entirely to
   * keep every well-formed custom entry (callers that have not resolved the
   * app list yet, e.g. the SSR default).
   */
  knownCustomIds?: ReadonlySet<string>
}

/**
 * Read side of the additive contract: coerce whatever is in the column into a
 * renderable, ordered, deduped, capped list.
 *
 *   - not an array / empty            → `DEFAULT_HOME_APPS`
 *   - unknown built-in key            → dropped
 *   - malformed or unknown `custom:`  → dropped
 *   - duplicates                      → first occurrence wins
 *   - more than `HOME_APPS_MAX`       → truncated
 *   - everything dropped              → `DEFAULT_HOME_APPS` (never an empty strip)
 */
export function normalizeHomeApps(
  raw: unknown,
  opts: NormalizeHomeAppsOptions = {},
): HomeAppEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_HOME_APPS]
  const seen = new Set<string>()
  const out: HomeAppEntry[] = []
  for (const value of raw) {
    if (out.length >= HOME_APPS_MAX) break
    if (typeof value !== 'string' || seen.has(value)) continue
    if (isBuiltinHomeAppKey(value)) {
      seen.add(value)
      out.push(value)
      continue
    }
    const customId = customHomeAppId(value)
    if (!customId) continue
    if (opts.knownCustomIds && !opts.knownCustomIds.has(customId)) continue
    seen.add(value)
    out.push(value as HomeAppEntry)
  }
  return out.length > 0 ? out : [...DEFAULT_HOME_APPS]
}

export type HomeAppsValidationError =
  | 'not-an-array'
  | 'empty'
  | 'too-many'
  | 'duplicate'
  | 'unknown-key'

export type ValidateHomeAppsResult =
  | { ok: true; apps: HomeAppEntry[] }
  | { ok: false; reason: HomeAppsValidationError }

/**
 * WRITE side — strict, unlike `normalizeHomeApps`. A save that names an app the
 * server does not know is a client bug (or a stale tab), and silently dropping
 * it would show the admin a strip they did not choose. Both the route schema
 * and the store setter run this, per C-T10 ("validated in BOTH").
 */
export function validateHomeApps(raw: unknown): ValidateHomeAppsResult {
  if (!Array.isArray(raw)) return { ok: false, reason: 'not-an-array' }
  if (raw.length === 0) return { ok: false, reason: 'empty' }
  if (raw.length > HOME_APPS_MAX) return { ok: false, reason: 'too-many' }
  const seen = new Set<string>()
  const apps: HomeAppEntry[] = []
  for (const value of raw) {
    if (!isHomeAppEntry(value)) return { ok: false, reason: 'unknown-key' }
    if (seen.has(value)) return { ok: false, reason: 'duplicate' }
    seen.add(value)
    apps.push(value)
  }
  return { ok: true, apps }
}
