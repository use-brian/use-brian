/**
 * Workspace brand routes — `/api/workspaces/:workspaceId/brand`.
 *
 * Mounted by `bootOpenApi`, so BOTH editions serve them: the OSS standalone
 * entry and the hosted platform app. Deliberately NOT added to the forked
 * `/api/connectors` router pair — `brand` is a connector only in the
 * governance-display sense (an `auth_type: 'none'` built-in primitive); its
 * data surface is a workspace resource, and putting it on the connector pair
 * would mean maintaining it twice by hand for no benefit.
 *
 * ## Two authorisation levels
 *
 * Every route requires workspace membership, resolved the same way
 * `workspaceKnowledgeRoutes` resolves it. **Approve additionally requires
 * `owner` or `admin`**, because approval is the irreversible step: it mints a
 * version that becomes what every assistant in the workspace ambiently
 * believes about the brand. A row predicate cannot express "who may approve"
 * — that is a question about the actor's role — so the check lives here,
 * beside the action, rather than in RLS.
 *
 * Draft writes stay at member level. A draft is a proposal, and the whole
 * design assumes proposals arrive from many places (a member, an assistant,
 * an agency's brain key); the gate is at approval, not at authorship.
 *
 * Spec: docs/architecture/features/brand.md → "Management flows"
 *
 * [COMP:brand/routes]
 */

import { Router } from 'express'
import { BrandRecordPatchSchema, BrandRecordSchema, mergeBrandRecordPatch } from '@use-brian/shared'
import { z } from 'zod'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { getBrandStore } from '../db/brand-store.js'
import type { BrandStore } from '@use-brian/core'

type BrandRouteOptions = {
  /** Test seam. Defaults to the shared pg-backed store. */
  store?: BrandStore
}

const slugShape = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'slug must be lowercase letters, digits, and hyphens')

const createBody = z.object({
  slug: slugShape,
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().optional(),
  sensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
})

export function brandRoutes(opts: BrandRouteOptions = {}): Router {
  const router = Router({ mergeParams: true })
  const store = opts.store ?? getBrandStore()

  async function verifyMember(
    req: { userId?: string; params: Record<string, string> },
    res: import('express').Response,
  ): Promise<{ userId: string; workspaceId: string; role: 'owner' | 'admin' | 'member' } | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const workspaceId = req.params.workspaceId
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return null
    }
    // The shared membership resolver rather than a route-local join: seven
    // call sites once each spelled this out differently, disagreeing on the
    // pool, on whether a role came back, and on 403-vs-404. Graded by
    // `pnpm check` (`invariants/assistant-access-predicate`).
    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    return { userId, workspaceId, role: membership.role }
  }

  // ── List ──────────────────────────────────────────────────────────────

  router.get('/', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    const brands = await store.list(auth.userId, auth.workspaceId)
    res.json({ brands, canApprove: auth.role === 'owner' || auth.role === 'admin' })
  })

  // ── Create ────────────────────────────────────────────────────────────

  router.post('/', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' })
      return
    }
    try {
      const brand = await store.create(auth.userId, auth.workspaceId, parsed.data)
      res.status(201).json({ brand })
    } catch (err) {
      // The (workspace_id, slug) unique index is the only collision a caller
      // can trigger, and it is worth naming: "slug already in use" is
      // actionable, a bare 500 is not.
      const message = err instanceof Error ? err.message : String(err)
      if (/idx_workspace_brands_slug|unique/i.test(message)) {
        res.status(409).json({ error: `A brand with the slug "${parsed.data.slug}" already exists in this workspace.` })
        return
      }
      throw err
    }
  })

  // ── Read one ──────────────────────────────────────────────────────────
  //
  // `:brandId` accepts the literal `default` so the common case — "the
  // workspace's brand" — needs no prior list call.

  router.get('/:brandId', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    const ref = req.params.brandId === 'default' ? undefined : { id: req.params.brandId }
    const brand = await store.get(auth.userId, auth.workspaceId, ref)
    if (!brand) {
      res.status(404).json({ error: 'Brand not found' })
      return
    }
    res.json({ brand, canApprove: auth.role === 'owner' || auth.role === 'admin' })
  })

  // ── Draft upsert ──────────────────────────────────────────────────────

  router.put('/:brandId/draft', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    const parsed = BrandRecordPatchSchema.safeParse(req.body?.changes ?? req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid brand record',
        issues: parsed.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
      return
    }

    const brand = await store.get(auth.userId, auth.workspaceId, { id: req.params.brandId })
    if (!brand) {
      res.status(404).json({ error: 'Brand not found' })
      return
    }

    // Same base rule as the chat tool: patch the in-flight draft when there is
    // one, otherwise the approved record. Patching the approved record while a
    // draft exists would silently discard a colleague's unapproved work.
    const merged = mergeBrandRecordPatch(brand.draft ?? brand.activeRecord ?? null, parsed.data)
    const validated = BrandRecordSchema.safeParse(merged)
    if (!validated.success) {
      res.status(400).json({
        error: 'The change would leave the brand record invalid',
        issues: validated.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
      return
    }

    // `writtenBy` is left at its 'user' default: this route is a human in
    // Studio. The chat tool and the brain-MCP bridge pass 'system', which is
    // what marks their lifecycle event bot-authored.
    const saved = await store.saveDraft(auth.userId, auth.workspaceId, brand.id, validated.data)
    res.json({ brand: saved })
  })

  // ── Approve ───────────────────────────────────────────────────────────

  router.post('/:brandId/approve', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      res.status(403).json({ error: 'Only a workspace owner or admin can approve a brand version.' })
      return
    }
    const approval = await store.approve(auth.userId, auth.workspaceId, req.params.brandId, auth.userId)
    if (!approval) {
      // The store returns null both for "no such brand" and for "nothing in
      // flight". Reporting the second honestly matters: a double-clicked
      // Approve button must read as already-approved, not as an error.
      const brand = await store.get(auth.userId, auth.workspaceId, { id: req.params.brandId })
      if (!brand) {
        res.status(404).json({ error: 'Brand not found' })
        return
      }
      res.status(409).json({ error: 'There is no unapproved draft to approve.', brand })
      return
    }
    res.json({ brand: approval.brand, version: approval.version })
  })

  // ── Version history ───────────────────────────────────────────────────

  router.get('/:brandId/versions', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    const versions = await store.listVersions(auth.userId, auth.workspaceId, req.params.brandId)
    res.json({ versions })
  })

  router.get('/:brandId/versions/:version', async (req, res) => {
    const auth = await verifyMember(req as never, res)
    if (!auth) return
    const version = Number(req.params.version)
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ error: 'version must be a positive integer' })
      return
    }
    const row = await store.getVersion(auth.userId, auth.workspaceId, req.params.brandId, version)
    if (!row) {
      res.status(404).json({ error: 'Version not found' })
      return
    }
    res.json({ version: row })
  })

  return router
}
