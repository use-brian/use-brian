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
  /**
   * The extension's source fingerprint (`dist/build-info.json`). Optional
   * because every extension built before the stamp existed omits it — and
   * those are precisely the installs worth flagging, so absence is a value
   * here, not a gap. `z.object` is non-strict, so an old relay meeting a new
   * extension simply drops the field instead of rejecting the frame.
   */
  build: z.string().max(64).optional(),
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

type ReadyMessage = { type: 'ready'; sessionToken?: string; staleBuild?: boolean }
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

/**
 * The RelayCommandResult shape the api's transport port expects.
 *
 * `staleBuild` rides only on failures, and only as context: it says "the
 * extension that produced this failure is out of date", never what failed. The
 * api side appends a remedy to the message so the assistant has something to
 * tell the user besides the failure itself.
 */
export type InternalCommandResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; code?: string; staleBuild?: boolean }
