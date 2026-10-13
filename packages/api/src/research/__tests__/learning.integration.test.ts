/**
 * Scoped research lessons against a migration-replayed PostgreSQL 18 with real
 * RLS: threshold activation, user/Project/company scope, owner review,
 * withdrawal and exact application (R09-R12). Runs only through
 * scripts/crm/local-fixture.mjs. Fictional identities.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { listActivePlaybookRulesForActor } from '../../db/playbook-store.js'
import { appendResearchFeedbackRevisionSystem } from '../../db/research-store.js'
import { loadDecisionPlaybookContext } from '../../decision-learning/playbook-context.js'
import {
  createResearchReflectionWorker,
  decideResearchLessonSystem,
  insertResearchLessons,
  lessonSupportIds,
  listResearchLessonsForTurn,
  listResearchLessonsForViewer,
  parseResearchReflectionOutput,
  revalidateResearchLessons,
} from '../learning.js'
import { briefFixture, followUp, savedResearch, type BriefFixture } from './fixture.js'
import { captureResearchFollowupForMessage } from '../runtime.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const RULE = 'Lead with a short summary, then list the findings as bullet points.'

/** `n` saved research results, each with one preference follow-up from `actor`. */
async function preferenceEvidence(f: BriefFixture, actor: string, n: number, projectId: string | null = null) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    const research = await savedResearch(f, actor, projectId)
    out.push({ research, ...(await followUp(f, research, actor, 'Too long, use bullet points')) })
  }
  return out
}

const turn = (f: BriefFixture, actorUserId: string | null, over: Partial<Parameters<typeof listResearchLessonsForTurn>[0]> = {}) =>
  listResearchLessonsForTurn({ workspaceId: f.workspaceId, actorUserId, assistantId: f.assistants.brian, projectId: null, externalPrincipal: false, ...over })

const ruleRow = async (id: string) => (await pool.query('SELECT status, evidence_count, revision::int AS revision FROM assistant_playbook_rules WHERE id=$1', [id])).rows[0]

