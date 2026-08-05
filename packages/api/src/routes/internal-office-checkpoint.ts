/** doc-sync -> API immutable Office checkpoint handoff. [COMP:api/office-routes] */
import { Router } from 'express'

export type InternalOfficeCheckpointDeps = {
  sharedSecret?: string
  checkpoint(artifactId: string, expectedVersion: number, canonicalHash: string): Promise<{ version: number } | 'conflict' | 'not_found'>
}

export function internalOfficeCheckpointRoutes(deps: InternalOfficeCheckpointDeps): Router {
  const router = Router()
  router.post('/internal/office-checkpoint', async (req, res) => {
    if (!deps.sharedSecret || req.headers['x-doc-sync-secret'] !== deps.sharedSecret) return void res.status(403).json({ error: 'forbidden' })
    const body = (req.body ?? {}) as { artifactId?: unknown; expectedVersion?: unknown; canonicalHash?: unknown }
    if (typeof body.artifactId !== 'string' || !Number.isInteger(body.expectedVersion) || typeof body.canonicalHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.canonicalHash)) return void res.status(400).json({ error: 'invalid Office checkpoint' })
    const result = await deps.checkpoint(body.artifactId, body.expectedVersion as number, body.canonicalHash)
    if (result === 'not_found') return void res.status(200).json({ skipped: 'not_found' })
    if (result === 'conflict') return void res.status(409).json({ error: 'version_conflict' })
    res.status(201).json(result)
  })
  return router
}
