/**
 * Model selection surfaces (docs/architecture/platform/model-registry.md →
 * L10): per-class menus derived from the model registry, workspace-saved
 * metered profiles (L15), and the metered pre-flight estimate (L8).
 *
 *   GET    /api/models/menu?workspaceId=            — per-class menus + profiles + defaults
 *   POST   /api/models/metered-estimate             — estimate at a tool-round budget
 *   GET    /api/workspaces/:wid/metered-profiles    — list profiles
 *   POST   /api/workspaces/:wid/metered-profiles    — create
 *   PATCH  /api/workspaces/:wid/metered-profiles/:id — rename / re-budget
 *   DELETE /api/workspaces/:wid/metered-profiles/:id — delete
 *   PUT    /api/workspaces/:wid/model-defaults/:cls — set a class default (owner/admin)
 *   DELETE /api/workspaces/:wid/model-defaults/:cls — back to registry default (owner/admin)
 *
 * Menus honor key presence (L12): a model whose provider key is absent at
 * boot is absent from every menu — never listed, never erroring. Metered
 * entries are pickable ONLY through the estimate→confirm flow; the chat
 * route enforces it server-side regardless of the client.
 *
 * All routes require an authenticated user; workspace membership via
 * `WorkspaceStore.getRole`. Mount point: `/api`.
 *
 * [COMP:api/model-menu]
 */
import { Router } from 'express'
import { z } from 'zod'
import { menuForClass, type ModelClass, type ModelRegistryRow } from '@use-brian/shared/model-registry'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { MeteredProfileStore } from '../db/metered-profile-store.js'
import { isDefaultableClass, type WorkspaceModelDefaultsStore } from '../db/workspace-model-defaults-store.js'

export type ModelMenuRouteOptions = {
  workspaceStore: WorkspaceStore
  meteredProfileStore: MeteredProfileStore
  modelDefaultsStore: WorkspaceModelDefaultsStore
  /** Provider keys configured at boot (the routing table's keys). */
  configuredProviders: ReadonlySet<string>
  /** Closed billing seam; absent on the open build (menus still work,
   * estimates return null and the UI hides credit figures). */
  estimateMeteredTurn?: (modelAlias: string, toolRounds: number) => { modelAlias: string; toolRounds: number; minCredits: number; maxCredits: number } | null
}

const MENU_CLASSES: ModelClass[] = ['standard-pro', 'max', 'research', 'metered']

function serializeRow(row: ModelRegistryRow) {
  return {
    alias: row.alias,
    // Human product name — what every picker label shows (aliases and wire
    // ids stay technical identities).
    displayName: row.displayName,
    // Wire id: lets pickers collapse alias rows of the same underlying
    // model (standard-pro's two tier labels) instead of listing fake choices.
    apiModelId: row.apiModelId,
    class: row.class,
    provider: row.provider,
    contextWindow: row.contextWindow,
    capabilities: row.capabilities,
    metered: row.class === 'metered',
  }
}

const createProfileSchema = z.object({
  name: z.string().min(1).max(60),
  modelAlias: z.string().min(1),
  toolRounds: z.number().int().min(10).max(200),
  thinking: z.boolean().nullish(),
})

const updateProfileSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  toolRounds: z.number().int().min(10).max(200).optional(),
  thinking: z.boolean().nullish(),
})

const estimateSchema = z.object({
  workspaceId: z.string().uuid(),
  modelAlias: z.string().min(1),
  toolRounds: z.number().int().min(10).max(200),
})

// Exactly one of the two targets: a curated same-class pin or a saved
// metered profile (§4.4 — raw metered models are never defaults).
const setDefaultSchema = z.union([
  z.object({ modelAlias: z.string().min(1) }),
  z.object({ meteredProfileId: z.string().uuid() }),
])

