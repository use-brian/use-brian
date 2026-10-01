import {inspectMigrationInventory,getMigrationInventory} from '../workspace-access/migration-inventory.js'
import {explainWorkspaceAccess,getWorkspaceAccessEvents,getWorkspaceDepartmentRegistry} from '../workspace-access/access-inspection.js'
import {prepareOrganizationCommand,applyOrganizationCommand} from '../workspace-access/organization-command-review.js'
import { Router } from 'express'
import { z } from 'zod'
import { workspaceAccessHistoryQuerySchema } from '../workspace-access/commands.js'
import { getWorkspaceAccess, getWorkspaceAccessHistory } from '../workspace-access/service.js'
import { applyDepartmentCommand, prepareDepartmentCommand } from '../workspace-access/command-review.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { getOrganizationChart, OrganizationError } from '../db/org-chart-store.js'
import { executeWorkspaceScopeReview, getWorkspaceScopeInventory } from '../workspace-access/scope-review.js'
import { getWorkspaceAccessMode } from '../workspace-access/mode-policy.js'
import { migrationItemApplySchema, createMigrationPlan, getMigrationPlan, listMigrationPlans, prepareMigrationItem, applyMigrationItem, setMigrationPlanState } from '../workspace-access/migration-service.js'
import { departmentCommandApplySchema } from '../workspace-access/commands.js'

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
  router.get('/workspaces/:workspaceId/access/mode',async(req,res,next)=>{
    try{res.json(await getWorkspaceAccessMode(String(req.params.workspaceId),req.userId!))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.get('/workspaces/:workspaceId/access/migrations',async(req,res,next)=>{
    try{
      const query=z.object({after:z.string().uuid().optional()}).strict().safeParse(req.query)
      if(!query.success){res.status(400).json({error:'invalid_command'});return}
      res.json({plans:await listMigrationPlans(String(req.params.workspaceId),req.userId!,query.data.after)})
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/migrations',async(req,res,next)=>{
    try{res.json(await createMigrationPlan(String(req.params.workspaceId),req.userId!,req.body))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.use('/workspaces/:workspaceId/access/migrations/:planId',(req,res,next)=>{
    if(!z.string().uuid().safeParse(req.params.planId).success){res.status(404).json({error:'not_found'});return}
    next()
  })
  router.get('/workspaces/:workspaceId/access/migrations/:planId',async(req,res,next)=>{
    try{res.json(await getMigrationPlan(String(req.params.workspaceId),req.userId!,String(req.params.planId)))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.get('/workspaces/:workspaceId/access/migrations/:planId/inventory',async(req,res,next)=>{
    try{res.json(await getMigrationInventory(String(req.params.workspaceId),req.userId!,String(req.params.planId),req.query))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/migrations/:planId/inventory',async(req,res,next)=>{
    try{res.json(await inspectMigrationInventory(String(req.params.workspaceId),req.userId!,String(req.params.planId),req.body))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/migrations/:planId/state',async(req,res,next)=>{
    try{
      const parsed=z.object({state:z.enum(['paused','cancelled','proposed'])}).strict().safeParse(req.body)
      if(!parsed.success){res.status(400).json({error:'invalid_command'});return}
      res.json(await setMigrationPlanState(String(req.params.workspaceId),req.userId!,String(req.params.planId),parsed.data.state))
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/migrations/:planId/items/:itemId/review',async(req,res,next)=>{
    try{
      if(!z.string().uuid().safeParse(req.params.itemId).success){res.status(404).json({error:'not_found'});return}
      if(!z.object({}).strict().safeParse(req.body).success){res.status(400).json({error:'invalid_command'});return}
      res.json(await prepareMigrationItem(String(req.params.workspaceId),req.userId!,String(req.params.planId),String(req.params.itemId)))
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  router.post('/workspaces/:workspaceId/access/migrations/:planId/items/:itemId/apply',async(req,res,next)=>{
    try{
      if(!z.string().uuid().safeParse(req.params.itemId).success){res.status(404).json({error:'not_found'});return}
      const parsed=migrationItemApplySchema.safeParse(req.body)
      if(!parsed.success){res.status(400).json({error:'invalid_command'});return}
      res.json(await applyMigrationItem(String(req.params.workspaceId),req.userId!,String(req.params.planId),String(req.params.itemId),parsed.data))
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  for(const [suffix,read] of [['explain',explainWorkspaceAccess],['events',getWorkspaceAccessEvents],['registry',getWorkspaceDepartmentRegistry]] as const)router.get(`/workspaces/:workspaceId/access/${suffix}`,async(req,res,next)=>{
    try{res.json(await read(String(req.params.workspaceId),req.userId!,req.query))}
    catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  });
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
      const query=z.object({kind:z.string().optional(),includeClassified:z.literal('true').optional(),after:z.string().uuid().optional(),reviewId:z.string().uuid().optional(),reviewAfter:z.string().uuid().optional()}).strict().safeParse(req.query)
      if(!query.success){res.status(400).json({error:'invalid_command'});return}
      res.json(await getWorkspaceScopeInventory(String(req.params.workspaceId),req.userId!,query.data.kind,query.data.after,query.data.reviewId,query.data.reviewAfter,...(query.data.includeClassified?[true] as const:[])))
    }catch(error){if(error instanceof WorkspaceAccessError)res.status(error.status).json({error:error.code});else next(error)}
  })
  return router
}
