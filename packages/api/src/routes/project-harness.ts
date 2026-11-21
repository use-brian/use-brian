/** Authenticated engineering contracts and independently reviewed acceptance. [COMP:api/project-harness] */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { createProjectHarnessStore, readHarnessProjectSnapshot } from '../db/project-harness-store.js'
import { createHarnessExecutionStore } from '../db/project-harness-execution-store.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { approveRevisionSchema, createHarnessRunSchema, humanEvidenceSchema, type HarnessExecutionStore, type HarnessHumanActor } from '../project-harness/execution-contracts.js'
import { impactRequestSchema, selectHarnessImpact } from '../project-harness/impact.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import {
  createEngineeringNodeSchema, harnessScopeSchema, putHarnessDefinitionSchema, updateEngineeringNodeSchema,
  type ProjectHarnessStore,
} from '../project-harness/contracts.js'
import { resolveHarness } from '../project-harness/resolve.js'

const uuid = z.string().uuid()
const scopeQuery = z.object({
  scope: z.enum(['project', 'product', 'component']), productId: uuid.optional(), componentId: uuid.optional(),
}).strict().transform(({ scope, ...ids }) => harnessScopeSchema.parse({ kind: scope, ...ids }))
type Actor = { userId: string; workspaceId: string; projectId: string }
const base = '/workspaces/:workspaceId/projects/:projectId/harness'

