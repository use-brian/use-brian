/**
 * Compartment axis — config-layer routes (the admin surface that turns the
 * axis on). Mounted in apps/api (user app — workspace-admin, NOT platform
 * admin) at `/api/workspaces/:workspaceId/compartments`:
 *
 *   GET    /                              list the workspace taxonomy (any member)
 *   POST   /                              create a compartment (admin)
 *   DELETE /:key                          delete a compartment (admin)
 *   PUT    /assistant-grant/:assistantId  set an assistant's grant + write default (admin)
 *   PUT    /member-grant/:memberUserId    set a member's grant + audit (admin)
 *
 * Grant writes validate every key against the registry and enforce
 * `defaultCompartments ⊆ compartments`. The read-gate columns these populate
 * (mig 243) are what actually enforce. See docs/plans/compartment-axis.md.
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { CompartmentStore } from '../db/compartment-store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}$/

type Options = {
  compartmentStore: CompartmentStore
  workspaceStore: {
    getRole(userId: string, workspaceId: string): Promise<'owner' | 'admin' | 'member' | null>
  }
}

export function compartmentRoutes(opts: Options): Router {
  const router = Router({ mergeParams: true })

  async function gate(req: Request, res: Response, requireAdmin: boolean): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      res.status(400).json({ error: 'Invalid workspace id' })
      return null
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    if (requireAdmin && role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Only workspace admins can manage compartments' })
      return null
    }
    return workspaceId
  }

  // Validate that every requested key is registered + default ⊆ grant.
  async function validateGrant(
    workspaceId: string,
    grant: string[] | null,
    defaults: string[],
  ): Promise<string | null> {
    const keys = new Set<string>([...(grant ?? []), ...defaults])
    if (keys.size > 0) {
      const registered = await opts.compartmentStore.registeredKeysSystem(workspaceId)
      for (const k of keys) {
        if (!registered.has(k)) return `Unknown compartment key '${k}' — register it first.`
      }
    }
    if (grant !== null) {
      const g = new Set(grant)
      for (const d of defaults) {
        if (!g.has(d)) return `default_compartments must be a subset of compartments ('${d}' is not granted).`
      }
    }
    return null
  }

  router.get('/', async (req, res) => {
    const ws = await gate(req, res, false)
    if (!ws) return
    res.json({ compartments: await opts.compartmentStore.list(req.userId!, ws) })
  })

  const CreateBody = z.object({
    key: z.string().regex(KEY_RE, 'lowercase kebab key, ≤ 39 chars'),
    label: z.string().min(1).max(80),
    description: z.string().max(280).optional(),
    color: z.string().max(32).optional(),
  })
  router.post('/', async (req, res) => {
    const ws = await gate(req, res, true)
    if (!ws) return
    const parsed = CreateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() })
      return
    }
    try {
      const entry = await opts.compartmentStore.create(req.userId!, { workspaceId: ws, ...parsed.data })
      if (!entry) {
        res.status(403).json({ error: 'Not authorized' })
        return
      }
      res.status(201).json({ compartment: entry })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'A compartment with that key already exists' })
        return
      }
      throw err
    }
  })

  router.delete('/:key', async (req, res) => {
    const ws = await gate(req, res, true)
    if (!ws) return
    const ok = await opts.compartmentStore.remove(req.userId!, ws, req.params.key)
    if (!ok) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.status(204).end()
  })

  const AssistantGrantBody = z.object({
    compartments: z.array(z.string()).nullable(),
    defaultCompartments: z.array(z.string()).default([]),
  })
  router.put('/assistant-grant/:assistantId', async (req, res) => {
    const ws = await gate(req, res, true)
    if (!ws) return
    const assistantId = req.params.assistantId
    if (!UUID_RE.test(assistantId)) {
      res.status(400).json({ error: 'Invalid assistant id' })
      return
    }
    const parsed = AssistantGrantBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() })
      return
    }
    const invalid = await validateGrant(ws, parsed.data.compartments, parsed.data.defaultCompartments)
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }
    const ok = await opts.compartmentStore.setAssistantGrant(
      req.userId!,
      assistantId,
      parsed.data.compartments,
      parsed.data.defaultCompartments,
    )
    if (!ok) {
      res.status(404).json({ error: 'Assistant not found or not authorized' })
      return
    }
    res.json({ ok: true })
  })

  const MemberGrantBody = z.object({ compartments: z.array(z.string()).nullable() })
  router.put('/member-grant/:memberUserId', async (req, res) => {
    const ws = await gate(req, res, true)
    if (!ws) return
    const memberUserId = req.params.memberUserId
    if (!UUID_RE.test(memberUserId)) {
      res.status(400).json({ error: 'Invalid member id' })
      return
    }
    const parsed = MemberGrantBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() })
      return
    }
    const invalid = await validateGrant(ws, parsed.data.compartments, [])
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }
    const ok = await opts.compartmentStore.setMemberGrant(req.userId!, ws, memberUserId, parsed.data.compartments)
    if (!ok) {
      res.status(404).json({ error: 'Member not found' })
      return
    }
    res.json({ ok: true })
  })

  return router
}
