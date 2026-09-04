/**
 * Brain key management routes — the Settings ▸ Programmatic access surface.
 *
 *   GET    /api/workspaces/:workspaceId/brain-keys          — list keys
 *   POST   /api/workspaces/:workspaceId/brain-keys          — create a key
 *   PATCH  /api/workspaces/:workspaceId/brain-keys/:keyId   — set/clear max_clearance
 *   DELETE /api/workspaces/:workspaceId/brain-keys/:keyId   — revoke a key
 *
 * Mounted behind requireAuth in apps/api. Issuing a brain credential is an
 * administrative action — every handler is gated to workspace owner/admin
 * (`workspaceStore.getRole`); the `brain_keys` RLS policy is the DB-level
 * backstop. The plaintext key is returned exactly once, from POST.
 *
 * Component tag: [COMP:api/brain-keys-route].
 * Spec: docs/architecture/features/programmatic-access.md.
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { BrainKeyStore } from '../db/brain-keys-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  assertContextActivationReady,
  type ContextReadiness,
} from '../context-scope/context-readiness.js'
import {
  createDbContextScopeStore,
  type ContextScopeStore,
} from '../db/context-scope-store.js'

type Options = {
  brainKeyStore: BrainKeyStore
  workspaceStore: WorkspaceStore
  contextStore?: ContextScopeStore
  getContextReadiness?: (workspaceId: string) => Promise<ContextReadiness>
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CreateBody = z
  .object({
    name: z.string().min(1).max(120),
    scope: z.enum(['read', 'read_write']).default('read_write'),
    // Per-key clearance cap (migration 262). Omitted/null = the workspace
    // primary assistant's clearance governs.
    maxClearance: z.enum(['public', 'internal', 'confidential']).nullable().optional(),
    contextGroupId: z.string().uuid().nullable().optional(),
    contextProjectId: z.string().uuid().nullable().optional(),
  })
  .strict()

const PatchBody = z
  .object({
    // null clears the cap (primary's clearance governs); a tier sets it.
    maxClearance: z.enum(['public', 'internal', 'confidential']).nullable(),
  })
  .strict()

const CaptureBindingBody = z.object({
  assistantId: z.string().uuid().nullable(),
  profileId: z.string().uuid().nullable(),
}).strict().refine((value) => value.assistantId !== null || value.profileId === null, {
  message: 'A profile override requires a capture assistant',
  path: ['profileId'],
})

export function brainKeysRoutes(opts: Options): Router {
  // mergeParams so `:workspaceId` from the mount path is visible here.
  const router = Router({ mergeParams: true })
  const contextStore = opts.contextStore ?? createDbContextScopeStore()

  /**
   * Resolve + admin-gate the workspace from the mount path. On success
   * returns the workspaceId; on any failure writes the response and returns
   * null (the caller must `return` immediately).
   */
  async function gate(req: Request, res: Response): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    // `mergeParams` widens param values to `string | string[]` — narrow it.
    const rawWorkspaceId = req.params.workspaceId
    const workspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      res.status(400).json({ error: 'Invalid workspace id' })
      return null
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      // Not a member — or the workspace does not exist. Same 404 either way
      // so membership is not probeable.
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Only workspace admins can manage brain keys' })
      return null
    }
    return workspaceId
  }

  // ── GET / — list keys for the workspace ──
  router.get('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      const keys = await opts.brainKeyStore.listForWorkspace(req.userId!, workspaceId)
      res.json({ keys })
    } catch (err) {
      console.error('[brain-keys] list failed:', err)
      res.status(500).json({ error: 'Failed to list brain keys' })
    }
  })

  // ── POST / — create a key (plaintext returned once) ──
  router.post('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const parsed = CreateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }
    try {
      const contextGroupId = parsed.data.contextGroupId ?? null
      const contextProjectId = parsed.data.contextProjectId ?? null
      if (contextGroupId !== null || contextProjectId !== null) {
        await assertContextActivationReady(workspaceId, opts.getContextReadiness)
        const [team, project] = await Promise.all([
          contextGroupId ? contextStore.getTeamSystem(workspaceId, contextGroupId) : null,
          contextProjectId ? contextStore.getProjectSystem(workspaceId, contextProjectId) : null,
        ])
        if (
          (contextGroupId && (!team || team.status !== 'active'))
          || (contextProjectId && (!project || project.status !== 'active'))
        ) {
          res.status(404).json({ error: 'context_not_available' })
          return
        }
      }
      const created = await opts.brainKeyStore.create({
        workspaceId,
        name: parsed.data.name,
        scope: parsed.data.scope,
        maxClearance: parsed.data.maxClearance ?? null,
        contextGroupId,
        contextProjectId,
        actingUserId: req.userId!,
      })
      // `key` (plaintext) is returned ONLY here — never again.
      res.json({
        id: created.id,
        name: created.name,
        key: created.plaintext,
        prefix: created.prefix,
        scope: created.scope,
        status: created.status,
        maxClearance: created.maxClearance,
        contextGroupId: created.contextGroupId,
        contextProjectId: created.contextProjectId,
        captureAssistantId: created.captureAssistantId,
        captureProfileId: created.captureProfileId,
        createdAt: created.createdAt,
        lastUsedAt: created.lastUsedAt,
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'context_activation_blocked') {
        res.status(409).json({
          error: 'context_activation_blocked',
          failedChecks: (err as { failedChecks?: string[] }).failedChecks ?? [],
        })
        return
      }
      console.error('[brain-keys] create failed:', err)
      res.status(500).json({ error: 'Failed to create brain key' })
    }
  })

  // ── PUT /:keyId/capture — set the routed-capture target/override ──
  router.put('/:keyId/capture', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const rawKeyId = req.params.keyId
    const keyId = typeof rawKeyId === 'string' ? rawKeyId : ''
    const parsed = CaptureBindingBody.safeParse(req.body)
    if (!UUID_RE.test(keyId) || !parsed.success) {
      res.status(400).json({ error: 'Invalid input' })
      return
    }
    try {
      const ok = await opts.brainKeyStore.updateCaptureBinding(
        req.userId!,
        keyId,
        workspaceId,
        parsed.data.assistantId,
        parsed.data.profileId,
      )
      if (!ok) {
        res.status(404).json({ error: 'Brain key, assistant, or capture profile not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[brain-keys] capture binding update failed:', err)
      res.status(500).json({ error: 'Failed to update capture binding' })
    }
  })

  // ── PATCH /:keyId — set or clear the per-key clearance cap ──
  router.patch('/:keyId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const rawKeyId = req.params.keyId
    const keyId = typeof rawKeyId === 'string' ? rawKeyId : ''
    if (!UUID_RE.test(keyId)) {
      res.status(404).json({ error: 'Brain key not found' })
      return
    }
    const parsed = PatchBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }
    try {
      // RLS scopes the update to workspaces the caller owns/admins — a key
      // from another workspace yields 0 rows → 404.
      const ok = await opts.brainKeyStore.updateMaxClearance(
        req.userId!,
        keyId,
        parsed.data.maxClearance,
      )
      if (!ok) {
        res.status(404).json({ error: 'Brain key not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[brain-keys] update failed:', err)
      res.status(500).json({ error: 'Failed to update brain key' })
    }
  })

  // ── DELETE /:keyId — revoke a key (idempotent) ──
  router.delete('/:keyId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const rawKeyId = req.params.keyId
    const keyId = typeof rawKeyId === 'string' ? rawKeyId : ''
    if (!UUID_RE.test(keyId)) {
      res.status(404).json({ error: 'Brain key not found' })
      return
    }
    try {
      // RLS scopes the revoke to workspaces the caller owns/admins — a key
      // from another workspace yields 0 rows → 404.
      const ok = await opts.brainKeyStore.revoke(req.userId!, keyId)
      if (!ok) {
        res.status(404).json({ error: 'Brain key not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[brain-keys] revoke failed:', err)
      res.status(500).json({ error: 'Failed to revoke brain key' })
    }
  })

  return router
}
