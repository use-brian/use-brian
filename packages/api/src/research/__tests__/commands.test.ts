import { readFileSync } from 'node:fs'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'

const store = vi.hoisted(() => ({
  getResearchFeedbackForViewer: vi.fn(),
  getResearchActivityForViewer: vi.fn(),
  appendResearchFeedbackRevisionSystem: vi.fn(),
  listResearchActivitiesForViewer: vi.fn(async () => []),
  getResearchImprovementForViewer: vi.fn(),
  insertResearchImprovementSystem: vi.fn(),
  insertResearchComparisonSystem: vi.fn(),
  listResearchImprovementsForViewer: vi.fn(async () => []),
  taskReadableForViewer: vi.fn(async () => true),
}))
const learning = vi.hoisted(() => ({
  decideResearchLessonSystem: vi.fn(),
  listResearchLessonsForViewer: vi.fn(async () => []),
  lessonSupportIds: vi.fn(async () => []),
  revalidateResearchLessons: vi.fn(async () => ({ demoted: [] })),
}))

vi.mock('../../db/research-store.js', async (orig) => ({ ...(await orig<object>()), ...store }))
vi.mock('../learning.js', async (orig) => ({ ...(await orig<object>()), ...learning }))

const { researchRoutes } = await import('../../routes/research.js')
const { createResearchTools } = await import('../tools.js')
const { bridgeCoreTool } = await import('../../brain-mcp/tools.js')
const { ResearchStaleError } = await import('../../db/research-store.js')
const { ResearchLessonError } = await import('../learning.js')

const WS = '00000000-0000-4000-8000-000000000010'
const MEMBER = '00000000-0000-4000-8000-000000000011'
const OTHER = '00000000-0000-4000-8000-000000000012'
const FB = '00000000-0000-4000-8000-000000000013'
const LESSON = '00000000-0000-4000-8000-000000000014'
const IMP = '00000000-0000-4000-8000-000000000015'
const ACT = '00000000-0000-4000-8000-000000000016'

function app(userId = MEMBER) {
  const auth: RequestHandler = (req, _res, next) => { req.userId = userId; next() }
  const a = express()
  a.use(express.json())
  a.use('/api', researchRoutes({ auth }))
  return a
}
const tools = createResearchTools()
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  userId: MEMBER, assistantId: 'a', sessionId: 's', appId: 'x', channelType: 'web', channelId: 'c', workspaceId: WS,
  abortSignal: new AbortController().signal, attended: true, workspaceActorUserId: MEMBER, ...over,
}) as ToolContext
const mcp = (name: keyof typeof tools, context: ToolContext) => bridgeCoreTool(tools[name], async () => context, WS)
const body = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('')

const feedback = { id: FB, actorUserId: MEMBER, activityId: ACT, sensitivity: 'internal', version: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  store.getResearchFeedbackForViewer.mockResolvedValue(feedback)
  store.appendResearchFeedbackRevisionSystem.mockResolvedValue({ revision: 2, replayed: false })
})

