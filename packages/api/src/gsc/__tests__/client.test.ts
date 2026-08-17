/**
 * [COMP:api/gsc-client] — the Search Console service-account client.
 *
 * Fixtures are fictional: `sa@example.iam.gserviceaccount.com`,
 * `sc-domain:example.com`. The RSA key is generated per run.
 */
import { describe, expect, it, vi } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  GSC_CREDENTIAL_TYPE,
  SearchConsoleConnectorError,
  createSearchConsoleApi,
  getSearchConsoleIdentity,
  packSearchConsoleCredentials,
  parseServiceAccountKey,
  projectSiteList,
  safeErrorMessage,
  unpackSearchConsoleCredentials,
} from '../client.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CLIENT_EMAIL = 'sa@example.iam.gserviceaccount.com'
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'abc123',
  private_key: PEM,
  client_email: CLIENT_EMAIL,
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
  universe_domain: 'googleapis.com',
})
const KEY = { clientEmail: CLIENT_EMAIL, privateKey: PEM, tokenUri: 'https://oauth2.googleapis.com/token' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function b64urlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('[COMP:api/gsc-client] Search Console service-account client', () => {
  it('parses a service-account key and drops everything but email / key / token_uri', () => {
    expect(parseServiceAccountKey(KEY_JSON)).toEqual(KEY)
  })

  it('rejects non-service-account JSON, malformed JSON, and a non-PEM private key', () => {
    expect(parseServiceAccountKey('not json')).toBeNull()
    expect(parseServiceAccountKey('[]')).toBeNull()
    expect(parseServiceAccountKey(JSON.stringify({ type: 'authorized_user', client_id: 'x' }))).toBeNull()
    expect(parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: '', private_key: PEM }))).toBeNull()
    expect(parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL, private_key: 'nope' }))).toBeNull()
  })

  it('defaults token_uri when the key omits it', () => {
    const parsed = parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL, private_key: PEM }))
    expect(parsed?.tokenUri).toBe('https://oauth2.googleapis.com/token')
  })

  it('round-trips the credential envelope with the default property, as base64url', () => {
    const packed = packSearchConsoleCredentials({ ...KEY, defaultSite: 'sc-domain:example.com' })
    expect(packed).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(unpackSearchConsoleCredentials(packed)).toEqual({ ...KEY, defaultSite: 'sc-domain:example.com' })
    expect(unpackSearchConsoleCredentials(packSearchConsoleCredentials({ ...KEY, defaultSite: null }))?.defaultSite).toBeNull()
    expect(unpackSearchConsoleCredentials('garbage')).toBeNull()
    expect(unpackSearchConsoleCredentials(Buffer.from('{"clientEmail":"x"}').toString('base64url'))).toBeNull()
    expect(GSC_CREDENTIAL_TYPE).toBe('gsc_service_account')
  })

  it('mints an RS256 JWT with iss / scope / aud / exp that verifies against the key, and caches the token', async () => {
    let clock = 1_700_000_000_000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ya29.one', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' }] }))
      .mockResolvedValueOnce(jsonResponse({ siteEntry: [] }))
    const api = createSearchConsoleApi(KEY, { fetchImpl: fetchMock, now: () => clock })

    await api.listSites()
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token')
    const params = new URLSearchParams(String(tokenInit.body))
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [h, p, s] = params.get('assertion')!.split('.')
    expect(b64urlJson(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = b64urlJson(p)
    expect(claims.iss).toBe(CLIENT_EMAIL)
    expect(claims.scope).toBe('https://www.googleapis.com/auth/webmasters.readonly')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    expect(claims.iat).toBe(Math.floor(clock / 1000))
    expect(claims.exp).toBe(Math.floor(clock / 1000) + 3600)
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url')).toBe(true)

    const [sitesUrl, sitesInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(sitesUrl).toBe('https://www.googleapis.com/webmasters/v3/sites')
    expect((sitesInit.headers as Record<string, string>).Authorization).toBe('Bearer ya29.one')

    // Second call inside the cache window: no second token exchange.
    clock += 60_000
    await api.listSites()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe('https://www.googleapis.com/webmasters/v3/sites')
  })

  it('re-mints the token once it is within 60 s of expiry', async () => {
    let clock = 1_700_000_000_000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ya29.one', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ siteEntry: [] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ya29.two', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ siteEntry: [] }))
    const api = createSearchConsoleApi(KEY, { fetchImpl: fetchMock, now: () => clock })
    await api.listSites()
    clock += 3600_000 - 30_000
    await api.listSites()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(((fetchMock.mock.calls[3] as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer ya29.two')
  })

  it('addresses the four fixed endpoints with the property URL-encoded', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      return jsonResponse({ ok: true, url })
    })
    const api = createSearchConsoleApi(KEY, { fetchImpl: fetchMock })
    await api.querySearchAnalytics('sc-domain:example.com', { startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['query'] })
    await api.inspectUrl('https://example.com/', 'https://example.com/pricing', 'en-US')
    await api.listSitemaps('https://example.com/')
    const urls = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(urls).toContain('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query')
    expect(urls).toContain('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect')
    expect(urls).toContain('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps')
    const inspectCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('urlInspection'))!
    expect(JSON.parse(String((inspectCall[1] as RequestInit).body))).toEqual({
      inspectionUrl: 'https://example.com/pricing', siteUrl: 'https://example.com/', languageCode: 'en-US',
    })
    const queryCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('searchAnalytics'))!
    expect(JSON.parse(String((queryCall[1] as RequestInit).body))).toEqual({
      startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['query'],
    })
  })

  it.each([
    [401, 'invalid_credentials'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'invalid_request'],
    [429, 'rate_limited'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
  ] as const)('maps API status %s to %s with our sentence, keeping Google text aside', async (status, code) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 't', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: status, message: 'Google says: Invalid dimension: foo' } }, status))
    const api = createSearchConsoleApi(KEY, { fetchImpl: fetchMock })
    const err = await api.listSites().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SearchConsoleConnectorError)
    const e = err as SearchConsoleConnectorError
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
    expect(e.message).toBe(safeErrorMessage(code))
    expect(e.message).not.toContain('Google says')
    expect(e.providerMessage).toBe('Google says: Invalid dimension: foo')
  })

  it('treats a token-endpoint 400 / 401 as invalid_credentials', async () => {
    for (const status of [400, 401]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, status))
      const api = createSearchConsoleApi(KEY, { fetchImpl: fetchMock })
      const err = await api.listSites().catch((e: unknown) => e) as SearchConsoleConnectorError
      expect(err.code).toBe('invalid_credentials')
      expect(err.message).toContain('401')
    }
  })

  it('maps a transport failure / timeout to upstream_error', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const fetchMock = vi.fn().mockRejectedValueOnce(timeout)
    const api = createSearchConsoleApi(KEY, { fetchImpl: fetchMock })
    const err = await api.listSites().catch((e: unknown) => e) as SearchConsoleConnectorError
    expect(err.code).toBe('upstream_error')
    expect(err.cause).toBe(timeout)
  })

  it('projects sites.list and returns the identity shape', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 't', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ siteEntry: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
        { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
        { siteUrl: '' },
      ] }))
    const identity = await getSearchConsoleIdentity(KEY, { fetchImpl: fetchMock })
    expect(identity).toEqual({
      clientEmail: CLIENT_EMAIL,
      sites: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
        { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
      ],
    })
    expect(projectSiteList({})).toEqual([])
    expect(projectSiteList(null)).toEqual([])
  })
})
