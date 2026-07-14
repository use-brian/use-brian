/**
 * Deck routes — the read + export surface for the app-web live preview.
 * Writes happen only through the deck tools (generatePowerpoint /
 * updatePowerpoint); this router never mutates.
 *
 * Mounted at `/api` under `requireAuth` (authenticated open router — NOT
 * the public-mount hook). Membership is the visibility boundary: non-members
 * get the same 404 as a missing id.
 *
 * Spec: docs/architecture/features/deck-generation.md. [COMP:api/decks-route]
 */
import { Router } from 'express'
import type { FilesApi } from '@sidanclaw/core'
import { DECK_PPTX_MIME } from '@sidanclaw/core'
import type { DeckStore } from '../db/deck-store.js'
import {
  effectiveReadClearance,
  getWorkspaceMembershipWithClearanceSystem,
} from '../db/workspace-store.js'

export type DecksRouteOptions = {
  deckStore: DeckStore
  filesApi: FilesApi
}

export function decksRoutes(opts: DecksRouteOptions): Router {
  const router = Router()
  const { deckStore, filesApi } = opts

  async function memberOf(userId: string, workspaceId: string) {
    return getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
  }

  // GET /decks?workspaceId= — newest first
  router.get('/decks', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!workspaceId) return void res.status(400).json({ error: 'workspaceId is required' })
    if (!(await memberOf(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }
    const decks = await deckStore.listSystem(workspaceId)
    res.json({ decks })
  })

  // GET /decks/:id — full record (spec + style) for the preview renderer
  router.get('/decks/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const deck = await deckStore.getSystem(String(req.params.id))
    if (!deck || !(await memberOf(userId, deck.workspaceId))) {
      return void res.status(404).json({ error: 'Deck not found' })
    }
    res.json({ deck })
  })

  // GET /decks/:id/export — stream the built .pptx for browser download
  router.get('/decks/:id/export', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const deck = await deckStore.getSystem(String(req.params.id))
    if (!deck) return void res.status(404).json({ error: 'Deck not found' })
    const membership = await memberOf(userId, deck.workspaceId)
    if (!membership) return void res.status(404).json({ error: 'Deck not found' })

    const read = await filesApi.readBytes(
      {
        workspaceId: deck.workspaceId,
        userId,
        // No assistant in the loop — the member side alone decides.
        clearance: effectiveReadClearance(membership.role, membership.clearance, 'confidential'),
      },
      deck.filePath,
    )
    if (!read.ok) {
      return void res.status(404).json({ error: 'Deck file missing — regenerate the deck' })
    }
    const safeName = deck.title.replace(/[^a-zA-Z0-9._ -]+/g, '-').slice(0, 80) || 'deck'
    res.setHeader('Content-Type', DECK_PPTX_MIME)
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pptx"`)
    res.send(Buffer.from(read.value.bytes))
  })

  return router
}