describe('[COMP:api/research-commands] One research command service across REST, Brian and MCP', () => {
  it('R13: a correction goes through the same service on every surface; another member only disagrees', async () => {
    const res = await request(app()).post(`/api/workspaces/${WS}/research/feedback/${FB}/corrections`)
      .send({ kind: 'preference', expectedVersion: 1, idempotencyKey: 'k1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ revision: 2, stance: 'interpretation', replayed: false })
    const viaTool = await tools.correctResearchFeedback.execute({ feedback_id: FB, kind: 'preference', expected_version: 1 }, ctx())
    expect(viaTool.isError).toBeUndefined()
    const viaMcp = await mcp('correctResearchFeedback', ctx({ programmaticPrincipal: { credentialId: 'key-1' } as never }))
      .handler({ feedback_id: FB, kind: 'preference', expected_version: 1 })
    expect(viaMcp.isError).toBeFalsy()
    const calls = store.appendResearchFeedbackRevisionSystem.mock.calls.map((c) => c[0])
    expect(calls.map((c) => [c.actorUserId, c.stance, c.kind, c.expectedVersion])).toEqual([
      [MEMBER, 'interpretation', 'preference', 1], [MEMBER, 'interpretation', 'preference', 1], [MEMBER, 'interpretation', 'preference', 1],
    ])
    expect(learning.revalidateResearchLessons).toHaveBeenCalledTimes(3)
    await request(app(OTHER)).post(`/api/workspaces/${WS}/research/feedback/${FB}/corrections`).send({ kind: 'correction', expectedVersion: 2, idempotencyKey: 'k2' })
    expect(store.appendResearchFeedbackRevisionSystem.mock.calls.at(-1)![0]).toMatchObject({ actorUserId: OTHER, stance: 'disagreement' })
  })

  it('R13: stale revisions and hidden targets fail the same way on every surface', async () => {
    store.appendResearchFeedbackRevisionSystem.mockRejectedValue(new ResearchStaleError())
    const res = await request(app()).post(`/api/workspaces/${WS}/research/feedback/${FB}/corrections`).send({ kind: 'preference', expectedVersion: 1, idempotencyKey: 'k' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'research_stale' })
    const viaTool = await tools.correctResearchFeedback.execute({ feedback_id: FB, kind: 'preference', expected_version: 1 }, ctx())
    expect(viaTool).toMatchObject({ isError: true, data: expect.stringMatching(/changed since you read it/) })
    const viaMcp = await mcp('correctResearchFeedback', ctx()).handler({ feedback_id: FB, kind: 'preference', expected_version: 1 })
    expect(viaMcp.isError).toBe(true)
    expect(body(viaMcp as never)).toMatch(/changed since you read it/)

    store.getResearchFeedbackForViewer.mockResolvedValue(null)
    expect((await request(app()).post(`/api/workspaces/${WS}/research/feedback/${FB}/corrections`).send({ kind: 'preference', expectedVersion: 1, idempotencyKey: 'k' })).status).toBe(404)
    expect(await tools.correctResearchFeedback.execute({ feedback_id: FB, kind: 'preference', expected_version: 1 }, ctx()))
      .toMatchObject({ isError: true, data: expect.stringMatching(/Nothing you can see/) })
    store.getResearchActivityForViewer.mockResolvedValue(null)
    expect((await request(app()).get(`/api/workspaces/${WS}/research/activities/${ACT}`)).status).toBe(404)
    expect((await request(app()).get(`/api/workspaces/${WS}/research/activities/not-a-uuid`)).status).toBe(404)
  })

  it('R13: lesson decisions carry the real actor: an unattended assistant and a key are never human', async () => {
    learning.decideResearchLessonSystem.mockImplementation(async (actor) => {
      if (!actor.human || actor.kind !== 'user') throw new ResearchLessonError('research_forbidden', 403)
      return { lesson: { id: LESSON, status: 'active' }, replayed: false }
    })
    const input = { decision: 'approve', expectedVersion: 1, idempotencyKey: 'k' }
    expect((await request(app()).post(`/api/workspaces/${WS}/research/lessons/${LESSON}/decisions`).send(input)).status).toBe(200)
    expect(learning.decideResearchLessonSystem.mock.calls[0]![0]).toEqual({ userId: MEMBER, human: true, kind: 'user' })
    const unattended = await tools.decideResearchLesson.execute({ lesson_id: LESSON, decision: 'approve', expected_version: 1 }, ctx({ attended: false }))
    expect(unattended).toMatchObject({ isError: true, data: expect.stringMatching(/not allowed/) })
    expect(learning.decideResearchLessonSystem.mock.calls[1]![0]).toMatchObject({ kind: 'assistant', human: false })
    const viaKey = await mcp('decideResearchLesson', ctx({ programmaticPrincipal: { credentialId: 'k' } as never })).handler({ lesson_id: LESSON, decision: 'approve', expected_version: 1 })
    expect(viaKey.isError).toBe(true)
    expect(learning.decideResearchLessonSystem.mock.calls[2]![0]).toMatchObject({ kind: 'credential', human: false })
    expect((await request(app()).post(`/api/workspaces/${WS}/research/lessons/${LESSON}/decisions`).send({ decision: 'approve' })).status).toBe(400)
  })

  it('R13: an assistant acting on its own cannot correct, nominate or record', async () => {
    const self = ctx({ attended: false })
    for (const [name, input] of [
      ['correctResearchFeedback', { feedback_id: FB, kind: 'preference', expected_version: 1 }],
      ['nominateResearchImprovement', { title: 'Fix it', pattern: 'Generic pattern', desired_behavior: 'Generic behavior' }],
      ['recordResearchComparison', { improvement_id: IMP, bundle: { kind: 'traces', manifest: {}, baseline: {}, candidate: {} } }],
    ] as const) {
      expect(await tools[name].execute(input as never, self)).toMatchObject({ isError: true, data: expect.stringMatching(/not allowed/) })
    }
    expect(store.appendResearchFeedbackRevisionSystem).not.toHaveBeenCalled()
    expect(store.insertResearchImprovementSystem).not.toHaveBeenCalled()
  })

  it('R14: nomination requires visible evidence and links native work; it records a pattern, not the evidence', async () => {
    store.getResearchActivityForViewer.mockResolvedValue({ activity: { id: ACT, sensitivity: 'confidential', compartments: ['team:x'] } })
    store.insertResearchImprovementSystem.mockImplementation(async (i) => ({ improvement: { id: IMP, ...i }, created: true }))
    const task = '00000000-0000-4000-8000-000000000017'
    const res = await request(app()).post(`/api/workspaces/${WS}/research/improvements`).send({
      title: 'Coverage misses regulation', pattern: 'Vendor comparisons omit regulatory terms', desiredBehavior: 'Always check regulatory terms',
      feedbackIds: [FB], activityIds: [ACT], taskId: task, idempotencyKey: 'n1' })
    expect(res.status).toBe(200)
    expect(store.insertResearchImprovementSystem.mock.calls[0]![0]).toMatchObject({ createdBy: MEMBER, sensitivity: 'confidential', compartments: ['team:x'], taskId: task })
    store.getResearchFeedbackForViewer.mockResolvedValue(null)
    expect((await request(app()).post(`/api/workspaces/${WS}/research/improvements`).send({
      title: 'x y z', pattern: 'p q r', desiredBehavior: 'd e f', feedbackIds: [FB], idempotencyKey: 'n2' })).status).toBe(404)
    store.taskReadableForViewer.mockResolvedValue(false)
    expect((await request(app()).post(`/api/workspaces/${WS}/research/improvements`).send({
      title: 'x y z', pattern: 'p q r', desiredBehavior: 'd e f', taskId: task, idempotencyKey: 'n3' })).status).toBe(404)
  })

  it('R14/R15: trace bundles are recomputed as locally verified; reports stay reported; an opaque pass is refused', async () => {
    store.getResearchImprovementForViewer.mockResolvedValue({ improvement: { id: IMP }, comparisons: [] })
    store.insertResearchComparisonSystem.mockImplementation(async (i) => ({ comparison: { id: 'c', ...i }, created: true }))
    const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../evals/research/fixtures/${n}`, import.meta.url), 'utf8'))
    const traces = { kind: 'traces', manifest: fx('cases.json'), baseline: fx('baseline.trace.json'), candidate: fx('candidate.trace.json') }
    let res = await request(app()).post(`/api/workspaces/${WS}/research/improvements/${IMP}/comparisons`).send({ bundle: traces, idempotencyKey: 'c1' })
    expect(res.status).toBe(200)
    expect(store.insertResearchComparisonSystem.mock.calls[0]![0]).toMatchObject({ verification: 'local_verified', judgeIdentity: 'fixture-judge@1',
      result: { hardFailures: { newInCandidate: [{ caseId: 'regulation-scan' }, { caseId: 'regulation-scan' }] } } })
    res = await request(app()).post(`/api/workspaces/${WS}/research/improvements/${IMP}/comparisons`).send({ bundle: {
      kind: 'reported', caseSetVersion: 'v', datasetVersion: 'd', judge: 'j', baseline: { engine: 'a' }, candidate: { engine: 'b' }, summary: { passed: true } }, idempotencyKey: 'c2' })
    expect(store.insertResearchComparisonSystem.mock.calls[1]![0]).toMatchObject({ verification: 'externally_reported' })
    res = await request(app()).post(`/api/workspaces/${WS}/research/improvements/${IMP}/comparisons`).send({ bundle: { passed: true }, idempotencyKey: 'c3' })
    expect(res.status).toBe(400)
    res = await request(app()).post(`/api/workspaces/${WS}/research/improvements/${IMP}/comparisons`).send({ bundle: { ...traces, candidate: fx('baseline.trace.json') }, idempotencyKey: 'c4' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'research_invalid', detail: expect.stringMatching(/same engine/) })
    expect(store.insertResearchComparisonSystem).toHaveBeenCalledTimes(2)
  })

  it('R13: artifact inspection reads through the viewer on REST, Brian and MCP alike', async () => {
    const detail = { activity: { id: ACT }, artifacts: [{ kind: 'page', artifactId: 'p' }], feedback: [] }
    store.getResearchActivityForViewer.mockResolvedValue(detail)
    expect((await request(app()).get(`/api/workspaces/${WS}/research/activities/${ACT}`)).body).toMatchObject({ artifacts: [{ kind: 'page' }], lessons: [] })
    expect((await tools.getResearchActivity.execute({ activity_id: ACT }, ctx())).data).toMatchObject({ artifacts: [{ kind: 'page' }] })
    expect(body(await mcp('getResearchActivity', ctx()).handler({ activity_id: ACT }) as never)).toMatch(/"artifactId": "p"/)
    expect(store.getResearchActivityForViewer.mock.calls.map((c) => c[0])).toEqual([MEMBER, MEMBER, MEMBER])
  })
})
