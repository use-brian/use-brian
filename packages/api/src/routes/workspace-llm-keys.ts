/**
 * Workspace LLM provider key management — the Settings ▸ BYO model surface.
 *
 *   GET    /api/workspaces/:workspaceId/llm-keys   — masked status {isSet, last4}
 *   PUT    /api/workspaces/:workspaceId/llm-keys   — set the BYO Gemini key
 *   POST   /api/workspaces/:workspaceId/llm-keys   — alias of PUT
 *   DELETE /api/workspaces/:workspaceId/llm-keys   — remove the BYO key
 *
 * Mounted behind requireAuth in apps/api. Setting a provider key is an
 * administrative action — every handler is gated to workspace owner/admin
 * (`workspaceStore.getRole`); the `workspace_llm_provider_settings` RLS policy
 * is the DB-level backstop. The raw key is NEVER returned by any handler —
 * GET exposes only `{isSet, last4}` (see `getMasked`).
 *
 * Mirrors brain-keys.ts for auth / workspace-resolution / error-handling.
 * Component tag: [COMP:api/workspace-llm-keys-route].
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type {
  WorkspaceLlmProviderSettingsStore,
  LlmProvider,
} from '../db/workspace-llm-provider-settings.js'

type Options = {
  llmProviderSettingsStore: WorkspaceLlmProviderSettingsStore
  workspaceStore: WorkspaceStore
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Only Gemini is enabled by the schema today; default it server-side.
const DEFAULT_PROVIDER: LlmProvider = 'gemini'

const SetBody = z
  .object({
    apiKey: z.string().min(1).max(512),
  })
  .strict()

export function workspaceLlmKeysRoutes(opts: Options): Router {
  // mergeParams so `:workspaceId` from the mount path is visible here.
  const router = Router({ mergeParams: true })

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
      res
        .status(403)
        .json({ error: 'Only workspace admins can manage LLM provider keys' })
      return null
    }
    return workspaceId
  }

  // ── GET / — masked status (never the raw key) ──
  router.get('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      const masked = await opts.llmProviderSettingsStore.getMasked({
        actingUserId: req.userId!,
        workspaceId,
        provider: DEFAULT_PROVIDER,
      })
      // Response carries only masked metadata — no plaintext ever.
      res.json({
        provider: masked.provider,
        isSet: masked.isSet,
        last4: masked.last4,
      })
    } catch (err) {
      console.error('[workspace-llm-keys] get failed:', err)
      res.status(500).json({ error: 'Failed to read LLM provider key status' })
    }
  })

  // ── PUT / (and POST alias) — set the BYO key ──
  const setHandler = async (req: Request, res: Response): Promise<void> => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const parsed = SetBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }
    try {
      await opts.llmProviderSettingsStore.set({
        actingUserId: req.userId!,
        workspaceId,
        provider: DEFAULT_PROVIDER,
        apiKey: parsed.data.apiKey,
      })
      // Echo only masked metadata back — never the key just submitted.
      const masked = await opts.llmProviderSettingsStore.getMasked({
        actingUserId: req.userId!,
        workspaceId,
        provider: DEFAULT_PROVIDER,
      })
      res.json({
        provider: masked.provider,
        isSet: masked.isSet,
        last4: masked.last4,
      })
    } catch (err) {
      console.error('[workspace-llm-keys] set failed:', err)
      res.status(500).json({ error: 'Failed to set LLM provider key' })
    }
  }
  router.put('/', setHandler)
  router.post('/', setHandler)

  // ── DELETE / — remove the BYO key (idempotent) ──
  router.delete('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      await opts.llmProviderSettingsStore.delete({
        actingUserId: req.userId!,
        workspaceId,
        provider: DEFAULT_PROVIDER,
      })
      res.status(204).end()
    } catch (err) {
      console.error('[workspace-llm-keys] delete failed:', err)
      res.status(500).json({ error: 'Failed to remove LLM provider key' })
    }
  })

  return router
}
