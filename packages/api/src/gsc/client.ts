/**
 * Google Search Console client for the BYO service-account connector.
 *
 * Fixed hosts, fixed routes: the only variable path segment is the
 * URL-encoded property (`siteUrl`), and no caller can supply a REST path.
 * The service-account JWT signer + token cache live HERE and nowhere else
 * (moved out of the retired operator-global engines path); the core tools
 * only see the `SearchConsoleToolsApi` port.
 *
 * See docs/architecture/integrations/search-console.md.
 */

import { createSign } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 20_000
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3'
const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
/** Longest slice of Google's own wording that reaches the model (as `providerMessage`). */
const PROVIDER_MESSAGE_CAP = 300

/** The `client_id` discriminator stamped on every Search Console credential row. */
export const GSC_CREDENTIAL_TYPE = 'gsc_service_account'

/** The parts of a service-account key file we keep. Everything else is dropped. */
export type ServiceAccountKey = {
  clientEmail: string
  privateKey: string
  tokenUri: string
}

/**
 * The credential envelope stored as `credentials.client_secret`. The default
 * property rides in the envelope (exactly as WordPress packs `siteUrl` into
 * its tuple) so injection never has to read instance config.
 */
export type SearchConsoleCredentials = ServiceAccountKey & {
  defaultSite: string | null
}

export type SearchConsoleSite = {
  siteUrl: string
  permissionLevel: string
}

export type SearchConsoleIdentity = {
  clientEmail: string
  sites: SearchConsoleSite[]
}

export type SearchConsoleConnectorErrorCode =
  | 'invalid_key_json'
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'upstream_error'
  | 'no_properties'
  | 'unknown_property'
  | 'verification_failed'

export class SearchConsoleConnectorError extends Error {
  constructor(
    public readonly code: SearchConsoleConnectorErrorCode,
    message: string,
    /** HTTP status when the failure was an HTTP rejection. */
    public readonly status?: number,
    /** Google's own wording, capped. Reaches the model only through the tools' translate hook. */
    public readonly providerMessage?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SearchConsoleConnectorError'
  }
}

/** Our sentence per code. Vendor text never becomes the message (CLAUDE.md error-translator rule). */
export function safeErrorMessage(code: SearchConsoleConnectorErrorCode): string {
  switch (code) {
    case 'invalid_key_json': return 'The pasted text is not a Google service-account key (expected a JSON key with "type": "service_account", client_email and private_key)'
    case 'invalid_credentials': return 'Google rejected the service-account key: it is invalid, revoked, or the key file was edited (401)'
    case 'forbidden': return 'The service account does not have access to this Search Console property, or the Search Console API is not enabled for its Google Cloud project'
    case 'not_found': return 'Search Console has no such property or resource for this service account'
    case 'invalid_request': return 'Search Console rejected the request'
    case 'rate_limited': return 'Search Console rate limit hit'
    case 'upstream_error': return 'Search Console did not respond in time or returned a server error'
    case 'no_properties': return 'This service account cannot see any Search Console property yet. Add its email as a user of the property in Search Console (Settings, Users and permissions), then connect again'
    case 'unknown_property': return 'That property is not one the service account can see'
    case 'verification_failed': return 'Search Console verification failed'
    default: return 'The Search Console request could not be completed'
  }
}

/**
 * Parse a service-account key file. Returns null unless it is a
 * `service_account` key with a non-empty `client_email` and a PEM
 * `private_key`. Everything else in the file is dropped.
 */
export function parseServiceAccountKey(json: string): ServiceAccountKey | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const key = parsed as Record<string, unknown>
  if (key.type !== 'service_account') return null
  const clientEmail = typeof key.client_email === 'string' ? key.client_email.trim() : ''
  const privateKey = typeof key.private_key === 'string' ? key.private_key : ''
  if (!clientEmail || !privateKey.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')) return null
  const tokenUri = typeof key.token_uri === 'string' && key.token_uri.trim() ? key.token_uri.trim() : DEFAULT_TOKEN_URI
  return { clientEmail, privateKey, tokenUri }
}

