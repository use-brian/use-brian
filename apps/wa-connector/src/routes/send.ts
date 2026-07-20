/**
 * Outbound message endpoint.
 *
 * Ported from OpenClaw `send.ts`. Sends text or media (image / video /
 * document). Media is URL-based: the connector hands the URL to Baileys, which
 * fetches and streams it — no base64 in the request payload, so multi-MB clips
 * are fine.
 *
 * See docs/architecture/channels/whatsapp.md → "Outbound (Use Brian replies)".
 * Component tag: [COMP:wa-connector/send].
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AnyMessageContent } from '@whiskeysockets/baileys'
import type { SocketManager } from '../socket-manager.js'

const mediaSchema = z.object({
  url: z.string().url(),
  type: z.enum(['image', 'video', 'document']),
  mimetype: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  caption: z.string().optional(),
})

export const sendSchema = z
  .object({
    jid: z.string().min(1),
    text: z.string().min(1).optional(),
    media: mediaSchema.optional(),
    quotedMessageId: z.string().optional(),
  })
  .refine((d) => d.text !== undefined || d.media !== undefined, {
    message: 'Either `text` or `media` is required',
  })

export type SendBody = z.infer<typeof sendSchema>

/**
 * Build the Baileys message content from a validated send body. Media is
 * addressed by URL (`{ url }`) so Baileys streams it; text and media are
 * mutually exclusive at the schema level but media wins if both are present.
 * A `quotedMessageId` is attached the same way for both, matching prior
 * behavior.
 */
export function buildSendContent(body: SendBody): AnyMessageContent {
  const { text, media, jid, quotedMessageId } = body

  let content: Record<string, unknown>
  if (media) {
    const caption = media.caption ? { caption: media.caption } : {}
    if (media.type === 'video') {
      content = { video: { url: media.url }, mimetype: media.mimetype ?? 'video/mp4', ...caption }
    } else if (media.type === 'image') {
      content = { image: { url: media.url }, ...caption }
    } else {
      content = {
        document: { url: media.url },
        mimetype: media.mimetype ?? 'application/octet-stream',
        fileName: media.fileName ?? 'file',
        ...caption,
      }
    }
  } else {
    content = { text }
  }

  if (quotedMessageId) {
    content.quoted = { key: { id: quotedMessageId, remoteJid: jid } }
  }

  return content as unknown as AnyMessageContent
}

export function sendRoutes(socketManager: SocketManager): Router {
  const router = Router()

  router.post('/:channelId', async (req, res) => {
    const { channelId } = req.params

    const parsed = sendSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() })
      return
    }

    try {
      const content = buildSendContent(parsed.data)
      const result = await socketManager.send(channelId, parsed.data.jid, content)
      res.json({ messageId: result.messageId })
    } catch (err) {
      console.error(`[send] Failed for ${channelId}:`, err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
