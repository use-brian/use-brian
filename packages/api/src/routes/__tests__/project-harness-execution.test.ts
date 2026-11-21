import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectHarnessRoutes } from '../project-harness.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import type { HarnessExecutionStore } from '../../project-harness/execution-contracts.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'

const [userId, workspaceId, projectId, authSessionId, revisionId, runId, approvalId] = [1,2,3,4,5,6,7].map(i => `10000000-0000-4000-8000-${String(i).padStart(12,'0')}`)
const base = `/api/workspaces/${workspaceId}/projects/${projectId}/harness`
const actor = { userId, authSessionId }
const execution = Object.fromEntries(['approvals','approve','createRun','runs','run','evidence','addHumanEvidence','completeHuman','cancel','claimAgent','authorizeAgent','addAgentEvidence','completeAgent'].map(k => [k, vi.fn()])) as unknown as { [K in keyof HarnessExecutionStore]: ReturnType<typeof vi.fn> }
const snapshot = vi.fn()
const input = { approvalId, scenarioKey: 'journey', executor: 'human', build: { buildId: 'b', deploymentId: 'd' }, target: { url: 'https://example.com/', permittedOrigins: ['https://example.com'] }, environment: { environmentId: 'qa', locale: 'en', timezone: 'UTC', viewport: { width: 1280, height: 720 } } }
function app(mode: 'human' | 'legacy' | 'anonymous' | 'delegated' = 'human') {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => {
    if (mode !== 'anonymous') req.userId = userId
    if (mode !== 'legacy') req.authSessionId = authSessionId
    if (mode === 'delegated') runWithAgentAccess({ clearance: 'internal', compartments: null }, next)
    else next()
  })
  server.use('/api', projectHarnessRoutes({ execution, snapshot }))
  return server
}
beforeEach(() => {
  vi.resetAllMocks()
  for (const fn of Object.values(execution)) fn.mockResolvedValue({ id: runId })
  snapshot.mockResolvedValue({ tree: { products: [], components: [] }, revisions: [] })
})
describe('authenticated harness approval and run routes', () => {
  it.each(['anonymous','legacy','delegated'] as const)('rejects %s execution mutation before the store', async mode => {
    const res = await request(app(mode)).post(`${base}/runs`).send(input)
    expect(res.status).toBe(mode === 'anonymous' ? 401 : 403)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(execution.createRun).not.toHaveBeenCalled()
  })
  it('binds approval to authenticated human/session, exact revision and normalized reason', async () => {
    await request(app()).post(`${base}/revisions/${revisionId}/approve`).send({ expectedRevision: 1, reason: ' Reviewed independently ' }).expect(201)
    expect(execution.approve).toHaveBeenCalledWith(actor, workspaceId, projectId, revisionId, 1, 'Reviewed independently')
    await request(app()).post(`${base}/revisions/${revisionId}/approve`).send({ expectedRevision: 1, reason: 'OK', approvedBy: userId }).expect(400)
    expect(execution.approve).toHaveBeenCalledTimes(1)
  })
  it('creates only server-built runs, not client packets or authority', async () => {
    await request(app()).post(`${base}/runs`).send(input).expect(201)
    expect(execution.createRun).toHaveBeenCalledWith(actor, workspaceId, projectId, input)
    for (const extra of [{ preview: {} }, { approved: true }, { requestedBy: userId }, { authSessionId }, { configuration: {} }]) {
      await request(app()).post(`${base}/runs`).send({ ...input, ...extra }).expect(400)
    }
    expect(execution.createRun).toHaveBeenCalledTimes(1)
  })
  it('rejects agent runs before persisting an impossible pending run', async () => {
    const res = await request(app()).post(`${base}/runs`).send({ ...input, executor: 'agent' }).expect(503)
    expect(res.body).toEqual({ error: 'harness_agent_runtime_unavailable' })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(execution.createRun).not.toHaveBeenCalled()
    expect(execution.claimAgent).not.toHaveBeenCalled()
  })
  it('continues to read historical agent runs and their evidence', async () => {
    const historicalRun = { id: runId, executor: 'agent', status: 'blocked' }
    const evidence = [{ id: 'historical-evidence', provenance: 'isolated_browser' }]
    execution.runs.mockResolvedValue([historicalRun])
    execution.run.mockResolvedValue(historicalRun)
    execution.evidence.mockResolvedValue(evidence)
    const list = await request(app('legacy')).get(`${base}/runs?scope=project`).expect(200)
    expect(list.body.runs).toEqual([historicalRun])
    const detail = await request(app('legacy')).get(`${base}/runs/${runId}`).expect(200)
    expect(detail.body.run).toEqual(historicalRun)
    const observations = await request(app('legacy')).get(`${base}/runs/${runId}/evidence`).expect(200)
    expect(observations.body.evidence).toEqual(evidence)
  })
  it('preserves scope and actor on historical reads', async () => {
    execution.approvals.mockResolvedValue([]); execution.runs.mockResolvedValue([])
    for (const path of ['approvals','runs'] as const) {
      const res = await request(app('legacy')).get(`${base}/${path}?scope=project`).expect(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(execution[path]).toHaveBeenCalledWith(userId, workspaceId, projectId, { kind: 'project' })
      await request(app()).get(`${base}/${path}?scope=project&actorId=${userId}`).expect(400)
    }
    await request(app()).get(`${base}/runs/${runId}`).expect(200)
    await request(app()).get(`${base}/runs/${runId}/evidence`).expect(200)
    expect(execution.run).toHaveBeenCalledWith(userId, workspaceId, projectId, runId)
    expect(execution.evidence).toHaveBeenCalledWith(userId, workspaceId, projectId, runId)
  })
  it('accepts human observations but never screenshot/provenance assertions', async () => {
    await request(app()).post(`${base}/runs/${runId}/evidence`).send({ criterionKey: 'visible', text: ' Seen ' }).expect(201)
    expect(execution.addHumanEvidence).toHaveBeenCalledWith(actor, workspaceId, projectId, runId, { criterionKey: 'visible', text: 'Seen' })
    await request(app()).post(`${base}/runs/${runId}/evidence`).send({ criterionKey: 'visible', text: 'Seen', provenance: 'isolated_browser' }).expect(400)
    expect(execution.addAgentEvidence).not.toHaveBeenCalled()
  })
  it('submits results only through persisted human validation', async () => {
    const body = { status: 'passed' }
    execution.completeHuman.mockRejectedValue(new WorkspaceAccessError('harness_invalid_input', 400))
    await request(app()).post(`${base}/runs/${runId}/result`).send(body).expect(400)
    expect(execution.completeHuman).toHaveBeenCalledWith(actor, workspaceId, projectId, runId, body)
    expect(execution.completeAgent).not.toHaveBeenCalled()
  })
  it('does not expose the removed agent dispatch endpoint', async () => {
    await request(app()).post(`${base}/runs/${runId}/dispatch`).send({}).expect(404)
    expect(execution.claimAgent).not.toHaveBeenCalled()
    expect(execution.completeAgent).not.toHaveBeenCalled()
  })
  it('requires human identity for cancellation and rejects extra commands', async () => {
    await request(app()).post(`${base}/runs/${runId}/cancel`).send({}).expect(200)
    expect(execution.cancel).toHaveBeenCalledWith(actor, workspaceId, projectId, runId)
    await request(app('legacy')).post(`${base}/runs/${runId}/cancel`).send({}).expect(403)
    await request(app()).post(`${base}/runs/${runId}/cancel`).send({ status: 'passed' }).expect(400)
  })
  it.each([['harness_not_found',404],['harness_independent_reviewer_required',403],['harness_revision_stale',409],['harness_unavailable',503]] as const)('maps %s without leaking backend details', async (code, status) => {
    execution.approve.mockRejectedValue(new WorkspaceAccessError(code, status))
    const res = await request(app()).post(`${base}/revisions/${revisionId}/approve`).send({ expectedRevision: 1, reason: 'Reviewed' }).expect(status)
    expect(res.body).toEqual({ error: code })
    expect(res.headers['cache-control']).toBe('no-store')
  })
  it('plans impact only from the authorized complete snapshot, never caller definitions', async () => {
    const res = await request(app()).post(`${base}/impact`).send({ scopes: [{ kind: 'project' }] }).expect(200)
    expect(res.body.impact.status).toBe('ready')
    expect(snapshot).toHaveBeenCalledWith(userId, workspaceId, projectId)
    await request(app()).post(`${base}/impact`).send({ scopes: [{ kind: 'project' }], revisions: [] }).expect(400)
    expect(snapshot).toHaveBeenCalledTimes(1)
    snapshot.mockRejectedValue(new WorkspaceAccessError('harness_not_found', 404))
    await request(app()).post(`${base}/impact`).send({ changedSources: [{ repository: 'app', path: 'src/calendar.ts' }] }).expect(404)
  })
})