function normalizeSite(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** base64url JSON, stored as `credentials.client_secret` with `client_id: 'gsc_service_account'`. */
export function packSearchConsoleCredentials(t: SearchConsoleCredentials): string {
  const clientEmail = t.clientEmail.trim()
  const privateKey = t.privateKey
  const tokenUri = t.tokenUri?.trim() || DEFAULT_TOKEN_URI
  if (!clientEmail || !privateKey.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new SearchConsoleConnectorError('invalid_key_json', safeErrorMessage('invalid_key_json'))
  }
  const payload: SearchConsoleCredentials = {
    clientEmail,
    privateKey,
    tokenUri,
    defaultSite: normalizeSite(t.defaultSite),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function unpackSearchConsoleCredentials(blob: string): SearchConsoleCredentials | null {
  try {
    const parsed = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')) as Partial<SearchConsoleCredentials>
    if (typeof parsed.clientEmail !== 'string' || typeof parsed.privateKey !== 'string') return null
    const clientEmail = parsed.clientEmail.trim()
    const privateKey = parsed.privateKey
    if (!clientEmail || !privateKey.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')) return null
    return {
      clientEmail,
      privateKey,
      tokenUri: typeof parsed.tokenUri === 'string' && parsed.tokenUri.trim() ? parsed.tokenUri.trim() : DEFAULT_TOKEN_URI,
      defaultSite: normalizeSite(parsed.defaultSite),
    }
  } catch {
    return null
  }
}

export type SearchConsoleApiOptions = {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  /** Clock seam for the token cache (ms since epoch). */
  now?: () => number
}

export type SearchAnalyticsFilter = {
  dimension: string
  operator?: string
  expression: string
}

export type SearchAnalyticsQueryBody = {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
  startRow?: number
  type?: string
  dimensionFilterGroups?: Array<{ groupType?: string; filters: SearchAnalyticsFilter[] }>
}

export type SearchConsoleApi = {
  listSites(): Promise<unknown>
  querySearchAnalytics(siteUrl: string, body: SearchAnalyticsQueryBody): Promise<unknown>
  inspectUrl(siteUrl: string, url: string, languageCode?: string): Promise<unknown>
  listSitemaps(siteUrl: string): Promise<unknown>
}

function capProviderMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  const flat = message.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length <= PROVIDER_MESSAGE_CAP ? flat : `${flat.slice(0, PROVIDER_MESSAGE_CAP - 1)}…`
}

function apiErrorCode(status: number): SearchConsoleConnectorErrorCode {
  if (status === 401) return 'invalid_credentials'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'invalid_request'
  return 'upstream_error'
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Build a Search Console API bound to one service account. Behaviour of the
 * signer is unchanged from the retired engines path: RS256 via `node:crypto`,
 * `webmasters.readonly` scope, one token cache per api instance reused until
 * 60 s before expiry.
 */
export function createSearchConsoleApi(
  t: ServiceAccountKey,
  opts: SearchConsoleApiOptions = {},
): SearchConsoleApi {
  const fetchImpl = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const now = opts.now ?? (() => Date.now())
  const tokenUri = t.tokenUri?.trim() || DEFAULT_TOKEN_URI
  let cachedToken: { token: string; expiresAt: number } | null = null

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > now() + 60_000) return cachedToken.token
    const iat = Math.floor(now() / 1000)
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: t.clientEmail,
      scope: TOKEN_SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`
    let signature: string
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(t.privateKey, 'base64url')
    } catch (error) {
      throw new SearchConsoleConnectorError('invalid_key_json', safeErrorMessage('invalid_key_json'), undefined, undefined, { cause: error })
    }
    let res: Response
    try {
      res = await fetchImpl(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${signature}`,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new SearchConsoleConnectorError('upstream_error', safeErrorMessage('upstream_error'), undefined, undefined, { cause: error })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // The token endpoint answers a bad assertion / disabled key with 400
      // (`invalid_grant`) or 401 — both mean the credential is dead.
      const code: SearchConsoleConnectorErrorCode =
        res.status === 400 || res.status === 401 ? 'invalid_credentials'
        : res.status === 429 ? 'rate_limited'
        : 'upstream_error'
      throw new SearchConsoleConnectorError(code, safeErrorMessage(code), res.status, capProviderMessage(body), { cause: body })
    }
    const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
    if (!data?.access_token) {
      throw new SearchConsoleConnectorError('upstream_error', safeErrorMessage('upstream_error'), res.status)
    }
    cachedToken = { token: data.access_token, expiresAt: now() + (data.expires_in ?? 3600) * 1000 }
    return cachedToken.token
  }

  async function call(url: string, init: RequestInit = {}): Promise<unknown> {
    const token = await accessToken()
    let res: Response
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      const code: SearchConsoleConnectorErrorCode = 'upstream_error'
      throw new SearchConsoleConnectorError(code, safeErrorMessage(code), undefined, isTimeout(error) ? 'timeout' : undefined, { cause: error })
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      const code = apiErrorCode(res.status)
      let providerMessage: string | undefined
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } }
        providerMessage = typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined
      } catch {
        providerMessage = undefined
      }
      throw new SearchConsoleConnectorError(code, safeErrorMessage(code), res.status, capProviderMessage(providerMessage ?? text), { cause: text })
    }
    if (!text.trim()) return {}
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new SearchConsoleConnectorError('upstream_error', 'Search Console returned a response that could not be read', res.status, undefined, { cause: error })
    }
  }

  const site = (siteUrl: string) => `${WEBMASTERS_BASE}/sites/${encodeURIComponent(siteUrl)}`

  return {
    listSites: () => call(`${WEBMASTERS_BASE}/sites`),
    querySearchAnalytics: (siteUrl, body) => call(`${site(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    inspectUrl: (siteUrl, url, languageCode) => call(URL_INSPECTION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: url, siteUrl, ...(languageCode ? { languageCode } : {}) }),
    }),
    listSitemaps: (siteUrl) => call(`${site(siteUrl)}/sitemaps`),
  }
}

/** Project Google's `sites.list` body to `{ siteUrl, permissionLevel }[]`. */
export function projectSiteList(raw: unknown): SearchConsoleSite[] {
  const entries = (raw as { siteEntry?: unknown } | null)?.siteEntry
  if (!Array.isArray(entries)) return []
  const sites: SearchConsoleSite[] = []
  for (const entry of entries) {
    const siteUrl = normalizeSite((entry as { siteUrl?: unknown } | null)?.siteUrl)
    if (!siteUrl) continue
    const permission = (entry as { permissionLevel?: unknown }).permissionLevel
    sites.push({ siteUrl, permissionLevel: typeof permission === 'string' ? permission : 'unknown' })
  }
  return sites
}

/**
 * Verify-before-store: mint a token and list the properties the key can see.
 * Any failure surfaces as a `SearchConsoleConnectorError`; an empty list is
 * returned as-is (the route turns it into `no_properties`).
 */
export async function getSearchConsoleIdentity(
  t: ServiceAccountKey,
  opts: SearchConsoleApiOptions = {},
): Promise<SearchConsoleIdentity> {
  const api = createSearchConsoleApi(t, opts)
  const raw = await api.listSites()
  return { clientEmail: t.clientEmail, sites: projectSiteList(raw) }
}
