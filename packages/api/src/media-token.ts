/**
 * Media capability tokens for the internal media-fetch endpoint.
 *
 * A short-lived, user-scoped bearer token that authorizes a caller to fetch
 * exactly one user's most recent channel-media recording via
 * `GET /internal/media/latest` (`packages/api-platform/src/routes/media.ts`).
 *
 * Use Brian mints the token per turn (channel pipeline) and pushes it to a
 * custom MCP connector — only ones the user granted media access — over the
 * reserved `X-Sidanclaw-Media-Token` header. The connector echoes it back as
 * `Authorization: Bearer <token>`; the endpoint verifies signature + expiry +
 * audience and derives the target user from `sub`. The user identity is thus a
 * *signed claim*, never a request param, so a token only ever unlocks the media
 * of the user it was minted for — and no long-lived shared secret is ever handed
 * to the MCP operator.
 *
 * Prompt-compromise in the model cannot forge a token: it lacks the HMAC secret,
 * and the header lives in the reserved namespace the model/user config can't set.
 *
 * See docs/architecture/media/internal-media-fetch.md.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Audience claim — pins the token to the media endpoint so it can't be confused
 * with any other `{sub,...}` token that shares the HMAC secret. */
export const MEDIA_TOKEN_AUD = 'media' as const

export type MediaTokenPayload = {
  /** The Use Brian user UUID whose media this token unlocks (`created_by_user_id`). */
  sub: string
  /** Always `'media'` — verify rejects anything else. */
  aud: typeof MEDIA_TOKEN_AUD
  /** Unix ms. Verify rejects tokens past expiry. */
  exp: number
  /**
   * Optional: pin the token to ONE specific recording episode. When set, the
   * media endpoint resolves exactly this episode (still scoped to `sub`) instead
   * of the user's most recent recording. A WhatsApp video auto-turn sets this to
   * the episode it fired for, so the tool acts on THAT video even if a newer one
   * has since arrived. Absent (interactive chat, older tokens) ⇒ latest.
   */
  episodeId?: string
}

export type MintMediaTokenOptions = {
  /** The user UUID to scope the token to. */
  sub: string
  /** TTL in ms. The MCP fetches synchronously during the tool call, so keep this short. */
  ttlMs: number
  secret: string
  /** Optional: pin the token to one specific recording episode (see `MediaTokenPayload.episodeId`). */
  episodeId?: string
  /** Override `now` for tests. */
  now?: () => number
}

function signPayload(payload: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Returns a compact `<base64url-payload>.<base64url-sig>` token. */
export function mintMediaToken(opts: MintMediaTokenOptions): string {
  const now = opts.now ? opts.now() : Date.now()
  const payload: MediaTokenPayload = {
    sub: opts.sub,
    aud: MEDIA_TOKEN_AUD,
    exp: now + opts.ttlMs,
    ...(opts.episodeId ? { episodeId: opts.episodeId } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signPayload(encoded, opts.secret)
}

export type VerifyMediaTokenOptions = {
  token: string
  secret: string
  /** Override `now` for tests. */
  now?: () => number
}

export type MediaTokenFailure = 'malformed' | 'bad-signature' | 'wrong-audience' | 'expired'

export type VerifyMediaTokenResult =
  | { ok: true; payload: MediaTokenPayload }
  | { ok: false; reason: MediaTokenFailure }

/**
 * Verify a media capability token. Returns `{ok:false, reason}` — never throws —
 * so the caller can 401 without leaking a stack trace. Checks, in order:
 * structural shape, HMAC signature (constant-time), audience, then expiry.
 */
export function verifyMediaToken(opts: VerifyMediaTokenOptions): VerifyMediaTokenResult {
  const now = opts.now ? opts.now() : Date.now()
  const dot = opts.token.lastIndexOf('.')
  if (dot < 0) return { ok: false, reason: 'malformed' }

  const encoded = opts.token.slice(0, dot)
  const providedSig = opts.token.slice(dot + 1)
  const expectedSig = createHmac('sha256', opts.secret).update(encoded).digest('base64url')
  if (providedSig.length !== expectedSig.length) return { ok: false, reason: 'bad-signature' }
  if (!timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))) {
    return { ok: false, reason: 'bad-signature' }
  }

  let payload: MediaTokenPayload
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    payload = JSON.parse(json) as MediaTokenPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'malformed' }
  }
  if (payload.aud !== MEDIA_TOKEN_AUD) {
    return { ok: false, reason: 'wrong-audience' }
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, payload }
}

// ── Late-bound signing secret (channels open-core move) ─────────────────────
// The open channel pipeline mints actor media tokens but owns no env; the boot
// that validated JWT_SECRET binds it here once (the page-event-fanout pattern).
// Unset ⇒ `mintActorMediaToken` returns null and the actor identity ships
// without a media token — additive, never blocks a turn.

let boundSecret: string | null = null

export function setMediaTokenSecret(secret: string): void {
  boundSecret = secret
}

export function mintActorMediaToken(opts: Omit<MintMediaTokenOptions, 'secret'>): string | null {
  if (!boundSecret) return null
  return mintMediaToken({ ...opts, secret: boundSecret })
}