export function modelMenuRoutes(opts: ModelMenuRouteOptions): Router {
  const router = Router()

  async function memberOr403(req: { userId?: string }, res: { status(n: number): { json(b: unknown): void } }, workspaceId: string): Promise<boolean> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Not a workspace member' })
      return false
    }
    return true
  }

  router.get('/models/menu', async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!workspaceId) return void res.status(400).json({ error: 'workspaceId is required' })
    if (!(await memberOr403(req as { userId?: string }, res, workspaceId))) return

    const classes: Record<string, ReturnType<typeof serializeRow>[]> = {}
    for (const cls of MENU_CLASSES) {
      classes[cls] = menuForClass(cls, opts.configuredProviders).map(serializeRow)
    }
    const [profiles, defaults] = await Promise.all([
      opts.meteredProfileStore.list(workspaceId),
      opts.modelDefaultsStore.list(workspaceId),
    ])
    // Profiles over models whose key is gone are hidden with their models
    // (L12) — kept in the DB so a re-keyed deployment restores them. A
    // default pointing at a hidden profile hides with it (same rule).
    const available = new Set(classes['metered']!.map((m) => m.alias))
    const visibleProfiles = profiles.filter((p) => available.has(p.modelAlias))
    const visibleProfileIds = new Set(visibleProfiles.map((p) => p.id))
    res.json({
      classes,
      profiles: visibleProfiles,
      defaults: defaults.filter((d) => d.meteredProfileId === null || visibleProfileIds.has(d.meteredProfileId)),
      meteredBillingAvailable: Boolean(opts.estimateMeteredTurn),
    })
  })

  router.post('/models/metered-estimate', async (req, res) => {
    const parsed = estimateSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid estimate request' })
    if (!(await memberOr403(req as { userId?: string }, res, parsed.data.workspaceId))) return
    const estimate = opts.estimateMeteredTurn?.(parsed.data.modelAlias, parsed.data.toolRounds) ?? null
    res.json({ estimate })
  })

  router.get('/workspaces/:wid/metered-profiles', async (req, res) => {
    if (!(await memberOr403(req as { userId?: string }, res, req.params.wid))) return
    res.json({ profiles: await opts.meteredProfileStore.list(req.params.wid) })
  })

  router.post('/workspaces/:wid/metered-profiles', async (req, res) => {
    if (!(await memberOr403(req as { userId?: string }, res, req.params.wid))) return
    const parsed = createProfileSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid profile' })
    try {
      const profile = await opts.meteredProfileStore.create({
        workspaceId: req.params.wid,
        name: parsed.data.name,
        modelAlias: parsed.data.modelAlias,
        toolRounds: parsed.data.toolRounds,
        thinking: parsed.data.thinking ?? null,
        createdByUserId: (req as { userId?: string }).userId ?? null,
      })
      res.json({ profile })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not an active metered registry model')) {
        return void res.status(400).json({ error: 'Not a metered model' })
      }
      if (message.includes('duplicate key')) {
        return void res.status(409).json({ error: 'A profile with this name already exists for this model' })
      }
      throw err
    }
  })

  router.patch('/workspaces/:wid/metered-profiles/:id', async (req, res) => {
    if (!(await memberOr403(req as { userId?: string }, res, req.params.wid))) return
    const parsed = updateProfileSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid profile update' })
    const profile = await opts.meteredProfileStore.update({
      workspaceId: req.params.wid,
      id: req.params.id,
      name: parsed.data.name,
      toolRounds: parsed.data.toolRounds,
      thinking: parsed.data.thinking,
    })
    if (!profile) return void res.status(404).json({ error: 'Profile not found' })
    res.json({ profile })
  })

  router.delete('/workspaces/:wid/metered-profiles/:id', async (req, res) => {
    if (!(await memberOr403(req as { userId?: string }, res, req.params.wid))) return
    const removed = await opts.meteredProfileStore.remove(req.params.wid, req.params.id)
    if (!removed) return void res.status(404).json({ error: 'Profile not found' })
    res.json({ ok: true })
  })

  // Workspace-wide defaults change what every member's picker prefers, so
  // writes are owner/admin — plain members read them via /models/menu.
  async function adminOr403(req: { userId?: string }, res: { status(n: number): { json(b: unknown): void } }, workspaceId: string): Promise<boolean> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Owner or admin role required' })
      return false
    }
    return true
  }

  router.put('/workspaces/:wid/model-defaults/:cls', async (req, res) => {
    const cls = req.params.cls
    if (!isDefaultableClass(cls)) return void res.status(400).json({ error: 'Unknown model class' })
    if (!(await adminOr403(req as { userId?: string }, res, req.params.wid))) return
    const parsed = setDefaultSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid default' })
    const userId = (req as { userId?: string }).userId ?? null
    try {
      const setting =
        'modelAlias' in parsed.data
          ? await opts.modelDefaultsStore.setCurated({
              workspaceId: req.params.wid,
              modelClass: cls,
              modelAlias: parsed.data.modelAlias,
              updatedByUserId: userId,
            })
          : await opts.modelDefaultsStore.setProfile({
              workspaceId: req.params.wid,
              modelClass: cls,
              meteredProfileId: parsed.data.meteredProfileId,
              updatedByUserId: userId,
            })
      res.json({ default: setting })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not an active curated menu model')) {
        return void res.status(400).json({ error: 'Not a curated model of this class' })
      }
      if (message.includes('not found in workspace')) {
        return void res.status(404).json({ error: 'Profile not found' })
      }
      throw err
    }
  })

  router.delete('/workspaces/:wid/model-defaults/:cls', async (req, res) => {
    const cls = req.params.cls
    if (!isDefaultableClass(cls)) return void res.status(400).json({ error: 'Unknown model class' })
    if (!(await adminOr403(req as { userId?: string }, res, req.params.wid))) return
    await opts.modelDefaultsStore.clear(req.params.wid, cls)
    res.json({ ok: true })
  })

  return router
}
