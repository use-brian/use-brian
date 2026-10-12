/**
 * Governed Brief state and publication on a migration-replayed database
 * (project-briefs.md; plan §7). Real actor-bound SQL, RLS and triggers; runs
 * only through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createProjectSharedStore } from '../../db/project-shared-store.js'
import { withBriefActor, listProposals, publish, readPageState } from '../../db/brief-store.js'
import { createDbDocPageStore } from '../../db/doc-page-store.js'
import { applyDirection, restoreRevision, setBriefSyncClientForTests, buildPublishedState } from '../publication.js'
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

  it('explicit Apply publishes Page, revision and history atomically exactly once; a replay returns the same receipt', async () => {
    const f = await briefFixture()
    const synced: string[] = []
    setBriefSyncClientForTests({ syncBrief: async pageId => { synced.push(pageId); return true } })
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    const pageId = await pageOf(bindingId)
    const draft = await saveDraft(actorOf(f, f.people.lead), bindingId, { sections: { outcome: ['Launch the billing pilot'], rules: ['Finance approves invoices'] } })
    const key = randomUUID()
    const receipt = await applyDirection(actorOf(f, f.people.lead), bindingId, { proposalId: draft.id, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: key })
    expect(receipt).toMatchObject({ directionRevision: 1, replayed: false })
    const view = await inspectBrief(actorOf(f, f.people.member), { bindingId })
    expect(view.established).toBe(true)
    expect(view.direction).toEqual({ outcome: ['Launch the billing pilot'], rules: ['Finance approves invoices'], decisions: [] })
    expect(view.contentSeq).toBe(receipt.contentSeq)
    expect((await briefHistory(actorOf(f, f.people.lead), bindingId)).map(r => r.kind)).toEqual(['apply', 'created'])
    expect((await q('SELECT status FROM brief_proposals WHERE id=$1', [draft.id])).rows[0].status).toBe('applied')
    expect(synced).toEqual([pageId])
    expect((await q('SELECT broadcast_at FROM brief_revisions WHERE id=$1', [receipt.revisionId])).rows[0].broadcast_at).not.toBeNull()
    // Identical confirmed replay: same receipt, no second publication or broadcast.
    const replay = await applyDirection(actorOf(f, f.people.lead), bindingId, { proposalId: draft.id, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: key })
    expect(replay).toMatchObject({ revisionId: receipt.revisionId, directionRevision: 1, replayed: true })
    expect((await q('SELECT count(*)::int n FROM brief_revisions WHERE binding_id=$1', [bindingId])).rows[0].n).toBe(2)
    expect(synced).toHaveLength(1)
    // Same key, different request: refused, not merged.
    expect(await code(applyDirection(actorOf(f, f.people.lead), bindingId, { change: { sections: { outcome: ['Other'] } }, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: key })))
      .toBe('brief_idempotency_conflict')
    setBriefSyncClientForTests(undefined)
  })

  it('only an owner applies; Brian executes an owner\'s explicit Apply within its own admission', async () => {
    const f = await briefFixture()
    setBriefSyncClientForTests(null)
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    const proposal = await proposeChange(actorOf(f, f.people.member, f.assistants.brian), bindingId, { sections: { rules: ['Weekly status on Fridays'] } },
      { evidence: [{ kind: 'human', passage: 'we agreed weekly status on Fridays' }] })
    const apply = (userId: string, assistantId: string | null = null) => applyDirection(actorOf(f, userId, assistantId), bindingId,
      { proposalId: proposal.id, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    expect(await code(apply(f.people.member))).toBe('brief_owner_required')
    expect(await code(apply(f.people.member, f.assistants.brian))).toBe('brief_owner_required')
    expect(await code(apply(f.people.owner))).toBe('brief_owner_required') // workspace-owner oversight is not approval
    expect(await code(apply(f.people.lead, f.assistants.ops))).toBe('brief_not_found') // Ops holds no Project admission
    const ok = await apply(f.people.lead, f.assistants.brian)
    const row = (await q('SELECT actor_user_id, acting_assistant_id, evidence FROM brief_revisions WHERE id=$1', [ok.revisionId])).rows[0]
    expect(row).toMatchObject({ actor_user_id: f.people.lead, acting_assistant_id: f.assistants.brian })
    expect(row.evidence[0]).toMatchObject({ passage: 'we agreed weekly status on Fridays' })
  })

  it('stale and concurrent applications are refused without partial mutation', async () => {
    const f = await briefFixture()
    setBriefSyncClientForTests(null)
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    const pageId = await pageOf(bindingId)
    const early = await proposeChange(actorOf(f, f.people.member), bindingId, { sections: { decisions: ['Use vendor A'] } }, { evidence: [{ kind: 'human', passage: 'vendor A' }] })
    const racers = await Promise.allSettled([1, 2].map(n => applyDirection(actorOf(f, f.people.lead), bindingId,
      { change: { sections: { outcome: [`Outcome ${n}`] } }, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })))
    expect(racers.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(racers.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual(['brief_revision_stale'])
    const before = await snapshotOf(pageId)
    // The proposal was drafted against revision 0: it needs review against the current state.
    expect(await code(applyDirection(actorOf(f, f.people.lead), bindingId, { proposalId: early.id, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })))
      .toBe('brief_revision_stale')
    // A publication against an old content base is refused by the SQL CAS itself.
    const stale = await withBriefActor(f.people.lead, async client => {
      const state = (await readPageState(client, pageId, { withYdoc: true }))!
      const next = buildPublishedState(new Uint8Array(state.ydoc!), [])
      return code(publish(client, { bindingId, proposalId: null, ops: [], expectedDirection: 1, expectedSelection: 0, baseSeq: state.seq - 1,
        nextYdoc: next.ydoc, nextStateVector: next.stateVector, nextSnapshot: next.snapshot.page, nextTitle: null, idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64), evidence: [], activeWork: 'pause', kind: 'apply', assistantId: null }))
    })
    expect(stale).toBe('brief_page_changed')
    expect(await snapshotOf(pageId)).toEqual(before)
    expect((await q('SELECT direction_revision FROM brief_bindings WHERE id=$1', [bindingId])).rows[0].direction_revision).toBe(1)
  })

  it('every raw writer is refused: legacy CAS, raw snapshots, delete and move; Current context stays editable', async () => {
    const f = await briefFixture()
    setBriefSyncClientForTests(null)
    const { bindingId } = await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    await applyDirection(actorOf(f, f.people.lead), bindingId, { change: { sections: { rules: ['Accepted rule'] } }, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    const pageId = await pageOf(bindingId)
    const view = await inspectBrief(actorOf(f, f.people.lead), { bindingId })
    const current = (await snapshotOf(pageId)).snapshot_json
    // Legacy CAS (patchPage without doc-sync, Undo's last_undo restore): the legacy body is frozen.
    const legacy = createDbDocPageStore()
    expect(await code(legacy.applyPatch({ userId: f.people.lead, pageId, expectedVersion: 1, nextPage: { blocks: [] }, undo: null as never })))
      .toBe('brief_direction_protected')
    // A raw snapshot write that changes Direction, even by the owner role (bypassing RLS).
    const tampered = { blocks: current.blocks.map((b: { id: string; text?: string }) => b.id === view.directionBlocks!.rules[0].id ? { ...b, text: 'Injected rule' } : b) }
    expect(await code(q('UPDATE documents SET snapshot_json=$2 WHERE page_id=$1', [pageId, JSON.stringify(tampered)]))).toBe('brief_direction_protected')
    // A Current-context-only write passes the same guard.
    const findings = view.binding.layout.sectionIds.findings
    const idx = current.blocks.findIndex((b: { id: string }) => b.id === findings)
    const withFinding = { blocks: [...current.blocks.slice(0, idx + 1), { kind: 'text', id: randomUUID(), text: 'A finding' }, ...current.blocks.slice(idx + 1)] }
    expect(await code(q('UPDATE documents SET snapshot_json=$2 WHERE page_id=$1', [pageId, JSON.stringify(withFinding)]))).toBe('ok')
    // Delete, move and documents removal are refused outside workspace teardown.
    expect(await code(withBriefActor(f.people.lead, c => c.query('DELETE FROM saved_views WHERE id=$1', [pageId])))).toBe('brief_page_bound')
    expect(await code(q('UPDATE saved_views SET shared_project_id=NULL WHERE id=$1', [pageId]))).toBe('brief_page_bound')
    expect(await code(q('DELETE FROM documents WHERE page_id=$1', [pageId]))).toBe('brief_page_bound')
    expect((await inspectBrief(actorOf(f, f.people.lead), { bindingId })).direction!.rules).toEqual(['Accepted rule'])
  })

  it('restoring history is a new reviewed change; a failed broadcast never fakes or loses acceptance', async () => {
    const f = await briefFixture()
    setBriefSyncClientForTests({ syncBrief: async () => false })
    const lead = actorOf(f, f.people.lead)
    const { bindingId } = await ensureBrief(lead, { kind: 'project', id: f.projectId })
    const first = await applyDirection(lead, bindingId, { change: { sections: { outcome: ['Version one'] } }, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    await applyDirection(lead, bindingId, { change: { sections: { outcome: ['Version two'], decisions: ['Added later'] } }, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    // The broadcast failed, yet the committed state is the accepted state.
    expect((await q('SELECT broadcast_at FROM brief_revisions WHERE id=$1', [first.revisionId])).rows[0].broadcast_at).toBeNull()
    expect((await inspectBrief(lead, { bindingId })).direction!.outcome).toEqual(['Version two'])
    const { proposalId } = await restoreRevision(lead, bindingId, first.revisionId)
    // Restoring proposes; nothing changes until the owner applies under current authority.
    expect((await inspectBrief(lead, { bindingId })).direction!.outcome).toEqual(['Version two'])
    const restored = await applyDirection(lead, bindingId, { proposalId, expectedDirectionRevision: 2, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    expect(restored.directionRevision).toBe(3)
    const after = await inspectBrief(lead, { bindingId })
    expect(after.direction).toEqual({ outcome: ['Version one'], rules: [], decisions: [] })
    expect((await briefHistory(lead, bindingId)).map(r => r.kind)).toEqual(['restore', 'apply', 'apply', 'created'])
    setBriefSyncClientForTests(undefined)
  })
})
