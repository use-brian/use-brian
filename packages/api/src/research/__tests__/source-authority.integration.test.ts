/**
 * Research source authority against a migration-replayed PostgreSQL 18 with
 * real RLS through the NOBYPASSRLS app role: who sees an activity, its
 * artifacts and its follow-ups, and what revocation, holds, page deletion,
 * Department floors and erasure do to those projections (R01, R08, R18).
 * Runs only through scripts/crm/local-fixture.mjs. Fictional identities.
 */
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import {
  countResearchActivitiesForViewer,
  getResearchActivityForViewer,
  listResearchActivitiesForViewer,
  listResearchEvidenceSystem,
} from '../../db/research-store.js'
import { briefFixture, researchMessage, researchSession, savedResearch } from './fixture.js'
import { flushWorkspaceData, WORKSPACE_FLUSH_PRESERVED_TABLES, WORKSPACE_FLUSH_TABLES } from '../../db/workspace-flush.js'
import { beginResearchActivity, captureResearchFollowupForMessage } from '../runtime.js'
import { researchRoutes } from '../../routes/research.js'
import * as notifications from '../../brain-stream/notify.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const session = researchSession
const message = researchMessage

describe('[COMP:api/research-source-authority] research visibility follows its sources (real PG + RLS)', () => {
  it('R01: saves one canonical Project page, links it, and a fresh admitted chat can find and inspect it', async () => {
    const f = await briefFixture()
    const { activity } = await savedResearch(f, f.people.member, f.projectId)
    expect(activity).toMatchObject({ status: 'saved', projectId: f.projectId, saveError: null })
    const detail = await getResearchActivityForViewer(f.people.member, f.workspaceId, activity.id)
    expect(detail?.artifacts).toEqual([expect.objectContaining({ kind: 'page', artifactId: activity.plannedPageId, relation: 'output' })])
    const page = (await pool.query('SELECT state, shared_project_id FROM saved_views WHERE id=$1', [activity.plannedPageId])).rows[0]
    expect(page).toEqual({ state: 'saved', shared_project_id: f.projectId })
    expect(detail?.activity.sources).toEqual([expect.objectContaining({ ref: 'https://example.com/vendors', inspected: true })])
    // Another Project member's fresh chat finds the result without the original session.
    const fromLead = await listResearchActivitiesForViewer(f.people.lead, f.workspaceId, { projectId: f.projectId })
    expect(fromLead.map((a) => a.id)).toEqual([activity.id])
    // Replaying the same invocation reuses the activity and its planned page.
    const again = await beginResearchActivity({ workspaceId: f.workspaceId, sessionId: activity.sessionId, requestMessageId: activity.requestMessageId!,
      actorUserId: f.people.member, assistantId: f.assistants.brian, projectId: f.projectId, entry: 'explicit', runtime: {} })
    expect(again).toMatchObject({ id: activity.id, plannedPageId: activity.plannedPageId, status: 'saved' })

    // The Project lead continues it from a fresh chat by selecting it, without repasting.
    const fresh = await session(f, f.people.lead, f.projectId)
    const followup = await message(f, fresh, 'user', 'You missed the support terms', f.people.lead)
    const captured = await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId: fresh, assistantId: f.assistants.brian,
      messageId: followup, actorUserId: f.people.lead, externalPrincipal: false, selectedActivityId: activity.id })
    expect(captured).toMatchObject({ outcome: 'recorded', feedback: { activityId: activity.id, association: 'explicit_selection', kind: 'missing_coverage' } })
    // An outsider cannot attach feedback to a result they cannot see.
    const outsiderChat = await session(f, f.people.outsider)
    const probe = await message(f, outsiderChat, 'user', 'You missed the support terms', f.people.outsider)
    expect(await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId: outsiderChat, assistantId: f.assistants.brian,
      messageId: probe, actorUserId: f.people.outsider, externalPrincipal: false, selectedActivityId: activity.id })).toMatchObject({ outcome: 'no_research' })
  })

  it('R08: list, count and detail admit the session audience and live Project members only', async () => {
    const f = await briefFixture()
    const { activity } = await savedResearch(f, f.people.member, f.projectId)
    for (const viewer of [f.people.member, f.people.lead, f.people.financeLead]) {
      expect(await countResearchActivitiesForViewer(viewer, f.workspaceId)).toBe(1)
      expect(await getResearchActivityForViewer(viewer, f.workspaceId, activity.id)).not.toBeNull()
    }
    // Outside the Project, and the workspace owner without a roster edge, see nothing.
    for (const viewer of [f.people.outsider, f.people.owner]) {
      expect(await countResearchActivitiesForViewer(viewer, f.workspaceId)).toBe(0)
      expect(await listResearchActivitiesForViewer(viewer, f.workspaceId)).toEqual([])
      expect(await getResearchActivityForViewer(viewer, f.workspaceId, activity.id)).toBeNull()
    }
    // Revocation: a removed roster participant loses the Project leg at once.
    await pool.query('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2', [f.projectId, f.people.financeLead])
    expect(await getResearchActivityForViewer(f.people.financeLead, f.workspaceId, activity.id)).toBeNull()
    expect(await getResearchActivityForViewer(f.people.lead, f.workspaceId, activity.id)).not.toBeNull()
    // The originating member keeps it through their own session.
    expect(await getResearchActivityForViewer(f.people.member, f.workspaceId, activity.id)).not.toBeNull()
  })

  it('R08: a follow-up stays private to its source message even when the activity is shared', async () => {
    const f = await briefFixture()
    const { sessionId, activity } = await savedResearch(f, f.people.member, f.projectId)
    const followup = await message(f, sessionId, 'user', 'You missed the regulatory angle', f.people.member)
    const captured = await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId, assistantId: f.assistants.brian,
      messageId: followup, actorUserId: f.people.member, externalPrincipal: false })
    expect(captured).toMatchObject({ outcome: 'recorded', feedback: { kind: 'missing_coverage', association: 'same_chat_continuation' } })
    const asMember = await getResearchActivityForViewer(f.people.member, f.workspaceId, activity.id)
    expect(asMember?.feedback).toHaveLength(1)
    // The lead sees the shared result but not the member's private follow-up.
    const asLead = await getResearchActivityForViewer(f.people.lead, f.workspaceId, activity.id)
    expect(asLead?.activity.id).toBe(activity.id)
    expect(asLead?.feedback).toEqual([])
    // The journal holds ids only, appended once.
    const events = (await pool.query(`SELECT payload FROM decision_events WHERE event_kind='research.followup_recorded' AND source_id=$1`, [followup])).rows
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0].payload).sort()).toEqual(['activityId', 'association', 'feedbackId', 'messageId', 'outputKey'])
    // Replay converges.
    expect(await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId, assistantId: f.assistants.brian,
      messageId: followup, actorUserId: f.people.member, externalPrincipal: false })).toMatchObject({ outcome: 'replayed' })
  })

  it('R08: a held or edited source message stops counting and disappears from views', async () => {
    const f = await briefFixture()
    const { sessionId, activity } = await savedResearch(f, f.people.member, null)
    const followup = await message(f, sessionId, 'user', 'Too long, use bullet points', f.people.member)
    await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId, assistantId: f.assistants.brian,
      messageId: followup, actorUserId: f.people.member, externalPrincipal: false })
    const since = new Date(Date.now() - 86_400_000)
    expect((await listResearchEvidenceSystem({ workspaceId: f.workspaceId, since }))[0]).toMatchObject({ kind: 'preference', current: true })
    // An edit to the canonical message advances its scope version.
    await pool.query(`UPDATE session_messages SET content='[{"type":"text","text":"Actually keep the length"}]'::jsonb WHERE id=$1`, [followup])
    expect((await pool.query('SELECT scope_version::int v FROM session_messages WHERE id=$1', [followup])).rows[0].v).toBeGreaterThan(1)
    expect((await listResearchEvidenceSystem({ workspaceId: f.workspaceId, since }))[0]?.current).toBe(false)
    await pool.query('UPDATE session_messages SET scope_held = true WHERE id=$1', [followup])
    expect((await getResearchActivityForViewer(f.people.member, f.workspaceId, activity.id))?.feedback).toEqual([])
    // Retry/edit truncation deletes the message and the follow-up with it.
    await pool.query('DELETE FROM session_messages WHERE id=$1', [followup])
    expect((await pool.query('SELECT count(*)::int n FROM research_feedback WHERE message_id=$1', [followup])).rows[0].n).toBe(0)
  })

  it('R08: deleting the page drops its link and the Project leg; a Department floor hides the activity', async () => {
    const f = await briefFixture()
    const { activity } = await savedResearch(f, f.people.member, f.projectId)
    await pool.query('DELETE FROM saved_views WHERE id=$1', [activity.plannedPageId])
    expect((await pool.query('SELECT count(*)::int n FROM research_artifact_links WHERE activity_id=$1', [activity.id])).rows[0].n).toBe(0)
    expect(await getResearchActivityForViewer(f.people.lead, f.workspaceId, activity.id)).toBeNull()

    // Finance-labelled research in a member's own chat: readable only while
    // the member holds a Finance edge.
    const finance = await savedResearch(f, f.people.outsider, null)
    await pool.query('UPDATE research_activities SET compartments=$2 WHERE id=$1', [finance.activity.id, [`team:${f.finance}`]])
    expect(await getResearchActivityForViewer(f.people.outsider, f.workspaceId, finance.activity.id)).toBeNull()
    await f.edge('user', f.people.outsider)
    expect(await getResearchActivityForViewer(f.people.outsider, f.workspaceId, finance.activity.id)).not.toBeNull()
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [f.finance, f.people.outsider])
    expect(await getResearchActivityForViewer(f.people.outsider, f.workspaceId, finance.activity.id)).toBeNull()
  })

  it('R18: erasure and session deletion remove activities, links and follow-ups; trace cleanup does not', async () => {
    const f = await briefFixture()
    const { sessionId, activity } = await savedResearch(f, f.people.member, null)
    await pool.query(`DELETE FROM worker_runs WHERE created_at < now() + interval '1 day'`).catch(() => {})
    expect((await pool.query('SELECT count(*)::int n FROM research_activities WHERE id=$1', [activity.id])).rows[0].n).toBe(1)
    await pool.query('DELETE FROM sessions WHERE id=$1', [sessionId])
    expect((await pool.query('SELECT count(*)::int n FROM research_activities WHERE id=$1', [activity.id])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM research_artifact_links WHERE activity_id=$1', [activity.id])).rows[0].n).toBe(0)
  })

  it('R18: the app role cannot write research rows directly', async () => {
    const f = await briefFixture()
    const sessionId = await session(f, f.people.member)
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL app.current_user_id = '${f.people.member}'`)
      await expect(client.query(`INSERT INTO research_activities(workspace_id,session_id,actor_user_id,assistant_id,entry,idempotency_key)
        VALUES($1,$2,$3,$4,'explicit','direct')`, [f.workspaceId, sessionId, f.people.member, f.assistants.brian])).rejects.toThrow(/row-level security/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('R18: every research table is flush-classified and a workspace flush removes research rows and lessons', async () => {
    const tables = (await pool.query<{ t: string }>(`SELECT DISTINCT table_name t FROM information_schema.columns
      WHERE table_schema='public' AND column_name='workspace_id' AND (table_name LIKE 'research_%' OR table_name='assistant_playbook_rules')`)).rows.map((r) => r.t)
    const classified = new Set<string>([...WORKSPACE_FLUSH_TABLES, ...WORKSPACE_FLUSH_PRESERVED_TABLES])
    expect(tables.filter((t) => !classified.has(t))).toEqual([])
    const f = await briefFixture()
    const { activity } = await savedResearch(f, f.people.owner, null)
    await flushWorkspaceData(f.people.owner, f.workspaceId)
    expect((await pool.query('SELECT count(*)::int n FROM research_activities WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM research_artifact_links WHERE activity_id=$1', [activity.id])).rows[0].n).toBe(0)
  })
})


function researchApp(userId: string) {
  const auth: RequestHandler = (req, _res, next) => { req.userId = userId; next() }
  const app = express()
  app.use(express.json())
  app.use('/api', researchRoutes({ auth }))
  return app
}

const nomination = (idempotencyKey: string) => ({
  title: 'Coverage needs a second source',
  pattern: 'Comparisons rely on one source',
  desiredBehavior: 'Check independent source coverage',
  idempotencyKey,
})
const improvementsPath = (workspaceId: string) => `/api/workspaces/${workspaceId}/research/improvements`
const improvementRows = async (workspaceId: string) => (await pool.query(
  'SELECT id,created_by,revision,title,pattern,desired_behavior,feedback_ids,activity_ids FROM research_improvements WHERE workspace_id=$1 ORDER BY id',
  [workspaceId],
)).rows

// Authentication supplies a real fixture identity; routes, commands, owner
// writes and app_user permission projections below are the production code.
describe('[COMP:api/research-source-authority] nomination admission and replay on the real REST route', () => {
  it('R13: admits empty-evidence member nominations and visible creator/admin replay without extra writes', async () => {
    const f = await briefFixture(), path = improvementsPath(f.workspaceId), input = nomination('member-empty')
    const created = await request(researchApp(f.people.member)).post(path).send(input)
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ replayed: false, improvement: { createdBy: f.people.member, feedbackIds: [], activityIds: [] } })
    const before = await improvementRows(f.workspaceId)
    for (const viewer of [f.people.member, f.people.lead]) {
      const visible = await request(researchApp(viewer)).get(`${path}/${created.body.improvement.id}`)
      expect(visible.status).toBe(200)
      const replay = await request(researchApp(viewer)).post(path).send(input)
      expect(replay.status).toBe(200)
      expect(replay.body).toMatchObject({ replayed: true, improvement: { id: visible.body.improvement.id } })
    }
    expect(await improvementRows(f.workspaceId)).toEqual(before)
  })

  it('R08/R13: refuses an actor belonging only to a different workspace without an insert or notification', async () => {
    const target = await briefFixture(), foreign = await briefFixture()
    const before = await improvementRows(target.workspaceId)
    const emitted = vi.spyOn(notifications, 'notifyWorkspaceChange')
    try {
      const response = await request(researchApp(foreign.people.member)).post(improvementsPath(target.workspaceId)).send(nomination('foreign-empty'))
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'research_not_found' })
      expect(await improvementRows(target.workspaceId)).toEqual(before)
      expect(emitted).not.toHaveBeenCalled()
    } finally { emitted.mockRestore() }
  })

  it('R08/R13: refuses a removed workspace member without an insert or notification', async () => {
    const f = await briefFixture()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.people.outsider])
    const before = await improvementRows(f.workspaceId)
    const emitted = vi.spyOn(notifications, 'notifyWorkspaceChange')
    try {
      const response = await request(researchApp(f.people.outsider)).post(improvementsPath(f.workspaceId)).send(nomination('removed-empty'))
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'research_not_found' })
      expect(await improvementRows(f.workspaceId)).toEqual(before)
      expect(emitted).not.toHaveBeenCalled()
    } finally { emitted.mockRestore() }
  })

  it('R08/R13: a workspace-wide idempotency key cannot hydrate another member\'s hidden candidate', async () => {
    const f = await briefFixture(), path = improvementsPath(f.workspaceId), input = nomination('private-key')
    const created = await request(researchApp(f.people.member)).post(path).send(input)
    expect(created.status).toBe(200)
    expect((await request(researchApp(f.people.outsider)).get(`${path}/${created.body.improvement.id}`)).status).toBe(404)
    const before = await improvementRows(f.workspaceId)
    const emitted = vi.spyOn(notifications, 'notifyWorkspaceChange')
    try {
      const replay = await request(researchApp(f.people.outsider)).post(path).send(input)
      expect(replay.status).toBe(404)
      expect(replay.body).toEqual({ error: 'research_not_found' })
      expect(await improvementRows(f.workspaceId)).toEqual(before)
      expect(emitted).not.toHaveBeenCalled()
    } finally { emitted.mockRestore() }
  })

  it('R08: replay retains the Department floor for both a creator and an admin', async () => {
    const f = await briefFixture(), path = improvementsPath(f.workspaceId), input = nomination('department-key')
    await f.edge('user', f.people.member)
    const research = await savedResearch(f, f.people.member, null)
    await pool.query('UPDATE research_activities SET compartments=$2 WHERE id=$1', [research.activity.id, [`team:${f.finance}`]])
    const created = await request(researchApp(f.people.member)).post(path).send({ ...input, activityIds: [research.activity.id] })
    expect(created.status).toBe(200)
    expect((await request(researchApp(f.people.member)).post(path).send(input)).status).toBe(200)
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [f.finance, f.people.member])
    const before = await improvementRows(f.workspaceId)
    const emitted = vi.spyOn(notifications, 'notifyWorkspaceChange')
    try {
      for (const viewer of [f.people.member, f.people.lead]) {
        expect((await request(researchApp(viewer)).get(`${path}/${created.body.improvement.id}`)).status).toBe(404)
        const replay = await request(researchApp(viewer)).post(path).send(input)
        expect(replay.status).toBe(404)
        expect(replay.body).toEqual({ error: 'research_not_found' })
      }
      expect(await improvementRows(f.workspaceId)).toEqual(before)
      expect(emitted).not.toHaveBeenCalled()
    } finally { emitted.mockRestore() }
  })

  it('R08/R13: withholds a post-commit result after revocation while preserving the committed candidate', async () => {
    const f = await briefFixture(), viewerPool = getAppPool()
    expect(viewerPool).not.toBe(pool) // This maintained fixture has a real app_user pool.
    const input = nomination('postcommit-revocation')
    let atProjection = false
    let resumeProjection!: () => void
    const projectionGate = new Promise<void>(resolve => { resumeProjection = resolve })
    const realConnect = viewerPool.connect.bind(viewerPool)
    // Empty evidence performs no viewer read before persistence. Pause the
    // actual next app checkout, without replacing its query or permission result.
    const checkout = vi.spyOn(viewerPool, 'connect').mockImplementationOnce((async () => {
      atProjection = true
      await projectionGate
      return realConnect()
    }) as typeof viewerPool.connect)
    const emitted = vi.spyOn(notifications, 'notifyWorkspaceChange')
    let pending: Promise<request.Response> | undefined
    try {
      pending = request(researchApp(f.people.outsider)).post(improvementsPath(f.workspaceId)).send(input).then(response => response)
      await expect.poll(() => atProjection).toBe(true)
      // A separate owner read proves the insert is committed, not merely
      // visible inside an in-flight write transaction at this boundary.
      const committed = await improvementRows(f.workspaceId)
      expect(committed).toHaveLength(1)
      expect(committed[0]).toMatchObject({ created_by: f.people.outsider, title: input.title, revision: '1' })
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.people.outsider])
      resumeProjection()
      const response = await pending
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'research_not_found' })
      expect(await improvementRows(f.workspaceId)).toEqual(committed)
      expect(emitted).not.toHaveBeenCalled()
    } finally {
      resumeProjection()
      await pending?.catch(() => undefined)
      checkout.mockRestore()
      emitted.mockRestore()
    }
  })

  it('R08/R13: waits for the workspace barrier and observes a membership revocation committed by its holder', async () => {
    const f = await briefFixture(), holder = await pool.connect()
    const before = await improvementRows(f.workspaceId)
    const emitted = vi.spyOn(notifications, 'notifyWorkspaceChange')
    let pending: Promise<request.Response> | undefined
    let settled = false
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      pending = request(researchApp(f.people.outsider)).post(improvementsPath(f.workspaceId)).send(nomination('waiting-member'))
        .then(response => { settled = true; return response })
      // Observe either a response or the real PostgreSQL blocking relation.
      // The original INSERT may also wait here for its workspace foreign key;
      // it must still refuse after the holder commits the membership removal.
      await expect.poll(async () => settled || (await holder.query<{ blocked: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid],
      )).rows[0]!.blocked).toBe(true)
      expect(settled).toBe(false)
      await holder.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.people.outsider])
      await holder.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'research_not_found' })
      expect(await improvementRows(f.workspaceId)).toEqual(before)
      expect(emitted).not.toHaveBeenCalled()
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
      emitted.mockRestore()
    }
  })
})
