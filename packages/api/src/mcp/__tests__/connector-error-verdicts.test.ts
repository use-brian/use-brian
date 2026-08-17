/**
 * [COMP:tools/connector-error] — the D2 half for GitHub / Notion / Microsoft
 * Teams / Shopify: the connector-health classifier must return the SAME
 * verdict on the rewritten failure copy as it did on the raw
 * `<Provider> error: <Provider> API error (<status>): <body>` passthrough,
 * and each api client's parser must produce the structured error the copy is
 * rendered from.
 *
 * `classifyConnectorAuthError` (connector-health.ts) string-matches the
 * flattened tool result: `(401)` / `invalid or expired` / `invalid or
 * revoked` / `invalid_grant` flip a connector to `auth_failed`; a 403 flips
 * only when it names SAML / SSO re-authorization; `resource not accessible`
 * / `rate limit` must never flip (the 2026-07-20 GitHub incident). Standard:
 * docs/architecture/engine/tool-executor.md → "Failure copy".
 */

import { describe, it, expect } from 'vitest'
import { ConnectorApiError, connectorError, describeConnectorError } from '@use-brian/core'
import { classifyConnectorAuthError } from '../connector-health.js'
import { githubApiError } from '../../github/client.js'
import { notionApiError } from '../../notion/client.js'
import { MsGraphAuthError, MsGraphError } from '../../msgraph/client.js'

function fakeRes(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response
}

const render = (provider: string, err: unknown, extra: { mutating?: boolean } = {}) =>
  connectorError({ provider, tool: 'someTool', target: 'target `t`', discoveryTool: 'someList', ...extra, err }).data

// ── GitHub ──────────────────────────────────────────────────

describe('[COMP:tools/connector-error] GitHub — githubApiError parser + verdicts', () => {
  it('401 → kind auth, message keeps "invalid or revoked" + (401); verdict auth_failed as before', async () => {
    const err = await githubApiError(fakeRes(401, JSON.stringify({ message: 'Bad credentials' })))
    expect(err.kind).toBe('auth')
    expect(err.message).toBe('GitHub API error (401): GitHub PAT is invalid or revoked: Bad credentials')
    const copy = render('GitHub', err)
    expect(classifyConnectorAuthError('GitHub error: GitHub PAT is invalid or revoked (401): Bad credentials')).toBe(true)
    expect(classifyConnectorAuthError(copy)).toBe(true)
  })

  it('403 "Resource not accessible by personal access token" → forbidden; NEVER flips (the 2026-07-20 incident)', async () => {
    const err = await githubApiError(fakeRes(403, JSON.stringify({ message: 'Resource not accessible by personal access token', documentation_url: 'x' })))
    expect(err.kind).toBe('forbidden')
    const copy = render('GitHub', err)
    expect(copy).toContain('resource is not accessible')
    expect(copy).toContain('not a problem with the connector as a whole')
    expect(classifyConnectorAuthError('GitHub error: GitHub API error (403): {"message":"Resource not accessible by personal access token"}')).toBe(false)
    expect(classifyConnectorAuthError(copy)).toBe(false)
  })

  it('403 SAML enforcement → auth (reconnect really is the fix); verdict auth_failed as before', async () => {
    const body = JSON.stringify({ message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.' })
    const err = await githubApiError(fakeRes(403, body))
    expect(err.kind).toBe('auth')
    const copy = render('GitHub', err)
    expect(copy).toContain('SAML enforcement')
    expect(classifyConnectorAuthError(`GitHub error: GitHub API error (403): ${body}`)).toBe(true)
    expect(classifyConnectorAuthError(copy)).toBe(true)
  })

  it('403 rate limit → rate_limit; healthy as before', async () => {
    const err = await githubApiError(fakeRes(403, JSON.stringify({ message: 'API rate limit exceeded for user ID 4171296.' }), { 'retry-after': '60' }))
    expect(err.kind).toBe('rate_limit')
    expect(err.retryAfterSec).toBe(60)
    const copy = render('GitHub', err)
    expect(copy).toContain('rate limit')
    expect(copy).toContain('Wait 60s')
    expect(classifyConnectorAuthError(copy)).toBe(false)
  })

  it('422 carries errors[0] field + code so the copy names the field; 404 → healthy', async () => {
    const err = await githubApiError(fakeRes(422, JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] })))
    expect(err.field).toBe('Issue.title')
    expect(err.code).toBe('missing_field')
    const copy = render('GitHub', err, { mutating: true })
    expect(copy).toContain('The field GitHub named is `Issue.title`')
    expect(copy).toContain('Nothing was changed')
    expect(classifyConnectorAuthError(copy)).toBe(false)
    expect(classifyConnectorAuthError(render('GitHub', await githubApiError(fakeRes(404, JSON.stringify({ message: 'Not Found' })))))).toBe(false)
  })
})

// ── Notion ──────────────────────────────────────────────────

