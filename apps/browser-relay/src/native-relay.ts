import { z } from 'zod'
import { ClientMessageSchema, CommandSchema, GrantSchema, sameIdentity, sameTarget, parseMessage, type NativeGrant, type NativeCommand, type NativeReceipt, type NativeStatus } from '@use-brian/computer-control/protocol.js'
import type { NativeTokenClaims } from '@use-brian/api/auth/native-computer-token.js'
import type { RelaySocket } from './relay.js'
export const NativeReleaseRequestSchema = z.object({ reason: z.literal('released') }).strict()
type Entry = { uncertain?: boolean; grant: NativeGrant; jti: string; socket?: RelaySocket; status?: NativeStatus; seen: number; used: Set<string>; pending?: { command: NativeCommand; resolve: (r: NativeReceipt) => void; timer: NodeJS.Timeout } }
/** Single-instance registry. Registration is mandatory: signatures alone never authorize reconnect. */
export class NativeRelay {
  private sessions = new Map<string, Entry>()
  constructor(private verify: (token: string) => NativeTokenClaims | null) {}
  register(grant: NativeGrant, jti: string): void {
    GrantSchema.parse(grant)
    this.sweep()
    if (grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 900_000 || this.sessions.has(grant.identity.sessionId)) throw new Error('Invalid lease')
    for (const e of this.sessions.values()) if (e.grant.identity.deviceId === grant.identity.deviceId) throw new Error('Device busy')
    this.sessions.set(grant.identity.sessionId, { grant, jti, seen: Date.now(), used: new Set() })
  }
  status(id: string) { const e = this.sessions.get(id); return { connected: !!e?.socket, active: !!e, expiresAt: e?.grant.expiresAt, status: e?.status } }
  revoke(id: string, reason?: 'released'): void {
    const e = this.sessions.get(id); if (!e) return
    // API intent is necessary but not sufficient: independently prove an idle,
    // live profile lease with an exact active desktop status and no unknown receipt.
    const released = reason === 'released' && 'profileId' in e.grant.identity && !!e.socket && !e.pending && !e.uncertain &&
      e.status?.state === 'active' && !!e.status.identity && sameIdentity(e.status.identity, e.grant.identity) &&
      e.status.epoch === e.grant.epoch && e.grant.expiresAt > Date.now() && Date.now() - e.seen <= 30_000
    this.sessions.delete(id)
    if (e.pending) { clearTimeout(e.pending.timer); e.pending.resolve({ commandId: e.pending.command.commandId, outcome: 'execution_unknown', code: 'transport_error' }) }
    try { e.socket?.send(JSON.stringify({ type: 'revoke', ...(released ? { reason: 'released' } : {}) })); e.socket?.close(4401, 'revoked') } catch { /* closed */ }
  }
  disconnect(socket: RelaySocket): void { for (const [id,e] of this.sessions) if (e.socket === socket) this.revoke(id) }
  handle(socket: RelaySocket, raw: string): void {
    try {
      const msg = ClientMessageSchema.parse(parseMessage(raw))
      let e = [...this.sessions.values()].find(e => e.socket === socket)
      if (msg.type === 'hello') {
        if (e) throw new Error('Repeated hello')
        const c = this.verify(msg.token)
        e = c ? this.sessions.get(c.identity.sessionId) : undefined
        if (!c || !e || e.socket || c.jti !== e.jti || c.exp !== e.grant.expiresAt || c.grantId !== e.grant.grantId || c.epoch !== e.grant.epoch || !sameIdentity(c.identity,e.grant.identity)) throw new Error('Unauthorized')
        e.socket = socket
        socket.send(JSON.stringify({ type: 'ready', identity: e.grant.identity }))
      } else {
        if (!e || e.grant.expiresAt <= Date.now()) throw new Error('Expired')
        if (msg.type === 'status') {
          if (!msg.status.identity || !sameIdentity(msg.status.identity,e.grant.identity) || msg.status.epoch !== e.grant.epoch || msg.status.state !== 'active') throw new Error('Stopped or wrong identity')
          e.status = msg.status
        }
        if (msg.type === 'receipt') {
          const p = e.pending
          if (!p || p.command.deadlineAt <= Date.now() || msg.receipt.commandId !== p.command.commandId) throw new Error('Wrong receipt')
          const o = msg.receipt.observation
          if (o && (!sameIdentity(o.identity,e.grant.identity) || o.epoch !== e.grant.epoch || !sameTarget(o.target,p.command.action.target))) throw new Error('Wrong observation')
          if (msg.receipt.outcome === 'execution_unknown' || ['transport_error', 'helper_error', 'stopped', 'expired'].includes(msg.receipt.code)) e.uncertain = true
          clearTimeout(p.timer); e.pending = undefined; p.resolve(msg.receipt)
        }
      }
      e.seen = Date.now()
    } catch { this.disconnect(socket); socket.close(4401, 'Invalid native message') }
  }
  async dispatch(raw: unknown): Promise<NativeReceipt> {
    const c = CommandSchema.parse(raw); const e = this.sessions.get(c.identity.sessionId)
    const denied: NativeReceipt = { commandId: c.commandId, outcome: 'not_executed', code: 'denied' }
    if (!e?.socket || e.pending || e.used.has(c.commandId) || e.used.size >= 1000 || !sameIdentity(c.identity,e.grant.identity) || c.epoch !== e.grant.epoch || c.grantId !== e.grant.grantId || c.deadlineAt <= Date.now() || c.deadlineAt > Math.min(Date.now()+30_000,e.grant.expiresAt) || Date.now()-e.seen > 30_000 || !e.grant.targets.some(t => sameTarget(t,c.action.target)) || (c.action.kind === 'capture' ? !e.grant.allowCapture : c.action.kind !== 'observe' && !e.grant.allowControl)) return denied
    e.used.add(c.commandId)
    return new Promise(resolve => {
      const timer = setTimeout(() => this.revoke(c.identity.sessionId), c.deadlineAt-Date.now())
      e.pending = { command: c, resolve, timer }
      try { e.socket!.send(JSON.stringify({ type: 'command', command: c })) } catch { this.revoke(c.identity.sessionId) }
    })
  }
  sweep() { for (const [id,e] of this.sessions) if (Date.now() >= e.grant.expiresAt || Date.now()-e.seen > 30_000) this.revoke(id) }
}
