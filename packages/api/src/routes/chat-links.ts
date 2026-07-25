/**
 * Chat-link manage routes — mint/list/revoke the public chat links for
 * an assistant. Spec: docs/architecture/features/public-chat-link.md.
 *
 * Mounted at `/api/assistants/:assistantId/chat-links` behind requireAuth
 * in the OPEN boot (both editions get it — deliberately not forked into
 * the closed integrations router, so there is no route-parity risk).
 *
 *   GET    /            — list links (active + revoked)
 *   POST   /            — mint a link (label?, dailyMessageLimit?)
 *   DELETE /:linkId     — revoke
 *
 * Authorization: assistant owner OR workspace admin/owner — the same
 * split `assistants.ts` uses for clearance changes. Exposing an
 * assistant to the anonymous public is a team-governance action, not
 * a member-level one.
 *
 * [COMP:api/chat-links-route]
 */

import { Router } from 'express'
import { z } from 'zod'
import { resolveAssistantAccess } from '../db/users.js'
import type { ChatLinkStore } from '../db/chat-link-store.js'

export type ChatLinkRouteOptions = {
  chatLinkStore: ChatLinkStore
}

/**
 * Owner-or-admin gate via **the** assistant access predicate
 * (`resolveAssistantAccess` — effective role across direct membership
 * and workspace membership). Exposing an assistant to the anonymous
 * public is a governance action, so plain members are 403'd.
 */
async function requireOwnerOrAdmin(
  userId: string,
  assistantId: string,
  res: import('express').Response,
): Promise<boolean> {
  const access = await resolveAssistantAccess(userId, assistantId)
  if (!access || (access.role !== 'owner' && access.role !== 'admin')) {
    res.status(403).json({ error: 'Only the assistant owner or a workspace admin can manage chat links' })
    return false
  }
  return true
}

const createSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  /** 0 = unlimited. Default 200/day. */
  dailyMessageLimit: z.number().int().min(0).max(100_000).optional(),
}).strict()

export function chatLinkRoutes({ chatLinkStore }: ChatLinkRouteOptions): Router {
  // The assistantId param lives on the parent mount path.
  const router = Router({ mergeParams: true })

  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { assistantId } = req.params as { assistantId: string }
    if (!(await requireOwnerOrAdmin(userId, assistantId, res))) return

    try {
      const links = await chatLinkStore.listForAssistant(assistantId)
      res.json({ links })
    } catch (err) {
      console.error('[chat-links] list failed:', err)
      res.status(500).json({ error: 'Failed to list chat links' })
    }
  })

  router.post('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { assistantId } = req.params as { assistantId: string }
    if (!(await requireOwnerOrAdmin(userId, assistantId, res))) return

    const parsed = createSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message })
      return
    }

    try {
      const link = await chatLinkStore.create({
        assistantId,
        createdBy: userId,
        label: parsed.data.label,
        dailyMessageLimit: parsed.data.dailyMessageLimit,
      })
      res.status(201).json({ link })
    } catch (err) {
      console.error('[chat-links] create failed:', err)
      res.status(500).json({ error: 'Failed to create chat link' })
    }
  })

  router.delete('/:linkId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { assistantId, linkId } = req.params as { assistantId: string; linkId: string }
    if (!(await requireOwnerOrAdmin(userId, assistantId, res))) return

    try {
      const revoked = await chatLinkStore.revoke(linkId, assistantId)
      if (!revoked) {
        res.status(404).json({ error: 'Chat link not found' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[chat-links] revoke failed:', err)
      res.status(500).json({ error: 'Failed to revoke chat link' })
    }
  })

  return router
}
