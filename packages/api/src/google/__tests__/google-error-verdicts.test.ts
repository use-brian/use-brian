/**
 * [COMP:tools/google-error] — the D2 half: the connector-health classifier
 * must return the SAME verdict on the rewritten Google failure copy as it
 * did on the raw `<Api> API error (<status>): <body>` passthrough, and the
 * api-side `googleApiError()` parser must produce the structured error the
 * copy is rendered from.
 *
 * `classifyConnectorAuthError` (packages/api/src/mcp/connector-health.ts)
 * string-matches the flattened tool result: `(401)` / `invalid or expired`
 * / `invalid_grant` flip a connector to `auth_failed`; `not accessible` /
 * `rate limit` must never. A rewrite that drops those markers silently
 * disables (or over-triggers) the flip — see the 2026-07-20 GitHub incident
 * in connector-health.ts. Standard: docs/architecture/engine/tool-executor.md
 * → "Failure copy".
 */

import { describe, it, expect } from 'vitest'
import { GoogleApiError, describeGoogleError, googleFailure } from '@use-brian/core'
import { classifyConnectorAuthError } from '../../mcp/connector-health.js'
import { googleApiError } from '../client.js'

function fakeRes(status: number, body: string): Response {
  return { ok: false, status, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response
}

const envelope = (code: number, message: string, reason?: string, status?: string) =>
  JSON.stringify({ error: { code, message, errors: reason ? [{ reason, message, domain: 'global' }] : [], status } })

describe('[COMP:tools/google-error] googleApiError() parser (api client)', () => {
  it('builds a GoogleApiError with message/reason/status from the REST envelope', async () => {
    const err = await googleApiError(fakeRes(404, envelope(404, 'Requested entity was not found.', 'notFound', 'NOT_FOUND')), 'Calendar')
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.status).toBe(404)
    expect(err.reason).toBe('notFound')
    expect(err.googleStatus).toBe('NOT_FOUND')
    expect(err.message).toBe('Calendar API error (404): Requested entity was not found. [notFound]')
  })

  it('keeps the legacy prefix + plain-text body for non-JSON responses (existing callers match on it)', async () => {
    const err = await googleApiError(fakeRes(413, 'too large'), 'Gmail')
    expect(err.message).toBe('Gmail API error (413): too large')
    // The calendar poller branches on this reason by substring; it must survive.
    const gone = await googleApiError(fakeRes(410, JSON.stringify({ error: { errors: [{ reason: 'updatedMinTooLongAgo' }] } })), 'Calendar')
    expect(gone.message).toContain('updatedMinTooLongAgo')
    const op = await googleApiError(fakeRes(404, 'File not found'), 'Drive', 'export')
    expect(op.message).toBe('Drive API export error (404): File not found')
  })

  it('reads the OAuth token endpoint shape so invalid_grant survives as the reason', async () => {
    const err = await googleApiError(
      fakeRes(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })),
      'Google',
      'token refresh',
    )
    expect(err.reason).toBe('invalid_grant')
    // inject.ts `isTokenRevoked` keys on these two phrases in the message.
    expect(err.message).toContain('invalid_grant')
    expect(err.message).toContain('expired or revoked')
  })

  it('caps a huge body', async () => {
    const err = await googleApiError(fakeRes(502, '<html>' + 'x'.repeat(10_000) + '</html>'), 'Sheets')
    expect(err.message.length).toBeLessThan(260)
  })

  it('tolerates a Response double with only json()', async () => {
    const res = { ok: false, status: 400, json: async () => ({ error: { message: 'bad', errors: [{ reason: 'badRequest' }] } }) } as unknown as Response
    const err = await googleApiError(res, 'Tasks')
    expect(err.reason).toBe('badRequest')
    expect(err.detail).toBe('bad')
  })
})

describe('[COMP:tools/google-error] classifyConnectorAuthError verdicts on the new Google copy (D2)', () => {
  const ctx = { tool: 'googleCalendarGetEvent', product: 'Calendar' as const, target: 'event `e1` on calendar `primary`', discoveryTool: 'googleCalendarListEvents' }
  const rendered = (init: ConstructorParameters<typeof GoogleApiError>[0]) => googleFailure(new GoogleApiError(init), ctx).data

  it('401 → auth_failed (dead credential), same as the raw passthrough', () => {
    const raw = 'Calendar error: Calendar API error (401): {"error":{"code":401,"message":"Request had invalid authentication credentials."}}'
    expect(classifyConnectorAuthError(raw)).toBe(true)
    expect(classifyConnectorAuthError(rendered({ api: 'Calendar', status: 401, message: 'Request had invalid authentication credentials.', reason: 'authError' }))).toBe(true)
  })

  it('invalid_grant → auth_failed, same as before', () => {
    expect(classifyConnectorAuthError('Google token refresh failed: invalid_grant')).toBe(true)
    expect(classifyConnectorAuthError(rendered({ api: 'Google', status: 400, message: 'invalid_grant: Token has been expired or revoked.', reason: 'invalid_grant', operation: 'token refresh' }))).toBe(true)
  })

  it('403 per-item ACL → healthy (never flips), same as before', () => {
    const raw = 'Sheets error: Sheets API error (403): {"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}'
    expect(classifyConnectorAuthError(raw)).toBe(false)
    expect(classifyConnectorAuthError(rendered({ api: 'Sheets', status: 403, message: 'The caller does not have permission', googleStatus: 'PERMISSION_DENIED' }))).toBe(false)
  })

  it('403 scope loss → healthy (reconnect is the copy\'s remedy, but the verdict is unchanged)', () => {
    const raw = 'Drive error: Drive API error (403): {"error":{"code":403,"message":"Request had insufficient authentication scopes.","errors":[{"reason":"insufficientPermissions"}]}}'
    expect(classifyConnectorAuthError(raw)).toBe(false)
    expect(classifyConnectorAuthError(rendered({ api: 'Drive', status: 403, message: 'Request had insufficient authentication scopes.', reason: 'insufficientPermissions' }))).toBe(false)
  })

  it('429 rate limit and 5xx → healthy, same as before', () => {
    expect(classifyConnectorAuthError(rendered({ api: 'Gmail', status: 429, message: 'User-rate limit exceeded.', reason: 'rateLimitExceeded' }))).toBe(false)
    expect(classifyConnectorAuthError(rendered({ api: 'Gmail', status: 503, message: 'Backend Error' }))).toBe(false)
  })

  it('404 → healthy, same as before', () => {
    expect(classifyConnectorAuthError(rendered({ api: 'Calendar', status: 404, message: 'Not Found', reason: 'notFound' }))).toBe(false)
  })

  it('the not-connected / plain frames never flip a connector', () => {
    expect(classifyConnectorAuthError(describeGoogleError(new Error('Google Calendar and Google Tasks is not connected for this assistant (no Google grant is stored for it), so the call could not be made.'), ctx))).toBe(false)
    expect(classifyConnectorAuthError(describeGoogleError(new TypeError('fetch failed'), ctx))).toBe(false)
  })
})
