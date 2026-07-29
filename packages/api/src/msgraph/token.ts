/**
 * Microsoft Graph OAuth token manager — rotate-and-persist.
 *
 * Entra ID rotates the refresh token on EVERY refresh: the response carries a
 * new `refresh_token` and the one that was sent is burned. A manager that
 * refreshes without persisting the new tuple therefore works exactly once and
 * then bricks the connection with `invalid_grant`. That is the same invariant
 * `createFathomTokenManager` (../fathom/client.ts) encodes, and this module is
 * deliberately shaped after it.
 *
 * Two things Fathom does NOT need and this does:
 *
 *   - **In-flight coalescing.** All nine Teams tools are `isConcurrencySafe`,
 *     so the model routinely fires several in parallel off one manager. Two
 *     simultaneous refreshes would send the same single-use refresh token
 *     twice and the loser comes back `invalid_grant` — killing a connection
 *     that was healthy a millisecond earlier. One shared in-flight promise
 *     removes the race.
 *   - **A typed `invalid_grant`.** The caller flips the `connector_instance`
 *     to `auth_failed` only for credential death, never for a 503. The message
 *     also carries the literal `invalid_grant` so `classifyConnectorAuthError`
 *     (../mcp/connector-health.ts) agrees once the error has been flattened to
 *     a string, matching how the Google injector detects revocation.
 *
 * Auth model: standard env-var OAuth (one Use Brian-owned Entra app,
 * `MSGRAPH_CLIENT_ID` / `MSGRAPH_CLIENT_SECRET` via `getConnectorConfig`), with
 * a per-user authorization-code grant. See
 * docs/architecture/integrations/msgraph.md and
 * docs/plans/msteams-connector.md.
 */

const MSGRAPH_LOGIN_HOST = 'https://login.microsoftonline.com'

/**
 * Multi-tenant endpoint, work/school accounts only.
 *
 * NOT `common`. `common` also admits personal Microsoft accounts, and every
 * Teams delegated permission is documented *"Delegated (personal Microsoft
 * account): Not supported"* — so an MSA user would complete consent
 * successfully and then have all nine tools fail at runtime with no useful
 * signal. Microsoft additionally warns *"Do not use 'common', as personal
 * accounts cannot provide admin consent except in the context of a tenant"*,
 * and `ChannelMessage.Read.All` requires admin consent unconditionally.
 * `organizations` restricts the account picker to work/school, which is the
 * only population that can use this connector at all.
 *
 * The authorize URL must use the SAME segment (app-web's `msgraph-oauth.ts`).
 * Research: docs/research/external/microsoft-teams-connector-2026.md §2.2 and
 * its multitenant decision table ("Authority … Not `/common`").
 */
const DEFAULT_TENANT = 'organizations'

/** Refresh if the access token expires within this window (matches Fathom). */
const REFRESH_LEEWAY_MS = 60_000

export type MsGraphTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
  /**
   * The resolved tenant, from the connect flow's `id_token` `tid` claim. The
   * OAuth callback writes it into this same envelope
   * (`connectors.ts` → `store-credentials`), so it MUST survive a rotation:
   * `packMsGraphTokens` writing only the 3-tuple would erase it on the first
   * refresh, leaving it present for freshly-connected users and absent for
   * everyone else — the worst shape a missing field can have.
   *
   * Nothing reads it yet. It exists because Entra caches against the
   * *resolved* tenant rather than the authority segment (research note's
   * multitenant decision table), so refreshing against `/{tenantId}` instead
   * of `/organizations` is a plausible next step. Absent when the tenant did
   * not grant `openid`.
   */
  tenantId?: string
}

/**
 * The Entra token response. `refresh_token` is optional on the wire: it is
 * only returned when `offline_access` was consented, and the spec permits a
 * server to omit it on refresh (meaning "keep using the one you have").
 */
type MsGraphTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number // seconds
  token_type?: string
  scope?: string
}

/** The `error` / `error_description` pair Entra returns on a failed grant. */
type MsGraphTokenErrorResponse = {
  error?: string
  error_description?: string
}

// ── Errors ────────────────────────────────────────────────────

/**
 * Any failure of the Entra token endpoint. `isInvalidGrant` is the one branch
 * a caller must treat differently: the stored refresh token is dead and only
 * the user reconnecting can fix it, so the backing `connector_instance` goes
 * to `auth_failed`. Everything else (503, network blip, malformed payload) is
 * transient and must leave a healthy connector alone.
 */
export class MsGraphTokenError extends Error {
  constructor(
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`Microsoft token refresh failed${code ? ` (${code})` : ''}: ${detail}`)
    this.name = 'MsGraphTokenError'
  }

  get isInvalidGrant(): boolean {
    return this.code === 'invalid_grant'
  }
}

// ── Token endpoint ────────────────────────────────────────────

