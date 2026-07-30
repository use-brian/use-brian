/**
 * Custom Home app capability tokens — OPEN, pure HMAC.
 *
 * TWO tokens, deliberately separate, both compact
 * `<base64url-payload>.<base64url-sig>` signatures over the single server-side
 * signing secret (`JWT_SECRET` — there is exactly one, see
 * `brain-mcp/oauth/codes.ts`; a second would just be a rotation footgun):
 *
 *   1. **bundle token** (`aud: 'home-app-bundle'`) — authorizes an
 *      UNAUTHENTICATED `GET /api/home-apps/:appId/bundle/*`. The app renders in
 *      an opaque-origin iframe, so it carries no cookies and no Authorization
 *      header; without a signed URL the bundle route would either be open to
 *      the world or unreachable by the frame. Same shape as the file-preview
 *      token, which exists for exactly this reason.
 *
 *   2. **bridge token** (`aud: 'home-app'`) — what the frame posts back with,
 *      and what `brain-mcp/auth.ts` resolves as a third credential kind. This
 *      one carries the app's SCOPE and CLEARANCE CAP, so the brain tools gate
 *      identically to a brain key with zero new tool code.
 *
 * **The audiences must never be interchangeable.** They authorize different
 * things — one serves bytes, one reaches the workspace brain — and a token
 * that could be replayed across them would turn "can load this app's CSS" into
 * "can read this workspace's memories". Both verifiers pin `aud` AND the app
 * id, so a signature minted for one app or one purpose is inert everywhere
 * else. That separation is the single most load-bearing thing in this file.
 *
 * Spec: docs/architecture/features/home-apps.md → "Serving + the bridge".
 * [COMP:api/home-app-bridge]
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Sensitivity } from '@use-brian/core'
import type { AppDataScope } from '@use-brian/brian-app'

export const BUNDLE_TOKEN_AUD = 'home-app-bundle' as const
export const BRIDGE_TOKEN_AUD = 'home-app' as const

/** Short — the frame fetches its bundle immediately on render. */
export const BUNDLE_TOKEN_TTL_MS = 5 * 60 * 1000
/** ~10 min, refreshed on request over the postMessage channel. */
export const BRIDGE_TOKEN_TTL_MS = 10 * 60 * 1000

export type BundleTokenPayload = {
  /** The `workspace_home_apps` id this signature unlocks. */
  appId: string
  aud: typeof BUNDLE_TOKEN_AUD
  /** Unix ms. */
  exp: number
}

export type BridgeTokenPayload = {
  appId: string
  workspaceId: string
  /** The viewer. Apps key their per-user KV on this. */
  userId: string
  /** Brain access the admin consented to. */
  scope: AppDataScope
  /** Per-app clearance ceiling; null = the primary assistant's clearance governs. */
  maxClearance: Sensitivity | null
  aud: typeof BRIDGE_TOKEN_AUD
  exp: number
}

type AnyPayload = BundleTokenPayload | BridgeTokenPayload

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url')
}

function mint(payload: AnyPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded, secret)}`
}

export function mintBundleToken(opts: {
  appId: string
  secret: string
  ttlMs?: number
  now?: () => number
}): string {
  const now = opts.now ? opts.now() : Date.now()
  return mint(
    {
      appId: opts.appId,
      aud: BUNDLE_TOKEN_AUD,
      exp: now + (opts.ttlMs ?? BUNDLE_TOKEN_TTL_MS),
    },
    opts.secret,
  )
}

export function mintBridgeToken(opts: {
  appId: string
  workspaceId: string
  userId: string
  scope: AppDataScope
  maxClearance: Sensitivity | null
  secret: string
  ttlMs?: number
  now?: () => number
}): string {
  const now = opts.now ? opts.now() : Date.now()
  return mint(
    {
      appId: opts.appId,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      scope: opts.scope,
      maxClearance: opts.maxClearance,
      aud: BRIDGE_TOKEN_AUD,
      exp: now + (opts.ttlMs ?? BRIDGE_TOKEN_TTL_MS),
    },
    opts.secret,
  )
}

export type TokenFailure =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-audience'
  | 'wrong-app'
  | 'expired'

export type VerifyResult<T> = { ok: true; payload: T } | { ok: false; reason: TokenFailure }

/**
 * Shared verify. Checks, in order: structural shape, HMAC (constant-time),
 * audience, app-id binding, expiry.
 *
 * Never throws — the caller 401s without leaking a stack trace, and a probe
 * cannot distinguish "wrong signature" from "wrong app" from "expired" beyond
 * the reason we choose to surface.
 */
function verify<T extends AnyPayload>(opts: {
  token: string
  aud: T['aud']
  appId: string
  secret: string
  now?: () => number
}): VerifyResult<T> {
  const now = opts.now ? opts.now() : Date.now()
  const dot = opts.token.lastIndexOf('.')
  if (dot < 0) return { ok: false, reason: 'malformed' }

  const encoded = opts.token.slice(0, dot)
  const provided = opts.token.slice(dot + 1)
  const expected = sign(encoded, opts.secret)
  // Length-guard before timingSafeEqual (it throws on unequal lengths); an
  // early length mismatch is itself a bad signature.
  if (provided.length !== expected.length) return { ok: false, reason: 'bad-signature' }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return { ok: false, reason: 'bad-signature' }
  }

  let payload: T
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (typeof payload.appId !== 'string' || payload.appId.length === 0) {
    return { ok: false, reason: 'malformed' }
  }
  // Audience FIRST: a valid bundle signature must never satisfy a bridge check,
  // and vice versa.
  if (payload.aud !== opts.aud) return { ok: false, reason: 'wrong-audience' }
  if (payload.appId !== opts.appId) return { ok: false, reason: 'wrong-app' }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, payload }
}

export function verifyBundleToken(opts: {
  token: string
  appId: string
  secret: string
  now?: () => number
}): VerifyResult<BundleTokenPayload> {
  return verify<BundleTokenPayload>({ ...opts, aud: BUNDLE_TOKEN_AUD })
}

export function verifyBridgeToken(opts: {
  token: string
  appId: string
  secret: string
  now?: () => number
}): VerifyResult<BridgeTokenPayload> {
  const result = verify<BridgeTokenPayload>({ ...opts, aud: BRIDGE_TOKEN_AUD })
  if (!result.ok) return result
  const p = result.payload
  if (
    typeof p.workspaceId !== 'string' ||
    typeof p.userId !== 'string' ||
    (p.scope !== 'read' && p.scope !== 'read_write')
  ) {
    return { ok: false, reason: 'malformed' }
  }
  return result
}

/**
 * A bridge token WITHOUT its app-id binding pre-known — the brain-MCP path,
 * where the bearer token is all we have and the app id comes out of the
 * payload. Still audience-pinned; the caller re-derives the workspace from the
 * app row rather than trusting the claim.
 */
export function parseBridgeToken(opts: {
  token: string
  secret: string
  now?: () => number
}): VerifyResult<BridgeTokenPayload> {
  const dot = opts.token.lastIndexOf('.')
  if (dot < 0) return { ok: false, reason: 'malformed' }
  let appId: string
  try {
    const raw = JSON.parse(
      Buffer.from(opts.token.slice(0, dot), 'base64url').toString('utf8'),
    ) as { appId?: unknown }
    if (typeof raw.appId !== 'string') return { ok: false, reason: 'malformed' }
    appId = raw.appId
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // Re-verify with the claimed id — the signature covers it, so a forged id
  // fails the HMAC rather than the binding check.
  return verifyBridgeToken({ ...opts, appId })
}
