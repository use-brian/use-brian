/**
 * Per-assistant connector grants — shared OSS + hosted REST surface.
 *
 * The store, runtime gate, and app-web governance control are all open-core,
 * so this route is mounted by `bootOpenApi` for both editions. Keeping it in a
 * hosted-only package makes the OSS Granted control PATCH a 404 and bounce
 * back after its empty-list refetch.
 *
 * [COMP:api/assistant-connector-grants-route]
 */

import { Router } from 'express'
import { resolveAssistantAccess } from '../db/users.js'
import type { AssistantConnectorGrantsStore } from '../db/assistant-connector-grants-store.js'

type Options = {
  store: AssistantConnectorGrantsStore
}

type AssistantParams = { assistantId: string }
type GrantParams = { assistantId: string; connectorId: string }

export function assistantConnectorGrantsRoutes(options: Options): Router {
  const router = Router()

  async function verifyMembership(
    req: { userId?: string; params: AssistantParams },
    res: import('express').Response,
  ): Promise<{ userId: string } | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const access = await resolveAssistantAccess(userId, req.params.assistantId)
    if (!access) {
      res.status(403).json({ error: 'Not a member of this assistant' })
      return null
    }
    return { userId }
  }

  router.get<AssistantParams>('/:assistantId', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    try {
      const grants = await options.store.listForAssistant(member.userId, req.params.assistantId)
      res.json({ grants })
    } catch (err) {
      console.error('[assistant-connector-grants] list failed:', err)
      res.status(500).json({ error: 'Failed to list grants' })
    }
  })

  router.patch<GrantParams>('/:assistantId/:connectorId', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    const { assistantId, connectorId } = req.params
    const body = req.body as {
      readAllowed?: unknown
      allowedActions?: unknown
    }

    const readAllowed = typeof body.readAllowed === 'boolean' ? body.readAllowed : true
    const allowedActions = Array.isArray(body.allowedActions)
      ? body.allowedActions.filter((action): action is string => typeof action === 'string')
      : null

    if (allowedActions === null) {
      res.status(400).json({ error: 'allowedActions must be a string array' })
      return
    }

    try {
      const grant = await options.store.upsert(member.userId, {
        assistantId,
        connectorId,
        readAllowed,
        allowedActions,
      })
      res.json({ grant })
    } catch (err) {
      console.error('[assistant-connector-grants] upsert failed:', err)
      res.status(500).json({ error: 'Failed to update grant' })
    }
  })

  router.delete<GrantParams>('/:assistantId/:connectorId', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    const { assistantId, connectorId } = req.params
    try {
      const removed = await options.store.delete(member.userId, assistantId, connectorId)
      res.json({ ok: true, removed })
    } catch (err) {
      console.error('[assistant-connector-grants] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete grant' })
    }
  })

  return router
}