type TokenCallDeps = {
  tenantId?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

function tokenUrl(tenantId: string | undefined): string {
  return `${MSGRAPH_LOGIN_HOST}/${encodeURIComponent(tenantId ?? DEFAULT_TENANT)}/oauth2/v2.0/token`
}

/**
 * POST a form-encoded grant and normalise the response.
 *
 * `fallbackRefreshToken` covers the omitted-`refresh_token` case: reusing the
 * token we already hold is strictly safer than throwing away a working
 * connection over a field Entra was not obliged to send.
 */
async function tokenEndpointCall(
  form: Record<string, string>,
  deps: TokenCallDeps,
  fallbackRefreshToken?: string,
): Promise<MsGraphTokens> {
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now

  const res = await doFetch(tokenUrl(deps.tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })

  if (!res.ok) {
    const body = await res.text()
    let parsed: MsGraphTokenErrorResponse = {}
    try {
      parsed = JSON.parse(body) as MsGraphTokenErrorResponse
    } catch {
      // Non-JSON body (a gateway error page) — the raw text is the detail.
    }
    throw new MsGraphTokenError(
      parsed.error,
      `HTTP ${res.status}. ${(parsed.error_description ?? body).slice(0, 300)}`,
    )
  }

  const data = (await res.json()) as MsGraphTokenResponse
  const refreshToken = data.refresh_token ?? fallbackRefreshToken
  if (!data.access_token || !refreshToken) {
    throw new MsGraphTokenError(
      undefined,
      data.access_token
        ? 'the grant returned no refresh token (was offline_access consented?)'
        : 'the token endpoint returned no access token',
    )
  }

  return {
    accessToken: data.access_token,
    // Read the real lifetime rather than assuming one — Entra's access-token
    // lifetime is tenant-configurable (10-60 minutes by policy).
    expiresAt: new Date(now() + Math.max(0, (data.expires_in ?? 3600) * 1000)).toISOString(),
    refreshToken,
  }
}

/** Complete the per-user authorization-code grant (the OAuth callback path). */
export async function exchangeMsGraphAuthorizationCode(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scope?: string
} & TokenCallDeps): Promise<MsGraphTokens> {
  return tokenEndpointCall(
    {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      ...(params.scope ? { scope: params.scope } : {}),
    },
    params,
  )
}

/** Exchange a refresh token for a fresh (rotated) tuple. */
export async function refreshMsGraphTokens(params: {
  refreshToken: string
  clientId: string
  clientSecret: string
  scope?: string
} & TokenCallDeps): Promise<MsGraphTokens> {
  return tokenEndpointCall(
    {
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      ...(params.scope ? { scope: params.scope } : {}),
    },
    params,
    params.refreshToken,
  )
}

// ── Token manager (rotate-and-persist) ───────────────────────

/**
 * The persistence seam the injector plugs in. `persistTokens` re-encrypts and
 * writes the tuple into the `connector_instance` credentials envelope — if it
 * fails after a successful refresh the rotated refresh token is lost and the
 * user must reconnect, which is why the manager awaits it and lets a
 * persistence failure fail the whole call.
 */
export type MsGraphTokenStore = {
  getTokens(): Promise<MsGraphTokens | null>
  persistTokens(tokens: MsGraphTokens): Promise<void>
}

export type MsGraphTokenManager = {
  /** Get a usable access token, refreshing (and persisting) if needed. */
  getAccessToken(): Promise<string>
}

export function createMsGraphTokenManager(params: {
  store: MsGraphTokenStore
  clientId: string
  clientSecret: string
  /**
   * Defaults to `DEFAULT_TENANT` (`organizations`). Override with a tenant id
   * or domain to pin a single-tenant app registration — strictly narrower, so
   * it never reopens the personal-account hole `organizations` closes. Do not
   * pass `common`.
   */
  tenantId?: string
  /** Optional scope narrowing; omitted means "the scopes already consented". */
  scope?: string
  fetchImpl?: typeof fetch
  now?: () => number
}): MsGraphTokenManager {
  const now = params.now ?? Date.now
  // One shared in-flight refresh. Single-use refresh tokens make a concurrent
  // second refresh actively destructive, not merely wasteful.
  let inFlight: Promise<string> | null = null

  async function refreshAndPersist(current: MsGraphTokens): Promise<string> {
    const next = await refreshMsGraphTokens({
      refreshToken: current.refreshToken,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      scope: params.scope,
      tenantId: params.tenantId,
      fetchImpl: params.fetchImpl,
      now,
    })
    // Persist BEFORE returning: the next call must find the rotated token.
    // `tenantId` is carried across explicitly — the refresh response never
    // echoes it, so writing `next` alone would erase what the connect flow
    // stored in this envelope.
    await params.store.persistTokens(
      current.tenantId ? { ...next, tenantId: current.tenantId } : next,
    )
    return next.accessToken
  }

  return {
    async getAccessToken(): Promise<string> {
      const current = await params.store.getTokens()
      if (!current) throw new Error('Microsoft Teams not connected')

      const expiresAtMs = Date.parse(current.expiresAt)
      if (Number.isFinite(expiresAtMs) && expiresAtMs - now() > REFRESH_LEEWAY_MS) {
        return current.accessToken
      }

      if (!inFlight) {
        // Clear the slot on settle so a failed refresh is retried rather than
        // memoised as a permanently rejected promise.
        inFlight = refreshAndPersist(current).finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },
  }
}

// ── Credentials envelope ─────────────────────────────────────
//
// `connector_instance` has no expiry column, so the whole tuple rides inside
// the encrypted `client_secret` of an `oauth`-typed credentials blob — the
// same envelope Fathom uses.
//
// The OAuth callback writes this envelope too (`store-credentials`), so pack
// and unpack are one half of a contract with `apps/app-web`'s
// `/api/auth/callback/msgraph`. A field written there and not handled here is
// destroyed on the first refresh, not merely ignored — keep the two in step.

export function packMsGraphTokens(tokens: MsGraphTokens): string {
  return JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.tenantId ? { tenantId: tokens.tenantId } : {}),
  })
}

export function unpackMsGraphTokens(blob: string): MsGraphTokens | null {
  try {
    const parsed = JSON.parse(blob) as Partial<MsGraphTokens>
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        ...(typeof parsed.tenantId === 'string' ? { tenantId: parsed.tenantId } : {}),
      }
    }
  } catch {
    // Malformed payload — treat as "no tokens" so the caller reports
    // not-connected rather than crashing an injection.
  }
  return null
}
