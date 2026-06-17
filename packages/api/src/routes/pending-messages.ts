/**
 * Pending message routes.
 *
 * Mounted at `/api/pending-messages` behind requireAuth.
 *
 * [COMP:api/pending-messages-route]
 *
 *   GET    /                — list pending messages for current user
 *   POST   /:id/resolve     — resolve (approve/reject/edit)
 */

import { Router } from 'express'
import { query } from '../db/client.js'
import type { PendingMessageStore } from '../db/pending-message-store.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import { deliverToChannel } from '../inter-assistant/deliver.js'

type PendingMessageRouteOptions = {
  pendingMessageStore: PendingMessageStore
  integrationStore?: ChannelIntegrationStore
  defaultTelegramBotToken?: string
  waConnectorUrl?: string
  waConnectorSecret?: string
}

export function pendingMessageRoutes({ pendingMessageStore, integrationStore, defaultTelegramBotToken, waConnectorUrl, waConnectorSecret }: PendingMessageRouteOptions): Router {
  const router = Router()

  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const messages = await pendingMessageStore.listForUser(userId)
      res.json({ messages })
    } catch (err) {
      console.error('[pending-messages] list failed:', err)
      res.status(500).json({ error: 'Failed to list pending messages' })
    }
  })

  router.post('/:id/resolve', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { id } = req.params
    const { decision, editedPayload } = req.body as {
      decision?: 'approved' | 'rejected' | 'edited'
      editedPayload?: Record<string, unknown>
    }

    if (!decision || !['approved', 'rejected', 'edited'].includes(decision)) {
      res.status(400).json({ error: 'decision must be "approved", "rejected", or "edited"' })
      return
    }

    if (decision === 'edited' && !editedPayload) {
      res.status(400).json({ error: 'editedPayload is required when decision is "edited"' })
      return
    }

    try {
      const message = await pendingMessageStore.resolve(userId, id, decision, editedPayload)
      if (!message) {
        res.status(404).json({ error: 'Pending message not found or already resolved' })
        return
      }

      if (message.messageType === 'ask_confirmation' && (decision === 'approved' || decision === 'edited')) {
        const payload = message.payload as {
          question?: string
          draftResponse?: string
          callerAssistantId?: string
          callerSessionId?: string
          callerChannelType?: string
          callerChannelId?: string
        }

        const callerAssistantId = payload.callerAssistantId
        if (callerAssistantId) {
          const callerOwner = await query<{ ownerUserId: string }>(
            `SELECT owner_user_id AS "ownerUserId" FROM assistants WHERE id = $1`,
            [callerAssistantId],
          )

          if (callerOwner.rows[0]) {
            const responseText = decision === 'edited' && editedPayload
              ? (editedPayload as { response?: string }).response ?? (message.payload as { draftResponse?: string }).draftResponse ?? ''
              : (message.payload as { draftResponse?: string }).draftResponse ?? ''

            const sourceAssistant = await query<{ name: string }>(
              `SELECT name FROM assistants WHERE id = $1`,
              [message.targetAssistantId],
            )
            const sourceName = sourceAssistant.rows[0]?.name ?? 'An assistant'

            await pendingMessageStore.create({
              targetAssistantId: callerAssistantId,
              targetUserId: callerOwner.rows[0].ownerUserId,
              sourceAssistantId: message.targetAssistantId,
              messageType: 'async_response',
              category: message.category ?? undefined,
              payload: { question: payload.question, response: responseText },
            })

            const deliveryText = `${sourceName} approved your ${message.category ?? 'data'} request. Here's what they shared:\n\n${
              responseText.startsWith('{') ? formatJsonResponse(responseText, message.category) : responseText
            }`

            deliverToChannel({
              assistantId: callerAssistantId,
              userId: callerOwner.rows[0].ownerUserId,
              text: deliveryText,
              sessionId: payload.callerSessionId,
              channelType: payload.callerChannelType,
              channelId: payload.callerChannelId,
              integrationStore,
              defaultTelegramBotToken,
              waConnectorUrl,
              waConnectorSecret,
            }).catch((err) => console.error('[pending-messages] delivery failed:', err))
          }
        }
      }

      res.json(message)
    } catch (err) {
      console.error('[pending-messages] resolve failed:', err)
      res.status(500).json({ error: 'Failed to resolve pending message' })
    }
  })

  return router
}

function formatJsonResponse(json: string, category: string | null): string {
  try {
    const data = JSON.parse(json)
    if (category === 'tasks' && data.jobs) {
      const active = (data.jobs as Array<{ instructions: string; enabled: boolean }>).filter((j) => j.enabled)
      return active.length > 0 ? active.map((j) => `• ${j.instructions}`).join('\n') : 'No active tasks.'
    }
    if (category === 'knowledge' && data.entries) {
      return (data.entries as Array<{ title: string; summary?: string }>)
        .map((e) => `• ${e.title}${e.summary ? ` — ${e.summary}` : ''}`).join('\n')
    }
    if (category === 'memories' && data.memories) {
      return (data.memories as Array<{ summary: string }>).map((m) => `• ${m.summary}`).join('\n')
    }
    return json.slice(0, 500)
  } catch { return json.slice(0, 500) }
}
