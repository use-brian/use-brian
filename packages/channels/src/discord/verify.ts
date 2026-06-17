import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/**
 * Discord interaction webhook verification (Ed25519).
 *
 * When Discord delivers an Interaction over HTTP, it signs each request with
 * the application's Ed25519 key. Two headers carry the proof:
 *   - `X-Signature-Ed25519`   — hex-encoded 64-byte signature
 *   - `X-Signature-Timestamp` — the timestamp that was prepended to the body
 *
 * The signed message is `timestamp + rawBody` (UTF-8). An invalid signature
 * MUST be rejected with HTTP 401, or Discord will refuse to register the
 * endpoint. See docs/architecture/channels/discord.md § "Interaction verification".
 *
 * Gateway (WebSocket) delivery is authenticated by the bot token at connect
 * time and carries no per-message signature, so this is only for the HTTP
 * Interactions transport.
 *
 * Implemented with Node's built-in `crypto` (no `tweetnacl` dependency): a raw
 * 32-byte Ed25519 public key is wrapped in its fixed SPKI/DER prefix so
 * `createPublicKey` accepts it, then `crypto.verify(null, …)` does the one-shot
 * Ed25519 check.
 */

// The fixed ASN.1 SPKI prefix for an Ed25519 public key (RFC 8410). Prepending
// it to the raw 32-byte key yields a DER document `createPublicKey` understands.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function verifyDiscordSignature(params: {
  /** Application public key (hex, 32 bytes) from the Developer Portal. */
  publicKey: string
  /** `X-Signature-Ed25519` header value (hex, 64 bytes). */
  signature: string | undefined
  /** `X-Signature-Timestamp` header value. */
  timestamp: string | undefined
  /** Raw request body, exactly as received (pre-JSON-parse). */
  body: string
}): boolean {
  const { publicKey, signature, timestamp, body } = params
  if (!signature || !timestamp) return false

  const sigBytes = Buffer.from(signature, 'hex')
  const keyBytes = Buffer.from(publicKey, 'hex')
  // Buffer.from(hex) silently drops invalid/odd input — length check catches it.
  if (sigBytes.length !== 64 || keyBytes.length !== 32) return false

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: 'der',
      type: 'spki',
    })
    return cryptoVerify(null, Buffer.from(`${timestamp}${body}`, 'utf-8'), key, sigBytes)
  } catch {
    return false
  }
}

/** Discord interaction `type` values we care about at the transport edge. */
export const DISCORD_INTERACTION_PING = 1
export const DISCORD_INTERACTION_APPLICATION_COMMAND = 2

/** True when the payload is Discord's endpoint health-check PING (type 1). */
export function isPingInteraction(payload: unknown): boolean {
  return (payload as { type?: number } | null)?.type === DISCORD_INTERACTION_PING
}

/**
 * The body a route must return to a PING — `{ type: 1 }` (PONG). Exported so
 * the future HTTP-interactions route doesn't re-encode the magic number.
 */
export const DISCORD_PONG = { type: DISCORD_INTERACTION_PING } as const
