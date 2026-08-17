/**
 * [COMP:tools/connector-error] — ConnectorApiError + connectorError().
 *
 * The shared failure-copy renderer every built-in connector tool (GitHub,
 * Notion, Microsoft Teams, Shopify, Fathom, AgentMail) returns from its
 * `catch` (docs/architecture/engine/tool-executor.md → "Failure copy"). The
 * per-provider D2 half — `classifyConnectorAuthError` verdicts unchanged on
 * the new copy — lives in
 * `packages/api/src/mcp/__tests__/connector-error-verdicts.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import {
  CONNECTOR_ERROR_MESSAGE_CAP,
  ConnectorApiError,
  coerceConnectorError,
  connectorError,
  describeConnectorError,
  isConnectorApiError,
} from '../_connector-result.js'

const ctx = { provider: 'GitHub', tool: 'githubGetIssue', target: 'repo `o/r` issue #12', discoveryTool: 'githubListIssues' }

describe('[COMP:tools/connector-error] ConnectorApiError', () => {
  it('keeps the `<Provider> API error (<status>): <detail>` prefix and the structured fields', () => {
    const err = new ConnectorApiError({ provider: 'GitHub', status: 422, code: 'missing_field', field: 'issue.title', message: 'Validation Failed: title is required' })
    expect(err.message).toBe('GitHub API error (422): Validation Failed: title is required')
    expect(err.name).toBe('ConnectorApiError')
    expect(err.status).toBe(422)
    expect(err.field).toBe('issue.title')
    expect(isConnectorApiError(err)).toBe(true)
    expect(isConnectorApiError({ name: 'ConnectorApiError', provider: 'X', message: 'y' })).toBe(true)
    expect(isConnectorApiError(new Error('GitHub API error (422): x'))).toBe(false)
    // No status → no parentheses (a GraphQL / client-level failure).
    expect(new ConnectorApiError({ provider: 'Shopify', code: 'THROTTLED', message: 'busy' }).message).toBe('Shopify API error: busy')
  })

  it('caps the provider body', () => {
    const err = new ConnectorApiError({ provider: 'Notion', status: 500, message: 'x'.repeat(5000) })
    expect(err.detail.length).toBeLessThanOrEqual(CONNECTOR_ERROR_MESSAGE_CAP)
    expect(err.detail.endsWith('…')).toBe(true)
  })
})

describe('[COMP:tools/connector-error] coerceConnectorError', () => {
  it('passes a ConnectorApiError through, upgrades a status-carrying provider error, and parses the legacy prefix', () => {
    const structured = new ConnectorApiError({ provider: 'GitHub', status: 404, message: 'Not Found' })
    expect(coerceConnectorError(structured, 'GitHub')).toBe(structured)

    const graph = Object.assign(new Error('Microsoft Graph API error (429): retry after 12s. Too Many Requests'), { name: 'MsGraphError', status: 429 })
    const coerced = coerceConnectorError(graph, 'Microsoft Teams')!
    expect(coerced.status).toBe(429)
    expect(coerced.detail).toBe('retry after 12s. Too Many Requests')

    const legacy = coerceConnectorError(new Error('Notion API error (404): {"code":"object_not_found"}'), 'Notion')!
    expect(legacy.status).toBe(404)
    expect(legacy.detail).toContain('object_not_found')

    // A provider sentence that carries the status in parentheses.
    const pat = coerceConnectorError(new Error('GitHub PAT is invalid or revoked (401): Bad credentials'), 'GitHub')!
    expect(pat.status).toBe(401)

    expect(coerceConnectorError(new Error('Use eventLabelId or colorId, not both'), 'GitHub')).toBeUndefined()
    expect(coerceConnectorError('string error', 'GitHub')).toBeUndefined()
  })
})

describe('[COMP:tools/connector-error] describeConnectorError', () => {
  const rendered = (init: ConstructorParameters<typeof ConnectorApiError>[0], extra: Partial<typeof ctx> & { mutating?: boolean } = {}) =>
    describeConnectorError(new ConnectorApiError(init), { ...ctx, ...extra })

  it('auth (401 / kind auth) → (status) + "invalid or expired" + reconnect, do not retry', () => {
    const text = rendered({ provider: 'GitHub', status: 401, kind: 'auth', message: 'GitHub PAT is invalid or revoked: Bad credentials' })
    expect(text).toContain('GitHub rejected this connector\'s credential while running `githubGetIssue` on repo `o/r` issue #12')
    expect(text).toContain('(401)')
    expect(text).toContain('invalid or expired')
    expect(text).toContain('Reconnect GitHub (Studio → Connectors)')
    expect(text).toContain('retrying will not help')
  })

  it('forbidden (403) → per-resource: "not accessible", not connector-wide, retry fails the same way', () => {
    const text = rendered({ provider: 'GitHub', status: 403, kind: 'forbidden', message: 'Resource not accessible by personal access token' })
    expect(text).toContain('the credential is alive but the resource is not accessible to it')
    expect(text).toContain('not a problem with the connector as a whole')
    expect(text).toContain('Retrying unchanged will fail the same way')
    expect(text).not.toMatch(/invalid or expired|unauthorized/)
  })

  it('not_found (404) → names the target, keeps the code, points at the discovery tool, forbids the retry', () => {
    const text = rendered({ provider: 'GitHub', status: 404, message: 'Not Found' })
    expect(text).toContain('GitHub has no repo `o/r` issue #12 that this connector can see (GitHub API error (404))')
    expect(text).toContain('Call `githubListIssues` to get a current id.')
    expect(text).toContain('Retrying this exact id will keep failing')
    // No discovery tool → ask the user.
    expect(describeConnectorError(new ConnectorApiError({ provider: 'X', status: 404, message: 'gone' }), { provider: 'X', tool: 't' })).toContain('Ask the user to confirm the id.')
  })

  it('rate_limit (429 / kind) → transient, wait (Retry-After when known), retry once', () => {
    const text = rendered({ provider: 'GitHub', status: 429, message: 'API rate limit exceeded', retryAfterSec: 30 })
    expect(text).toContain('rate limit')
    expect(text).toContain('Nothing about the input is wrong')
    expect(text).toContain('Wait 30s, then retry the same call once')
    // A 403 that is really a rate limit renders as one.
    expect(rendered({ provider: 'GitHub', status: 403, message: 'API rate limit exceeded for user ID 1' })).toContain('rate limit')
  })

  it('transient (5xx) → retry once; a mutating tool is told the write may have applied', () => {
    const text = rendered({ provider: 'GitHub', status: 502, message: 'Bad Gateway' }, { mutating: true })
    expect(text).toContain('server-side error')
    expect(text).toContain('The write may or may not have been applied')
    expect(text).toContain('Retry once')
  })

  it('validation (400/422) → surfaces the provider message + field, nothing changed, same input fails', () => {
    const text = rendered({ provider: 'GitHub', status: 422, code: 'missing_field', field: 'issue.title', message: 'Validation Failed' }, { mutating: true })
    expect(text).toContain('GitHub rejected the request for `githubGetIssue` on repo `o/r` issue #12 (GitHub API error (422), missing_field)')
    expect(text).toContain('GitHub said: "Validation Failed"')
    expect(text).toContain('The field GitHub named is `issue.title`')
    expect(text).toContain('Nothing was changed on the provider side')
    expect(text).toContain('the same input will fail the same way')
  })

  it('conflict / too_large / permanent each state their own verdict', () => {
    expect(rendered({ provider: 'GitHub', status: 409, message: 'sha mismatch' })).toContain('Re-read it (`githubListIssues`) and retry once')
    expect(rendered({ provider: 'GitHub', status: 413, message: 'too big' })).toContain('Reduce the size and retry')
    expect(rendered({ provider: 'Shopify', kind: 'permanent', message: 'no Shopify Payments' })).toContain('permanent limitation')
  })

  it('not_connected → connect first; nothing about the arguments is wrong', () => {
    const structured = rendered({ provider: 'Shopify', kind: 'not_connected', message: 'Shopify not connected' }, { provider: 'Shopify' })
    expect(structured).toContain('Shopify is not connected for this assistant')
    expect(structured).toContain('Studio → Connectors')
    const plain = describeConnectorError(new Error('Fathom not connected'), { provider: 'Fathom', tool: 'fathomListMeetings' })
    expect(plain).toContain('Fathom is not connected for this assistant, so `fathomListMeetings` could not run')
  })

  it('translate hook overrides the generic rendering; returning undefined falls through', () => {
    const err = new ConnectorApiError({ provider: 'Notion', status: 400, code: 'validation_error', message: 'body.properties.Status is invalid' })
    const custom = describeConnectorError(err, { ...ctx, provider: 'Notion', translate: (e) => (e.code === 'validation_error' ? 'CUSTOM' : undefined) })
    expect(custom).toBe('CUSTOM')
    const fallthrough = describeConnectorError(err, { ...ctx, provider: 'Notion', translate: () => undefined })
    expect(fallthrough).toContain('Notion rejected the request')
  })

  it('plain errors: invalid_grant → dead grant; network blip → transient; anything else framed with tool + verdict', () => {
    const grant = describeConnectorError(new Error('Microsoft token refresh failed (invalid_grant): AADSTS700082'), { provider: 'Microsoft Teams', tool: 'msTeamsListTeams' })
    expect(grant).toContain('invalid_grant')
    expect(grant).toContain('reconnects it (Studio → Connectors)')
    expect(grant).toContain('Do not retry')

    const blip = describeConnectorError(new TypeError('fetch failed'), { ...ctx, mutating: true })
    expect(blip).toContain('could not be reached')
    expect(blip).toContain('may or may not have reached the provider')

    const plain = describeConnectorError(new Error('product has 3 variants - pass variantId'), { provider: 'Shopify', tool: 'shopifySetProductPrice', target: 'product `8`' })
    expect(plain).toBe('Shopify `shopifySetProductPrice` on product `8` failed: product has 3 variants - pass variantId. Retrying the same arguments will not help — fix what the message names, or ask the user.')
    expect(describeConnectorError('string error', { provider: 'X', tool: 't' })).toContain('string error')
  })

  it('connectorError wraps the text as an isError result', () => {
    const r = connectorError({ ...ctx, err: new ConnectorApiError({ provider: 'GitHub', status: 404, message: 'Not Found' }) })
    expect(r.isError).toBe(true)
    expect(r.data).toContain('GitHub has no repo `o/r` issue #12')
  })
})
