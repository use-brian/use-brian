/**
 * Discord Gateway (v10) protocol constants and pure payload builders.
 *
 * Kept free of socket/IO state so they can be unit-tested. The stateful
 * connection lifecycle (heartbeat loop, resume, reconnect) lives in
 * `gateway-manager.ts`. See docs/architecture/channels/discord.md →
 * "Receiving transports".
 */

export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/** Gateway opcodes we handle (https://discord.com/developers/docs/topics/gateway). */
export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

/**
 * Intents required to receive chat. `MESSAGE_CONTENT` (1<<15) is **privileged**
 * and must be enabled in the Developer Portal, or the gateway closes with 4014.
 *   GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)
 */
export const GATEWAY_INTENTS =
  (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15) // = 37377

export type GatewayPayload = {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

export function buildIdentify(token: string): GatewayPayload {
  return {
    op: GatewayOp.IDENTIFY,
    d: {
      token,
      intents: GATEWAY_INTENTS,
      properties: { os: 'linux', browser: 'Use Brian', device: 'sidanclaw-discord-connector' },
    },
  }
}

export function buildResume(token: string, sessionId: string, seq: number | null): GatewayPayload {
  return { op: GatewayOp.RESUME, d: { token, session_id: sessionId, seq } }
}

export function buildHeartbeat(seq: number | null): GatewayPayload {
  return { op: GatewayOp.HEARTBEAT, d: seq }
}

/**
 * Gateway close codes that are **fatal** — reconnecting would just fail the same
 * way, so the connection is torn down and surfaced as an error instead of
 * looping. Everything else is treated as transient (reconnect/resume).
 * https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes
 */
const FATAL_CLOSE_CODES = new Set([
  4004, // authentication failed (bad token)
  4010, // invalid shard
  4011, // sharding required
  4012, // invalid API version
  4013, // invalid intents
  4014, // disallowed intents (MESSAGE_CONTENT not enabled in the portal)
])

export function isFatalCloseCode(code: number): boolean {
  return FATAL_CLOSE_CODES.has(code)
}

/**
 * Close codes after which Discord will NOT let us RESUME — we must start a fresh
 * IDENTIFY. 4007 (invalid seq) and 4009 (session timed out) invalidate the
 * session; a clean 1000/1001 close also drops it.
 */
const NON_RESUMABLE_CLOSE_CODES = new Set([1000, 1001, 4007, 4009])

export function canResume(code: number | undefined): boolean {
  if (code == null) return true
  return !NON_RESUMABLE_CLOSE_CODES.has(code) && !isFatalCloseCode(code)
}
