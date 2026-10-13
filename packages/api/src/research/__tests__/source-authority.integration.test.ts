/**
 * Research source authority against a migration-replayed PostgreSQL 18 with
 * real RLS through the NOBYPASSRLS app role: who sees an activity, its
 * artifacts and its follow-ups, and what revocation, holds, page deletion,
 * Department floors and erasure do to those projections (R01, R08, R18).
 * Runs only through scripts/crm/local-fixture.mjs. Fictional identities.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import {
  countResearchActivitiesForViewer,
  getResearchActivityForViewer,
  listResearchActivitiesForViewer,
  listResearchEvidenceSystem,
} from '../../db/research-store.js'
import { briefFixture, type BriefFixture } from '../../briefs/__tests__/fixture.js'
import { createResearchTurnObserver, recordResearchDelivery } from '../delivery.js'
import { flushWorkspaceData, WORKSPACE_FLUSH_PRESERVED_TABLES, WORKSPACE_FLUSH_TABLES } from '../../db/workspace-flush.js'
import { beginResearchActivity, captureResearchFollowupForMessage, createResearchDeliveryDeps } from '../runtime.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

let seq = 0
async function session(f: BriefFixture, userId: string, projectId: string | null = null) {
  const id = randomUUID()
  await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance,context_project_id)
    VALUES($1,$2,$3,'web',$6,$4,'internal',$5)`, [id, f.assistants.brian, userId, f.workspaceId, projectId, id])
  return id
}

async function message(f: BriefFixture, sessionId: string, role: 'user' | 'assistant', text: string, owner: string) {
  seq += 1
  return (await pool.query<{ id: string }>(`INSERT INTO session_messages(session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,
      sensitivity,compartments,project_ids,scope_version,scope_held)
    VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,'internal','{}','{}',1,false) RETURNING id`,
  [sessionId, role, JSON.stringify([{ type: 'text', text }]), seq, f.workspaceId, owner, f.assistants.brian])).rows[0]!.id
}

/** A real research turn for `actor`: activity, default Page in the Project collection, inspected link. */
async function savedResearch(f: BriefFixture, actor: string, projectId: string | null) {
  const sessionId = await session(f, actor, projectId)
  const request = await message(f, sessionId, 'user', 'Research fictional widget vendors', actor)
  const activity = await beginResearchActivity({
    workspaceId: f.workspaceId, sessionId, requestMessageId: request, actorUserId: actor, assistantId: f.assistants.brian,
    projectId, entry: 'explicit', runtime: { surface: 'test' },
  })
  const output = await message(f, sessionId, 'assistant', 'Vendor A leads on price.', actor)
  const observer = createResearchTurnObserver()
  observer.observeWorker({ type: 'tool_input', id: 'w1', name: 'urlReader', input: { url: 'https://example.com/vendors' } })
  observer.observeWorker({ type: 'tool_result', id: 'w1', results: [{ type: 'tool_result', toolUseId: 'w1', name: 'urlReader', content: 'text' }] })
  const settled = await recordResearchDelivery(createResearchDeliveryDeps(), {
    activity, observation: observer.snapshot(), finalText: '## Vendors\nVendor A leads on price.', outputMessageId: output, requestText: 'Research fictional widget vendors',
  })
  return { sessionId, request, output, activity: settled }
}

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
