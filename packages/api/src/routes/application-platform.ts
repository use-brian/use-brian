/** One thin transport over the canonical application dispatcher. [COMP:api/application-auth] */
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError, applicationCommandSchema } from '@use-brian/shared'
import { query } from '../db/client.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'
import { authenticateApplicationRequest, ApplicationHomeBudgetExceeded, type ApplicationHomeAuthenticationOptions } from '../application-platform/request-auth.js'
import { getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import type { ApplicationPlatformService } from '../application-platform/service.js'
import type { ApplicationManagementService } from '../application-platform/management.js'
import { createApplicationConsentAdapter, loadApplicationOAuthClientSystem } from '../application-platform/oauth-consent.js'
import { oauthRoutes, type OAuthRoutesOptions } from '../brain-mcp/oauth/routes.js'
import { createDbOAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { serveStatelessMcp } from '../brain-mcp/stateless.js'
import { buildApplicationMcpTools } from '../application-platform/mcp.js'

export interface ApplicationRoutesOptions {
  service: ApplicationPlatformService
  management?: { service: ApplicationManagementService; requireAuth: RequestHandler; origins: readonly string[] }
  oauth?: Pick<OAuthRoutesOptions, 'clientStore' | 'workspaceStore' | 'signingSecret' | 'webAppUrl' | 'requireAuth'>
  home?: ApplicationHomeAuthenticationOptions
}

/** Public authentication metadata only, never record content or application rights. */
async function originAllowed(appId: string, origin: string) {
  const result = await query<{ origins: string[] }>("SELECT origins FROM application_clients WHERE id=$1 AND status='active'", [appId])
  return result.rows[0]?.origins.includes(origin) === true
}
export function applicationPlatformRoutes(options: ApplicationRoutesOptions): Router {
  const router = Router()
  const homeRequests = new WeakMap<Request, ExecutionContext>()
  router.use(express.json({ limit: '256kb' }))
  const management = options.management
  if (management) {
    router.use('/workspaces/:workspaceId', (req, res, next) => {
      res.set('Cache-Control', 'no-store')
      if (!z.string().uuid().safeParse(req.params.workspaceId).success) { res.status(404).json({ error: 'access_unavailable' }); return }
      if (req.headers.origin !== undefined) {
        res.vary('Origin')
        if (!management.origins.includes(req.headers.origin)) { res.status(403).json({ error: 'access_unavailable' }); return }
        res.set('Access-Control-Allow-Origin', req.headers.origin)
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version')
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      }
      if (req.method === 'OPTIONS') { res.sendStatus(204); return }
      next()
    }, management.requireAuth)
    const manage = (operation: (req: Request, actorId: string, workspaceId: string) => Promise<unknown>) => async (req: Request, res: Response) => {
      try {
        if (!req.userId) { res.status(401).json({ error: 'authentication_required' }); return }
        for (const [key, value] of Object.entries(req.params)) if (key !== 'workspaceId' && !z.string().uuid().safeParse(value).success) {
          throw new ApplicationPlatformError('invalid_value', 'The application identifier is invalid.')
        }
        res.json(await operation(req, req.userId, String(req.params.workspaceId)))
      } catch (error) {
        if (error instanceof AuthorityChangedError) { res.status(403).json({ error: 'grant_revoked',effect: error.operationMayHaveExecuted ? 'uncertain' : 'none',retrySafe: false }); return }
        if (error instanceof ApplicationPlatformError) res.status(error.code === 'invalid_value' ? 400 : error.code === 'access_unavailable' ? 403 : 409)
          .json({ error: error.code, effect: error.effect, retrySafe: error.retrySafe })
        else res.status(503).json({ error: 'access_unavailable', effect: 'none', retrySafe: false })
      }
    }
    const base = '/workspaces/:workspaceId'
    const requestSignal = (req: Request) => {
      const controller=new AbortController();if (req.aborted) controller.abort();else req.once('aborted',() => controller.abort());return controller.signal
    }
    router.post(`${base}/schemas/:schemaId/preview`,manage((req,actor,workspace) =>
      management.service.previewSchema(actor,workspace,String(req.params.schemaId),req.body,requestSignal(req))))
    router.post(`${base}/schema-reviews/:reviewId/apply`,manage((req,actor,workspace) =>
      management.service.applySchema(actor,workspace,String(req.params.reviewId),req.body,requestSignal(req))))
    router.post(`${base}/schema-mcp`,async (req,res) => {
      if (!req.userId) { res.status(401).json({ error: 'authentication_required' });return }
      try {
        const tools=await management.service.schemaMcpTools(req.userId,String(req.params.workspaceId),req.query,requestSignal(req))
        await serveStatelessMcp(req,res,tools,'use-brian-native-schema-management')
      } catch (error) {
        if (res.headersSent) return
        const code=error instanceof ApplicationPlatformError ? error.code : error instanceof AuthorityChangedError ? 'grant_revoked' : 'access_unavailable'
        res.status(code==='authentication_required' ? 401 : code==='invalid_value' ? 400 : 403).json({ error: code,effect: 'none',retrySafe: false })
      }
    })
    router.get(`${base}/governance/catalog`,manage((req,actor,workspace) => management.service.governanceCatalog(actor,workspace,req.query,requestSignal(req))))
    router.post(`${base}/governance/preview`,manage((req,actor,workspace) => management.service.previewGovernance(actor,workspace,req.body,requestSignal(req))))
    router.post(`${base}/governance/reviews/:reviewId/apply`,manage((req,actor,workspace) => management.service.applyGovernance(actor,workspace,String(req.params.reviewId),req.body,requestSignal(req))))
    router.post(`${base}/governance/mcp`,async (req,res) => {
      if (!req.userId) {res.status(401).json({error:'authentication_required'});return}
      try {
        const tools=await management.service.governanceMcpTools(req.userId,String(req.params.workspaceId),req.query,requestSignal(req))
        await serveStatelessMcp(req,res,tools,'use-brian-native-module-governance')
      } catch (error) {
        if (res.headersSent) return
        const code=error instanceof ApplicationPlatformError ? error.code : error instanceof AuthorityChangedError ? 'grant_revoked' : 'access_unavailable'
        res.status(code==='authentication_required'?401:code==='invalid_value'?400:403).json({error:code,effect:'none',retrySafe:false})
      }
    })
    router.get(`${base}/management`,manage((req,actor,workspace)=>management.service.overview(actor,workspace,req.query)))
    router.post(`${base}/management/commands`,manage((req,actor,workspace)=>management.service.executeCommand(actor,workspace,req.body)))
    router.post(`${base}/management/mcp`,async(req,res)=>{
      if(!req.userId){res.status(401).json({error:'authentication_required'});return}
      try { const tools=await management.service.managementMcpTools(req.userId,String(req.params.workspaceId),req.query)
        await serveStatelessMcp(req,res,tools,'use-brian-native-application-management')
      } catch(error) {if(res.headersSent)return;const code=error instanceof ApplicationPlatformError?error.code:'access_unavailable';res.status(code==='invalid_value'?400:403).json({error:code,effect:'none',retrySafe:false})}
    })
    router.get(`${base}/clients`, manage((_req, actor, workspace) => management.service.list(actor, workspace)))
    router.post(`${base}/clients`, manage((req, actor, workspace) => {
      if (req.body?.workspaceId !== workspace) throw new ApplicationPlatformError('invalid_value', 'The application workspace is invalid.')
      return management.service.create(actor, req.body)
    }))
    router.post(`${base}/clients/:clientId/status`, manage((req, actor, workspace) => {
      const input = z.object({ status: z.enum(['active', 'suspended', 'revoked']) }).strict().safeParse(req.body)
      if (!input.success) throw new ApplicationPlatformError('invalid_value', 'The application status is invalid.')
      return management.service.setStatus(actor, workspace, String(req.params.clientId), input.data.status)
    }))
    router.get(`${base}/clients/:clientId/grants`, manage((req, actor, workspace) => management.service.listGrants(actor, workspace, String(req.params.clientId))))
    router.post(`${base}/clients/:clientId/grants/review`, manage((req, actor, workspace) => management.service.reviewGrant(actor, workspace, String(req.params.clientId), req.body)))
    router.post(`${base}/clients/:clientId/grants/reviews/:reviewId/apply`, manage((req, actor, workspace) => management.service.applyGrantReview(actor, workspace, String(req.params.clientId), String(req.params.reviewId))))
    router.get(`${base}/clients/:clientId/credentials`, manage((req, actor, workspace) => management.service.listCredentials(actor, workspace, String(req.params.clientId))))
    router.post(`${base}/clients/:clientId/services`, manage((req, actor, workspace) => management.service.prepareServiceSubject(actor, workspace, String(req.params.clientId), req.body)))
    router.post(`${base}/clients/:clientId/credentials/review`, manage((req, actor, workspace) => management.service.reviewCredential(actor, workspace, String(req.params.clientId), req.body)))
    router.post(`${base}/clients/:clientId/credentials/reviews/:reviewId/apply`, manage((req, actor, workspace) => management.service.applyCredentialReview(actor, workspace, String(req.params.clientId), String(req.params.reviewId))))
    router.post(`${base}/clients/:clientId/grants/:grantId/revoke`, manage((req, actor, workspace) => management.service.revokeGrant(actor, workspace, String(req.params.clientId), String(req.params.grantId))))
    router.post(`${base}/clients/:clientId/credentials/:credentialId/revoke`, manage((req, actor, workspace) => management.service.revokeCredential(actor, workspace, String(req.params.clientId), String(req.params.credentialId))))
  }
  // This router must mount before global/bare member preflight/auth middleware.
  router.use('/:appId', async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!z.string().uuid().safeParse(req.params.appId).success) { res.status(404).json({ error: 'access_unavailable', effect: 'none', retrySafe: false }); return }
    try {
      const origin = req.headers.origin
      if (origin !== undefined) {
        res.vary('Origin')
        if (origin === 'null') {
          const client = options.home && (await query<{ home: boolean }>(`SELECT client_mode='home_app' AS home
            FROM application_clients WHERE id=$1 AND status='active'`,[req.params.appId])).rows[0]
          if (!client || !client.home) { res.status(403).json({ error: 'access_unavailable', effect: 'none', retrySafe: false }); return }
          if (req.method !== 'OPTIONS') {
            // Opaque browser origins require the existing signed Home audience,
            // not another credential profile. Reuse only within this request;
            // the canonical service still rechecks current authority at each boundary.
            homeRequests.set(req,await authenticateApplicationRequest(req,String(req.params.appId),options.home,'home'))
          }
        } else {
          const consent = req.path === '/consent' && options.oauth
          const allowed = consent ? origin === new URL(options.oauth!.webAppUrl).origin : await originAllowed(req.params.appId, origin)
          if (!allowed) { res.status(403).json({ error: 'access_unavailable', effect: 'none', retrySafe: false }); return }
        }
        res.set('Access-Control-Allow-Origin', origin)
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-UseBrian-User-Authorization')
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      }
      if (req.method === 'OPTIONS') { res.sendStatus(204); return }
      next()
    } catch (error) {
      const status = error instanceof ApplicationHomeBudgetExceeded ? 429 : error instanceof ApplicationPlatformError
        ? error.code === 'authentication_required' ? 401 : 403 : 503
      res.status(status).json({ error: error instanceof ApplicationPlatformError ? error.code : 'access_unavailable',effect: 'none',retrySafe: false })
    }
  })
  if (options.oauth) {
    const oauth = options.oauth
    router.use('/:appId', async (req, res, next) => {
      if (!['/authorize', '/consent', '/token', '/register'].includes(req.path)) { next(); return }
      try {
        const appId = String(req.params.appId), client = await loadApplicationOAuthClientSystem(appId)
        if (!client) { res.status(404).json({ error: 'invalid_client' }); return }
        const protocol = oauthRoutes({ ...oauth,
          clientStore: { register: async () => { throw new Error('Application clients use native management') },
            getByClientIdSystem: id => id === client.clientId ? oauth.clientStore.getByClientIdSystem(id) : Promise.resolve(null),
            touchLastUsedAt: id => id === client.clientId ? oauth.clientStore.touchLastUsedAt(id) : Promise.resolve() },
          authorizationStore: createDbOAuthAuthorizationStore({ audience: 'application', applicationClientId: appId }),
          applicationConsent: createApplicationConsentAdapter(appId, oauth.signingSecret),
        })
        protocol(req, res, next)
      } catch { res.status(503).json({ error: 'application_access_unavailable' }) }
    })
  }
  function endpoint(operation: (req: Request, execution: Awaited<ReturnType<typeof authenticateApplicationRequest>>) => Promise<unknown>, effectful = false) {
    return async (req: Request, res: Response) => {
      let committed = false
      try {
        const execution = homeRequests.get(req) ?? await authenticateApplicationRequest(req, String(req.params.appId), options.home)
        const result = await operation(req, execution)
        committed = effectful
        await execution.security.authority.assertCurrent()
        res.json(result)
      } catch (error) {
        if (error instanceof AuthorityChangedError) {
          res.status(403).json({ error: 'grant_revoked', effect: committed ? 'committed' : error.operationMayHaveExecuted ? 'uncertain' : 'none', retrySafe: false }); return
        }
        if (error instanceof ApplicationPlatformError) {
          if (error instanceof ApplicationHomeBudgetExceeded) { res.status(429).json({ error: error.code, effect: error.effect, retrySafe: false }); return }
          const status = error.code === 'authentication_required' ? 401 : ['access_unavailable','grant_revoked'].includes(error.code) ? 403
            : error.code === 'operation_not_available' ? 404 : error.code.endsWith('conflict') ? 409 : 400
          res.status(status).json({ error: error.code, effect: error.effect, retrySafe: error.retrySafe }); return
        }
        // No exception bodies/SQL/credential material enter the caller or log.
        res.status(503).json({ error: 'access_unavailable', effect: committed ? 'committed' : 'none', retrySafe: false })
      }
    }
  }
  router.get('/:appId/catalog', endpoint((_req, execution) => options.service.catalog(execution)))
  router.post('/:appId/mcp', async (req, res) => {
    try {
      const execution = homeRequests.get(req) ?? await authenticateApplicationRequest(req, String(req.params.appId), options.home)
      await serveStatelessMcp(req, res, await buildApplicationMcpTools(options.service, execution), 'use-brian-application')
    } catch (error) {
      if (res.headersSent) return
      res.status(error instanceof ApplicationHomeBudgetExceeded ? 429 : error instanceof ApplicationPlatformError ? error.code === 'authentication_required' ? 401
        : ['grant_revoked', 'access_unavailable'].includes(error.code) ? 403 : 400 : error instanceof AuthorityChangedError ? 403 : 503)
        .json({ error: error instanceof ApplicationPlatformError ? error.code : 'access_unavailable', effect: 'none', retrySafe: false })
    }
  })
  router.get('/:appId/mcp', (_req, res) => { res.status(405).json({ error: 'method_not_allowed' }) })
  router.get('/:appId/schemas/:type', endpoint(async (req, execution) => {
    const catalog = await options.service.catalog(execution)
    const schema = catalog.resources.find(resource => resource.typeKey === req.params.type)
    if (!schema) throw new ApplicationPlatformError('access_unavailable', 'The schema is unavailable.')
    return schema
  }))
  router.post('/:appId/queries/:queryKey', endpoint((req, execution) => options.service.query(execution,
    getApplicationExecutionBinding(execution)!.state.moduleKey, String(req.params.queryKey), req.body)))
  router.get('/:appId/records/:type/:id', endpoint((req, execution) => options.service.query(execution,
    getApplicationExecutionBinding(execution)!.state.moduleKey, 'get', { type: req.params.type, id: req.params.id })))
  router.get('/:appId/records/:type/:id/history', endpoint((req, execution) => options.service.query(execution,
    getApplicationExecutionBinding(execution)!.state.moduleKey, 'history', { type: req.params.type, id: req.params.id,
      ...(req.query.beforeVersion ? { beforeVersion: req.query.beforeVersion } : {}) })))
  router.post('/:appId/records/:type/query', endpoint((req, execution) => options.service.query(execution,
    getApplicationExecutionBinding(execution)!.state.moduleKey, 'query', { type: req.params.type, query: req.body })))
  router.post('/:appId/commands/:commandKey', endpoint((req, execution) => {
    const command = applicationCommandSchema.safeParse(req.body)
    if (!command.success) throw new ApplicationPlatformError('invalid_value', 'The command envelope is invalid.')
    return options.service.command(execution, getApplicationExecutionBinding(execution)!.state.moduleKey, String(req.params.commandKey), command.data)
  }, true))
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const kind = (error as { type?: string })?.type
    const invalid = kind === 'entity.too.large' || kind === 'entity.parse.failed'
    res.status(kind === 'entity.too.large' ? 413 : invalid ? 400 : 503)
      .json({ error: invalid ? 'invalid_value' : 'access_unavailable', effect: 'none', retrySafe: false })
  })
  return router
}
