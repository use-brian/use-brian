/**
 * Modes route — CRUD for assistant_modes.
 *
 * Mounted at `/api/assistants/:assistantId/modes` in apps/api.
 *
 * Auth: any workspace member of the assistant's workspace can manage modes
 * for that assistant. Enforced by checking `workspace_members` membership
 * before delegating to the store.
 *
 * [COMP:api/modes-route]
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AssistantModesStore } from '../db/assistant-modes-store.js'
import { findAssistantById } from '../db/users.js'
import { query } from '../db/client.js'

const createBodySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  exposedTools: z.array(z.string().min(1)).default([]),
  freshness: z.enum(['live', 'snapshot']).default('live'),
  requireApproval: z.boolean().default(false),
  allowOnwardConsults: z.boolean().default(false),
  knowledgeMaxSensitivity: z.string().nullable().optional(),
  memoryCategories: z.array(z.string()).nullable().optional(),
})

const updateBodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  exposedTools: z.array(z.string().min(1)).optional(),
  freshness: z.enum(['live', 'snapshot']).optional(),
  requireApproval: z.boolean().optional(),
  allowOnwardConsults: z.boolean().optional(),
  knowledgeMaxSensitivity: z.string().nullable().optional(),
  memoryCategories: z.array(z.string()).nullable().optional(),
})

export type ModesRouterDeps = {
  modesStore: AssistantModesStore
}

export function createModesRouter({ modesStore }: ModesRouterDeps): Router {
  const router = Router({ mergeParams: true })

  // Helper: verify the caller can manage modes for this assistant.
  // (Workspace membership in the assistant's workspace.)
  async function verifyAccess(
    userId: string,
    assistantId: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const assistant = await findAssistantById(assistantId)
    if (!assistant) return { ok: false, status: 404, error: 'Assistant not found' }
    if (!assistant.workspaceId) {
      return { ok: false, status: 403, error: 'Assistant has no workspace' }
    }
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM workspace_members
         WHERE workspace_id = $1 AND user_id = $2
       ) AS exists`,
      [assistant.workspaceId, userId],
    )
    if (!result.rows[0]?.exists) {
      return { ok: false, status: 403, error: 'Not a member of this assistant\'s workspace' }
    }
    return { ok: true }
  }

  // ── GET / ───────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const access = await verifyAccess(userId, (req.params as { assistantId: string; modeId?: string }).assistantId)
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return }

    try {
      const modes = await modesStore.list((req.params as { assistantId: string; modeId?: string }).assistantId)
      res.json({ modes })
    } catch (err) {
      console.error('[modes] list failed:', err)
      res.status(500).json({ error: 'Failed to list modes' })
    }
  })

  // ── GET /:modeId ────────────────────────────────────────────────
  router.get('/:modeId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const access = await verifyAccess(userId, (req.params as { assistantId: string; modeId?: string }).assistantId)
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return }

    try {
      const mode = await modesStore.get((req.params as { assistantId: string; modeId: string }).modeId)
      if (!mode || mode.assistantId !== (req.params as { assistantId: string; modeId?: string }).assistantId) {
        res.status(404).json({ error: 'Mode not found' })
        return
      }
      res.json(mode)
    } catch (err) {
      console.error('[modes] get failed:', err)
      res.status(500).json({ error: 'Failed to get mode' })
    }
  })

  // ── POST / ──────────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const access = await verifyAccess(userId, (req.params as { assistantId: string; modeId?: string }).assistantId)
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return }

    const parsed = createBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.errors })
      return
    }

    try {
      const mode = await modesStore.create({
        assistantId: (req.params as { assistantId: string; modeId?: string }).assistantId,
        ...parsed.data,
      })
      res.status(201).json(mode)
    } catch (err) {
      // 23505 unique violation on (assistant_id, name).
      if (typeof err === 'object' && err && 'code' in err && (err as { code: unknown }).code === '23505') {
        res.status(409).json({ error: 'A mode with this name already exists' })
        return
      }
      console.error('[modes] create failed:', err)
      res.status(500).json({ error: 'Failed to create mode' })
    }
  })

  // ── PATCH /:modeId ──────────────────────────────────────────────
  router.patch('/:modeId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const access = await verifyAccess(userId, (req.params as { assistantId: string; modeId?: string }).assistantId)
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return }

    const parsed = updateBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.errors })
      return
    }

    // Verify the mode belongs to this assistant.
    const existing = await modesStore.get((req.params as { assistantId: string; modeId: string }).modeId)
    if (!existing || existing.assistantId !== (req.params as { assistantId: string; modeId?: string }).assistantId) {
      res.status(404).json({ error: 'Mode not found' })
      return
    }

    try {
      const updated = await modesStore.update((req.params as { assistantId: string; modeId: string }).modeId, parsed.data)
      if (!updated) { res.status(404).json({ error: 'Mode not found' }); return }
      res.json(updated)
    } catch (err) {
      if (typeof err === 'object' && err && 'code' in err && (err as { code: unknown }).code === '23505') {
        res.status(409).json({ error: 'A mode with this name already exists' })
        return
      }
      console.error('[modes] update failed:', err)
      res.status(500).json({ error: 'Failed to update mode' })
    }
  })

  // ── DELETE /:modeId ─────────────────────────────────────────────
  router.delete('/:modeId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const access = await verifyAccess(userId, (req.params as { assistantId: string; modeId?: string }).assistantId)
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return }

    // Verify the mode belongs to this assistant.
    const existing = await modesStore.get((req.params as { assistantId: string; modeId: string }).modeId)
    if (!existing || existing.assistantId !== (req.params as { assistantId: string; modeId?: string }).assistantId) {
      res.status(404).json({ error: 'Mode not found' })
      return
    }

    try {
      const ok = await modesStore.delete((req.params as { assistantId: string; modeId: string }).modeId)
      // Connections bound to this mode fall back to free via ON DELETE SET NULL.
      res.json({ deleted: ok })
    } catch (err) {
      console.error('[modes] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete mode' })
    }
  })

  return router
}
