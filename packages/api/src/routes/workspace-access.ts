import {prepareOrganizationCommand,applyOrganizationCommand} from '../workspace-access/organization-command-review.js'
import { Router } from 'express'
import { z } from 'zod'
import { workspaceAccessHistoryQuerySchema } from '../workspace-access/commands.js'
import { getWorkspaceAccess, getWorkspaceAccessHistory } from '../workspace-access/service.js'
import { applyDepartmentCommand, prepareDepartmentCommand } from '../workspace-access/command-review.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { getOrganizationChart, OrganizationError } from '../db/org-chart-store.js'
import { executeWorkspaceScopeReview, getWorkspaceScopeInventory } from '../workspace-access/scope-review.js'

/** Both HTTP and native assistant commands enter the same transactional service. */
export function workspaceAccessRoutes(): Router {
  const router = Router()
  router.use('/workspaces/:workspaceId', (req,res,next) => {
    if (!req.userId) { res.status(401).json({error:'unauthorized'}); return }
    if (!z.string().uuid().safeParse(req.params.workspaceId).success) { res.status(404).json({error:'not_found'}); return }
    res.setHeader('Cache-Control','no-store')
    next()
  })
  router.get('/workspaces/:workspaceId/org-chart',async(req,res,next) => {
    try { res.json(await getOrganizationChart(String(req.params.workspaceId),req.userId!)) }
    catch(error) { if (error instanceof OrganizationError || error instanceof WorkspaceAccessError) res.status(error.status).json({error:error.code}); else next(error) }
  })
  router.get('/workspaces/:workspaceId/access',async(req,res,next) => {
    try { res.json(await getWorkspaceAccess(String(req.params.workspaceId),req.userId!)) }
    catch(error) { if (error instanceof WorkspaceAccessError) res.status(error.status).json({error:error.code}); else next(error) }
  })
  for(const kind of ['requests','grants'] as const)router.get(`/workspaces/:workspaceId/access/${kind}`,async(req,res,next)=>{
    try{
      const parsed=workspaceAccessHistoryQuerySchema.safeParse(req.query);
      if(!parsed.success){res.status(400).json({error:'invalid_command'});return}
      res.json(await getWorkspaceAccessHistory(String(req.params.workspaceId),req.userId!,kind,parsed.data));
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  });
  router.post('/workspaces/:workspaceId/org-chart/command-review',async(req,res,next)=>{
    try{res.json(await prepareOrganizationCommand(String(req.params.workspaceId),req.userId!,req.body))}
    catch(error){if(error instanceof OrganizationError||error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/command-review',async(req,res,next)=>{
    try{res.json(await prepareDepartmentCommand(String(req.params.workspaceId),req.userId!,req.body))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/commands',async(req,res,next) => {
    try { const execute = typeof req.body?.type === 'string' && req.body.type.startsWith('org.') ? applyOrganizationCommand : typeof req.body?.type === 'string' && req.body.type.startsWith('scope.review.') ? executeWorkspaceScopeReview : applyDepartmentCommand; res.json(await execute(String(req.params.workspaceId),req.userId!,req.body)) }
    catch(error) { if (error instanceof OrganizationError || error instanceof WorkspaceAccessError) res.status(error.status).json({error:error.code}); else next(error) }
  })
  router.get('/workspaces/:workspaceId/scope-review',async(req,res,next)=>{
    try {
      const query=z.object({kind:z.string().optional(),after:z.string().uuid().optional(),reviewId:z.string().uuid().optional(),reviewAfter:z.string().uuid().optional()}).strict().safeParse(req.query)
      if(!query.success){res.status(400).json({error:'invalid_command'});return}
      res.json(await getWorkspaceScopeInventory(String(req.params.workspaceId),req.userId!,query.data.kind,query.data.after,query.data.reviewId,query.data.reviewAfter))
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  return router
}
