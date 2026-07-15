import { describe, it, expect } from 'vitest'
import {
  GATEWAY_INTENTS,
  GatewayOp,
  buildIdentify,
  buildResume,
  buildHeartbeat,
  isFatalCloseCode,
  canResume,
} from '../gateway-protocol.js'

describe('[COMP:channels/discord-connector] gateway protocol', () => {
  it('computes the privileged-message intent bitfield', () => {
    // GUILDS(1) + GUILD_MESSAGES(512) + DIRECT_MESSAGES(4096) + MESSAGE_CONTENT(32768)
    expect(GATEWAY_INTENTS).toBe(37377)
    // MESSAGE_CONTENT (1<<15) must be set, or content arrives empty.
    expect(GATEWAY_INTENTS & (1 << 15)).toBeTruthy()
  })

  it('builds an IDENTIFY with token + intents', () => {
    const p = buildIdentify('tok')
    expect(p.op).toBe(GatewayOp.IDENTIFY)
    expect(p.d).toMatchObject({ token: 'tok', intents: GATEWAY_INTENTS })
  })

  it('builds a RESUME with session + sequence', () => {
    const p = buildResume('tok', 'sess', 42)
    expect(p.op).toBe(GatewayOp.RESUME)
    expect(p.d).toEqual({ token: 'tok', session_id: 'sess', seq: 42 })
  })

  it('builds a HEARTBEAT carrying the last sequence (null-safe)', () => {
    expect(buildHeartbeat(7)).toEqual({ op: GatewayOp.HEARTBEAT, d: 7 })
    expect(buildHeartbeat(null)).toEqual({ op: GatewayOp.HEARTBEAT, d: null })
  })

  it('classifies fatal close codes (no reconnect)', () => {
    expect(isFatalCloseCode(4004)).toBe(true) // bad token
    expect(isFatalCloseCode(4014)).toBe(true) // disallowed intents
    expect(isFatalCloseCode(4000)).toBe(false)
  })

  it('decides resumability from the close code', () => {
    expect(canResume(4000)).toBe(true) // transient
    expect(canResume(undefined)).toBe(true)
    expect(canResume(4009)).toBe(false) // session timed out → fresh identify
    expect(canResume(1000)).toBe(false) // clean close drops the session
    expect(canResume(4004)).toBe(false) // fatal is never resumable
  })
})
