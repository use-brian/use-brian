/**
 * Doc v1 — user-defined entity types + instances REST API (Phase B of the
 * editable Notion-database table view).
 *
 * Exposes the `DocEntityStore` (chat-tool-only until now) over HTTP so the
 * app-web table UI can edit the SCHEMA (add / rename / delete / retype a
 * property) and the ROWS (create / update / delete an instance) of a
 * user-defined entity table. The `data` block's `{ entity: 'custom' }` binding
 * resolves through `buildPayload` (the views render route); these routes are
 * the write side.
 *
 * Mounted under `requireAuth` in `apps/api/src/index.ts`. Every handler
 * re-checks workspace membership via `WorkspaceStore.getRole` (the entity RLS
 * is workspace-keyed, so the route IS the per-user trust boundary). Body shape
 * is validated loosely here (`workspaceId` + structural presence) and deeply by
 * the store's own Zod (`docEntityTypeSchema` / `docEntityInstanceSchema`).
 *
 * [COMP:api/doc-entities-routes]
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { DocEntityStore, CellValue, PropertyDef } from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'

export type DocEntitiesRouteOptions = {
  docEntityStore: DocEntityStore
  workspaceStore: WorkspaceStore
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error })
}

const uuid = z.string().uuid()

export function docEntitiesRoutes(opts: DocEntitiesRouteOptions): Router {
  const router = Router()

  /** Resolve `{ userId, workspaceId }` after verifying membership, or write the
   *  error and return null. `workspaceId` is read from the query string. */
  async function member(
    req: Request,
    res: Response,
  ): Promise<{ userId: string; workspaceId: string } | null> {
    const userId = (req as { userId?: string }).userId
    if (!userId) return fail(res, 401, 'Unauthorized'), null
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : ''
    if (!uuid.safeParse(workspaceId).success) return fail(res, 400, 'workspaceId query param is required'), null
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return fail(res, 403, 'Not a member of this workspace'), null
    return { userId, workspaceId }
  }

  function serverError(res: Response, where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[doc-entities] ${where} failed:`, err)
    if (/unique/i.test(message)) fail(res, 409, message)
    else if (/not found/i.test(message)) fail(res, 404, message)
    else if (/already exists|collide/i.test(message)) fail(res, 409, message)
    else res.status(500).json({ error: `Failed to ${where}`, message })
  }

  // ── Entity types ─────────────────────────────────────────────────────

  // Read a type incl. its properties (app-web needs name/icon/properties for
  // the table title + the column type-pickers).
  router.get('/entity-types/:id', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    const type = await opts.docEntityStore.getEntityType(ctx.workspaceId, req.params.id)
    if (!type) return fail(res, 404, 'Entity type not found')
    res.json(type)
  })

  const createTypeBody = z.object({
    workspaceId: uuid,
    name: z.string().min(1).max(256),
    icon: z.string().min(1).max(64).optional(),
    properties: z.array(z.record(z.unknown())).min(1).max(128),
  })

  // Create a new user-defined type (the "+ New database" flow).
  router.post('/entity-types', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return fail(res, 401, 'Unauthorized')
    const parsed = createTypeBody.safeParse(req.body ?? {})
    if (!parsed.success) return fail(res, 400, parsed.error.issues.map((i) => i.message).join('; '))
    const role = await opts.workspaceStore.getRole(userId, parsed.data.workspaceId)
    if (!role) return fail(res, 403, 'Not a member of this workspace')
    try {
      const created = await opts.docEntityStore.createEntityType({
        workspaceId: parsed.data.workspaceId,
        name: parsed.data.name,
        icon: parsed.data.icon,
        properties: parsed.data.properties as unknown as PropertyDef[],
        createdBy: userId,
      })
      res.status(201).json(created)
    } catch (err) {
      serverError(res, 'create entity type', err)
    }
  })

  // Replace the property list (used by the column "retype" — swap one
  // property's config in place). Body: { properties }.
  router.patch('/entity-types/:id', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    const props = (req.body ?? {}).properties
    if (!Array.isArray(props)) return fail(res, 400, 'properties array is required')
    try {
      const updated = await opts.docEntityStore.updateEntityType(ctx.workspaceId, req.params.id, {
        properties: props as unknown as PropertyDef[],
      })
      res.json(updated)
    } catch (err) {
      serverError(res, 'update entity type', err)
    }
  })

  // Add a property (column insert). Read-modify-write the property array;
  // guards a name collision before the store call.
  router.post('/entity-types/:id/properties', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    const property = (req.body ?? {}).property as PropertyDef | undefined
    if (!property || typeof property.name !== 'string') return fail(res, 400, 'property is required')
    try {
      const current = await opts.docEntityStore.getEntityType(ctx.workspaceId, req.params.id)
      if (!current) return fail(res, 404, 'Entity type not found')
      if (current.properties.some((p) => p.name === property.name)) {
        return fail(res, 409, `Property "${property.name}" already exists`)
      }
      const updated = await opts.docEntityStore.updateEntityType(ctx.workspaceId, req.params.id, {
        properties: [...current.properties, property],
      })
      res.status(201).json(updated)
    } catch (err) {
      serverError(res, 'add property', err)
    }
  })

  // Remove a property (column delete). Cell values stay in the JSONB (soft).
  router.delete('/entity-types/:id/properties/:name', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    try {
      const current = await opts.docEntityStore.getEntityType(ctx.workspaceId, req.params.id)
      if (!current) return fail(res, 404, 'Entity type not found')
      if (!current.properties.some((p) => p.name === req.params.name)) {
        return fail(res, 404, `Property "${req.params.name}" not found`)
      }
      const updated = await opts.docEntityStore.updateEntityType(ctx.workspaceId, req.params.id, {
        properties: current.properties.filter((p) => p.name !== req.params.name),
      })
      res.json(updated)
    } catch (err) {
      serverError(res, 'remove property', err)
    }
  })

  // Rename a property (column rename) — atomic schema + data migration.
  router.patch('/entity-types/:id/properties/:name', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    const newName = (req.body ?? {}).newName
    if (typeof newName !== 'string' || newName.length < 1 || newName.length > 128) {
      return fail(res, 400, 'newName is required')
    }
    try {
      const updated = await opts.docEntityStore.renameProperty(
        ctx.workspaceId,
        req.params.id,
        req.params.name,
        newName,
      )
      res.json(updated)
    } catch (err) {
      serverError(res, 'rename property', err)
    }
  })

  // ── Entity instances (rows) ──────────────────────────────────────────

  const createEntityBody = z.object({
    workspaceId: uuid,
    entityTypeId: uuid,
    data: z.record(z.unknown()),
  })

  router.post('/entities', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return fail(res, 401, 'Unauthorized')
    const parsed = createEntityBody.safeParse(req.body ?? {})
    if (!parsed.success) return fail(res, 400, parsed.error.issues.map((i) => i.message).join('; '))
    const role = await opts.workspaceStore.getRole(userId, parsed.data.workspaceId)
    if (!role) return fail(res, 403, 'Not a member of this workspace')
    try {
      const created = await opts.docEntityStore.createEntity({
        entityTypeId: parsed.data.entityTypeId,
        workspaceId: parsed.data.workspaceId,
        data: parsed.data.data as unknown as Record<string, CellValue>,
        sourceApp: 'doc',
        createdBy: userId,
        lastEditedBy: userId,
      })
      res.status(201).json(created)
    } catch (err) {
      serverError(res, 'create entity', err)
    }
  })

  router.patch('/entities/:id', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    const data = (req.body ?? {}).data
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      return fail(res, 400, 'data object with at least one cell is required')
    }
    try {
      const updated = await opts.docEntityStore.updateEntity(ctx.workspaceId, req.params.id, {
        data: data as Record<string, CellValue>,
        lastEditedBy: ctx.userId,
      })
      res.json(updated)
    } catch (err) {
      serverError(res, 'update entity', err)
    }
  })

  router.delete('/entities/:id', async (req, res) => {
    const ctx = await member(req, res)
    if (!ctx) return
    try {
      await opts.docEntityStore.deleteEntity(ctx.workspaceId, req.params.id)
      res.json({ ok: true })
    } catch (err) {
      serverError(res, 'delete entity', err)
    }
  })

  return router
}
