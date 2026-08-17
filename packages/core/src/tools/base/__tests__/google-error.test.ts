/**
 * [COMP:tools/google-error] — GoogleApiError + describeGoogleError.
 *
 * The rendering half of the Google failure-copy contract
 * (docs/architecture/engine/tool-executor.md → "Failure copy"): every
 * status class names the target, keeps the code in parentheses, points at
 * the discovery sibling, and states the retry verdict. The classifier-verdict
 * half (D2 — `classifyConnectorAuthError` unchanged on the new copy) lives in
 * `packages/api/src/google/__tests__/google-error-verdicts.test.ts`, which
 * can import both sides.
 */

import { describe, it, expect } from 'vitest'
import {
  GOOGLE_ERROR_MESSAGE_CAP,
  GoogleApiError,
  describeGoogleError,
  googleFailure,
  isGoogleApiError,
  parseGoogleErrorBody,
} from '../_google-error.js'

const REST_404 = JSON.stringify({
  error: {
    code: 404,
    message: 'Requested entity was not found.',
    errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }],
    status: 'NOT_FOUND',
  },
})

describe('[COMP:tools/google-error] parseGoogleErrorBody', () => {
  it('reads message + reason + status from the REST envelope', () => {
    expect(parseGoogleErrorBody(REST_404)).toEqual({
      message: 'Requested entity was not found.',
      reason: 'notFound',
      googleStatus: 'NOT_FOUND',
    })
  })

  it('reads the OAuth token-endpoint shape (error + error_description)', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    expect(parseGoogleErrorBody(body)).toEqual({
      message: 'invalid_grant: Token has been expired or revoked.',
      reason: 'invalid_grant',
    })
  })

  it('falls back to details[].reason when errors[] is absent', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
      },
    })
    expect(parseGoogleErrorBody(body).reason).toBe('ACCESS_TOKEN_SCOPE_INSUFFICIENT')
  })

  it('passes a non-JSON body through as the message', () => {
    expect(parseGoogleErrorBody('<html>502 Bad Gateway</html>')).toEqual({ message: '<html>502 Bad Gateway</html>' })
    expect(parseGoogleErrorBody('')).toEqual({ message: '(empty response body)' })
  })
})

describe('[COMP:tools/google-error] GoogleApiError', () => {
  it('keeps the legacy `<Api> API error (<status>): <detail>` prefix and the structured fields', () => {
    const err = new GoogleApiError({ api: 'Calendar', status: 400, message: 'Invalid recurrence rule', reason: 'invalid' })
    // The reason rides at the end so substring-branching callers (the
    // calendar poller's `updatedMinTooLongAgo` recovery) still see it.
    expect(err.message).toBe('Calendar API error (400): Invalid recurrence rule [invalid]')
    expect(new GoogleApiError({ api: 'Calendar', status: 410, message: 'x', reason: 'updatedMinTooLongAgo' }).message).toContain('updatedMinTooLongAgo')
    expect(new GoogleApiError({ api: 'Calendar', status: 400, message: 'invalid_grant: dead', reason: 'invalid_grant' }).message).toBe('Calendar API error (400): invalid_grant: dead')
    expect(err.name).toBe('GoogleApiError')
    expect(err.status).toBe(400)
    expect(err.reason).toBe('invalid')
    expect(isGoogleApiError(err)).toBe(true)
    // Duck-typed so a copy from another module instance still counts.
    expect(isGoogleApiError({ name: 'GoogleApiError', status: 404, message: 'x' })).toBe(true)
    expect(isGoogleApiError(new Error('Calendar API error (400): x'))).toBe(false)
  })

  it('renders the operation into the prefix', () => {
    const err = new GoogleApiError({ api: 'Drive', status: 404, message: 'File not found', operation: 'export' })
    expect(err.message).toBe('Drive API export error (404): File not found')
  })

  it('caps the body so an HTML error page cannot flood the context', () => {
    const err = new GoogleApiError({ api: 'Sheets', status: 502, message: 'x'.repeat(5000) })
    expect(err.detail.length).toBeLessThanOrEqual(GOOGLE_ERROR_MESSAGE_CAP)
    expect(err.detail.endsWith('…')).toBe(true)
    // Whitespace runs (pretty-printed JSON, HTML) collapse before capping.
    const spaced = new GoogleApiError({ api: 'Sheets', status: 400, message: 'a\n\n   b\t c' })
    expect(spaced.detail).toBe('a b c')
  })
})

