import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import type { Tool } from '@use-brian/core'
import {
  classifyConnectorAuthError,
  wrapToolsWithHealthProbe,
  createHealthReporter,
  connectorReconnectNotice,
} from '../connector-health.js'

function makeTool(execute: Tool['execute']): Tool {
  return {
    name: 'githubSearchRepositories',
    description: 'search repos',
    inputSchema: z.object({}),
    execute,
    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,
  }
}

describe('[COMP:integrations/connector-health] classifyConnectorAuthError', () => {
  it('flags 401 / invalid-credential messages as auth failures', () => {
    // The exact strings the provider clients emit.
    expect(classifyConnectorAuthError(new Error('GitHub PAT is invalid or revoked (401): Bad credentials'))).toBe(true)
    expect(classifyConnectorAuthError('Notion token is invalid or expired. Please reconnect.')).toBe(true)
    expect(classifyConnectorAuthError('Fathom token is invalid or expired.')).toBe(true)
    expect(classifyConnectorAuthError('Google token refresh failed: invalid_grant')).toBe(true)
    expect(classifyConnectorAuthError(new Error('401 Unauthorized'))).toBe(true)
  })

  it('does NOT flag transient / non-auth errors (so a blip never marks a live connector dead)', () => {
    expect(classifyConnectorAuthError(new Error('GitHub API error (404): Not Found'))).toBe(false)
    expect(classifyConnectorAuthError(new Error('fetch failed: ECONNRESET'))).toBe(false)
    expect(classifyConnectorAuthError(new Error('GitHub API error (500): server error'))).toBe(false)
    expect(classifyConnectorAuthError('rate limit exceeded')).toBe(false)
  })

  // ── 403 is NOT 401 ──────────────────────────────────────────────
  // Regression: production incident 2026-07-20. A fine-grained GitHub PAT with
  // `Pull requests: Read` on one repo but not another returned this verbatim.
  // The old classifier matched a bare `\b403\b` and flipped the whole connector
  // to auth_failed, which made the next injection skip the GitHub tools for
  // EVERY repo. The credential was alive the entire time.
  it('does NOT flag a per-resource 403 — the credential is alive, it just cannot touch that resource', () => {
    const real =
      'GitHub error: GitHub API error (403): {"message":"Resource not accessible by personal access token",' +
      '"documentation_url":"https://docs.github.com/rest/pulls/pulls#list-pull-requests","status":"403"}'
    expect(classifyConnectorAuthError(real)).toBe(false)
    expect(classifyConnectorAuthError('GitHub error: GitHub API error (403): forbidden')).toBe(false)
    expect(classifyConnectorAuthError('GitHub API error (403): Resource not accessible by integration')).toBe(false)
  })

  it('does NOT flag a 403 rate limit or IP allow-list refusal', () => {
    expect(classifyConnectorAuthError('GitHub API error (403): API rate limit exceeded for user ID 4171296')).toBe(false)
    expect(classifyConnectorAuthError('GitHub API error (403): You have exceeded a secondary rate limit')).toBe(false)
    expect(classifyConnectorAuthError('GitHub API error (403): Although you appear to have the correct authorization credentials, your IP address is not permitted')).toBe(false)
  })

  it('DOES flag a 403 that names a re-authorization requirement (SSO/SAML)', () => {
    expect(
      classifyConnectorAuthError(
        'GitHub API error (403): Resource protected by organization SAML enforcement. ' +
          'You must grant your Personal Access Token access to this organization.',
      ),
    ).toBe(true)
  })

  it('ignores an incidental 401/403 that is not an HTTP status', () => {
    // A bare \b403\b previously matched any of these.
    expect(classifyConnectorAuthError('GitHub error: pull request #403 could not be merged')).toBe(false)
    expect(classifyConnectorAuthError('GitHub error: 401 files changed')).toBe(false)
  })
})

describe('[COMP:integrations/connector-health] wrapToolsWithHealthProbe', () => {
  it('flips to auth_failed on an auth-class isError result and passes the result through', async () => {
    const report = vi.fn()
    const [wrapped] = wrapToolsWithHealthProbe(
      [makeTool(async () => ({ data: 'GitHub error: GitHub PAT is invalid or revoked (401): Bad credentials', isError: true }))],
      'inst-1',
      report,
    )
    const result = await wrapped.execute({}, {} as never)
    expect(result.isError).toBe(true) // caller still sees the real error
    expect(report).toHaveBeenCalledWith('inst-1', 'auth_failed', expect.stringContaining('401'))
  })

  it('resets to ok on a successful result', async () => {
    const report = vi.fn()
    const [wrapped] = wrapToolsWithHealthProbe([makeTool(async () => ({ data: { items: [] } }))], 'inst-1', report)
    await wrapped.execute({}, {} as never)
    expect(report).toHaveBeenCalledWith('inst-1', 'ok')
  })

  it('leaves health untouched on a non-auth isError (e.g. a 404)', async () => {
    const report = vi.fn()
    const [wrapped] = wrapToolsWithHealthProbe(
      [makeTool(async () => ({ data: 'GitHub error: GitHub API error (404): Not Found', isError: true }))],
      'inst-1',
      report,
    )
    await wrapped.execute({}, {} as never)
    expect(report).not.toHaveBeenCalled()
  })

  it('flips to auth_failed and rethrows when a tool throws an auth error', async () => {
    const report = vi.fn()
    const [wrapped] = wrapToolsWithHealthProbe([makeTool(async () => { throw new Error('401 Unauthorized') })], 'inst-1', report)
    await expect(wrapped.execute({}, {} as never)).rejects.toThrow('401')
    expect(report).toHaveBeenCalledWith('inst-1', 'auth_failed', expect.any(String))
  })
})

describe('[COMP:integrations/connector-health] createHealthReporter', () => {
  it('calls markHealth and swallows a store rejection (never affects the tool call)', async () => {
    const markHealth = vi.fn().mockRejectedValue(new Error('db down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const report = createHealthReporter({ markHealth })
    report('inst-1', 'auth_failed', 'boom')
    expect(markHealth).toHaveBeenCalledWith('inst-1', 'auth_failed', 'boom')
    await Promise.resolve() // flush the fire-and-forget catch
    spy.mockRestore()
  })

  it('is a no-op without a store', () => {
    const report = createHealthReporter(undefined)
    expect(() => report('inst-1', 'ok')).not.toThrow()
  })
})

describe('[COMP:integrations/connector-health] connectorReconnectNotice', () => {
  it('names the provider + label and instructs the user to reconnect', () => {
    const notice = connectorReconnectNotice('github', 'Use Brian')
    expect(notice).toContain('GitHub')
    expect(notice).toContain('Use Brian')
    expect(notice.toLowerCase()).toContain('reconnect')
  })
})
