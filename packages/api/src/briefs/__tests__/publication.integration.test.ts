/**
 * Governed Brief state and publication on a migration-replayed database
 * (project-briefs.md; plan §7). Real actor-bound SQL, RLS and triggers; runs
 * only through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createProjectSharedStore } from '../../db/project-shared-store.js'
import { withBriefActor, listProposals } from '../../db/brief-store.js'
import { dismissProposal, ensureBrief, inspectBrief, proposeChange, saveDraft, briefHistory } from '../service.js'
import { actorOf, briefFixture } from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = getPool()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)
const code = async (work: Promise<unknown>) => work.then(() => 'ok', (error: { code?: string; message?: string }) =>
  /^brief_|^no_rows$/.test(error.message ?? '') ? error.message : error.code ?? error.message)
const pageOf = async (bindingId: string) => (await q('SELECT page_id FROM brief_bindings WHERE id=$1', [bindingId])).rows[0].page_id as string
const snapshotOf = async (pageId: string) => (await q('SELECT snapshot_json, seq FROM documents WHERE page_id=$1', [pageId])).rows[0]

describe('[COMP:api/brief-publication] Brief canonical state, drafts and publication', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('a name-only Project home gets an empty, not-established Brief and nothing else', async () => {
    const f = await briefFixture()
    const goalsBefore = (await q('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n
    const { bindingId, created } = await ensureBrief(actorOf(f, f.people.member), { kind: 'project', id: f.projectId })
    expect(created).toBe(true)
    // Idempotent: a second ensure resolves the same binding.
    expect(await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })).toEqual({ bindingId, created: false })
    const view = await inspectBrief(actorOf(f, f.people.lead), { bindingId })
    expect(view.role).toBe('owner')
    expect(view.established).toBe(false)
    expect(view.direction).toEqual({ outcome: [], rules: [], decisions: [] })
    expect(view.binding.directionRevision).toBe(0)
    expect(view.proposals).toEqual([])
    // The Page lives in the Project collection with the canonical placement.
    const page = (await q('SELECT shared_project_id, teamspace_id, state FROM saved_views WHERE id=$1', [view.pageId])).rows[0]
    expect(page).toMatchObject({ shared_project_id: f.projectId, teamspace_id: null, state: 'saved' })
    expect((await briefHistory(actorOf(f, f.people.lead), bindingId)).map(r => r.kind)).toEqual(['created'])
    // No Goal, no generated description, no questionnaire.
    expect((await q('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(goalsBefore)
    expect((await q('SELECT description FROM workspace_projects WHERE id=$1', [f.projectId])).rows[0].description).toBeNull()
  })

  it('a legacy description becomes a pending proposal, never accepted direction; a legacy Project has no Brief', async () => {
    const f = await briefFixture()
    const store = createProjectSharedStore()
    const described = await store.create(f.people.lead, f.workspaceId, { name: 'Beacon', description: 'Reduce invoice cycle time', userIds: [], assistantIds: [] })
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: described })
    const view = await inspectBrief(actorOf(f, f.people.lead), { bindingId })
    expect(view.direction!.outcome).toEqual([])
    expect(view.proposals).toHaveLength(1)
    expect(view.proposals[0].evidence[0]).toMatchObject({ kind: 'project_description', passage: 'Reduce invoice cycle time' })
    await q('UPDATE workspaces SET project_shared_spaces=false WHERE id=$1', [f.workspaceId])
    await q(`INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Legacy','legacy',$3)`, [randomUUID(), f.workspaceId, f.people.lead])
    const legacy = (await q(`SELECT id FROM workspace_projects WHERE workspace_id=$1 AND name='Legacy'`, [f.workspaceId])).rows[0].id
    await q('UPDATE workspaces SET project_shared_spaces=true WHERE id=$1', [f.workspaceId])
    expect(await code(ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: legacy }))).toBe('brief_requires_shared_project')
  })

  it('owner autosave changes only the private draft; the Page and accepted revision stay put', async () => {
    const f = await briefFixture()
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    const pageId = await pageOf(bindingId)
    const before = await snapshotOf(pageId)
    const draft = await saveDraft(actorOf(f, f.people.lead), bindingId, { sections: { outcome: ['Launch the billing pilot'] } })
    const again = await saveDraft(actorOf(f, f.people.lead), bindingId, { sections: { outcome: ['Launch the billing pilot in March'] } })
    expect(again.id).toBe(draft.id) // one open draft per author, autosaved in place
    expect(await snapshotOf(pageId)).toEqual(before)
    const lead = await inspectBrief(actorOf(f, f.people.lead), { bindingId })
    expect(lead.binding.directionRevision).toBe(0)
    expect(lead.direction!.outcome).toEqual([])
    expect(lead.myDraft?.id).toBe(draft.id)
    // A draft is the author's own: another participant never sees it.
    const member = await inspectBrief(actorOf(f, f.people.member), { bindingId })
    expect(member.myDraft).toBeNull()
    expect(await withBriefActor(f.people.member, c => listProposals(c, bindingId))).toEqual([])
  })

  it('participants and Brian propose with source evidence; a private source keeps the proposal private', async () => {
    const f = await briefFixture()
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    const shared = await proposeChange(actorOf(f, f.people.member, f.assistants.brian), bindingId, { sections: { rules: ['Invoices are approved by Finance'] } },
      { evidence: [{ kind: 'human', passage: 'Use this meeting note to update the project' }], summary: 'From the kickoff' })
    expect(shared.authorAssistantId).toBe(f.assistants.brian)
    expect(shared.envelope.compartments).toContain(`project:${f.projectId}`)
    // A personal chat is a private source: the proposal is visible only to its author.
    const session = randomUUID()
    await q(`INSERT INTO sessions(id,workspace_id,user_id,assistant_id,channel_type,channel_id,visibility) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'owner')`,
      [session, f.workspaceId, f.people.member, f.assistants.brian])
    const priv = await proposeChange(actorOf(f, f.people.member), bindingId, { sections: { decisions: ['Pricing stays private'] } },
      { evidence: [{ kind: 'session', id: session, passage: 'private remark' }] })
    expect(priv.envelope.privateToUser).toBe(f.people.member)
    const leadView = await inspectBrief(actorOf(f, f.people.lead), { bindingId })
    expect(leadView.proposals.map(p => p.id)).toEqual([shared.id])
    const memberView = await inspectBrief(actorOf(f, f.people.member), { bindingId })
    expect(memberView.proposals.map(p => p.id).sort()).toEqual([shared.id, priv.id].sort())
    // A source the actor cannot read is refused, never assumed.
    const hidden = randomUUID()
    await q(`INSERT INTO sessions(id,workspace_id,user_id,assistant_id,channel_type,channel_id,visibility) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'owner')`,
      [hidden, f.workspaceId, f.people.outsider, f.assistants.brian])
    expect(await code(proposeChange(actorOf(f, f.people.member), bindingId, { sections: { rules: ['x'] } }, { evidence: [{ kind: 'session', id: hidden }] })))
      .toBe('brief_unavailable')
    // Dismiss leaves accepted direction unchanged; only owner or author may dismiss.
    expect(await code(dismissProposal(actorOf(f, f.people.financeLead), shared.id))).toBe('brief_owner_required')
    await dismissProposal(actorOf(f, f.people.lead), shared.id)
    expect((await inspectBrief(actorOf(f, f.people.lead), { bindingId })).proposals).toEqual([])
    expect(await code(dismissProposal(actorOf(f, f.people.lead), shared.id))).toBe('brief_proposal_closed')
  })

  it('nonparticipants, oversight and unadmitted assistants cannot govern; Department Briefs follow Department authority', async () => {
    const f = await briefFixture()
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    expect(await code(inspectBrief(actorOf(f, f.people.outsider), { bindingId }))).toBe('brief_not_found')
    const oversight = await inspectBrief(actorOf(f, f.people.owner), { bindingId })
    expect(oversight.role).toBe('oversight')
    expect(await code(saveDraft(actorOf(f, f.people.owner), bindingId, { sections: { outcome: ['x'] } }))).toBe('brief_owner_required')
    // Ops is not on the Project roster: it cannot act here even for an owner.
    expect(await code(inspectBrief(actorOf(f, f.people.lead, f.assistants.ops), { bindingId }))).toBe('brief_not_found')
    // Department Brief: placed in the Department's teamspace, governed by its owner.
    const dept = await ensureBrief(actorOf(f, f.people.financeLead), { kind: 'department', id: f.finance })
    const deptView = await inspectBrief(actorOf(f, f.people.financeLead), { bindingId: dept.bindingId })
    expect(deptView.role).toBe('owner')
    expect((await q('SELECT teamspace_id FROM saved_views WHERE id=$1', [deptView.pageId])).rows[0].teamspace_id).toBe(f.financeSpace)
    // A Project owner without a Finance edge cannot see or govern Finance rules.
    expect(await code(inspectBrief(actorOf(f, f.people.lead), { bindingId: dept.bindingId }))).toBe('brief_not_found')
  })

  it('the history and binding tables refuse direct writes and edits', async () => {
    const f = await briefFixture()
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    // The app role has no write policy on any Brief table.
    expect(await code(withBriefActor(f.people.lead, c => c.query('UPDATE brief_bindings SET direction_revision=9 WHERE id=$1 RETURNING id', [bindingId])
      .then(r => { if (!r.rowCount) throw new Error('no_rows') })))).toBe('no_rows')
    // Even the owner role cannot rewrite accepted history.
    expect(await code(q(`UPDATE brief_revisions SET direction_hash='x' WHERE binding_id=$1`, [bindingId]))).toBe('brief_history_immutable')
    expect(await code(q('DELETE FROM brief_revisions WHERE binding_id=$1', [bindingId]))).toBe('brief_history_immutable')
  })
})
