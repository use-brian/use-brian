/** [COMP:recordings/recovery] Both editions mount this authenticated surface. */
import { Router } from 'express'
import { z } from 'zod'
import { recordingRecovery, isRecordingRecoveryUnavailable } from './recovery.js'

export function recordingRecoveryRoutes(recover = recordingRecovery): Router {
  const router = Router()
  for (const prepare of [false, true]) {
    router[prepare ? 'post' : 'get'](prepare ? '/:recordingId/recover' : '/:recordingId/recovery', async (req, res) => {
      const userId = (req as unknown as { userId?: string }).userId
      if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
      const input = z.object({ workspaceId: z.string().uuid(), recordingId: z.string().uuid() }).safeParse({
        workspaceId: prepare ? req.body?.workspaceId : req.query.workspaceId,
        recordingId: req.params.recordingId,
      })
      if (!input.success) return void res.status(400).json({ error: 'invalid_recording_recovery_request' })
      try {
        const result = await recover({ actorUserId: userId }, input.data.workspaceId, input.data.recordingId, prepare)
        res.setHeader('Cache-Control', 'no-store')
        res.json(result)
      } catch (error) {
        // Do not distinguish absent/held/private/revoked sources in this surface.
        console.warn('[recordings] recovery unavailable:', error instanceof Error ? error.message : 'unknown')
        res.setHeader('Cache-Control', 'no-store')
        const unavailable = isRecordingRecoveryUnavailable(error)
        res.status(unavailable ? 404 : 503).json({ error: unavailable ? 'recording_recovery_unavailable' : 'recording_recovery_failed' })
      }
    })
  }
  return router
}
