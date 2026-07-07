/**
 * File-preview capability tokens — OPEN, pure HMAC.
 *
 * A short-lived, file-scoped signature that authorizes an *unauthenticated*
 * `GET /api/files/:id/preview` to serve exactly one `file_cache` row's bytes.
 *
 * Why signed URLs and not an auth gate: the preview is consumed via a
 * cross-origin `<img src>` / download anchor (the API lives on a different
 * origin from the app). The `access_token` cookie is `SameSite=Lax`, which
 * browsers do NOT send on cross-site subresource requests, so requiring the
 * cookie would break inline doc image rendering. Instead an *authorized*
 * viewer mints a signature server-side (the mint route runs the access-scoped
 * `fileStore.get(id, ctx)` gate), and `/preview` verifies signature + expiry +
 * audience + file-id binding — no cookie needed, so `<img>` still loads.
 * This closes the IDOR: a bare `file_cache` UUID no longer retrieves content;
 * a valid, unexpired, id-bound signature is required (WS3 #8).
 *
 * The HMAC secret reuses `JWT_SECRET` — there is exactly one server-side
 * signing secret in this codebase (see `brain-mcp/oauth/codes.ts`), and adding
 * a second would just be a rotation footgun. Same compact
 * `<base64url-payload>.<base64url-sig>` shape as the media capability token
 * (`packages/api-platform/src/media-token.ts`), and the audience claim pins the
 * signature to the preview endpoint so it can't be confused with any other
 * `{...}` token sharing the secret.
 *
 * See docs/architecture/features/files.md → "Signed preview capability URLs".
 *
 * [COMP:api/file-preview-token]
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Audience claim — pins the token to the file-preview endpoint. */
export const FILE_PREVIEW_TOKEN_AUD = 'file-preview' as const

export type FilePreviewTokenPayload = {
  /** The `file_cache` row id this signature unlocks. Bound so a sig for one
   * file can't be replayed against another. */
  fid: string
  /** Always `'file-preview'` — verify rejects anything else. */
  aud: typeof FILE_PREVIEW_TOKEN_AUD
  /** Unix ms. Verify rejects tokens past expiry. */
  exp: number
}

export type MintFilePreviewTokenOptions = {
  /** The `file_cache` id to scope the token to. */
  fid: string
  /** TTL in ms. The browser fetches promptly on render, so keep this short. */
  ttlMs: number
  secret: string
  /** Override `now` for tests. */
  now?: () => number
}

/** Returns a compact `<base64url-payload>.<base64url-sig>` token. */
export function mintFilePreviewToken(opts: MintFilePreviewTokenOptions): string {
  const now = opts.now ? opts.now() : Date.now()
  const payload: FilePreviewTokenPayload = {
    fid: opts.fid,
    aud: FILE_PREVIEW_TOKEN_AUD,
    exp: now + opts.ttlMs,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', opts.secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

export type VerifyFilePreviewTokenOptions = {
  token: string
  /** The `:id` route param — the signature must be bound to exactly this file. */
  fid: string
  secret: string
  /** Override `now` for tests. */
  now?: () => number
}

export type FilePreviewTokenFailure =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-audience'
  | 'wrong-file'
  | 'expired'

export type VerifyFilePreviewTokenResult =
  | { ok: true; payload: FilePreviewTokenPayload }
  | { ok: false; reason: FilePreviewTokenFailure }

/**
 * Verify a file-preview capability token against the requested file id.
 * Returns `{ok:false, reason}` — never throws — so the caller can 403 without
 * leaking a stack trace. Checks, in order: structural shape, HMAC signature
 * (constant-time), audience, file-id binding, then expiry.
 */
export function verifyFilePreviewToken(
  opts: VerifyFilePreviewTokenOptions,
): VerifyFilePreviewTokenResult {
  const now = opts.now ? opts.now() : Date.now()
  const dot = opts.token.lastIndexOf('.')
  if (dot < 0) return { ok: false, reason: 'malformed' }

  const encoded = opts.token.slice(0, dot)
  const providedSig = opts.token.slice(dot + 1)
  const expectedSig = createHmac('sha256', opts.secret).update(encoded).digest('base64url')
  // Length-guard before timingSafeEqual (it throws on unequal-length buffers);
  // an early length mismatch is itself a bad signature.
  if (providedSig.length !== expectedSig.length) return { ok: false, reason: 'bad-signature' }
  if (!timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))) {
    return { ok: false, reason: 'bad-signature' }
  }

  let payload: FilePreviewTokenPayload
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    payload = JSON.parse(json) as FilePreviewTokenPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (typeof payload.fid !== 'string' || payload.fid.length === 0) {
    return { ok: false, reason: 'malformed' }
  }
  if (payload.aud !== FILE_PREVIEW_TOKEN_AUD) {
    return { ok: false, reason: 'wrong-audience' }
  }
  // File-id binding: reject a signature minted for a different row even if its
  // own signature/audience/expiry are valid (replay across ids).
  if (payload.fid !== opts.fid) {
    return { ok: false, reason: 'wrong-file' }
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, payload }
}
