/**
 * Unit tests for the custom-connector auth header builder.
 * Component tag: [COMP:api/mcp-auth-headers].
 *
 * Spec: docs/architecture/integrations/mcp.md → "Custom connector auth".
 * The builder maps the stored credentials union to outbound HTTP headers,
 * never throws, never logs secret values, and degrades malformed input to
 * `{}` so one bad credential can't break tool injection for the turn.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildConnectorAuthHeaders, isValidHeaderName, isValidHeaderValue, mergeValidatedHeaders, preflightHeadersToRecord, actorIdentityHeaders } from '../auth-headers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('[COMP:api/mcp-auth-headers] buildConnectorAuthHeaders', () => {
  it('returns Authorization for bearer credentials', () => {
    expect(buildConnectorAuthHeaders({ type: 'bearer', token: 'secret123' })).toEqual({
      Authorization: 'Bearer secret123',
    })
  })

  it('returns the named header for custom_header credentials', () => {
    expect(buildConnectorAuthHeaders({ type: 'custom_header', header: 'X-Api-Key', value: 'k1' })).toEqual({
      'X-Api-Key': 'k1',
    })
  })

  it('returns no headers for oauth credentials (the OAuth client flow is a separate surface)', () => {
    expect(
      buildConnectorAuthHeaders({ type: 'oauth', client_id: 'id', client_secret: 'sec' }),
    ).toEqual({})
  })

  it('returns no headers for none / null / undefined', () => {
    expect(buildConnectorAuthHeaders({ type: 'none' })).toEqual({})
    expect(buildConnectorAuthHeaders(null)).toEqual({})
    expect(buildConnectorAuthHeaders(undefined)).toEqual({})
  })

  it('returns no headers for a legacy oauth-shaped blob without a type discriminator', () => {
    // Pre-migration-261 rows decrypt to a bare pair — today's no-op behavior
    // must be preserved byte-for-byte.
    expect(buildConnectorAuthHeaders({ client_id: 'id', client_secret: 'sec' })).toEqual({})
  })

  it('rejects a bearer token containing CR/LF without throwing or logging the token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(buildConnectorAuthHeaders({ type: 'bearer', token: 'evil\r\nX-Inject: 1' })).toEqual({})
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0])).not.toContain('evil')
  })

  it('rejects an empty bearer token', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(buildConnectorAuthHeaders({ type: 'bearer', token: '' })).toEqual({})
  })

  it('rejects an invalid header name (non-token chars, CR/LF) without leaking the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      buildConnectorAuthHeaders({ type: 'custom_header', header: 'X-Bad: yes\r\n', value: 'topsecret' }),
    ).toEqual({})
    expect(buildConnectorAuthHeaders({ type: 'custom_header', header: '', value: 'topsecret' })).toEqual({})
    for (const call of warn.mock.calls) {
      expect(String(call)).not.toContain('topsecret')
    }
  })

  it('rejects a header value containing CR/LF without leaking it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      buildConnectorAuthHeaders({ type: 'custom_header', header: 'X-Api-Key', value: 'a\r\nb' }),
    ).toEqual({})
    for (const call of warn.mock.calls) {
      expect(String(call)).not.toContain('a\r\nb')
    }
  })

  it('never throws on malformed blobs', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const malformed: unknown[] = [
      { type: 'bearer' },
      { type: 'bearer', token: 42 },
      { type: 'custom_header', header: 'X-K' },
      { type: 'custom_header', value: 'v' },
      { type: 'unknown_scheme' },
      'a string',
      42,
    ]
    for (const blob of malformed) {
      expect(() =>
        buildConnectorAuthHeaders(blob as Parameters<typeof buildConnectorAuthHeaders>[0]),
      ).not.toThrow()
    }
  })
})

describe('[COMP:api/mcp-auth-headers] header validators', () => {
  it('accepts RFC 7230 token names and rejects everything else', () => {
    expect(isValidHeaderName('X-Api-Key')).toBe(true)
    expect(isValidHeaderName('Authorization')).toBe(true)
    expect(isValidHeaderName('x_custom.key~1')).toBe(true)
    expect(isValidHeaderName('')).toBe(false)
    expect(isValidHeaderName('X Api Key')).toBe(false)
    expect(isValidHeaderName('X-Key:')).toBe(false)
    expect(isValidHeaderName('X-Key\r\n')).toBe(false)
    expect(isValidHeaderName('a'.repeat(129))).toBe(false)
  })

  it('rejects values with CR/LF, empty values, and oversized values', () => {
    expect(isValidHeaderValue('plain-token')).toBe(true)
    expect(isValidHeaderValue('')).toBe(false)
    expect(isValidHeaderValue('a\rb')).toBe(false)
    expect(isValidHeaderValue('a\nb')).toBe(false)
    expect(isValidHeaderValue('a'.repeat(8193))).toBe(false)
  })
})

describe('[COMP:api/mcp-header-merge] mergeValidatedHeaders', () => {
  it('returns undefined when there is nothing to send (no base, no overrides)', () => {
    expect(mergeValidatedHeaders(undefined, undefined)).toBeUndefined()
    expect(mergeValidatedHeaders({}, {})).toBeUndefined()
  })

  it('passes the base headers through untouched when there are no overrides', () => {
    expect(mergeValidatedHeaders({ Authorization: 'Bearer x' }, undefined)).toEqual({
      Authorization: 'Bearer x',
    })
  })

  it('injects a new header alongside the stored-credential headers', () => {
    expect(mergeValidatedHeaders({ Authorization: 'Bearer x' }, { 'X-Tenant': 'acme' })).toEqual({
      Authorization: 'Bearer x',
      'X-Tenant': 'acme',
    })
  })

  it('override wins on a same-name clash', () => {
    expect(mergeValidatedHeaders({ Authorization: 'Bearer stored' }, { Authorization: 'Bearer override' })).toEqual({
      Authorization: 'Bearer override',
    })
  })

  it('override wins case-insensitively (HTTP header names are case-insensitive)', () => {
    // A lowercase override must replace the stored capitalized header, not
    // duplicate it — otherwise the transport sends two Authorization headers.
    const merged = mergeValidatedHeaders({ Authorization: 'Bearer stored' }, { authorization: 'Bearer override' })
    expect(merged).toEqual({ authorization: 'Bearer override' })
    expect(Object.keys(merged ?? {})).toHaveLength(1)
  })

  it('drops an override with an invalid header name, keeping the base', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const merged = mergeValidatedHeaders({ Authorization: 'Bearer x' }, { 'X-Bad: yes\r\n': 'v' })
    expect(merged).toEqual({ Authorization: 'Bearer x' })
    expect(warn).toHaveBeenCalled()
  })

  it('drops an override whose value contains CR/LF without leaking it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const merged = mergeValidatedHeaders(undefined, { 'X-Inject': 'a\r\nEvil: 1' })
    expect(merged).toBeUndefined()
    for (const call of warn.mock.calls) {
      expect(String(call)).not.toContain('Evil')
    }
  })

  it('never throws — a fully-invalid override set degrades to the base', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => mergeValidatedHeaders({ A: 'b' }, { '': 'x', 'Bad Name': 'y' })).not.toThrow()
    expect(mergeValidatedHeaders({ A: 'b' }, { '': 'x' })).toEqual({ A: 'b' })
  })
})

describe('[COMP:api/connector-preflight-headers] preflightHeadersToRecord', () => {
  it('returns {} when config has no preflightHeaders', () => {
    expect(preflightHeadersToRecord(undefined)).toEqual({})
    expect(preflightHeadersToRecord(null)).toEqual({})
    expect(preflightHeadersToRecord({})).toEqual({})
    expect(preflightHeadersToRecord({ authHeaderName: 'X-K' })).toEqual({})
  })

  it('converts an array of {name,value} rows to a name→value map', () => {
    expect(
      preflightHeadersToRecord({ preflightHeaders: [
        { name: 'X-Tenant', value: 'acme' },
        { name: 'X-Env', value: 'prod' },
      ] }),
    ).toEqual({ 'X-Tenant': 'acme', 'X-Env': 'prod' })
  })

  it('last row wins on a duplicate name', () => {
    expect(
      preflightHeadersToRecord({ preflightHeaders: [
        { name: 'X-Tenant', value: 'first' },
        { name: 'X-Tenant', value: 'second' },
      ] }),
    ).toEqual({ 'X-Tenant': 'second' })
  })

  it('skips malformed rows without throwing (non-array, missing/typed fields, empty name)', () => {
    expect(preflightHeadersToRecord({ preflightHeaders: 'nope' as unknown })).toEqual({})
    expect(
      preflightHeadersToRecord({ preflightHeaders: [
        { name: 'X-Ok', value: 'y' },
        { name: 'X-NoValue' },
        { value: 'orphan' },
        { name: 42, value: 'x' },
        { name: '', value: 'blank-name' },
        null,
        'string-row',
      ] as unknown }),
    ).toEqual({ 'X-Ok': 'y' })
  })

  it('does not validate the header charset itself — that is mergeValidatedHeaders job', () => {
    // A bad name survives extraction (it is dropped later at merge time).
    expect(
      preflightHeadersToRecord({ preflightHeaders: [{ name: 'Bad Name', value: 'v' }] }),
    ).toEqual({ 'Bad Name': 'v' })
    // …and mergeValidatedHeaders drops it, so the wire never sees it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mergeValidatedHeaders({}, preflightHeadersToRecord({ preflightHeaders: [{ name: 'Bad Name', value: 'v' }] }))).toBeUndefined()
  })

  it('DROPS reserved X-Sidanclaw-* names so user config cannot forge an identity claim', () => {
    expect(
      preflightHeadersToRecord({ preflightHeaders: [
        { name: 'X-Sidanclaw-Actor-Email', value: 'attacker@evil.com' },
        { name: 'x-sidanclaw-user-id', value: 'someone-else' },
        { name: 'X-Tenant', value: 'acme' },
      ] }),
    ).toEqual({ 'X-Tenant': 'acme' })
  })
})

describe('[COMP:api/actor-identity] actorIdentityHeaders', () => {
  it('builds the full reserved-namespace header set', () => {
    expect(actorIdentityHeaders({ channel: 'web', id: 'a@b.com', email: 'a@b.com', userId: 'u-1' })).toEqual({
      'X-Sidanclaw-Actor-Channel': 'web',
      'X-Sidanclaw-User-Id': 'u-1',
      'X-Sidanclaw-Actor-Id': 'a@b.com',
      'X-Sidanclaw-Actor-Email': 'a@b.com',
    })
  })

  it('always sends channel + user id; omits absent id / email', () => {
    expect(actorIdentityHeaders({ channel: 'telegram', userId: 'u-2' })).toEqual({
      'X-Sidanclaw-Actor-Channel': 'telegram',
      'X-Sidanclaw-User-Id': 'u-2',
    })
    expect(actorIdentityHeaders({ channel: 'slack', id: 'U0999', email: null, userId: 'u-3' })).toEqual({
      'X-Sidanclaw-Actor-Channel': 'slack',
      'X-Sidanclaw-User-Id': 'u-3',
      'X-Sidanclaw-Actor-Id': 'U0999',
    })
  })

  it('actor headers win when merged over auth + (reserved-stripped) preflight', () => {
    const actor = actorIdentityHeaders({ channel: 'whatsapp', id: '15551234567', email: 'real@user.com', userId: 'u-4' })
    const merged = mergeValidatedHeaders({ Authorization: 'Bearer x' }, actor)
    expect(merged).toMatchObject({
      Authorization: 'Bearer x',
      'X-Sidanclaw-Actor-Id': '15551234567',
      'X-Sidanclaw-Actor-Email': 'real@user.com',
    })
  })
})
