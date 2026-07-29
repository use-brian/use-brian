import { z } from 'zod'

/**
 * Extension ↔ relay wire protocol (P1.2 / computer-use.md §4): JSON envelopes
 * over one WebSocket per extension. The extension is the executor; the relay
 * only routes. Mirror image lives in apps/browser-extension/src/protocol.ts —
 * keep the two in sync (the relay zod-validates every inbound frame, so drift
 * fails loud, not silent).
 *
 *   ext → relay : hello{pairingToken} · result{id,ok,data|error,code?} ·
 *                 event{kind} · ping
 *   relay → ext : ready · command{id,op,args} · pong · error{message}
 */

// ── Extension → relay ──────────────────────────────────────────

const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  pairingToken: z.string().min(1),
})

const ResultMessageSchema = z.object({
  type: z.literal('result'),
  id: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  /** BrowserBackendErrorCode-compatible short code (stopped, tab_closed, stale_ref …). */
  code: z.string().optional(),
})

const EVENT_KINDS = ['stopped', 'tab_closed', 'detached'] as const

const EventMessageSchema = z.object({
  type: z.literal('event'),
  kind: z.enum(EVENT_KINDS),
})

const PingMessageSchema = z.object({ type: z.literal('ping') })

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  ResultMessageSchema,
  EventMessageSchema,
  PingMessageSchema,
])
type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>

// ── Relay → extension ──────────────────────────────────────────

type ReadyMessage = { type: 'ready'; sessionToken?: string }
type CommandMessage = { type: 'command'; id: string; op: string; args: Record<string, unknown> }
type PongMessage = { type: 'pong' }
type ErrorMessage = { type: 'error'; message: string }
export type RelayToExtensionMessage = ReadyMessage | CommandMessage | PongMessage | ErrorMessage

// ── Internal command API (api → relay) ─────────────────────────

export const InternalCommandRequestSchema = z.object({
  userId: z.string().min(1),
  op: z.string().min(1),
  args: z.record(z.unknown()).optional(),
})
type InternalCommandRequest = z.infer<typeof InternalCommandRequestSchema>

/** The RelayCommandResult shape the api's transport port expects. */
export type InternalCommandResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; code?: string }
