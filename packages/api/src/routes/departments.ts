/**
 * Department management (permission model v2, D25): the REST face of the
 * actor-bound department commands. The Brian tools (`inspectDepartments`,
 * `manageDepartments`) and Organization -> Departments call the same store.
 * Spec: docs/architecture/features/workspace-access.md -> "Department
 * management and home departments (v2, migration 651)".
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { createDepartmentStore, type DepartmentStore } from '../db/department-store.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

const uuid = z.string().uuid()
const principal = z.object({ kind: z.enum(['user', 'assistant']), id: uuid }).strict()
const clearance = z.enum(['public', 'internal', 'confidential'])
const edgeBody = z.object({
  principal,
  clearance,
  expiresAt: z.string().datetime().nullable().optional(),
  expectedRevision: z.number().int().positive().optional(),
}).strict()
const removeBody = z.object({ principal, expectedRevision: z.number().int().positive().optional() }).strict()
const ownerBody = z.object({ userId: uuid, expectedRevision: z.number().int().positive().optional() }).strict()
const breakGlassBody = z.object({ reason: z.string().trim().min(1).max(1000) }).strict()
const homeBody = z.object({ principal, departmentId: uuid.nullable() }).strict()

export function departmentRoutes(store: DepartmentStore = createDepartmentStore()): Router {
  const router = Router()
  const fail = (res: Response, next: NextFunction, error: unknown) => {
    if (error instanceof WorkspaceAccessError) res.status(error.status).json({ error: error.code })
    else next(error)
  }
  router.use('/workspaces/:workspaceId/departments', (req, res, next) => {
    if (!req.userId) { res.status(401).json({ error: 'unauthorized' }); return }
    if (!uuid.safeParse(req.params.workspaceId).success) { res.status(404).json({ error: 'not_found' }); return }
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  /** A department id in the path must be one the caller can see in this workspace (I2). */
  const department = async (req: Request, res: Response): Promise<string | null> => {
    const id = String(req.params.departmentId)
    if (!uuid.safeParse(id).success || !(await store.inWorkspace(req.userId!, String(req.params.workspaceId), id))) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    return id
  }
  const body = <T>(schema: z.ZodType<T>, req: Request, res: Response): T | null => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_command' }); return null }
    return parsed.data
  }

  router.get('/workspaces/:workspaceId/departments', async (req, res, next) => {
    try {
      const workspaceId = String(req.params.workspaceId)
      res.json({ departments: await store.directory(req.userId!, workspaceId), homes: await store.homes(req.userId!, workspaceId) })
    } catch (error) { fail(res, next, error) }
  })
  router.put('/workspaces/:workspaceId/departments/home', async (req, res, next) => {
    try {
      const b = body(homeBody, req, res); if (!b) return
      await store.setHome(req.userId!, String(req.params.workspaceId), b.principal, b.departmentId)
      res.json({ ok: true })
    } catch (error) { fail(res, next, error) }
  })
  router.get('/workspaces/:workspaceId/departments/:departmentId', async (req, res, next) => {
    try {
      const id = await department(req, res); if (!id) return
      res.json({ edges: await store.listEdges(req.userId!, id) })
    } catch (error) { fail(res, next, error) }
  })
  router.put('/workspaces/:workspaceId/departments/:departmentId/edges', async (req, res, next) => {
    try {
      const id = await department(req, res); if (!id) return
      const b = body(edgeBody, req, res); if (!b) return
      res.json({ revision: await store.setEdge(req.userId!, id, b.principal, b.clearance, b.expiresAt ? new Date(b.expiresAt) : null, b.expectedRevision) })
    } catch (error) { fail(res, next, error) }
  })
  router.delete('/workspaces/:workspaceId/departments/:departmentId/edges', async (req, res, next) => {
    try {
      const id = await department(req, res); if (!id) return
      const b = body(removeBody, req, res); if (!b) return
      res.json({ revision: await store.removeEdge(req.userId!, id, b.principal, b.expectedRevision) })
    } catch (error) { fail(res, next, error) }
  })
  router.post('/workspaces/:workspaceId/departments/:departmentId/owners', async (req, res, next) => {
    try {
      const id = await department(req, res); if (!id) return
      const b = body(ownerBody, req, res); if (!b) return
      res.json({ revision: await store.addOwner(req.userId!, id, b.userId, b.expectedRevision) })
    } catch (error) { fail(res, next, error) }
  })
  router.delete('/workspaces/:workspaceId/departments/:departmentId/owners', async (req, res, next) => {
    try {
      const id = await department(req, res); if (!id) return
      const b = body(ownerBody, req, res); if (!b) return
      res.json({ revision: await store.removeOwner(req.userId!, id, b.userId, b.expectedRevision) })
    } catch (error) { fail(res, next, error) }
  })
  router.post('/workspaces/:workspaceId/departments/:departmentId/break-glass', async (req, res, next) => {
    try {
      const id = await department(req, res); if (!id) return
      const b = body(breakGlassBody, req, res); if (!b) return
      res.json({ revision: await store.breakGlass(req.userId!, id, b.reason) })
    } catch (error) { fail(res, next, error) }
  })
  return router
}
