/**
 * [COMP:api/home-app-bridge] — the two custom-Home-app capability tokens and
 * the bundle CSP.
 *
 * These are the security boundary around running someone else's code. The
 * cases below are the ones that would be incidents rather than bugs:
 *
 *   - a bundle token replayed as a bridge token (bytes → brain), or vice versa;
 *   - a token minted for one app replayed against another;
 *   - a tampered payload keeping a valid-looking signature;
 *   - a manifest `net` origin escaping into the CSP header as a directive.
 */

import { describe, it, expect } from 'vitest'
import {
  BRIDGE_TOKEN_AUD,
  BUNDLE_TOKEN_AUD,
  mintBridgeToken,
  mintBundleToken,
  parseBridgeToken,
  verifyBridgeToken,
  verifyBundleToken,
} from '../tokens.js'
import { buildBundleCsp } from '../csp.js'

const SECRET = 'test-signing-secret'
const APP = 'app-1'
const OTHER_APP = 'app-2'

const bridge = () =>
  mintBridgeToken({
    appId: APP,
    workspaceId: 'ws-1',
    userId: 'u-1',
    scope: 'read',
    maxClearance: null,
    secret: SECRET,
  })

describe('[COMP:api/home-app-bridge] bundle token', () => {
  it('round-trips for its own app', () => {
    const token = mintBundleToken({ appId: APP, secret: SECRET })
    const result = verifyBundleToken({ token, appId: APP, secret: SECRET })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.aud).toBe(BUNDLE_TOKEN_AUD)
  })

  it('is bound to ONE app', () => {
    const token = mintBundleToken({ appId: APP, secret: SECRET })
    expect(verifyBundleToken({ token, appId: OTHER_APP, secret: SECRET })).toEqual({
      ok: false,
      reason: 'wrong-app',
    })
  })

  it('rejects a foreign signing secret', () => {
    const token = mintBundleToken({ appId: APP, secret: 'other' })
    expect(verifyBundleToken({ token, appId: APP, secret: SECRET })).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('expires', () => {
    const token = mintBundleToken({ appId: APP, secret: SECRET, ttlMs: 1_000, now: () => 0 })
    expect(verifyBundleToken({ token, appId: APP, secret: SECRET, now: () => 500 }).ok).toBe(true)
    expect(verifyBundleToken({ token, appId: APP, secret: SECRET, now: () => 2_000 })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects a tampered payload', () => {
    const token = mintBundleToken({ appId: APP, secret: SECRET })
    const [encoded, sig] = token.split('.')
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    payload.appId = OTHER_APP
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`
    expect(verifyBundleToken({ token: forged, appId: OTHER_APP, secret: SECRET })).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('rejects malformed input without throwing', () => {
    for (const token of ['', 'nodot', 'a.b.c', '...']) {
      expect(verifyBundleToken({ token, appId: APP, secret: SECRET }).ok).toBe(false)
    }
  })
})

describe('[COMP:api/home-app-bridge] bridge token', () => {
  it('round-trips with its scope and clearance cap', () => {
    const token = mintBridgeToken({
      appId: APP,
      workspaceId: 'ws-1',
      userId: 'u-1',
      scope: 'read_write',
      maxClearance: 'internal',
      secret: SECRET,
    })
    const result = verifyBridgeToken({ token, appId: APP, secret: SECRET })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload).toMatchObject({
      aud: BRIDGE_TOKEN_AUD,
      workspaceId: 'ws-1',
      userId: 'u-1',
      scope: 'read_write',
      maxClearance: 'internal',
    })
  })

  it('parses without a pre-known app id, still signature-checked', () => {
    const result = parseBridgeToken({ token: bridge(), secret: SECRET })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.appId).toBe(APP)
    expect(parseBridgeToken({ token: bridge(), secret: 'other' }).ok).toBe(false)
  })
})

describe('[COMP:api/home-app-bridge] the two audiences are NOT interchangeable', () => {
  // The load-bearing separation: one token serves bytes, the other reaches the
  // workspace brain. A replay across them would turn "can load this app's CSS"
  // into "can read this workspace's memories".
  it('refuses a bundle token where a bridge token is required', () => {
    const token = mintBundleToken({ appId: APP, secret: SECRET })
    expect(verifyBridgeToken({ token, appId: APP, secret: SECRET })).toEqual({
      ok: false,
      reason: 'wrong-audience',
    })
    expect(parseBridgeToken({ token, secret: SECRET })).toEqual({
      ok: false,
      reason: 'wrong-audience',
    })
  })

  it('refuses a bridge token where a bundle token is required', () => {
    expect(verifyBundleToken({ token: bridge(), appId: APP, secret: SECRET })).toEqual({
      ok: false,
      reason: 'wrong-audience',
    })
  })
})

describe('[COMP:api/home-app-bundle-route] bundle CSP', () => {
  const API = 'https://api.usebrian.ai'

  it('denies by default and allows only what the bundle needs', () => {
    const csp = buildBundleCsp({ apiOrigin: API })
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain(`connect-src 'self' ${API}`)
  })

  it('folds in consented net origins, and ONLY those', () => {
    const csp = buildBundleCsp({
      apiOrigin: API,
      netOrigins: ['https://a.example.com', 'https://b.example.com'],
    })
    expect(csp).toContain(
      `connect-src 'self' ${API} https://a.example.com https://b.example.com`,
    )
  })

  it('drops an unsafe origin instead of concatenating it into the header', () => {
    // A wildcard grants a subdomain tree the consent screen never showed; the
    // quote/semicolon forms would terminate the directive outright.
    const csp = buildBundleCsp({
      apiOrigin: API,
      netOrigins: [
        "https://evil.com'; script-src *",
        'https://*.example.com',
        'http://plain.example.com',
        'https://ok.example.com',
      ],
    })
    expect(csp).toContain(`connect-src 'self' ${API} https://ok.example.com`)
    expect(csp).not.toContain('script-src *')
    expect(csp).not.toContain('*.example.com')
    expect(csp).not.toContain('http://plain')
    // Exactly one script-src directive survives.
    expect(csp.match(/script-src/g)).toHaveLength(1)
  })

  it('de-dupes an origin that repeats the API origin', () => {
    const csp = buildBundleCsp({ apiOrigin: API, netOrigins: [API] })
    expect(csp.match(new RegExp(API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
  })
})

describe('[COMP:api/home-app-bundle-route] frame-ancestors names the framer', () => {
  const API = 'https://api.example.com'
  const APP = 'https://app.example.com'

  it('allows the app origin to frame the bundle', () => {
    // The regression: the bundle is served from the API origin, so `'self'`
    // alone means "only the API may frame this" — and the API frames nothing.
    // Every custom Home app was blocked, which Chrome reports as "refused to
    // connect", indistinguishable from a dead server.
    const csp = buildBundleCsp({ apiOrigin: API, appOrigin: APP })
    expect(csp).toContain(`frame-ancestors 'self' ${APP}`)
  })

  it('accepts an http localhost framer, because dev is split-origin too', () => {
    const csp = buildBundleCsp({ apiOrigin: 'http://localhost:4000', appOrigin: 'http://localhost:3003' })
    expect(csp).toContain("frame-ancestors 'self' http://localhost:3003")
  })

  it("falls back to 'self' when no framer is configured", () => {
    expect(buildBundleCsp({ apiOrigin: API })).toContain("frame-ancestors 'self'")
  })

  it('refuses a framer that could terminate the directive or widen it', () => {
    for (const bad of [
      "https://app.example.com; script-src *",
      'https://*.example.com',
      'https://app.example.com/path',
      'javascript:alert(1)',
      'https://user:pw@app.example.com',
    ]) {
      const csp = buildBundleCsp({ apiOrigin: API, appOrigin: bad })
      expect(csp).toContain("frame-ancestors 'self'")
      expect(csp).not.toContain(bad)
    }
  })
})