describe('[COMP:tools/connector-error] Notion — notionApiError parser + verdicts', () => {
  it('401 → auth, keeps "invalid or expired" + (401); verdict auth_failed as before', async () => {
    const err = await notionApiError(fakeRes(401, JSON.stringify({ object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' })))
    expect(err.kind).toBe('auth')
    expect(err.code).toBe('unauthorized')
    const copy = render('Notion', err)
    expect(classifyConnectorAuthError('Notion error: Notion token is invalid or expired. Please reconnect Notion in Settings > Connectors.')).toBe(true)
    expect(classifyConnectorAuthError(copy)).toBe(true)
  })

  it('object_not_found / restricted_resource → not_found copy with the share-the-page remedy; healthy', async () => {
    const err = await notionApiError(fakeRes(404, JSON.stringify({ object: 'error', status: 404, code: 'object_not_found', message: 'Could not find page with ID: abc.' })))
    expect(err.kind).toBe('not_found')
    expect(err.message).toBe('Notion API error (404): Could not find page with ID: abc.')
    expect(classifyConnectorAuthError(render('Notion', err))).toBe(false)
  })

  it('validation_error keeps the property path in the message; rate_limited reads Retry-After; both healthy', async () => {
    const v = await notionApiError(fakeRes(400, JSON.stringify({ object: 'error', status: 400, code: 'validation_error', message: 'body.properties.Status.select.name should be a string.' })))
    expect(v.kind).toBe('validation')
    expect(v.detail).toContain('body.properties.Status.select.name')
    expect(classifyConnectorAuthError(render('Notion', v))).toBe(false)
    const r = await notionApiError(fakeRes(429, JSON.stringify({ object: 'error', status: 429, code: 'rate_limited', message: 'Rate limited' }), { 'retry-after': '3' }))
    expect(r.kind).toBe('rate_limit')
    expect(r.retryAfterSec).toBe(3)
    expect(classifyConnectorAuthError(render('Notion', r))).toBe(false)
  })
})

// ── Microsoft Teams ─────────────────────────────────────────

describe('[COMP:tools/connector-error] Microsoft Teams — MsGraphError verdicts', () => {
  it('MsGraphAuthError (401) → auth_failed as before', () => {
    const err = new MsGraphAuthError('{"error":{"code":"InvalidAuthenticationToken"}}')
    expect(classifyConnectorAuthError(`Microsoft Teams error: ${err.message}`)).toBe(true)
    const copy = render('Microsoft Teams', err)
    expect(copy).toContain('(401)')
    expect(copy).toContain('invalid or expired')
    expect(classifyConnectorAuthError(copy)).toBe(true)
  })

  it('403 / 404 / 429 / 5xx MsGraphError → healthy as before', () => {
    for (const status of [403, 404, 429, 503]) {
      const err = new MsGraphError(status, status === 429 ? 'retry after 12s. Too Many Requests' : '{"error":{"code":"Forbidden"}}')
      expect(classifyConnectorAuthError(`Microsoft Teams error: ${err.message}`), String(status)).toBe(false)
      expect(classifyConnectorAuthError(render('Microsoft Teams', err)), String(status)).toBe(false)
    }
  })

  it('MsGraphTokenError invalid_grant → auth_failed as before', () => {
    const err = new Error('Microsoft token refresh failed (invalid_grant): AADSTS700082: The refresh token has expired.')
    expect(classifyConnectorAuthError(`Microsoft Teams error: ${err.message}`)).toBe(true)
    expect(classifyConnectorAuthError(describeConnectorError(err, { provider: 'Microsoft Teams', tool: 'msTeamsListTeams' }))).toBe(true)
  })
})

// ── Shopify ─────────────────────────────────────────────────

describe('[COMP:tools/connector-error] Shopify — structured client errors + verdicts', () => {
  it('401/403 (Shopify uses both for a dead token) → auth_failed as before', () => {
    for (const status of [401, 403]) {
      const err = new ConnectorApiError({ provider: 'Shopify', status, kind: 'auth', message: 'the access token is invalid or expired (the app was uninstalled, or the token was rotated). Reconnect Shopify in Studio → Connectors.' })
      expect(classifyConnectorAuthError(`Shopify error: Shopify auth error (${status}): the access token is invalid or expired.`)).toBe(true)
      expect(classifyConnectorAuthError(render('Shopify', err))).toBe(true)
    }
  })

  it('THROTTLED / userErrors / GraphQL access-denied / 5xx → healthy as before', () => {
    const cases = [
      new ConnectorApiError({ provider: 'Shopify', code: 'THROTTLED', kind: 'rate_limit', message: 'THROTTLED — query-cost budget exhausted' }),
      new ConnectorApiError({ provider: 'Shopify', kind: 'validation', code: 'productUpdate.userErrors', field: 'title', message: "title: Title can't be blank" }),
      new ConnectorApiError({ provider: 'Shopify', kind: 'forbidden', code: 'ACCESS_DENIED', message: 'Access denied for orders field. Required access: `read_orders` access scope.' }),
      new ConnectorApiError({ provider: 'Shopify', status: 502, message: 'Bad Gateway' }),
    ]
    for (const err of cases) {
      expect(classifyConnectorAuthError(`Shopify error: ${err.message}`), err.message).toBe(false)
      expect(classifyConnectorAuthError(render('Shopify', err)), err.message).toBe(false)
    }
  })
})