describe('[COMP:tools/google-error] describeGoogleError', () => {
  const ctx = { tool: 'googleCalendarGetEvent', product: 'Calendar' as const, target: 'event `evt_1` on calendar `primary`', discoveryTool: 'googleCalendarListEvents' }

  it('404 names the target, keeps the code, points at the discovery sibling, and forbids the retry', () => {
    const text = describeGoogleError(
      new GoogleApiError({ api: 'Calendar', status: 404, message: 'Not Found', reason: 'notFound' }),
      ctx,
    )
    expect(text).toContain('Google Calendar could not find event `evt_1` on calendar `primary`')
    expect(text).toContain('Calendar API error (404), notFound')
    expect(text).toContain('Call `googleCalendarListEvents` to get a current id.')
    expect(text).toContain('Retrying this exact id will keep failing')
  })

  it('404 without a discovery tool asks the user instead', () => {
    const text = describeGoogleError(new GoogleApiError({ api: 'Docs', status: 404, message: 'x' }), { tool: 'googleDocsCreate', product: 'Docs' })
    expect(text).toContain('Ask the user to confirm the id.')
    expect(text).toContain('the requested item')
  })

  it('401 keeps (401) and the dead-credential phrase, and says reconnect / do not retry', () => {
    const text = describeGoogleError(
      new GoogleApiError({ api: 'Gmail', status: 401, message: 'Request had invalid authentication credentials.', reason: 'authError' }),
      { tool: 'gmailListMessages', product: 'Gmail' },
    )
    expect(text).toContain('Gmail rejected this connector\'s credential')
    expect(text).toContain('Gmail API error (401)')
    expect(text).toContain('invalid or expired')
    expect(text).toContain('Reconnect Gmail (Studio → Connectors)')
    expect(text).toContain('retrying will not help')
  })

  it('403 scope loss → reconnect remedy; 403 per-item ACL → share-the-item remedy, never a connector-wide diagnosis', () => {
    const scope = describeGoogleError(
      new GoogleApiError({ api: 'Drive', status: 403, message: 'Request had insufficient authentication scopes.', reason: 'insufficientPermissions' }),
      { tool: 'googleDriveListFiles', product: 'Drive' },
    )
    expect(scope).toContain('lacks the permission scope this call needs')
    expect(scope).toContain('Reconnect Google Drive')
    expect(scope).toContain('Drive API error (403)')
    // No dead-credential phrase: the health classifier must NOT flip on a 403.
    expect(scope).not.toMatch(/invalid or expired|unauthorized|invalid_grant/i)

    const item = describeGoogleError(
      new GoogleApiError({ api: 'Sheets', status: 403, message: 'The caller does not have permission', googleStatus: 'PERMISSION_DENIED' }),
      { tool: 'googleSheetsReadRange', product: 'Sheets', target: 'spreadsheet `s-1` range `A1:B2`' },
    )
    expect(item).toContain('the resource is not accessible to this connector\'s Google account')
    expect(item).toContain('spreadsheet `s-1` range `A1:B2`')
    expect(item).toContain('not a problem with the connector as a whole')
    expect(item).toContain('Retrying unchanged will fail the same way')
  })

  it('429 / rate-limit reasons → transient, "nothing about the input is wrong", retry once', () => {
    const text = describeGoogleError(
      new GoogleApiError({ api: 'Sheets', status: 429, message: 'Quota exceeded for quota metric', reason: 'rateLimitExceeded' }),
      { tool: 'googleSheetsAppendRows', product: 'Sheets' },
    )
    expect(text).toContain('rate limit')
    expect(text).toContain('Nothing about the input is wrong')
    expect(text).toContain('retry the same call once')
    // A 403 that is really a quota refusal renders as rate limit too.
    const quota = describeGoogleError(
      new GoogleApiError({ api: 'Drive', status: 403, message: 'User Rate Limit Exceeded', reason: 'userRateLimitExceeded' }),
      { tool: 'googleDriveListFiles', product: 'Drive' },
    )
    expect(quota).toContain('rate limit')
  })

  it('5xx → transient with a retry-once verdict', () => {
    const text = describeGoogleError(new GoogleApiError({ api: 'Slides', status: 503, message: 'Backend Error' }), { tool: 'googleSlidesBatchUpdate', product: 'Slides' })
    expect(text).toContain('server-side error')
    expect(text).toContain('Slides API error (503)')
    expect(text).toContain('Retry once')
  })

  it('400 surfaces Google\'s own message and says the same input fails the same way', () => {
    const text = describeGoogleError(
      new GoogleApiError({ api: 'Sheets', status: 400, message: 'Unable to parse range: Sheet9!A1', reason: 'badRequest' }),
      { tool: 'googleSheetsReadRange', product: 'Sheets', target: 'spreadsheet `s-1` range `Sheet9!A1`' },
    )
    expect(text).toContain('Google said: "Unable to parse range: Sheet9!A1"')
    expect(text).toContain('Fix the field that message names')
    expect(text).toContain('the same input will fail the same way')
  })

  it('409 / 412 → conflict: re-read then retry once', () => {
    const text = describeGoogleError(new GoogleApiError({ api: 'Calendar', status: 412, message: 'Precondition Failed' }), ctx)
    expect(text).toContain('conflict')
    expect(text).toContain('Re-read it (`googleCalendarListEvents`)')
  })

  it('invalid_grant → the whole grant is dead: reconnect, never retry', () => {
    const text = describeGoogleError(
      new GoogleApiError({ api: 'Google', status: 400, message: 'invalid_grant: Token has been expired or revoked.', reason: 'invalid_grant', operation: 'token refresh' }),
      { tool: 'googleCalendarListEvents', product: 'Calendar' },
    )
    expect(text).toContain('The Google grant behind Google Calendar has expired or been revoked (invalid_grant)')
    expect(text).toContain('Do not retry')
  })

  it('upgrades a plain Error carrying the legacy prefix so it still renders by status', () => {
    const text = describeGoogleError(new Error('Tasks API error (401): Unauthorized'), { tool: 'googleTasksListTasks', product: 'Tasks' })
    expect(text).toContain('Google Tasks rejected this connector\'s credential')
    expect(text).toContain('Tasks API error (401)')
    expect(text).toContain('invalid or expired')
    const legacyBody = describeGoogleError(new Error(`Calendar API error (404): ${REST_404}`), ctx)
    expect(legacyBody).toContain('could not find event `evt_1`')
    expect(legacyBody).toContain('Google said: "Requested entity was not found."')
    expect(legacyBody).not.toContain('{"error"')
  })

  it('a plain error is framed with product + tool + target and a no-retry verdict; a network blip is transient', () => {
    const plain = describeGoogleError(new Error('Use eventLabelId or colorId, not both'), ctx)
    expect(plain).toBe(
      'Google Calendar `googleCalendarGetEvent` on event `evt_1` on calendar `primary` failed: Use eventLabelId or colorId, not both. Retrying the same arguments will not help — fix what the message names, or ask the user.',
    )
    const blip = describeGoogleError(new TypeError('fetch failed'), ctx)
    expect(blip).toContain('could not be reached')
    expect(blip).toContain('network blip')
    expect(blip).toContain('Retry once')
    // Non-Error throws are stringified, never "[object Object]"-ed into a crash.
    expect(describeGoogleError('string error', { tool: 'googleTasksGetTask', product: 'Tasks' })).toContain('string error')
  })

  it('googleFailure wraps the text as an isError result', () => {
    const r = googleFailure(new GoogleApiError({ api: 'Docs', status: 404, message: 'x' }), { tool: 'googleDocsGetContent', product: 'Docs', target: 'document `d`' })
    expect(r.isError).toBe(true)
    expect(r.data).toContain('Google Docs could not find document `d`')
  })
})
