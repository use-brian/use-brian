import { randomBytes, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveUser } from '../routes/route-helpers.js'
import {
  SupportCapsuleBuilder,
  SupportDiagnosticNotFoundError,
  SupportDiagnosticSessionError,
} from './bundle.js'
import { SupportDiagnosticsCaptureManager } from './capture.js'
import { SupportDiagnosticConflictError } from './store.js'
import {
  SUPPORT_DIAGNOSTIC_DURATIONS,
  type SupportDiagnosticStatus,
  type SupportDiagnosticsStore,
} from './types.js'

const workspaceSchema = z.object({
  workspaceId: z.string().uuid(),
})

const startSchema = workspaceSchema.extend({
  durationHours: z.union([
    z.literal(SUPPORT_DIAGNOSTIC_DURATIONS[0]),
    z.literal(SUPPORT_DIAGNOSTIC_DURATIONS[1]),
    z.literal(SUPPORT_DIAGNOSTIC_DURATIONS[2]),
  ]),
  includeContent: z.boolean().default(false),
})

const capsuleSchema = workspaceSchema.extend({
  sessionId: z.string().uuid().optional(),
})

export type SupportDiagnosticRouteOptions = {
  store: SupportDiagnosticsStore
  captureManager: SupportDiagnosticsCaptureManager
  capsuleBuilder: SupportCapsuleBuilder
}

export function supportDiagnosticRoutes(options: SupportDiagnosticRouteOptions): Router {
  const router = Router()

  router.get('/status', async (req, res) => {
    const parsed = workspaceSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'A valid workspaceId is required' })
      return
    }
    const identity = await authorizeOwnerOrAdmin(req, parsed.data.workspaceId)
    if (!identity.ok) {
      res.status(identity.status).json({ error: identity.error })
      return
    }
    const capture = await options.store.getOwnedActive(identity.userId, parsed.data.workspaceId)
    const body: SupportDiagnosticStatus = {
      active: Boolean(capture),
      capture: capture
        ? {
            id: capture.id,
            workspaceId: capture.workspaceId,
            includeContent: capture.includeContent,
            startedAt: capture.startedAt.toISOString(),
            expiresAt: capture.expiresAt.toISOString(),
            eventCount: capture.eventCount,
          }
        : null,
    }
    res.json(body)
  })

  router.post('/start', async (req, res) => {
    const parsed = startSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid support capture settings' })
      return
    }
    const identity = await authorizeOwnerOrAdmin(req, parsed.data.workspaceId)
    if (!identity.ok) {
      res.status(identity.status).json({ error: identity.error })
      return
    }
    try {
      const expiresAt = new Date(Date.now() + parsed.data.durationHours * 60 * 60 * 1_000)
      const capture = await options.store.start({
        id: randomUUID(),
        userId: identity.userId,
        workspaceId: parsed.data.workspaceId,
        includeContent: parsed.data.includeContent,
        pseudonymSalt: randomBytes(32),
        expiresAt,
      })
      options.captureManager.activate(capture)
      res.status(201).json({
        active: true,
        capture: {
          id: capture.id,
          workspaceId: capture.workspaceId,
          includeContent: capture.includeContent,
          startedAt: capture.startedAt.toISOString(),
          expiresAt: capture.expiresAt.toISOString(),
          eventCount: capture.eventCount,
        },
      } satisfies SupportDiagnosticStatus)
    } catch (error) {
      if (error instanceof SupportDiagnosticConflictError) {
        res.status(409).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.delete('/active', async (req, res) => {
    const parsed = workspaceSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'A valid workspaceId is required' })
      return
    }
    const identity = await authorizeOwnerOrAdmin(req, parsed.data.workspaceId)
    if (!identity.ok) {
      res.status(identity.status).json({ error: identity.error })
      return
    }
    const capture = await options.store.getOwnedActive(identity.userId, parsed.data.workspaceId)
    if (capture) await options.captureManager.deactivate(capture.id)
    const deletedId = await options.store.deleteOwnedCapture(identity.userId, parsed.data.workspaceId)
    res.json({ stopped: Boolean(deletedId) })
  })

  router.post('/capsule/preview', async (req, res) => {
    const parsed = capsuleSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid capsule request' })
      return
    }
    const identity = await authorizeOwnerOrAdmin(req, parsed.data.workspaceId)
    if (!identity.ok) {
      res.status(identity.status).json({ error: identity.error })
      return
    }
    try {
      await options.captureManager.flush()
      const preview = await options.capsuleBuilder.preview({
        userId: identity.userId,
        workspaceId: parsed.data.workspaceId,
        sessionId: parsed.data.sessionId,
      })
      res.json(preview)
    } catch (error) {
      if (handleCapsuleError(error, res)) return
      throw error
    }
  })

  router.post('/capsule', async (req, res) => {
    const parsed = capsuleSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid capsule request' })
      return
    }
    const identity = await authorizeOwnerOrAdmin(req, parsed.data.workspaceId)
    if (!identity.ok) {
      res.status(identity.status).json({ error: identity.error })
      return
    }
    try {
      await options.captureManager.flush()
      const { capture, capsule } = await options.capsuleBuilder.build({
        userId: identity.userId,
        workspaceId: parsed.data.workspaceId,
        sessionId: parsed.data.sessionId,
      })
      const body = JSON.stringify(capsule, null, 2)
      await options.captureManager.deactivate(capture.id)
      await options.store.deleteCapture(capture.id)

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="brian-support-capsule-${stamp}.json"`)
      res.send(body)
    } catch (error) {
      if (handleCapsuleError(error, res)) return
      throw error
    }
  })

  return router
}

async function authorizeOwnerOrAdmin(
  req: Request,
  workspaceId: string,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string }
> {
  const jwtUserId = (req as Request & { userId?: string }).userId
  const user = await resolveUser(jwtUserId)
  if (!user) return { ok: false, status: 401, error: 'Authentication required' }
  const role = await getWorkspaceRoleSystem(user.id, workspaceId)
  if (role !== 'owner' && role !== 'admin') {
    return { ok: false, status: 403, error: 'Workspace owner or admin access is required' }
  }
  return { ok: true, userId: user.id }
}

function handleCapsuleError(error: unknown, res: Response): boolean {
  if (error instanceof SupportDiagnosticNotFoundError) {
    res.status(404).json({ error: error.message })
    return true
  }
  if (error instanceof SupportDiagnosticSessionError) {
    res.status(error.status).json({ error: error.message })
    return true
  }
  return false
}
