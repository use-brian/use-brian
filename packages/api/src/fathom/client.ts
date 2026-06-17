/**
 * Fathom API client — thin fetch wrappers + OAuth token rotation.
 *
 * Fathom refresh tokens are one-time-use ("can only be used once. If unused
 * it stays valid until the user revokes access"). Each call to
 * `refreshFathomTokens` returns a NEW refresh_token alongside the access_token
 * and the caller MUST persist the new tuple before the next API request, or
 * the connection bricks. The `FathomTokenManager` below encapsulates that
 * rotate-and-persist invariant.
 *
 * See docs/architecture/integrations/fathom.md.
 */

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1'
const FATHOM_TOKEN_URL = `${FATHOM_API_BASE}/oauth2/token`
const REFRESH_LEEWAY_MS = 60_000  // Refresh if access token expires within 60s

export type FathomTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string  // ISO timestamp
}

type FathomTokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number  // seconds
  token_type?: string
  scope?: string
}

// ── OAuth token endpoint ─────────────────────────────────────

export async function exchangeFathomAuthorizationCode(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<FathomTokens> {
  return tokenEndpointCall({
    grant_type: 'authorization_code',
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  })
}

export async function refreshFathomTokens(params: {
  refreshToken: string
  clientId: string
  clientSecret: string
}): Promise<FathomTokens> {
  return tokenEndpointCall({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  })
}

async function tokenEndpointCall(form: Record<string, string>): Promise<FathomTokens> {
  const res = await fetch(FATHOM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Fathom token endpoint failed (${res.status}): ${err}`)
  }

  const data = (await res.json()) as FathomTokenResponse
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Fathom token endpoint returned an incomplete payload')
  }

  const expiresInMs = Math.max(0, (data.expires_in ?? 3600) * 1000)
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  }
}

// ── Token manager (rotate-and-persist) ───────────────────────

/**
 * The persistence interface the API layer plugs in. The store re-encrypts
 * and writes the new tuple inside a single transaction — if `persistTokens`
 * fails after a successful refresh, the new refresh token is lost and the
 * user must reconnect.
 */
export type FathomTokenStore = {
  getTokens(): Promise<FathomTokens | null>
  persistTokens(tokens: FathomTokens): Promise<void>
}

export type FathomTokenManager = {
  /** Get a usable access token, refreshing if needed. */
  getAccessToken(): Promise<string>
}

export function createFathomTokenManager(params: {
  store: FathomTokenStore
  clientId: string
  clientSecret: string
}): FathomTokenManager {
  return {
    async getAccessToken(): Promise<string> {
      const current = await params.store.getTokens()
      if (!current) throw new Error('Fathom not connected')

      const expiresAtMs = Date.parse(current.expiresAt)
      if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_LEEWAY_MS) {
        return current.accessToken
      }

      const next = await refreshFathomTokens({
        refreshToken: current.refreshToken,
        clientId: params.clientId,
        clientSecret: params.clientSecret,
      })
      await params.store.persistTokens(next)
      return next.accessToken
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────

export function packFathomTokens(tokens: FathomTokens): string {
  return JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })
}

export function unpackFathomTokens(blob: string): FathomTokens | null {
  try {
    const parsed = JSON.parse(blob) as Partial<FathomTokens>
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
      }
    }
  } catch {
    // fallthrough — treat malformed payload as "no tokens"
  }
  return null
}

// ── API surface ──────────────────────────────────────────────

async function fathomFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${FATHOM_API_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  })

  if (!res.ok) {
    const err = await res.text()
    console.warn(`[fathom] ${init?.method ?? 'GET'} ${path} → ${res.status}: ${err.slice(0, 200)}`)
    if (res.status === 401) {
      throw new Error('Fathom token is invalid or expired. Please reconnect Fathom in Settings ▸ Connectors.')
    }
    throw new Error(`Fathom API error (${res.status}): ${err}`)
  }

  return res.json() as Promise<T>
}

export type FathomMeetingListParams = {
  cursor?: string
  limit?: number
  recordedAfter?: string
  recordedBefore?: string
  includeTranscript?: boolean
  includeSummary?: boolean
  includeActionItems?: boolean
  includeCrmMatches?: boolean
}

export async function listFathomMeetings(
  accessToken: string,
  params: FathomMeetingListParams = {},
): Promise<unknown> {
  const qs = new URLSearchParams()
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.recordedAfter) qs.set('recorded_after', params.recordedAfter)
  if (params.recordedBefore) qs.set('recorded_before', params.recordedBefore)
  if (params.includeTranscript) qs.set('include_transcript', 'true')
  if (params.includeSummary) qs.set('include_summary', 'true')
  if (params.includeActionItems) qs.set('include_action_items', 'true')
  if (params.includeCrmMatches) qs.set('include_crm_matches', 'true')
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return fathomFetch(accessToken, `/meetings${suffix}`)
}

export async function getFathomMeeting(accessToken: string, meetingId: string): Promise<unknown> {
  return fathomFetch(accessToken, `/meetings/${encodeURIComponent(meetingId)}`)
}

export async function getFathomTranscript(accessToken: string, recordingId: string): Promise<unknown> {
  return fathomFetch(accessToken, `/recordings/${encodeURIComponent(recordingId)}/transcript`)
}

export async function getFathomSummary(accessToken: string, recordingId: string): Promise<unknown> {
  return fathomFetch(accessToken, `/recordings/${encodeURIComponent(recordingId)}/summary`)
}

/** Fetches the connected user's identity (used to populate connectedEmail). */
export async function getFathomCurrentUser(accessToken: string): Promise<{ email?: string; name?: string }> {
  const data = await fathomFetch<{ email?: string; name?: string; user?: { email?: string; name?: string } }>(
    accessToken,
    '/users/me',
  )
  return { email: data.email ?? data.user?.email, name: data.name ?? data.user?.name }
}
