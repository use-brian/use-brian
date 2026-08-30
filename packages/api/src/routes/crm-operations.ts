/**
 * Member-authenticated REST adapter for CRM operations.
 *
 * [COMP:api/crm-operations-route]
 */

import { Router, type Request, type Response } from 'express'
import {
  CreateCrmIntakeCredentialCommandSchema,
  CrmOperationsError,
  SaveCrmIntakeDefinitionCommandSchema,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { CrmIntakeReadStore } from '../db/crm-intake-store.js'

const SaveDefinitionBody = SaveCrmIntakeDefinitionCommandSchema.omit({ kind: true }).strict()
const CreateCredentialBody = CreateCrmIntakeCredentialCommandSchema.omit({ kind: true }).strict()

type Options = {
  workspaceStore: WorkspaceStore
  service: CrmOperationsServicePort
  readStore: CrmIntakeReadStore
}

function writeError(res: Response, error: unknown): void {
  if (error instanceof CrmOperationsError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'not_authorized' ? 403
        : error.code === 'conflict' ? 409 : 400
    res.status(status).json({ error: error.code, message: error.message, ...error.details })
    return
  }
  console.error('[crm-operations] request failed', error instanceof Error ? error.message : 'unknown')
  res.status(500).json({ error: 'internal' })
}

export function crmOperationsRoutes(options: Options): Router {
  const router = Router()

  async function context(req: Request, res: Response): Promise<CrmOperationsContext | null> {
    const userId = req.userId
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : ''
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await options.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    return {
      workspaceId,
      actor: { kind: 'user', userId },
      authority: {
        role,
        canWrite: true,
        canConfigure: role === 'owner' || role === 'admin',
        trustedIdentitySources: [],
      },
    }
  }

  router.get('/:workspaceId/operations/intake-definitions', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    try {
      res.json({ definitions: await options.readStore.listDefinitions(ctx.workspaceId) })
    } catch (error) {
      writeError(res, error)
    }
  })

  router.post('/:workspaceId/operations/intake-definitions', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = SaveDefinitionBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, { kind: 'save_intake_definition', ...body.data })
      res.status(output.created ? 201 : 200).json(output)
    } catch (error) {
      writeError(res, error)
    }
  })

  router.get('/:workspaceId/operations/intake-credentials', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    if (!ctx.authority.canConfigure) {
      res.status(403).json({ error: 'not_authorized' })
      return
    }
    try {
      res.json({ credentials: await options.readStore.listCredentials(ctx.workspaceId) })
    } catch (error) {
      writeError(res, error)
    }
  })

  router.post('/:workspaceId/operations/intake-credentials', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const body = CreateCredentialBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
      return
    }
    try {
      const output = await options.service.execute(ctx, { kind: 'create_intake_credential', ...body.data })
      res.status(201).json({ ...output, key: output.oneTimeSecret })
    } catch (error) {
      writeError(res, error)
    }
  })

  router.delete('/:workspaceId/operations/intake-credentials/:credentialId', async (req, res) => {
    const ctx = await context(req, res)
    if (!ctx) return
    const credentialId = typeof req.params.credentialId === 'string' ? req.params.credentialId : ''
    try {
      const output = await options.service.execute(ctx, { kind: 'revoke_intake_credential', credentialId })
      res.json(output)
    } catch (error) {
      writeError(res, error)
    }
  })

  return router
}
