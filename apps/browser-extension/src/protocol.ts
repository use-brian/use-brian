/**
 * Extension side of the relay wire protocol (P1.2). Mirror image of
 * apps/browser-relay/src/protocol.ts — keep in sync (the relay
 * zod-validates every inbound frame; the extension validates shape-lite
 * here because it ships without zod).
 */

type HelloMessage = { type: 'hello'; pairingToken: string }
type ResultMessage = {
  type: 'result'
  id: string
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}
type EventKind = 'stopped' | 'tab_closed' | 'detached'
type EventMessage = { type: 'event'; kind: EventKind }
type PingMessage = { type: 'ping' }
export type ExtensionToRelay = HelloMessage | ResultMessage | EventMessage | PingMessage

type ReadyMessage = { type: 'ready'; sessionToken?: string }
type CommandMessage = { type: 'command'; id: string; op: string; args: Record<string, unknown> }
type PongMessage = { type: 'pong' }
type ErrorMessage = { type: 'error'; message: string }
export type RelayToExtension = ReadyMessage | CommandMessage | PongMessage | ErrorMessage

export function parseRelayMessage(raw: unknown): RelayToExtension | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const type = (parsed as { type?: unknown }).type
  if (type === 'ready' || type === 'pong' || type === 'error') return parsed as RelayToExtension
  if (type === 'command') {
    const c = parsed as CommandMessage
    if (typeof c.id === 'string' && typeof c.op === 'string') {
      return { type: 'command', id: c.id, op: c.op, args: c.args ?? {} }
    }
  }
  return null
}
