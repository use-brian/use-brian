import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/**
 * Microsoft Bot Framework inbound request verification (JWT bearer).
 *
 * When Azure Bot Service delivers an Activity to our messaging endpoint, it
 * carries a JWT in the `Authorization: Bearer <token>` header (there is NO
 * HMAC-over-body signature like Slack, and NO Ed25519 like Discord). We verify:
 *
 *   - `alg` is RS256,
 *   - `iss` == `https://api.botframework.com`,
 *   - `aud` == this bot's Microsoft App id (per-channel, from the stored creds),
 *   - the token is inside its validity window (5-min clock skew), and
 *   - the RS256 signature checks against a key from Bot Framework's JWKS.
 *
 * The signing keys live at the `jwks_uri` advertised by the OpenID metadata
 * document (`https://login.botframework.com/v1/.well-known/openidconfiguration`).
 * They are Bot Framework's — shared across all bots — so the key set is cached
 * process-wide (the audience check, keyed on the per-channel App id, is what
 * scopes a token to one bot). Implemented with Node's built-in `crypto`; no
 * `jose` / `jsonwebtoken` dependency (the channels package has zero runtime
 * deps — see discord/verify.ts for the same discipline).
 *
 * Spec: docs/architecture/channels/msteams.md § "Inbound verification".
 */

/** OpenID metadata document for tokens the Bot Connector sends TO a bot. */
export const BOT_FRAMEWORK_OPENID_METADATA =
  'https://login.botframework.com/v1/.well-known/openidconfiguration'

/** The only issuer we accept for inbound Bot Connector tokens. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com'

const CLOCK_SKEW_SEC = 300
/** How long to trust a cached JWKS before refetching (keys rotate ~daily). */
const JWKS_TTL_MS = 60 * 60 * 1000

// A JSON Web Key as served by Bot Framework's JWKS (RSA signing keys). Kept as
// a local structural type — `node:crypto`'s `createPublicKey({ format: 'jwk' })`
// accepts this shape without naming the DOM `JsonWebKey` global (absent here).
type Jwk = { kid?: string; kty?: string; use?: string; alg?: string; n?: string; e?: string }

type JwtHeader = { alg?: string; kid?: string; typ?: string }
type JwtClaims = { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; serviceurl?: string }

export type MsTeamsVerifyResult =
  | { valid: true; claims: JwtClaims }
  | { valid: false; reason: string }

export type MsTeamsVerifierOptions = {
  /** The bot's Microsoft App id — the required `aud` claim (per channel). */
  appId: string
  fetchImpl?: typeof fetch
  metadataUrl?: string
  issuer?: string
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment, 'base64url')
}

function decodeSegment<T>(segment: string): T | null {
  try {
    return JSON.parse(base64UrlDecode(segment).toString('utf-8')) as T
  } catch {
    return null
  }
}

export function createMsTeamsVerifier(options: MsTeamsVerifierOptions) {
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input as string, init))
  const metadataUrl = options.metadataUrl ?? BOT_FRAMEWORK_OPENID_METADATA
  const issuer = options.issuer ?? BOT_FRAMEWORK_ISSUER

  let keyCache: { keys: Jwk[]; expiresAt: number } | null = null

  async function fetchKeys(force: boolean): Promise<Jwk[]> {
    if (!force && keyCache && keyCache.expiresAt > Date.now()) return keyCache.keys
    const metaRes = await doFetch(metadataUrl)
    if (!metaRes.ok) throw new Error(`openid metadata: HTTP ${metaRes.status}`)
    const meta = (await metaRes.json()) as { jwks_uri?: string }
    if (!meta.jwks_uri) throw new Error('openid metadata: missing jwks_uri')
    const jwksRes = await doFetch(meta.jwks_uri)
    if (!jwksRes.ok) throw new Error(`jwks: HTTP ${jwksRes.status}`)
    const jwks = (await jwksRes.json()) as { keys?: Jwk[] }
    const keys = jwks.keys ?? []
    keyCache = { keys, expiresAt: Date.now() + JWKS_TTL_MS }
    return keys
  }

  /** Find the JWK for a `kid`, refetching once on a miss (key rotation). */
  async function keyForKid(kid: string): Promise<Jwk | null> {
    let keys = await fetchKeys(false)
    let jwk = keys.find((k) => k.kid === kid)
    if (!jwk) {
      keys = await fetchKeys(true)
      jwk = keys.find((k) => k.kid === kid)
    }
    return jwk ?? null
  }

  /** Verify a raw JWT string. */
  async function verifyToken(token: string | undefined): Promise<MsTeamsVerifyResult> {
    if (!token) return { valid: false, reason: 'missing token' }
    const parts = token.split('.')
    if (parts.length !== 3) return { valid: false, reason: 'malformed token' }
    const [headerB64, payloadB64, sigB64] = parts

    const header = decodeSegment<JwtHeader>(headerB64)
    const claims = decodeSegment<JwtClaims>(payloadB64)
    if (!header || !claims) return { valid: false, reason: 'undecodable token' }
    if (header.alg !== 'RS256') return { valid: false, reason: `unsupported alg ${header.alg}` }
    if (!header.kid) return { valid: false, reason: 'missing kid' }

    // Claims
    if (claims.iss !== issuer) return { valid: false, reason: 'bad issuer' }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(options.appId)) return { valid: false, reason: 'bad audience' }
    const now = Math.floor(Date.now() / 1000)
    if (typeof claims.exp === 'number' && now > claims.exp + CLOCK_SKEW_SEC) {
      return { valid: false, reason: 'expired' }
    }
    if (typeof claims.nbf === 'number' && now + CLOCK_SKEW_SEC < claims.nbf) {
      return { valid: false, reason: 'not yet valid' }
    }

    // Signature
    let jwk: Jwk | null
    try {
      jwk = await keyForKid(header.kid)
    } catch (err) {
      return { valid: false, reason: `jwks fetch failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!jwk) return { valid: false, reason: 'unknown kid' }

    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' as const })
      const ok = cryptoVerify(
        'RSA-SHA256',
        Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8'),
        key,
        base64UrlDecode(sigB64),
      )
      return ok ? { valid: true, claims } : { valid: false, reason: 'bad signature' }
    } catch (err) {
      return { valid: false, reason: `verify error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** Verify the `Authorization` header value (`Bearer <jwt>`). */
  async function verifyAuthHeader(authHeader: string | undefined): Promise<MsTeamsVerifyResult> {
    if (!authHeader) return { valid: false, reason: 'missing Authorization header' }
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
    if (!m) return { valid: false, reason: 'not a Bearer token' }
    return verifyToken(m[1])
  }

  return { verifyToken, verifyAuthHeader }
}

export type MsTeamsVerifier = ReturnType<typeof createMsTeamsVerifier>
