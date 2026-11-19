/** Shared CRM member context and workspace module lifecycle routes.
 * [COMP:api/workspace-modules]
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AssociationContext } from '@use-brian/core/association/operations.js'
import {
  WORKSPACE_MODULES,
  WORKSPACE_MODULE_ACTIONS,
  WorkspaceModuleError,
  isWorkspaceModuleKey,
  type WorkspaceModuleActionResult,
  type WorkspaceModuleDefinition,
  type WorkspaceModuleRegistry,
} from '@use-brian/shared'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { crmErrorResponse } from './crm-errors.js'
import type { WorkspaceModulesStore } from '../db/workspace-modules-store.js'

export type CrmMemberContextResolver = (req: Request, res: Response) => Promise<AssociationContext | null>
export function crmMemberContext(workspaces: WorkspaceStore): CrmMemberContextResolver {
  return async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    const workspaceId = z.string().uuid().safeParse(req.params.workspaceId)
    if (!workspaceId.success) { res.status(400).json({ error: 'invalid_workspace' }); return null }
    const role = await workspaces.getRole(req.userId, workspaceId.data)
    if (!role) { res.status(404).json({ error: 'workspace_not_found' }); return null }
    return { workspaceId: workspaceId.data, actor: { kind: 'user', userId: req.userId },
      authority: { role, canRead: true, canWrite: true, canConfigure: role === 'owner' || role === 'admin',
        canReconcileProvider: false, trustedIdentitySources: [] } }
  }
}

function moduleWireProjection(definition: WorkspaceModuleDefinition,
  result: WorkspaceModuleActionResult): Record<string, number> {
  const compatibility = definition.blockingCountCompatibility
  if (!compatibility) return {}
  return { [compatibility.field]: result.blockingWork.find((row) => row.key === compatibility.blockerKey)?.count ?? 0 }
}

export function workspaceModuleRoutes(options: {
  workspaceStore: WorkspaceStore
  modules: WorkspaceModulesStore
  registry?: WorkspaceModuleRegistry
}): Router {
  const router = Router()
  const registry: WorkspaceModuleRegistry = options.registry ?? WORKSPACE_MODULES
  const context = crmMemberContext(options.workspaceStore)
  router.get('/:workspaceId/modules', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx || ctx.actor.kind !== 'user') return
      res.json({ registry, modules: await options.modules.listForMember(ctx.workspaceId, ctx.actor.userId) })
    } catch (error) { crmErrorResponse(error, res) }
  })
  router.post('/:workspaceId/modules/:moduleKey/actions', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx || ctx.actor.kind !== 'user') return
      if (!ctx.authority.canConfigure || !['owner', 'admin'].includes(ctx.authority.role)) {
        throw new WorkspaceModuleError('not_authorized', 'An owner or admin member is required')
      }
      const moduleKey = req.params.moduleKey
      if (!isWorkspaceModuleKey(moduleKey, registry)) {
        throw new WorkspaceModuleError('invalid_input', 'A registered workspace module is required.', { moduleKey })
      }
      const body = z.object({ action: z.enum(WORKSPACE_MODULE_ACTIONS), expectedVersion: z.number().int().nonnegative() }).strict().parse(req.body)
      const result = await options.modules.act(ctx.workspaceId, ctx.actor.userId, moduleKey, body)
      res.json({ ...moduleWireProjection(registry[moduleKey], result), module: result.module,
        changed: result.changed, blockingWork: result.blockingWork })
    } catch (error) { crmErrorResponse(error, res) }
  })
  return router
}
