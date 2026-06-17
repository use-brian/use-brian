/**
 * Approval tokens for `threadsReplyToPost`.
 *
 * A reply is only eligible to post when the caller presents a token that
 * binds the assistant, the target reply, and the *exact* text the team
 * approved. Prompt-compromise in the assistant cannot produce a valid
 * token because it lacks the HMAC secret; the token also binds the text
 * so a compromised assistant can't post alternative text under a token
 * minted for a different draft.
 *
 * Tokens are short-lived (default 30 minutes). The pipeline mints them
 * for auto-whitelisted patterns with a shorter TTL; the UI approval flow
 * (2D) mints them for human-approved drafts. Both call paths go through
 * the same sign/verify here.
 *
 * See docs/architecture/feed/defense-pipeline.md.
 */

import { createHmac, timingSafeEqual, createHash, randomBytes } from 'node:crypto'

export type ApprovalTokenPayload = {
  assistantId: string
  /** The platform reply id we're responding to (or post id for top-level reply). */
  replyToId: string
  /** SHA-256 of the approved text. Binds the token to exactly what was approved. */
  textHash: string
  /** Nonce, 16 bytes hex — prevents accidental reuse across concurrent drafts. */
  nonce: string
  /** Unix ms. Tool rejects tokens past expiry. */
  expiresAt: number
  /**
   * Provenance of the approval, surfaced in the audit log:
   * - 'auto'  — pipeline-minted (defense pipeline auto-whitelist).
   * - 'human' — UI-approved (drafts queue / approvals endpoint).
   * - 'chat'  — chat confirmation card approved by an admin from the
   *             tuning chat. The card shows exact (replyToId, text) and
   *             the engine re-runs the same locked input on approval, so
   *             the chat click carries the same authorization weight as a
   *             UI approval.
   */
  source: 'auto' | 'human' | 'chat'
}

export type ApprovalTokenMintOptions = {
  assistantId: string
  replyToId: string
  text: string
  source: 'auto' | 'human' | 'chat'
  /** TTL in ms. Defaults to 30 minutes. Auto-minted tokens should use a shorter value (e.g. 60s). */
  ttlMs?: number
  secret: string
  /** Override `now` for tests. */
  now?: () => number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000

/** Compute the text hash used in the token — exported for test assertion. */
export function hashApprovalText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function signPayload(payload: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Returns a compact `<base64url-payload>.<base64url-sig>` token. */
export function mintApprovalToken(opts: ApprovalTokenMintOptions): string {
  const now = opts.now ? opts.now() : Date.now()
  const payload: ApprovalTokenPayload = {
    assistantId: opts.assistantId,
    replyToId: opts.replyToId,
    textHash: hashApprovalText(opts.text),
    nonce: randomBytes(16).toString('hex'),
    expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    source: opts.source,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signPayload(encoded, opts.secret)
}

export type ApprovalTokenVerifyOptions = {
  token: string
  /** Must match the assistant the tool is acting for. */
  expectedAssistantId: string
  /** Must match the target reply id. */
  expectedReplyToId: string
  /** Must exactly match the text the assistant is about to post — guards against text-swap attacks. */
  text: string
  secret: string
  /** Override `now` for tests. */
  now?: () => number
}

export type ApprovalTokenVerifyResult =
  | { ok: true; payload: ApprovalTokenPayload }
  | { ok: false; reason: ApprovalTokenFailure }

export type ApprovalTokenFailure =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-assistant'
  | 'wrong-reply-target'
  | 'text-mismatch'
  | 'expired'

/**
 * Verify an approval token. Returns {ok:false, reason} — never throws —
 * so the tool can log the exact failure without leaking a stack trace
 * into the audit log.
 */
export function verifyApprovalToken(opts: ApprovalTokenVerifyOptions): ApprovalTokenVerifyResult {
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

  let payload: ApprovalTokenPayload
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    payload = JSON.parse(json) as ApprovalTokenPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (payload.assistantId !== opts.expectedAssistantId) {
    return { ok: false, reason: 'wrong-assistant' }
  }
  if (payload.replyToId !== opts.expectedReplyToId) {
    return { ok: false, reason: 'wrong-reply-target' }
  }
  if (payload.textHash !== hashApprovalText(opts.text)) {
    return { ok: false, reason: 'text-mismatch' }
  }
  if (payload.expiresAt < now) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, payload }
}
