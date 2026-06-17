import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ChannelAdapter, IncomingMessage } from '../types.js'
import { createDedupBuffer } from '../dedup.js'

/**
 * Telegram webhook verification.
 * Validates the X-Telegram-Bot-Api-Secret-Token header using constant-time comparison.
 */
export function verifyTelegramWebhook(secretToken: string, headerValue: string | undefined): boolean {
  if (!headerValue) return false
  try {
    const expected = Buffer.from(secretToken, 'utf-8')
    const actual = Buffer.from(headerValue, 'utf-8')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * Creates a webhook handler for Telegram updates.
 *
 * Usage with Express:
 *   const handler = createTelegramWebhookHandler({ adapter, secretToken, onMessage })
 *   app.post('/webhook/telegram', handler.middleware)
 */
export type TelegramWebhookHandlerOptions = {
  adapter: ChannelAdapter & { handleWebhook(payload: unknown): void }
  secretToken?: string
  onMessage: (msg: IncomingMessage) => void
  /**
   * Optional post-verification hook that fires with the raw Telegram
   * update payload BEFORE the adapter consumes it. Used by the API
   * route to inspect for update kinds the adapter does not handle
   * (e.g. `message_reaction` for emoji-feedback wiring). Fired
   * fire-and-forget — errors are swallowed by the wrapper.
   */
  onUpdate?: (payload: unknown) => void | Promise<void>
}

export function createTelegramWebhookHandler(options: TelegramWebhookHandlerOptions) {
  const dedup = createDedupBuffer()

  return {
    /**
     * Express-compatible middleware.
     * Expects body to be parsed as JSON already (express.json()).
     */
    middleware(
      req: { body: unknown; headers: Record<string, string | string[] | undefined> },
      res: { status(code: number): { json(data: unknown): void; end(): void } },
    ): void {
      // Verify secret token if configured
      if (options.secretToken) {
        const header = req.headers['x-telegram-bot-api-secret-token']
        const headerStr = Array.isArray(header) ? header[0] : header
        if (!verifyTelegramWebhook(options.secretToken, headerStr)) {
          res.status(401).json({ error: 'Invalid secret token' })
          return
        }
      }

      const payload = req.body

      // Deduplication
      const dedupId = options.adapter.deduplicateId(payload)
      if (dedupId && dedup.isDuplicate(dedupId)) {
        res.status(200).json({ ok: true })
        return
      }

      // Respond 200 immediately, process async
      res.status(200).json({ ok: true })

      // Surface the raw verified update to the API-side hook (reactions
      // and other non-message updates) before the adapter consumes the
      // payload for its own message-shaped routing.
      if (options.onUpdate) {
        try {
          const out = options.onUpdate(payload)
          if (out && typeof (out as Promise<void>).then === 'function') {
            (out as Promise<void>).catch((err) => {
              console.error('[telegram-webhook] onUpdate failed:', err)
            })
          }
        } catch (err) {
          console.error('[telegram-webhook] onUpdate threw:', err)
        }
      }

      // Delegate to adapter (handles media groups, text fragments, etc.)
      options.adapter.handleWebhook(payload)
    },
  }
}