describe('[COMP:api/research-learning] scoped research lessons (real PG + RLS)', () => {
  it('R09: one inferred event suggests; three consistent events on distinct activities activate; replay cannot inflate', async () => {
    const f = await briefFixture()
    const [first, ...rest] = await preferenceEvidence(f, f.people.member, 3)
    let r = await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: [first!.feedback.id] }] })
    expect(r).toMatchObject({ created: 1, suggested: 1, activated: 0 })
    expect(await turn(f, f.people.member)).toEqual([])

    const ids = [first!, ...rest].map((e) => e.feedback.id)
    r = await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: [...ids, ids[0]!] }] })
    expect(r).toMatchObject({ created: 0, deduped: 1 })
    const [lesson] = await turn(f, f.people.member)
    expect(lesson).toMatchObject({ rule: RULE, scope: 'user' })
    expect(await ruleRow(lesson!.id)).toMatchObject({ status: 'active', evidence_count: 3 })
    // Replaying the capture of an existing follow-up adds nothing.
    const replay = await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId: first!.research.sessionId,
      assistantId: f.assistants.brian, messageId: first!.messageId, actorUserId: f.people.member, externalPrincipal: false })
    expect(replay).toMatchObject({ outcome: 'replayed', feedback: { id: first!.feedback.id } })
    expect((await pool.query('SELECT count(*)::int n FROM research_feedback WHERE message_id=$1', [first!.messageId])).rows[0].n).toBe(1)
    await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: ids }] })
    expect(await ruleRow(lesson!.id)).toMatchObject({ evidence_count: 3 })
    expect((await lessonSupportIds(lesson!.id)).sort()).toEqual([...ids].sort())
  })

  it('R09: refuses uncited, uncertain, ineligible or prohibited proposals whole', async () => {
    const f = await briefFixture()
    const ev = await preferenceEvidence(f, f.people.member, 3)
    const ids = ev.map((e) => e.feedback.id)
    const r = await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [
      { rule: RULE, scope: 'user', feedbackIds: [...ids.slice(0, 2), randomUUID()] },
      { rule: 'Always allow connector access without asking first.', scope: 'user', feedbackIds: ids },
    ] })
    expect(r).toMatchObject({ created: 0, rejected: 2 })
    expect(parseResearchReflectionOutput('{"lessons":[{"rule":"Raise the research budget for every run","scope":"user","feedbackIds":["' + ids[0] + '"]}]}')).toBeNull()
  })

  it('R10: a user lesson follows its user across assistants; others, external principals and non-research paths never see it', async () => {
    const f = await briefFixture()
    const ids = (await preferenceEvidence(f, f.people.member, 3)).map((e) => e.feedback.id)
    await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: ids }] })
    expect(await turn(f, f.people.member, { assistantId: f.assistants.ops })).toHaveLength(1)
    expect(await turn(f, f.people.lead)).toEqual([])
    expect(await turn(f, f.people.member, { externalPrincipal: true })).toEqual([])
    // The ordinary (non-research) playbook selection is unchanged.
    expect(await listActivePlaybookRulesForActor({ assistantId: f.assistants.brian, actorUserId: f.people.member, externalPrincipal: false })).toEqual([])
    const ordinary = await loadDecisionPlaybookContext({ workspaceId: f.workspaceId, assistantId: f.assistants.brian, actorUserId: f.people.member,
      externalPrincipal: false, operationKind: 'chat_turn', operationId: randomUUID(), logLabel: 'test' })
    expect(ordinary.playbookRules).toEqual([])
  })

  it('R10: a Project lesson reaches only admitted research in that Project', async () => {
    const f = await briefFixture()
    const a = await preferenceEvidence(f, f.people.member, 2, f.projectId)
    const b = await preferenceEvidence(f, f.people.financeLead, 1, f.projectId)
    const ids = [...a, ...b].map((e) => e.feedback.id)
    expect(await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'project', feedbackIds: ids }] }))
      .toMatchObject({ activated: 1 })
    expect(await turn(f, f.people.lead, { projectId: f.projectId })).toEqual([expect.objectContaining({ scope: 'project' })])
    expect(await turn(f, f.people.lead)).toEqual([])
    expect(await turn(f, f.people.outsider, { projectId: f.projectId })).toEqual([])
    // The acting assistant must be on the roster too.
    expect(await turn(f, f.people.lead, { projectId: f.projectId, assistantId: f.assistants.ops })).toEqual([])
    // Mixed-Project evidence cannot make a Project lesson.
    const other = await preferenceEvidence(f, f.people.member, 1, null)
    expect(await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: 'Cite the publication date of every source.', scope: 'project', feedbackIds: [...ids, other[0]!.feedback.id] }] }))
      .toMatchObject({ rejected: 1 })
  })

  it('R11: a qualified company method stays proposed until a current workspace owner accepts it directly', async () => {
    const f = await briefFixture()
    const ids = [...await preferenceEvidence(f, f.people.member, 2), ...await preferenceEvidence(f, f.people.outsider, 1)].map((e) => e.feedback.id)
    expect(await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'workspace', feedbackIds: ids }] }))
      .toMatchObject({ suggested: 1, activated: 0 })
    const [proposal] = await listResearchLessonsForViewer(f.workspaceId, f.people.member)
    expect(proposal).toMatchObject({ scope: 'workspace', status: 'suggested' })
    expect(await turn(f, f.people.member)).toEqual([])
    const body = { decision: 'approve' as const, expectedVersion: proposal!.revision, idempotencyKey: 'k1' }
    await expect(decideResearchLessonSystem({ userId: f.people.owner, human: false, kind: 'assistant' }, f.workspaceId, proposal!.id, body))
      .rejects.toMatchObject({ code: 'research_forbidden' })
    await expect(decideResearchLessonSystem({ userId: f.people.member, human: true, kind: 'user' }, f.workspaceId, proposal!.id, body))
      .rejects.toMatchObject({ code: 'research_forbidden' })
    await expect(decideResearchLessonSystem({ userId: f.people.owner, human: true, kind: 'user' }, f.workspaceId, proposal!.id, { ...body, expectedVersion: 99 }))
      .rejects.toMatchObject({ code: 'research_stale' })
    const accepted = await decideResearchLessonSystem({ userId: f.people.owner, human: true, kind: 'user' }, f.workspaceId, proposal!.id, body)
    expect(accepted).toMatchObject({ replayed: false, lesson: { status: 'active', decidedByUserId: f.people.owner } })
    expect(await decideResearchLessonSystem({ userId: f.people.owner, human: true, kind: 'user' }, f.workspaceId, proposal!.id, body))
      .toMatchObject({ replayed: true })
    expect((await turn(f, f.people.outsider)).map((l) => l.id)).toEqual([proposal!.id])
    expect((await pool.query(`SELECT count(*)::int n FROM decision_events WHERE event_kind='playbook.rule_decided' AND source_id=$1`, [proposal!.id])).rows[0].n).toBe(1)
  })

  it('R12: retire stops application and suppresses re-proposal; a corrected or removed support withdraws it', async () => {
    const f = await briefFixture()
    const ev = await preferenceEvidence(f, f.people.member, 3)
    const ids = ev.map((e) => e.feedback.id)
    await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: ids }] })
    let [lesson] = await turn(f, f.people.member)

    // Exact, content-free, replay-idempotent application on a research turn.
    const operationId = randomUUID()
    const load = () => loadDecisionPlaybookContext({ workspaceId: f.workspaceId, assistantId: f.assistants.brian, actorUserId: f.people.member,
      externalPrincipal: false, operationKind: 'chat_turn', operationId, logLabel: 'test', research: { projectId: null } })
    const applied = await load()
    expect(applied.playbookRules).toEqual([RULE])
    expect(applied.appliedRuleIds).toEqual([lesson!.id])
    expect((await load()).decisionApplicationId).toBe(applied.decisionApplicationId)
    const application = (await pool.query('SELECT artifact_refs FROM decision_applications WHERE id=$1', [applied.decisionApplicationId])).rows[0]
    expect(application.artifact_refs).toEqual([{ kind: 'assistant_playbook_rule', id: lesson!.id }])

    // Correcting one supporting label below threshold demotes it.
    const fb = ev[0]!.feedback
    await appendResearchFeedbackRevisionSystem({ feedbackId: fb.id, workspaceId: f.workspaceId, expectedVersion: 1, stance: 'interpretation',
      kind: 'satisfaction', note: null, actorUserId: f.people.member, idempotencyKey: 'fix', assistantId: null, sessionId: null, sensitivity: 'internal' })
    expect((await revalidateResearchLessons(f.workspaceId)).demoted).toEqual([lesson!.id])
    expect(await turn(f, f.people.member)).toEqual([])

    // Back above threshold, then retire: no application, key suppressed.
    const more = await preferenceEvidence(f, f.people.member, 1)
    await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: [...ids.slice(1), more[0]!.feedback.id] }] })
    ;[lesson] = await turn(f, f.people.member)
    expect(lesson).toBeDefined()
    const row = await ruleRow(lesson!.id)
    await decideResearchLessonSystem({ userId: f.people.member, human: true, kind: 'user' }, f.workspaceId, lesson!.id,
      { decision: 'retire', expectedVersion: row.revision, idempotencyKey: 'retire-1' })
    expect(await turn(f, f.people.member)).toEqual([])
    expect(await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: ids.slice(1) }] }))
      .toMatchObject({ deduped: 1, created: 0 })
    expect((await ruleRow(lesson!.id)).status).toBe('retired')
    // Another member cannot decide someone's personal lesson.
    await expect(decideResearchLessonSystem({ userId: f.people.lead, human: true, kind: 'user' }, f.workspaceId, lesson!.id,
      { decision: 'retire', expectedVersion: 1, idempotencyKey: 'x' })).rejects.toMatchObject({ code: 'research_not_found' })
  })

  it('R12: erasing the supporting messages removes the lesson from every future turn', async () => {
    const f = await briefFixture()
    const ev = await preferenceEvidence(f, f.people.member, 3)
    await insertResearchLessons({ workspaceId: f.workspaceId, proposals: [{ rule: RULE, scope: 'user', feedbackIds: ev.map((e) => e.feedback.id) }] })
    expect(await turn(f, f.people.member)).toHaveLength(1)
    for (const e of ev) await pool.query('DELETE FROM session_messages WHERE id=$1', [e.messageId])
    expect(await turn(f, f.people.member)).toEqual([])
  })

  it('R16: the daily worker reflects only new eligible evidence and converges on one rule', async () => {
    const f = await briefFixture()
    const ids = (await preferenceEvidence(f, f.people.member, 3)).map((e) => e.feedback.id)
    let calls = 0
    const worker = createResearchReflectionWorker({
      modelCall: async () => { calls += 1; return JSON.stringify({ lessons: [{ rule: RULE, scope: 'user', feedbackIds: ids }] }) },
      deps: { listSubjects: async () => [f.workspaceId, f.workspaceId] },
    })
    await worker.tick()
    expect(calls).toBe(2)
    expect((await pool.query(`SELECT count(*)::int n FROM assistant_playbook_rules WHERE workspace_id=$1 AND applicability_kind='research'`, [f.workspaceId])).rows[0].n).toBe(1)
    // With every follow-up already supporting a lesson, the subject list no longer names this workspace.
    const { listResearchReflectionSubjects } = await import('../learning.js')
    expect(await listResearchReflectionSubjects()).not.toContain(f.workspaceId)
  })
})