export function projectHarnessRoutes(options: {
  store?: ProjectHarnessStore; execution?: HarnessExecutionStore;
  snapshot?: typeof readHarnessProjectSnapshot;
} = {}): Router {
  const router = Router({ mergeParams: true })
  const store = options.store ?? createProjectHarnessStore()
  const execution = options.execution ?? createHarnessExecutionStore()
  const snapshot = options.snapshot ?? readHarnessProjectSnapshot
  function human(req: Request): HarnessHumanActor {
    // Human JWT sessions only; legacy tokens and delegated/assistant contexts
    // may read as authorized, but cannot approve, execute or submit evidence.
    if (!req.userId || !uuid.safeParse(req.authSessionId).success || currentAgentAccess()) {
      throw new WorkspaceAccessError('harness_human_required', 403)
    }
    return { userId: req.userId, authSessionId: req.authSessionId! }
  }
  const emptyBody = z.object({}).strict()
  const param = (req: Request, name: string) => uuid.parse(req.params[name])
  function handle(work: (actor: Actor, req: Request) => Promise<unknown>, status = 200) {
    return async (req: Request, res: Response) => {
      // Protected definitions, including empty responses, must not enter shared HTTP caches.
      res.setHeader('Cache-Control', 'no-store')
      if (!req.userId) return void res.status(401).json({ error: 'unauthorized' })
      if (!uuid.safeParse(req.params.workspaceId).success || !uuid.safeParse(req.params.projectId).success) {
        return void res.status(404).json({ error: 'harness_not_found' })
      }
      const actor = { userId: req.userId, workspaceId: String(req.params.workspaceId), projectId: String(req.params.projectId) }
      try {
        res.status(status).json(await work(actor, req))
      } catch (error) {
        if (error instanceof z.ZodError) return void res.status(400).json({ error: 'harness_invalid_input' })
        if (error instanceof WorkspaceAccessError) return void res.status(error.status).json({ error: error.code })
        throw error
      }
    }
  }
  router.get(`${base}/tree`, handle(a => store.tree(a.userId, a.workspaceId, a.projectId)))
  router.post(`${base}/products`, handle(async (a, req) => ({
    product: await store.createProduct(a.userId, a.workspaceId, a.projectId, createEngineeringNodeSchema.parse(req.body)),
  }), 201))
  router.patch(`${base}/products/:productId`, handle(async (a, req) => ({
    product: await store.updateProduct(a.userId, a.workspaceId, a.projectId, param(req, 'productId'), updateEngineeringNodeSchema.parse(req.body)),
  })))
  router.post(`${base}/products/:productId/components`, handle(async (a, req) => ({
    component: await store.createComponent(a.userId, a.workspaceId, a.projectId, param(req, 'productId'), createEngineeringNodeSchema.parse(req.body)),
  }), 201))
  router.patch(`${base}/products/:productId/components/:componentId`, handle(async (a, req) => ({
    component: await store.updateComponent(a.userId, a.workspaceId, a.projectId, param(req, 'productId'), param(req, 'componentId'), updateEngineeringNodeSchema.parse(req.body)),
  })))
  router.get(`${base}/definition`, handle(async (a, req) => ({
    definition: await store.definition(a.userId, a.workspaceId, a.projectId, scopeQuery.parse(req.query)),
  })))
  router.put(`${base}/definition`, handle(async (a, req) => ({
    definition: await store.putDefinition(a.userId, a.workspaceId, a.projectId, putHarnessDefinitionSchema.parse(req.body)),
  })))
  router.get(`${base}/history`, handle(async (a, req) => ({
    revisions: await store.history(a.userId, a.workspaceId, a.projectId, scopeQuery.parse(req.query)),
    limit: 100,
  })))
  router.get(`${base}/effective`, handle(async (a, req) => {
    const scope = scopeQuery.parse(req.query)
    return { effective: resolveHarness({ workspaceId: a.workspaceId, projectId: a.projectId, scope },
      await store.lineage(a.userId, a.workspaceId, a.projectId, scope)) }
  }))
  router.post(`${base}/impact`, handle(async (a, req) => {
    const input = impactRequestSchema.parse(req.body)
    return { impact: selectHarnessImpact({ workspaceId: a.workspaceId, projectId: a.projectId }, await snapshot(a.userId, a.workspaceId, a.projectId), input) }
  }))
  router.get(`${base}/approvals`, handle(async (a, req) => ({
    approvals: await execution.approvals(a.userId, a.workspaceId, a.projectId, scopeQuery.parse(req.query)),
  })))
  router.post(`${base}/revisions/:revisionId/approve`, handle(async (a, req) => {
    const actor = human(req)
    const input = approveRevisionSchema.parse(req.body)
    return { approval: await execution.approve(actor, a.workspaceId, a.projectId, param(req, 'revisionId'), input.expectedRevision, input.reason) }
  }, 201))
  router.get(`${base}/runs`, handle(async (a, req) => ({
    runs: await execution.runs(a.userId, a.workspaceId, a.projectId, scopeQuery.parse(req.query)),
  })))
  router.post(`${base}/runs`, handle(async (a, req) => {
    const actor = human(req)
    const input = createHarnessRunSchema.parse(req.body)
    // Agent execution is not provided by this context layer. Reject before
    // persisting a pending run that no available runtime can execute.
    if (input.executor === 'agent') throw new WorkspaceAccessError('harness_agent_runtime_unavailable', 503)
    return { run: await execution.createRun(actor, a.workspaceId, a.projectId, input) }
  }, 201))
  router.get(`${base}/runs/:runId`, handle(async (a, req) => ({
    run: await execution.run(a.userId, a.workspaceId, a.projectId, param(req, 'runId')),
  })))
  router.get(`${base}/runs/:runId/evidence`, handle(async (a, req) => ({
    evidence: await execution.evidence(a.userId, a.workspaceId, a.projectId, param(req, 'runId')),
  })))
  router.post(`${base}/runs/:runId/evidence`, handle(async (a, req) => ({
    evidence: await execution.addHumanEvidence(human(req), a.workspaceId, a.projectId, param(req, 'runId'), humanEvidenceSchema.parse(req.body)),
  }), 201))
  router.post(`${base}/runs/:runId/result`, handle(async (a, req) => ({
    // Store validates the full result against persisted preview and actual
    // evidence. This route has no path to completeAgent/addAgentEvidence.
    run: await execution.completeHuman(human(req), a.workspaceId, a.projectId, param(req, 'runId'), req.body),
  })))
  router.post(`${base}/runs/:runId/cancel`, handle(async (a, req) => {
    const actor = human(req); emptyBody.parse(req.body)
    return { run: await execution.cancel(actor, a.workspaceId, a.projectId, param(req, 'runId')) }
  }))
  return router
}
