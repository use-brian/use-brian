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
import { buildConnectorAuthHeaders, isValidHeaderName, isValidHeaderValue } from '../auth-headers.js'

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
