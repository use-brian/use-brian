import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FeedCommand, FeedCommandRequest, FeedEdit } from '@use-brian/shared'
import { feedParagraph, projectFeed, sliceFeedInline } from '@use-brian/doc-model'
import { getPool, queryWithRLS } from '../../db/client.js'
import { executeFeedCommands, getFeedCollaboration, getFeedThreadMessages, type FeedActor, type StructuredFeedContent } from '../../db/feed-collaboration-store.js'
import { postWorkingCopiesStore, type PostWorkingContent } from '../../db/post-working-copies.js'

// Deliberately no skip: this is the phase barrier, not a mocked substitute.
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/absent')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/feed_draft_collaboration_acceptance') throw new Error('Feed integration requires its isolated loopback acceptance database')
const pool = getPool(); const createdWorkspaces: string[] = []; const users: string[] = []
beforeAll(async () => {
  const row = (await pool.query('SELECT inet_server_addr()::text AS address,current_database() AS name')).rows[0]
  expect(['127.0.0.1/32', '127.0.0.1', '::1/128', '::1']).toContain(row.address)
  expect(row.name).toBe('feed_draft_collaboration_acceptance')
})
afterAll(async () => {
  for (const id of createdWorkspaces) await pool.query('DELETE FROM workspaces WHERE id=$1', [id])
  for (const id of users) await pool.query('DELETE FROM users WHERE id=$1', [id])
  await pool.end()
})
async function fixture(text = 'First paragraph.\n\nThe same phrase.\n\nThe same phrase.') {
  const workspaceId = randomUUID(); const userId = randomUUID(); const otherId = randomUUID(); const assistantId = randomUUID(); const sessionId = randomUUID()
  createdWorkspaces.push(workspaceId); users.push(userId, otherId)
  await pool.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,\'Author fixture\'),($2::uuid,$2::text,\'Editor fixture\')', [userId, otherId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Feed fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,can_draft) VALUES($1,$2,'owner',true),($1,$3,'member',true)", [workspaceId, userId, otherId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,app_type,clearance) VALUES($1,'Feed fixture',$2,$3,'app','distribution','internal')", [assistantId, workspaceId, userId])
  const actor: FeedActor = { userId, assistantId, sessionId, kind: 'user' }; const other = { ...actor, userId: otherId }
  const content: PostWorkingContent = { title: 'Fixture draft', privateBrief: 'Private direction', text, postFormat: 'post', threadSegments: [], article: { sourceUrl: '', title: '', description: '' }, media: [] }
  await postWorkingCopiesStore.put(assistantId, sessionId, userId, { revision: 0, mutationId: randomUUID(), create: { platform: 'threads' }, content })
  const command = async (commands: FeedCommand[], expectedRevision?: number, who = actor, mutationId = randomUUID()) => executeFeedCommands(who, { commands, expectedRevision: expectedRevision ?? (await getFeedCollaboration(actor)).copy!.revision, mutationId })
  const upgrade = async () => { await command([{ kind: 'upgrade' }], 1); return (await getFeedCollaboration(actor)).copy!.content as StructuredFeedContent }
  return { workspaceId, actor, other, command, upgrade, content }
}
function replace(content: StructuredFeedContent, block: number, text: string): FeedEdit {
  const segment = content.composition.segments[0]!; const node = segment.content[block]!
  if (node.type !== 'paragraph' && node.type !== 'heading') throw new Error('text required')
  const length = (node.content ?? []).reduce((n, item) => n + (item.type === 'text' ? item.text.length : 1), 0)
  return { kind: 'replaceText', spans: [{ segmentId: segment.id, blockId: node.attrs.id, from: 0, to: length }], preimage: [sliceFeedInline(node.content ?? [], 0, length)], replacement: [[{ type: 'text', text }]] }
}

import { loadFeedReviewContext } from '../review-context.js'
import { createFeedReviewHandler, requestFeedReview } from '../review.js'
import { claimFeedRun, getFeedRun, retryFeedRun, failFeedRun, cancelFeedRun, markFeedDispatch, saveFeedPart, summarizeFeedRun } from '../../db/feed-editorial-runs-store.js'
import { createMemory } from '../../db/memories.js'
import { FEED_REVIEW_DIMENSIONS } from '@use-brian/shared'
import { readReviewedFeedCollaboration } from '../collaboration-service.js'
async function reviewFixture() {
  const f = await fixture('Orchard irrigation saves water.'); await f.upgrade()
  const goal = (await pool.query(`INSERT INTO goals(workspace_id,outcome,done_when,created_by_user_id) VALUES($1,'Explain water savings','{"kind":"subtasks"}',$2) RETURNING id`, [f.workspaceId, f.actor.userId])).rows[0].id
  await f.command([{ kind: 'context', goalId: goal, reviewMonth: '2026-10' }])
  await pool.query(`INSERT INTO content_plan_briefs(assistant_id,month_start,brief,themes) VALUES($1,'2026-10-01','Explain orchard irrigation',ARRAY['water savings'])`, [f.actor.assistantId])
  await pool.query(`INSERT INTO assistant_playbook_rules(assistant_id,rule,status,created_by) VALUES($1,'Use specific orchard examples.','active','owner')`, [f.actor.assistantId])
  await createMemory({ assistantId: f.actor.assistantId, workspaceId: f.workspaceId, userId: f.actor.userId, createdByUserId: f.actor.userId, scope: 'shared', sensitivity: 'internal', summary: 'Secret personal preference.', source: 'manual', tags: ['voice'] })
  const historySession = randomUUID()
  await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,mode,title) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'draft','History fixture')`, [historySession, f.actor.assistantId, f.actor.userId, f.workspaceId])
  for (let i = 0; i < 55; i++) await pool.query(`INSERT INTO content_planning_drafts(assistant_id,session_id,platform,draft_text,final_text,status,created_at,resolved_at) VALUES($1,$4,'threads',$2,$2,'posted',now()-($3::int*interval '1 day'),now()-($3::int*interval '1 day'))`, [f.actor.assistantId, i === 54 ? 'Older orchard irrigation uses less water than the current unsupported claim.' : 'Orchard irrigation example '+i, i, historySession])
  return f
}
describe('[COMP:feed/draft-review] real database review lifecycle', () => {
  it('excludes playbook guidance above the assistant clearance even when every member can read it', async () => {
    const f = await fixture(); await f.upgrade()
    const rules = (await pool.query(`INSERT INTO assistant_playbook_rules(assistant_id,rule,status,created_by,decision_sensitivity) VALUES
      ($1,'Use public examples.','active','owner','public'),
      ($1,'Use internal examples.','active','owner','internal') RETURNING id,decision_sensitivity`, [f.actor.assistantId])).rows
    await pool.query("UPDATE assistants SET clearance='public' WHERE id=$1", [f.actor.assistantId])

    const context = await loadFeedReviewContext(f.actor)
    const sourceIds = context.dimensions.memory.sources.map(item => item.id)
    const publicRule = rules.find(rule => rule.decision_sensitivity === 'public')!
    const internalRule = rules.find(rule => rule.decision_sensitivity === 'internal')!
    expect(sourceIds).toContain(`playbook:${publicRule.id}`)
    expect(sourceIds).not.toContain(`playbook:${internalRule.id}`)
    expect(context.dimensions.memory.coverage.limits).toContain('private_or_bounded_sources_omitted')
  })

  it('scenarios 16-19: freezes the explicit Goal/month, reads older full bodies, excludes private sources and persists five comments-only checks', async () => {
    const f = await reviewFixture(); const before = (await getFeedCollaboration(f.actor)).copy!
    const context = await loadFeedReviewContext(f.actor)
    expect(context.month).toBe('2026-10'); expect(context.goalId).toBe(before.content.goalId)
    expect(context.dimensions.memory.sources.some(item => item.body.includes('Secret'))).toBe(false)
    expect(context.dimensions.post_history.sources).toHaveLength(50)
    expect(context.dimensions.post_history.coverage).toMatchObject({ state: 'partial', eligible: 55, nextCursor: 20 })
    const call = vi.fn(async ({ prompt }: { prompt: string }) => {
      const input = JSON.parse(prompt); const source = input.sources[0]
      return { text: JSON.stringify({ findings: [{ issueKey: input.dimension+'_fixture', dimensions: [input.dimension], priority: 'medium', target: { kind: 'post' }, issue: 'Use a supported example.', nextStep: 'Add the measured water saving.', evidence: [{ sourceId: source.id, quote: source.body.slice(0, 160) }] }] }) }
    })
    const request = { mutationId: randomUUID(), expectedRevision: before.revision, model: 'standard' as const, locale: 'en' as const }
    const queued = await requestFeedReview(f.actor, request); const active = await claimFeedRun(['review']); expect(active?.id).toBe(queued.id)
    await createFeedReviewHandler(async () => ({ model: 'fixture', tier: 'standard', inputCharacters: 160_000, maxTokens: 6000, call }))(active!, new AbortController().signal)
    expect(call).toHaveBeenCalledTimes(5)
    expect(call.mock.calls.map(([input]) => JSON.parse(input.prompt).dimension)).toEqual(FEED_REVIEW_DIMENSIONS)
    const complete = await getFeedRun(f.actor, queued.id); expect(complete.status).toBe('succeeded')
    expect(Object.keys(complete.result.parts)).toHaveLength(5)
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.copy!.content).toEqual(before.content); expect(snapshot.copy!.revision).toBe(before.revision)
    expect(snapshot.threads).toHaveLength(6); expect(snapshot.suggestions).toHaveLength(0)
    expect((await pool.query('SELECT id FROM decision_events WHERE session_id=$1', [f.actor.sessionId])).rows).toHaveLength(0)
    expect((await requestFeedReview(f.actor, request)).id).toBe(queued.id)
    expect((await retryFeedRun(f.actor, queued.id)).status).toBe('succeeded')
    const reused = await requestFeedReview(f.actor, { ...request, mutationId: randomUUID() })
    expect(reused.status).toBe('succeeded'); expect(reused.summaryThreadId).toBe(complete.summaryThreadId)
    expect(call).toHaveBeenCalledTimes(5); expect((await getFeedCollaboration(f.actor)).threads).toHaveLength(6)
    // Completed provider receipts also survive a worker restart between
    // persistence and acknowledgement. Reapplication does not repeat calls.
    await pool.query("UPDATE feed_editorial_runs SET status='pending' WHERE id=$1", [queued.id])
    const recovered = (await claimFeedRun(['review']))!
    const removedProvider = vi.fn(async () => { throw new Error('Provider is no longer configured') })
    await createFeedReviewHandler(removedProvider)(recovered, new AbortController().signal)
    expect(removedProvider).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(5); expect((await getFeedCollaboration(f.actor)).threads).toHaveLength(6)
    await pool.query("UPDATE goals SET outcome='Explain a different outcome',updated_at=now() WHERE id=$1", [context.goalId])
    const revalidated = await readReviewedFeedCollaboration(f.actor)
    expect(revalidated.runs.find(run => run.id === reused.id)?.stale).toBe(true)
    await expect(requestFeedReview(f.actor, { ...request, mutationId: randomUUID(), continuationRunId: queued.id })).rejects.toMatchObject({ code: 'review_context_changed_start_new' })
    const continued = await loadFeedReviewContext(f.actor, { historyCursor: context.dimensions.post_history.coverage.nextCursor! })
    expect(continued.dimensions.post_history.sources.some(item => item.body.includes('Older orchard'))).toBe(true)
    expect(continued.dimensions.post_history.sources.every(item => !context.dimensions.post_history.sources.some(old => old.id === item.id))).toBe(true)
  })
  it('scenario 19: an uncertain provider call cannot be resent by retry or cancellation', async () => {
    const f = await fixture(); await f.upgrade(); const revision = (await getFeedCollaboration(f.actor)).copy!.revision
    const queued = await requestFeedReview(f.actor, { mutationId: randomUUID(), expectedRevision: revision, model: 'standard', locale: 'en' })
    const active = (await claimFeedRun(['review']))!; expect(active.id).toBe(queued.id)
    const call = vi.fn(async () => { throw new Error('Transport lost after dispatch') })
    await expect(createFeedReviewHandler(async () => ({ model: 'fixture', tier: 'standard', inputCharacters: 160_000, maxTokens: 6000, call }))(active, new AbortController().signal)).rejects.toThrow()
    await failFeedRun(active, 'provider_outcome_unknown')
    expect((await getFeedRun(f.actor, active.id)).status).toBe('unknown_outcome')
    await expect(retryFeedRun(f.actor, active.id)).rejects.toMatchObject({ code: 'fresh_explicit_attempt_required' })
    await cancelFeedRun(f.actor, active.id)
    await expect(retryFeedRun(f.actor, active.id)).rejects.toMatchObject({ code: 'fresh_explicit_attempt_required' })
    expect(call).toHaveBeenCalledTimes(1)
    const partial = await getFeedRun(f.actor, active.id)
    expect(partial.summaryThreadId).toBeTruthy(); expect(Object.keys(partial.coverage)).toHaveLength(5)
  })
  it('scenario 20: concurrent duplicate requests return one durable run without exhausting the source-read pool', async () => {
    const f = await fixture(); await f.upgrade()
    const request = { mutationId: randomUUID(), expectedRevision: 2, model: 'standard' as const, locale: 'en' as const }
    const results = await Promise.all(Array.from({ length: 10 }, () => requestFeedReview(f.actor, request)))
    expect(new Set(results.map(run => run.id)).size).toBe(1)
    await cancelFeedRun(f.actor, results[0]!.id)
  })
  it('scenarios 7 and 19: revoking draft access invalidates queued worker authority before any model call', async () => {
    const f = await fixture(); await f.upgrade()
    const queued = await requestFeedReview(f.other, { mutationId: randomUUID(), expectedRevision: 2, model: 'standard', locale: 'en' })
    await pool.query('UPDATE workspace_members SET can_draft=false WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.other.userId])
    const active = (await claimFeedRun(['review']))!; expect(active.id).toBe(queued.id)
    const resolve = vi.fn(async () => ({ model: 'fixture', tier: 'standard', inputCharacters: 160_000, maxTokens: 6000, call: vi.fn(async () => ({ text: '{"findings":[]}' })) }))
    await expect(createFeedReviewHandler(resolve)(active, new AbortController().signal)).rejects.toMatchObject({ status: 403 })
    expect(resolve).not.toHaveBeenCalled(); await failFeedRun(active, 'draft_access_required')
    await expect(retryFeedRun(f.other, active.id)).rejects.toMatchObject({ status: 403 })
  })
  it('scenario 19: a deleted target stays detached in the completed review, with its original quote and source revision', async () => {
    const f = await fixture('Keep this paragraph.\n\nRemove this paragraph.'); const content = await f.upgrade(); const segment = content.composition.segments[0]!; const node = segment.content[1]!
    const queued = await requestFeedReview(f.actor, { mutationId: randomUUID(), expectedRevision: 2, model: 'standard', locale: 'en' })
    const active = (await claimFeedRun(['review']))!; expect(active.id).toBe(queued.id)
    const call = vi.fn(async () => {
      await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: segment.id, blockId: node.attrs.id, preimage: node, replacement: [] }] }])
      return { text: JSON.stringify({ findings: [{ issueKey: 'remove_unsupported_claim', dimensions: ['content'], priority: 'high', target: { kind: 'block', segmentId: segment.id, blockId: node.attrs.id }, issue: 'The old claim needs evidence.', nextStep: 'Provide evidence.', evidence: [] }] }) }
    })
    await createFeedReviewHandler(async () => ({ model: 'fixture', tier: 'standard', inputCharacters: 160_000, maxTokens: 6000, call }))(active, new AbortController().signal)
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.threads.find(thread => thread.anchor.target.kind === 'block')?.anchor).toMatchObject({ quote: 'Remove this paragraph.', sourceRevision: 2, state: 'detached' })
    expect((await getFeedRun(f.actor, active.id)).coverage.content?.limits).toContain('draft_changed_since_review')
    expect(snapshot.copy?.content.text).toBe('Keep this paragraph.')
  })
  it('scenario 20: later checks reuse resolved discussions; changed evidence adds an explanation before reopening', async () => {
    const f = await reviewFixture(); const revision = (await getFeedCollaboration(f.actor)).copy!.revision
    const call = vi.fn(async ({ prompt }: { prompt: string }) => {
      const input = JSON.parse(prompt)
      return { text: JSON.stringify({ findings: input.dimension === 'memory' ? [{ issueKey: 'voice_example', dimensions: ['memory'], priority: 'medium', target: { kind: 'post' }, issue: 'Add a concrete example.', nextStep: 'Use the approved voice preference.', evidence: [{ sourceId: input.sources[0].id }] }] : [] }) }
    })
    async function run(model: 'standard' | 'pro') {
      const queued = await requestFeedReview(f.actor, { mutationId: randomUUID(), expectedRevision: revision, model, locale: 'en' })
      const active = (await claimFeedRun(['review']))!; expect(active.id).toBe(queued.id)
      await createFeedReviewHandler(async () => ({ model: 'fixture', tier: model, inputCharacters: 160_000, maxTokens: 6000, call }))(active, new AbortController().signal)
      return getFeedCollaboration(f.actor)
    }
    const first = await run('standard'); const thread = first.reviewFindings[0]!.threadId
    await f.command([{ kind: 'reply', threadId: thread, text: 'Keep this discussion.' }, { kind: 'resolve', threadId: thread, resolved: true }])
    const second = await run('pro')
    expect(second.threads).toHaveLength(3); expect(second.threads.find(item => item.id === thread)?.resolved).toBe(true)
    expect(await getFeedThreadMessages(f.actor, thread)).toHaveLength(2)
    await pool.query("UPDATE assistant_playbook_rules SET rule='Use concrete orchard measurements.' WHERE assistant_id=$1", [f.actor.assistantId])
    const third = await run('standard')
    expect(third.threads).toHaveLength(4); expect(third.threads.find(item => item.id === thread)?.resolved).toBe(false)
    const messages = await getFeedThreadMessages(f.actor, thread)
    expect(messages).toHaveLength(3); expect(JSON.stringify(messages.at(-1)?.content)).toContain('source evidence changed')
  })
  it('scenario 20: separate Review runs retain exact rule applications and acceptance links only to the owning draft', async () => {
    const f = await fixture(); const content = await f.upgrade()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.other.userId])
    const ruleId = (await pool.query(`INSERT INTO assistant_playbook_rules(assistant_id,rule,status,created_by,applies_to_user_id) VALUES($1,'Use concrete introductions.','active','decision_reflection',$2) RETURNING id`, [f.actor.assistantId, f.actor.userId])).rows[0].id
    const source = vi.fn(async () => ({ text: '{"findings":[]}' }))
    const runIds: string[] = []
    for (const model of ['standard', 'pro'] as const) {
      const queued = await requestFeedReview(f.actor, { mutationId: randomUUID(), expectedRevision: 2, model, locale: 'en' }); runIds.push(queued.id)
      const active = (await claimFeedRun(['review']))!
      await createFeedReviewHandler(async () => ({ model: 'fixture', tier: model, inputCharacters: 160_000, maxTokens: 6000, call: source }))(active, new AbortController().signal)
    }
    const applications = (await pool.query("SELECT id,operation_id,artifact_refs FROM decision_applications WHERE assistant_id=$1 AND operation_kind='feed_review' ORDER BY created_at", [f.actor.assistantId])).rows
    expect(applications.map(row => row.operation_id)).toEqual(runIds)
    expect(applications.map(row => row.artifact_refs)).toEqual([[{ kind: 'assistant_playbook_rule', id: ruleId }], [{ kind: 'assistant_playbook_rule', id: ruleId }]])
    const suggestionId = randomUUID()
    await f.command([{ kind: 'propose', suggestionId, edits: [replace(content, 0, 'A concrete example.')], rationale: 'Use the reviewed preference.', applicationId: applications[1].id }])
    await expect(pool.query('UPDATE feed_draft_suggestions SET application_id=$2 WHERE id=$1', [suggestionId, applications[0].id])).rejects.toThrow('immutable')
    await f.command([{ kind: 'decide', suggestionId, outcome: 'accepted' }])
    const event = (await pool.query("SELECT caused_by_application_id FROM decision_events WHERE session_id=$1 AND event_kind='feed.proposal_decided'", [f.actor.sessionId])).rows[0]
    expect(event.caused_by_application_id).toBe(applications[1].id)
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,can_draft) VALUES($1,$2,'member',true)", [f.workspaceId, f.other.userId])
    await expect(queryWithRLS(f.other.userId, 'UPDATE feed_draft_suggestions SET application_id=NULL WHERE id=$1', [suggestionId])).rejects.toThrow('immutable')
    const other = await fixture(); const otherContent = await other.upgrade()
    await expect(other.command([{ kind: 'propose', suggestionId: randomUUID(), edits: [replace(otherContent, 0, 'Wrong source.')], rationale: 'Must not link.', applicationId: applications[1].id }])).rejects.toMatchObject({ code: 'application_scope_mismatch' })
    await pool.query('DELETE FROM workspaces WHERE id=$1', [f.workspaceId])
    expect((await pool.query('SELECT id FROM feed_editorial_runs WHERE session_id=$1', [f.actor.sessionId])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM feed_comment_threads WHERE session_id=$1', [f.actor.sessionId])).rowCount).toBe(0)
  })
})
describe('[COMP:feed/draft-comments] PostgreSQL command and anchor barrier', () => {
  it('scenarios 2 and 9: upgrades losslessly and stores the legacy snapshot without stripping old-client retries', async () => {
    const f = await fixture('  **Bold** 中文\n\n[unfinished gap]\n'); const structured = await f.upgrade()
    expect(projectFeed(structured.composition).text).toBe(f.content.text)
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.copy!.revision).toBe(2)
    const old = (await pool.query('SELECT content FROM feed_post_revisions WHERE session_id=$1 AND revision=1', [f.actor.sessionId])).rows[0]
    expect(old.content).toEqual(f.content)
    await expect(postWorkingCopiesStore.put(f.actor.assistantId, f.actor.sessionId, f.actor.userId, { revision: 2, mutationId: snapshot.copy!.mutationId, content: f.content })).rejects.toMatchObject({ status: 409 })
    expect((await getFeedCollaboration(f.actor)).copy!.content).toEqual(structured)
    await expect(pool.query('UPDATE feed_post_working_copies SET content=$2 WHERE session_id=$1', [f.actor.sessionId, JSON.stringify(f.content)])).rejects.toThrow('typed commands')
  })
  it('scenarios 1 and 2: threads use attributed Feed transcripts and discussion does not invalidate content', async () => {
    const f = await fixture(); const content = await f.upgrade(); const segment = content.composition.segments[0]!; const threadId = randomUUID()
    const anchor = { kind: 'range' as const, spans: [{ segmentId: segment.id, blockId: segment.content[2]!.attrs.id, from: 4, to: 15 }] }
    const receipt = await f.command([{ kind: 'comment', threadId, target: anchor, text: 'Make the second example precise.' }], 2)
    expect(receipt.revision).toBe(2)
    await f.command([{ kind: 'reply', threadId, text: 'Agreed, keep the first example.' }], 2, f.other)
    await f.command([{ kind: 'resolve', threadId, resolved: true }, { kind: 'resolve', threadId, resolved: false }], 2)
    const messages = await getFeedThreadMessages(f.actor, threadId)
    expect(messages.map(m => m.senderUserId)).toEqual([f.actor.userId, f.other.userId])
    const before = await getFeedCollaboration(f.actor)
    const session = (await pool.query('SELECT mode,channel_type FROM sessions WHERE id=$1', [before.threads[0]!.transcriptSessionId])).rows[0]
    expect(session).toEqual({ mode: null, channel_type: 'feed_thread' })
    await f.command([{ kind: 'edit', edits: [{ kind: 'moveBlock', segmentId: segment.id, blockId: segment.content[2]!.attrs.id, afterId: null }] }], 2)
    expect((await getFeedCollaboration(f.actor)).threads[0]!.anchor).toEqual(before.threads[0]!.anchor)
  })

  it('scenario 7: retains old receipts, rejects ID reuse and refuses denied replay after revocation', async () => {
    const f = await fixture(); const content = await f.upgrade(); const request: FeedCommandRequest = { mutationId: randomUUID(), expectedRevision: 2, commands: [{ kind: 'edit', edits: [replace(content, 0, 'Saved once.')] }] }
    const original = await executeFeedCommands(f.other, request)
    await f.command([{ kind: 'comment', threadId: randomUUID(), target: { kind: 'post' }, text: 'An intervening discussion.' }], 3)
    expect(await executeFeedCommands(f.other, request)).toEqual(original)
    await expect(executeFeedCommands(f.actor, request)).rejects.toMatchObject({ code: 'mutation_id_reused' })
    await expect(executeFeedCommands(f.other, { ...request, commands: [{ kind: 'upgrade' }] })).rejects.toMatchObject({ code: 'mutation_id_reused' })
    await pool.query('UPDATE workspace_members SET can_draft=false WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.other.userId])
    await expect(executeFeedCommands(f.other, request)).rejects.toMatchObject({ status: 403 })
  })
  it('scenarios 6 and 7: rolls back content, anchors, transcript, journal and receipt as one compound command', async () => {
    const f = await fixture(); const content = await f.upgrade(); const mutationId = randomUUID(); const threadId = randomUUID()
    await expect(f.command([{ kind: 'comment', threadId, target: { kind: 'post' }, text: 'Must roll back.' }, { kind: 'edit', edits: [replace(content, 0, 'Must roll back too.')] }, { kind: 'reply', threadId: randomUUID(), text: 'Unknown target.' }], 2, f.actor, mutationId)).rejects.toMatchObject({ status: 404 })
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.copy!.revision).toBe(2); expect(snapshot.copy!.content).toEqual(content); expect(snapshot.threads).toHaveLength(0)
    expect((await pool.query('SELECT id FROM decision_events WHERE session_id=$1', [f.actor.sessionId])).rowCount).toBe(0)
    expect((await pool.query('SELECT mutation_id FROM feed_collaboration_mutations WHERE session_id=$1 AND mutation_id=$2', [f.actor.sessionId, mutationId])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM sessions WHERE channel_id=$1', [`feed-thread:${threadId}`])).rowCount).toBe(0)
  })
  it('scenario 7: rejects cross-workspace/session scope at the service and SQL boundaries', async () => {
    const f = await fixture(); const foreign = await fixture(); await f.upgrade(); const otherContent = await foreign.upgrade(); const threadId = randomUUID()
    await foreign.command([{ kind: 'comment', threadId, target: { kind: 'post' }, text: 'Other workspace.' }], 2)
    await expect(getFeedCollaboration({ ...f.actor, sessionId: foreign.actor.sessionId })).rejects.toMatchObject({ status: 404 })
    await expect(f.command([{ kind: 'reply', threadId, text: 'Not permitted.' }], 2)).rejects.toMatchObject({ status: 404 })
    await expect(f.command([{ kind: 'edit', edits: [replace(otherContent, 0, 'Wrong session.')] }], 2)).rejects.toMatchObject({ code: 'invalid_target' })
    await expect(pool.query(`INSERT INTO feed_collaboration_mutations(session_id,mutation_id,workspace_id,assistant_id,actor_user_id,actor_kind,fingerprint,command_kind,receipt) VALUES($1,$2,$3,$4,$5,'user','fake','edit','{}')`, [f.actor.sessionId, randomUUID(), foreign.workspaceId, f.actor.assistantId, f.actor.userId])).rejects.toThrow('scope mismatch')
  })
  it('scenario 7: refuses private/inaccessible images and permits shared authorized durable images', async () => {
    const f = await fixture(); const content = await f.upgrade(); const fileId = randomUUID(); const segment = content.composition.segments[0]!
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,mime,storage_uri,user_id,created_by_user_id,sensitivity) VALUES($1,$2,$3,'fixture.png','image/png','file:///fixture.png',$4,$4,'internal')", [fileId, f.workspaceId, '/'+fileId+'.png', f.actor.userId])
    const edit: FeedEdit = { kind: 'insertBlock', segmentId: segment.id, afterId: segment.content[0]!.attrs.id, node: { type: 'image', attrs: { id: randomUUID(), fileId, mimeType: 'image/png', placement: 'inline', alt: 'Fixture diagram' } } }
    await expect(f.command([{ kind: 'edit', edits: [edit] }], 2)).rejects.toMatchObject({ code: 'file_not_available_to_draft' })
    await pool.query('UPDATE workspace_files SET user_id=NULL WHERE id=$1', [fileId])
    await f.command([{ kind: 'edit', edits: [edit] }], 2)
    expect((await getFeedCollaboration(f.actor)).copy!.content.media[0]!.fileId).toBe(fileId)
  })

  it('erases Feed transcripts with their owning draft instead of leaving orphan sessions', async () => {
    const f = await fixture(); await f.upgrade(); const threadId = randomUUID()
    await f.command([{ kind: 'comment', threadId, target: { kind: 'post' }, text: 'Owned discussion.' }], 2)
    const transcript = (await getFeedCollaboration(f.actor)).threads[0]!.transcriptSessionId
    await pool.query('DELETE FROM sessions WHERE id=$1', [f.actor.sessionId])
    expect((await pool.query('SELECT id FROM sessions WHERE id=$1', [transcript])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM session_messages WHERE session_id=$1', [transcript])).rowCount).toBe(0)
  })
  it('scenario 2: a changed duplicate-text block cannot redirect acceptance to a matching phrase', async () => {
    const f = await fixture('same same'); const content = await f.upgrade(); const s = content.composition.segments[0]!; const suggestionId = randomUUID()
    const edit: FeedEdit = { kind: 'replaceText', spans: [{ segmentId: s.id, blockId: s.content[0]!.attrs.id, from: 5, to: 9 }], preimage: [[{ type: 'text', text: 'same' }]], replacement: [[{ type: 'text', text: 'chosen' }]] }
    await f.command([{ kind: 'propose', suggestionId, edits: [edit], rationale: 'Second occurrence only.' }], 2)
    await f.command([{ kind: 'edit', edits: [replace(content, 0, 'same same same')] }], 2)
    await expect(f.command([{ kind: 'decide', suggestionId, outcome: 'accepted' }], 3)).rejects.toMatchObject({ code: 'proposal_target_changed' })
    expect((await getFeedCollaboration(f.actor)).copy!.content.text).toBe('same same same')
  })

})

describe('[COMP:feed/draft-suggestions] PostgreSQL suggestion acceptance', () => {
  it('scenario 3: concurrent acceptance applies once, with one member decision and a recoverable conflict', async () => {
    const f = await fixture(); const content = await f.upgrade(); const suggestionId = randomUUID()
    await f.command([{ kind: 'propose', suggestionId, edits: [replace(content, 1, 'Chosen replacement.')], rationale: 'Concrete example.' }], 2)
    const results = await Promise.allSettled([f.command([{ kind: 'decide', suggestionId, outcome: 'accepted' }], 2), f.command([{ kind: 'decide', suggestionId, outcome: 'accepted' }], 2, f.other)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'revision_conflict' } })
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.copy!.revision).toBe(3); expect(snapshot.suggestions[0]!.status).toBe('accepted')
    expect((await pool.query("SELECT id FROM decision_events WHERE session_id=$1 AND event_kind='feed.proposal_decided'", [f.actor.sessionId])).rowCount).toBe(1)
    await f.command([{ kind: 'undo', revision: 3 }], 3)
    expect((await getFeedCollaboration(f.actor)).suggestions[0]!.status).toBe('undone')
    expect((await getFeedCollaboration(f.actor)).copy!.content.text).toBe(f.content.text)
  })
})

describe('[COMP:feed/editorial-decisions] Immutable editorial lineage', () => {
  it('scenario 11 foundation: immutable alternatives and explicit counterproposals retain distinct source history', async () => {
    const f = await fixture(); const content = await f.upgrade(); const first = randomUUID(); const second = randomUUID(); const counter = randomUUID()
    await f.command([{ kind: 'propose', suggestionId: first, edits: [replace(content, 0, 'Alternative one.')], rationale: 'First choice.', sourceToolCallId: 'tool-index-0' }, { kind: 'propose', suggestionId: second, edits: [replace(content, 0, 'Alternative two.')], rationale: 'Reused index, new proposal.', sourceToolCallId: 'tool-index-0' }], 2, { ...f.actor, kind: 'assistant' })
    await f.command([{ kind: 'propose', suggestionId: counter, parentId: first, edits: [replace(content, 0, 'Human counterproposal.')], rationale: 'Prefer the concrete outcome.' }], 2, f.other)
    const proposals = (await getFeedCollaboration(f.actor)).suggestions
    expect(proposals).toHaveLength(3); expect(proposals.find(p => p.id === counter)).toMatchObject({ parentId: first, authorUserId: f.other.userId })
    expect(proposals.every(p => p.status === 'proposed')).toBe(true)
    await expect(pool.query("UPDATE feed_draft_suggestions SET rationale='replaced evidence' WHERE id=$1", [first])).rejects.toThrow('immutable')
    expect((await pool.query('SELECT id FROM decision_events WHERE session_id=$1', [f.actor.sessionId])).rowCount).toBe(0)
  })
})

import { resolveFeedTurnContext } from '../collaboration-service.js'
import { buildFeedCollaborationTools } from '../collaboration-tools.js'
import type { ToolContext } from '@use-brian/core'
describe('[COMP:feed/draft-suggestions] live selection and proposal lineage', () => {
  it('scenario 11: every reused whole-draft index retains a distinct complete immutable source', async () => {
    const f = await fixture('Original body.'); await f.upgrade()
    const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 2 })
    const tool = buildFeedCollaborationTools(context!).find(item => item.name === 'proposeDrafts')!
    const first = { index: 1, text: 'First alternative', label: 'concise', imageBrief: 'A fictional diagram' }
    const second = { index: 1, text: 'Revised alternative', label: 'warm', imageBrief: 'A second diagram' }
    await tool.execute({ rationale: 'Compare two choices', drafts: [first] }, {} as ToolContext)
    await tool.execute({ rationale: 'Refine the choice', drafts: [second] }, {} as ToolContext)
    const rows = (await pool.query('SELECT id,source_proposal FROM feed_draft_suggestions WHERE session_id=$1 ORDER BY created_at,id', [f.actor.sessionId])).rows
    expect(rows.map(row => row.source_proposal)).toEqual([first, second]); expect(rows[0].id).not.toBe(rows[1].id)
    expect((await getFeedCollaboration(f.actor)).copy!.content.text).toBe('Original body.')
    await expect(pool.query(`UPDATE feed_draft_suggestions SET source_proposal='{}' WHERE id=$1`, [rows[0].id])).rejects.toThrow('immutable')
  })
  it('scenario 11: a whole-thread alternative replaces every explicit segment and preserves their identities', async () => {
    const f = await fixture('First segment.'); const content = await f.upgrade(); const secondId = randomUUID()
    await f.command([{ kind: 'context', postFormat: 'thread' }, { kind: 'edit', edits: [{ kind: 'insertSegment', afterId: content.composition.segments[0]!.id, segment: { id: secondId, content: [feedParagraph('Second segment.')] } }] }], 2)
    const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 4 })
    const tool = buildFeedCollaborationTools(context!).find(item => item.name === 'proposeDrafts')!
    await expect(tool.execute({ rationale: 'Ambiguous thread', drafts: [{ index: 1, text: 'Only one body' }] }, {} as ToolContext)).rejects.toMatchObject({ code: 'matching_thread_segments_required' })
    await tool.execute({ rationale: 'Two-part argument', drafts: [{ index: 1, text: 'New first. New second.', threadSegments: ['New first.', 'New second.'] }] }, {} as ToolContext)
    const proposal = (await getFeedCollaboration(f.actor)).suggestions[0]!
    await f.command([{ kind: 'decide', suggestionId: proposal.id, outcome: 'accepted' }], 4)
    const accepted = (await getFeedCollaboration(f.actor)).copy!.content
    expect(accepted.threadSegments).toEqual(['New first.', 'New second.'])
    expect(accepted.composition!.segments.map(segment => segment.id)).toEqual([content.composition.segments[0]!.id, secondId])
  })
  it('scenarios 1 and 7: thread tools keep their source transcript and reject foreign, stale and unselected targets', async () => {
    const f = await fixture(); const content = await f.upgrade(); const segment = content.composition.segments[0]!
    const threadId = randomUUID(); const target = { kind: 'range' as const, spans: [{ segmentId: segment.id, blockId: segment.content[2]!.attrs.id, from: 4, to: 15 }] }
    await f.command([{ kind: 'comment', threadId, target, text: 'Discuss the second phrase.' }], 2)
    const snapshot = await getFeedCollaboration(f.actor); const transcriptId = snapshot.threads[0]!.transcriptSessionId
    const sourceMessageId = (await getFeedThreadMessages(f.actor, threadId))[0]!.id
    const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: transcriptId, mode: null, channelType: 'feed_thread', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 2, threadId })
    expect(context!.selectedQuote).toBe('same phrase'); expect(context!.reference.target).toEqual(target)
    const tools = buildFeedCollaborationTools(context!, sourceMessageId)
    await tools.find(tool => tool.name === 'commentOnFeedDraft')!.execute({ mutationId: randomUUID(), text: 'A precise alternative would help.' }, {} as ToolContext)
    expect((await getFeedThreadMessages(f.actor, threadId)).at(-1)).toMatchObject({ role: 'assistant' })
    await tools.find(tool => tool.name === 'proposeDrafts')!.execute({ rationale: 'Target only the selected phrase.', drafts: [{ index: 1, text: 'concrete example' }] }, {} as ToolContext)
    const proposal = (await getFeedCollaboration(f.actor)).suggestions[0]!
    expect(proposal.edits).toMatchObject([{ kind: 'replaceText', spans: target.spans }])
    await expect(tools.find(tool => tool.name === 'suggestFeedDraftChange')!.execute({ mutationId: randomUUID(), edits: [replace(content, 0, 'Unselected')], rationale: 'Wrong target' }, {} as ToolContext)).rejects.toMatchObject({ status: 403 })
    await expect(resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 2, threadId })).rejects.toMatchObject({ code: 'thread_scope_mismatch' })
    await f.command([{ kind: 'edit', edits: [replace(content, 0, 'New surrounding copy')] }], 2)
    await expect(tools.find(tool => tool.name === 'readFeedDraft')!.execute({}, {} as ToolContext)).rejects.toMatchObject({ code: 'draft_context_changed' })
  })
})

import express from 'express'
import { feedCollaborationRoutes } from '../../routes/feed-collaboration.js'
describe('[COMP:feed/draft-comments] authenticated HTTP command boundary', () => {
  it('scenarios 3 and 7: HTTP commands share real receipts, authority, conflicts and transcript storage', async () => {
    const f = await fixture(); const content = await f.upgrade(); const foreign = await fixture(); await foreign.upgrade()
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.userId = req.get('x-fixture-user') || undefined; next() }); app.use('/api/distribution', feedCollaborationRoutes())
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback HTTP required')
    const base = `http://127.0.0.1:${address.port}/api/distribution/${f.actor.assistantId}/draft-sessions/${f.actor.sessionId}`
    const mutationId = randomUUID(); const request = { mutationId, expectedRevision: 2, commands: [{ kind: 'edit', edits: [replace(content, 0, 'Saved through HTTP')] }] }
    const send = (body: unknown, user = f.actor.userId) => fetch(`${base}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': user }, body: JSON.stringify(body) })
    try {
      expect((await fetch(`${base}/collaboration`)).status).toBe(401)
      expect((await fetch(`${base}/collaboration`, { headers: { 'x-fixture-user': foreign.actor.userId } })).status).toBe(403)
      const first = await send(request); expect(first.status).toBe(200); const receipt = await first.json()
      expect(await (await send(request)).json()).toEqual(receipt)
      expect((await send({ ...request, mutationId: randomUUID() })).status).toBe(409)
      expect((await send({ ...request, mutationId: randomUUID(), expectedRevision: 3, commands: [{ kind: 'comment', threadId: randomUUID(), target: { kind: 'block', segmentId: randomUUID(), blockId: randomUUID() }, text: 'Foreign target' }] })).status).toBe(409)
      const threadId = randomUUID(); expect((await send({ mutationId: randomUUID(), expectedRevision: 3, commands: [{ kind: 'comment', threadId, target: { kind: 'post' }, text: 'Stored HTTP discussion' }] })).status).toBe(200)
      const messages = await (await fetch(`${base}/threads/${threadId}/messages`, { headers: { 'x-fixture-user': f.other.userId } })).json()
      expect((messages as { messages: Array<{ senderUserId: string; senderName: string }> }).messages[0]).toMatchObject({ senderUserId: f.actor.userId, senderName: 'Author fixture' })
      const reviewResponse = await fetch(`${base}/reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': f.actor.userId }, body: JSON.stringify({ mutationId: randomUUID(), expectedRevision: 3 }) })
      expect(reviewResponse.status).toBe(200)
      const queuedReview = await reviewResponse.json() as { run: { id: string; status: string } }
      expect(queuedReview.run.status).toBe('pending')
      await cancelFeedRun(f.actor, queuedReview.run.id)
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.userId])
      expect((await send(request)).status).toBe(403)
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})

import { createFeedGenerationService } from '../generation.js'
import type { FeedGenerationPort } from '../generation-port.js'
async function generationFixture() {
  const f = await fixture('Opening paragraph.'); const content = await f.upgrade()
  const segmentId = content.composition.segments[0]!.id; const slotId = randomUUID()
  const slot = { id: slotId, kind: 'text' as const, brief: 'Explain irrigation with a measured example.', briefRevision: 0, references: [] }
  await f.command([{ kind: 'edit', edits: [{ kind: 'insertBlock', segmentId, afterId: content.composition.segments[0]!.content[0]!.attrs.id, node: { type: 'generationPlaceholder', attrs: slot } }] }])
  const call = vi.fn(async () => ({ text: JSON.stringify({ candidates: [{ markdown: 'Candidate one.\n\nMeasured example.', rationale: 'A clear example.' }, { markdown: 'Candidate two.', rationale: 'A shorter opening.' }] }), usage: { inputTokens: 100, outputTokens: 50 } }))
  const port: FeedGenerationPort = { resolve: vi.fn(async () => ({ model: 'fixture', tier: 'standard', identity: 'fixture:v1', inputCharacters: 160_000, maxTokens: 6000, call, price: () => ({ currency: 'USD' as const, maximumUsd: 0.01, rateVersion: 'fixture:v1', billing: 'included' as const }) })), readReference: vi.fn(async () => ({ omission: 'fixture_unavailable' })) }
  const service = createFeedGenerationService(port)
  const request = { mutationId: randomUUID(), expectedRevision: 3, segmentId, slotId, model: 'standard' as const, count: 2, locale: 'en' as const }
  return { ...f, slot, slotId, segmentId, call, port, service, request }
}
describe('[COMP:feed/draft-generation] real database generation lifecycle', () => {
  it('scenarios 4 and 7: binds a cheap estimate, dispatches once, stores candidates and accepts only the exact slot with Undo', async () => {
    const f = await generationFixture(); const estimate = await f.service.estimate(f.actor, f.request)
    expect(f.call).not.toHaveBeenCalled(); expect(estimate).toMatchObject({ slot: f.slot, count: 2, confirmationRequired: true, price: { maximumUsd: 0.01 } })
    expect(await f.service.estimate(f.actor, f.request)).toEqual(estimate)
    await expect(f.service.estimate(f.other, f.request)).rejects.toMatchObject({ code: 'mutation_id_reused' })
    const request = { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true as const }
    const [one, duplicate] = await Promise.all([f.service.dispatch(f.actor, request), f.service.dispatch(f.actor, request)])
    expect(one.id).toBe(duplicate.id)
    await expect(f.service.dispatch(f.actor, { ...request, mutationId: randomUUID() })).rejects.toMatchObject({ code: 'generation_estimate_already_used' })
    const active = await claimFeedRun(['text_generation']); expect(active?.id).toBe(one.id)
    await f.service.handler(active!, new AbortController().signal)
    expect(f.call).toHaveBeenCalledTimes(1)
    const snapshot = await getFeedCollaboration(f.actor); expect(snapshot.copy!.revision).toBe(3); expect(snapshot.suggestions).toHaveLength(2)
    const candidate = snapshot.suggestions[0]!
    expect(candidate).toMatchObject({ sourceRunId: one.id, sourceRevision: 3 })
    await f.command([{ kind: 'decide', suggestionId: candidate.id, outcome: 'accepted' }], 3)
    expect((await getFeedCollaboration(f.actor)).copy!.content.text).toContain('Candidate')
    await f.command([{ kind: 'undo', revision: 4 }], 4)
    expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual({ type: 'generationPlaceholder', attrs: f.slot })
    expect((await f.service.dispatch(f.actor, request)).id).toBe(one.id)
    const copy = (await getFeedCollaboration(f.actor)).copy!
    await pool.query("UPDATE feed_editorial_runs SET status='pending' WHERE id=$1", [one.id])
    const recovered = await claimFeedRun(['text_generation']); vi.mocked(f.port.resolve).mockRejectedValue(new Error('Provider removed'))
    await f.service.handler(recovered!, new AbortController().signal)
    expect(f.call).toHaveBeenCalledTimes(1); expect((await getFeedCollaboration(f.actor)).copy!.content).toEqual(copy.content)
    expect((await getFeedCollaboration(f.actor)).suggestions).toHaveLength(2)
  })
  it('scenarios 5 and 8: retains a late cancelled candidate after target deletion without changing text', async () => {
    const f = await generationFixture(); const estimate = await f.service.estimate(f.actor, f.request)
    const queued = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    f.call.mockImplementationOnce(async () => {
      await cancelFeedRun(f.actor, queued.id)
      await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [] }] }])
      return { text: JSON.stringify({ candidates: [{ markdown: 'Late retained candidate.', rationale: 'Original brief.' }] }), usage: { inputTokens: 100, outputTokens: 50 } }
    })
    const active = await claimFeedRun(['text_generation']); await f.service.handler(active!, new AbortController().signal)
    const completed = await getFeedRun(f.actor, queued.id)
    expect(completed.status).toBe('cancelled'); expect(completed.result.parts.generation).toBeTruthy(); expect(completed.usage.generation).toBeTruthy()
    const snapshot = await getFeedCollaboration(f.actor); expect(snapshot.copy!.content.text).toBe('Opening paragraph.'); expect(snapshot.suggestions).toHaveLength(1)
    await expect(f.command([{ kind: 'decide', suggestionId: snapshot.suggestions[0]!.id, outcome: 'accepted' }])).rejects.toBeTruthy()
    expect((await getFeedCollaboration(f.actor)).copy!.content).toEqual(snapshot.copy!.content)
  })
  it('scenario 8: uncertain dispatch cannot resend, while an expired lease can retain a known late response', async () => {
    const f = await generationFixture(); const estimate = await f.service.estimate(f.actor, f.request)
    const queued = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    const active = await claimFeedRun(['text_generation'])
    f.call.mockImplementationOnce(async () => { await failFeedRun(active!, 'provider_timeout'); await expect(retryFeedRun(f.actor, queued.id)).rejects.toMatchObject({ code: 'fresh_explicit_attempt_required' }); return { text: JSON.stringify({ candidates: [{ markdown: 'Known late response.', rationale: 'Retained receipt.' }] }), usage: { inputTokens: 100, outputTokens: 50 } } })
    await f.service.handler(active!, new AbortController().signal)
    expect((await getFeedRun(f.actor, queued.id)).status).toBe('succeeded'); expect(f.call).toHaveBeenCalledTimes(1)
    const nextEstimate = await f.service.estimate(f.actor, { ...f.request, mutationId: randomUUID() })
    const next = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: nextEstimate.id, confirmed: true }); const failing = await claimFeedRun(['text_generation'])
    f.call.mockRejectedValueOnce(new Error('Timed out after dispatch'))
    await expect(f.service.handler(failing!, new AbortController().signal)).rejects.toThrow('Timed out')
    await failFeedRun(failing!, 'provider_timeout')
    await expect(retryFeedRun(f.actor, next.id)).rejects.toMatchObject({ code: 'fresh_explicit_attempt_required' })
    expect(f.call).toHaveBeenCalledTimes(2)
  })
  it('scenario 8: presents an unanswered image dispatch as failed and lets explicit Retry supersede it', async () => {
    const f = await generationFixture()
    await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, kind: 'image', briefRevision: 1 } }] }] }])
    const estimate = await f.service.estimate(f.actor, { ...f.request, mutationId: randomUUID(), expectedRevision: 4, count: 1, imageProvider: 'gemini' })
    const queued = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    const active = (await claimFeedRun(['image_generation']))!; await markFeedDispatch(active, 'generation', estimate)
    await failFeedRun(active, 'generation_transport_failed')
    const uncertain = await getFeedRun(f.actor, queued.id)
    expect(uncertain).toMatchObject({ status: 'unknown_outcome', dispatchedPart: 'generation', attempts: 1 })
    expect(summarizeFeedRun(uncertain)).toMatchObject({ status: 'failed', attempts: 1 })
    const retried = await retryFeedRun(f.actor, queued.id)
    expect(retried).toMatchObject({ status: 'pending', dispatchedPart: null, attempts: 1 })
    expect(retried.result.discardedDispatches).toEqual([expect.objectContaining({ part: 'generation', attempt: 1, error: 'generation_transport_failed', dispatchId: expect.any(String) })])
    expect((retried.result.dispatches as Record<string, unknown>).generation).toBeUndefined()
    await expect(saveFeedPart(active, 'generation', { imageReceipt: { image: { fileId: randomUUID() } } })).rejects.toMatchObject({ code: 'run_no_longer_active' })
    const cleanup = (await claimFeedRun(['image_generation']))!; expect(cleanup.id).toBe(queued.id)
    await failFeedRun(cleanup, 'fixture_complete')
  })
  it('scenario 8: automatically resumes an image request that provably never connected', async () => {
    const f = await generationFixture()
    await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, kind: 'image', briefRevision: 1 } }] }] }])
    const estimate = await f.service.estimate(f.actor, { ...f.request, mutationId: randomUUID(), expectedRevision: 4, count: 1, imageProvider: 'gemini' })
    const queued = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    const first = (await claimFeedRun(['image_generation']))!; await markFeedDispatch(first, 'generation', estimate)
    await failFeedRun(first, 'provider_request_not_dispatched', { providerRequest: 'not_dispatched' })
    const pending = await getFeedRun(f.actor, queued.id)
    expect(pending).toMatchObject({ status: 'pending', dispatchedPart: null, attempts: 1, error: 'provider_request_not_dispatched' })
    expect(pending.result.discardedDispatches).toEqual([expect.objectContaining({ part: 'generation', attempt: 1, error: 'provider_request_not_dispatched', dispatchId: expect.any(String) })])
    const resumed = (await claimFeedRun(['image_generation']))!
    expect(resumed).toMatchObject({ id: queued.id, status: 'running', attempts: 2, dispatchedPart: null })
    await failFeedRun(resumed, 'fixture_complete')
  })
  it('scenarios 7 and 8: refuses changed estimates/configuration and revoked queued actors before any model call', async () => {
    const f = await generationFixture(); const estimate = await f.service.estimate(f.actor, f.request)
    const request = { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true as const }
    await f.command([{ kind: 'context', title: 'Changed draft title' }])
    await expect(f.service.dispatch(f.actor, request)).rejects.toMatchObject({ code: 'revision_conflict' })
    const nextRequest = { ...f.request, expectedRevision: 4, mutationId: randomUUID() }
    const nextEstimate = await f.service.estimate(f.actor, nextRequest)
    const resolved = await f.port.resolve({ ...f.actor, workspaceId: f.workspaceId }, 'text', 'standard')
    vi.mocked(f.port.resolve).mockResolvedValueOnce({ ...resolved, identity: 'changed-configuration' })
    await expect(f.service.dispatch(f.actor, { ...request, estimateId: nextEstimate.id })).rejects.toMatchObject({ code: 'generation_configuration_changed' })
    const next = await f.service.dispatch(f.actor, { ...request, estimateId: nextEstimate.id })
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.userId])
    const active = await claimFeedRun(['text_generation']); expect(active?.id).toBe(next.id)
    await expect(f.service.handler(active!, new AbortController().signal)).rejects.toMatchObject({ code: 'draft_access_required' })
    await failFeedRun(active!, 'draft_access_required')
    expect(f.call).not.toHaveBeenCalled()
    await expect(f.service.dispatch(f.actor, { ...request, estimateId: nextEstimate.id })).rejects.toMatchObject({ code: 'draft_access_required' })
  })
  it('scenario 8: Retry archives an unusable image receipt and calls the provider again', async () => {
    const f = await generationFixture()
    await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, kind: 'image', briefRevision: 1 } }] }] }])
    const responses = ['image_provider_rejected', 'image_missing'] as const
    const call = vi.fn(async () => { const error = responses[call.mock.calls.length - 1]!; return { text: '', imageReceipt: { error, status: error === 'image_provider_rejected' ? 400 : undefined, usage: { inputTokens: 0, outputTokens: 0, measured: false } }, usage: { inputTokens: 0, outputTokens: 0, measured: false } } })
    const port: FeedGenerationPort = {
      resolve: vi.fn(async () => ({ model: 'fixture-image', tier: 'image', identity: 'fixture-image:v1', inputCharacters: 160_000, maxTokens: 6000, call, price: () => ({ currency: 'USD' as const, maximumUsd: 0, rateVersion: 'fixture-image:v1', billing: 'included' as const }) })),
      readReference: vi.fn(async () => ({ omission: 'fixture_unavailable' })),
      persistImage: vi.fn(async (_run, receipt) => { throw new Error(receipt.error ?? 'image_missing') }),
    }
    const service = createFeedGenerationService(port)
    const estimate = await service.estimate(f.actor, { ...f.request, mutationId: randomUUID(), expectedRevision: 4, count: 1, imageProvider: 'gemini' })
    const queued = await service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    const first = (await claimFeedRun(['image_generation']))!; await expect(service.handler(first, new AbortController().signal)).rejects.toThrow('image_provider_rejected'); await failFeedRun(first, 'image_provider_rejected')
    const failed = await getFeedRun(f.actor, queued.id); expect(failed.result.parts.generation).toBeTruthy(); expect(failed.usage.generation).toBeTruthy()
    const retried = await retryFeedRun(f.actor, queued.id)
    expect(retried.status).toBe('pending'); expect(retried.result.parts.generation).toBeUndefined(); expect(retried.usage.generation).toBeUndefined()
    expect(retried.result.discardedParts).toEqual([expect.objectContaining({ part: 'generation', attempt: 1, response: expect.objectContaining({ imageReceipt: expect.objectContaining({ error: 'image_provider_rejected' }) }) })])
    const second = (await claimFeedRun(['image_generation']))!; await expect(service.handler(second, new AbortController().signal)).rejects.toThrow('image_missing'); await failFeedRun(second, 'image_missing')
    expect(call).toHaveBeenCalledTimes(2)
  })
})


describe('[COMP:feed/draft-generation] scoped tools and decision provenance', () => {
  it('saves coalesced placeholder keystrokes atomically, replays once, and undoes the whole batch', async () => {
    const f = await generationFixture()
    const original = { type: 'generationPlaceholder' as const, attrs: f.slot }
    const first = { ...original, attrs: { ...f.slot, brief: 'A', briefRevision: 1 } }
    const second = { ...original, attrs: { ...f.slot, brief: 'AI', briefRevision: 2 } }
    const edit = (preimage: typeof original, replacement: typeof original): FeedEdit => ({ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage, replacement: [replacement] })
    const commands: FeedCommand[] = [{ kind: 'edit', edits: [edit(original, first), edit(first, second)] }]
    const mutationId = randomUUID()
    const receipt = await f.command(commands, 3, f.actor, mutationId)
    expect(receipt.revision).toBe(4)
    expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual(second)
    expect(await f.command(commands, 3, f.actor, mutationId)).toEqual(receipt)
    await f.command([{ kind: 'undo', revision: 4 }], 4)
    expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual(original)
    expect(f.call).not.toHaveBeenCalled()
  })
  it('rejects a skipped placeholder counter inside a batch even when the final counter looks valid', async () => {
    const f = await generationFixture()
    const original = { type: 'generationPlaceholder' as const, attrs: f.slot }
    const skipped = { ...original, attrs: { ...f.slot, brief: 'Skipped increment', briefRevision: 0 } }
    const final = { ...original, attrs: { ...f.slot, brief: 'Final value', briefRevision: 1 } }
    const edit = (preimage: typeof original, replacement: typeof original): FeedEdit => ({ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage, replacement: [replacement] })
    await expect(f.command([{ kind: 'edit', edits: [edit(original, skipped), edit(skipped, final)] }], 3)).rejects.toMatchObject({ code: 'placeholder_brief_revision_conflict' })
    expect((await getFeedCollaboration(f.actor)).copy!.revision).toBe(3)
    expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual(original)
    await expect(f.command([{ kind: 'edit', edits: [
      { kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: original, replacement: [] },
      { kind: 'insertBlock', segmentId: f.segmentId, afterId: null, node: skipped },
    ] }], 3)).rejects.toMatchObject({ code: 'placeholder_brief_revision_conflict' })
  })

  it.each([false, true])('resumes a known image slot from whole-post chat (explicit post target: %s)', async explicitPost => {
    const f = await generationFixture()
    const imageSlot = { type: 'generationPlaceholder' as const, attrs: { ...f.slot, kind: 'image' as const, briefRevision: 1 } }
    await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [imageSlot] }] }])
    const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 4, ...(explicitPost ? { target: { kind: 'post' } } : {}) })
    const tool = buildFeedCollaborationTools(context!, undefined, f.service).find(item => item.name === 'editFeedPlaceholder')!
    const target = { kind: 'block' as const, segmentId: f.segmentId, blockId: f.slotId }
    const input = { mutationId: randomUUID(), action: 'update', target, patch: { brief: 'Simplify the diagram to three shapes.' } }
    expect(tool.requiresConfirmation).toBe(true)
    expect(tool.inputSchema.parse(input)).toEqual(input)
    await tool.execute(input, {} as ToolContext)
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.copy!.revision).toBe(5)
    expect(snapshot.copy!.content.composition!.segments[0]!.content[1]).toMatchObject({ type: 'generationPlaceholder', attrs: { id: f.slotId, kind: 'image', briefRevision: 2, brief: input.patch.brief } })
    expect(snapshot.runs).toHaveLength(0)
    expect(f.call).not.toHaveBeenCalled()
    await expect(tool.execute({ ...input, mutationId: randomUUID() }, {} as ToolContext)).rejects.toMatchObject({ code: 'draft_context_changed' })
    await f.command([{ kind: 'undo', revision: 5 }], 5)
    expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual(imageSlot)
  })
  it.each(['block', 'range'] as const)('does not let an explicit placeholder target widen an attached %s context', async kind => {
    const f = await generationFixture()
    const paragraph = (await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[0]!
    const target = kind === 'block' ? { kind, segmentId: f.segmentId, blockId: paragraph.attrs.id } : { kind, spans: [{ segmentId: f.segmentId, blockId: paragraph.attrs.id, from: 0, to: 7 }] }
    const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 3, target })
    const tool = buildFeedCollaborationTools(context!, undefined, f.service).find(item => item.name === 'editFeedPlaceholder')!
    await expect(tool.execute({ mutationId: randomUUID(), action: 'update', target: { kind: 'block', segmentId: f.segmentId, blockId: f.slotId }, patch: { brief: 'Outside attached context.' } }, {} as ToolContext)).rejects.toMatchObject({ code: 'selection_scope_mismatch' })
    const snapshot = await getFeedCollaboration(f.actor)
    expect(snapshot.copy!.revision).toBe(3)
    expect(snapshot.copy!.content.composition!.segments[0]!.content[1]).toEqual({ type: 'generationPlaceholder', attrs: f.slot })
    expect(snapshot.runs).toHaveLength(0)
    expect(f.call).not.toHaveBeenCalled()
  })
  it('scenarios 6 and 7: Brian edits the selected slot through shared commands and duplicates never inherit a run', async () => {
    const f = await generationFixture()
    const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 3, target: { kind: 'block', segmentId: f.segmentId, blockId: f.slotId } })
    const tools = buildFeedCollaborationTools(context!, undefined, f.service)
    const change = tools.find(tool => tool.name === 'editFeedPlaceholder')!
    expect(change.requiresConfirmation).toBe(true)
    await change.execute({ mutationId: randomUUID(), action: 'update', patch: { brief: 'Use an example without numbers.' } }, {} as ToolContext)
    const copy = (await getFeedCollaboration(f.actor)).copy!
    const node = copy.content.composition!.segments[0]!.content[1]!
    expect(node).toMatchObject({ attrs: { id: f.slotId, briefRevision: 1, brief: 'Use an example without numbers.' } })
    await expect(f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: node, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, brief: 'Missing revision increment.', briefRevision: 1 } }] }] }])).rejects.toMatchObject({ code: 'placeholder_brief_revision_conflict' })
    const refreshed = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 4, target: { kind: 'block', segmentId: f.segmentId, blockId: f.slotId } })
    await buildFeedCollaborationTools(refreshed!, undefined, f.service).find(tool => tool.name === 'editFeedPlaceholder')!.execute({ mutationId: randomUUID(), action: 'duplicate' }, {} as ToolContext)
    const slots = (await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content.filter(node => node.type === 'generationPlaceholder')
    expect(slots).toHaveLength(2); expect(slots[0]!.attrs.id).not.toBe(slots[1]!.attrs.id); expect((await getFeedCollaboration(f.actor)).runs).toHaveLength(0); expect(f.call).not.toHaveBeenCalled()
  })
  it('scenarios 7 and 11: generation uses exact application provenance, retains changed-brief candidates and scopes estimate RLS', async () => {
    const f = await generationFixture(); const foreign = await fixture(); await foreign.upgrade()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.other.userId])
    const rule = (await pool.query("INSERT INTO assistant_playbook_rules(assistant_id,rule,status,created_by,applies_to_user_id) VALUES($1,'Use a concrete example.','active','decision_reflection',$2) RETURNING id", [f.actor.assistantId, f.actor.userId])).rows[0].id
    const estimate = await f.service.estimate(f.actor, f.request)
    expect((await queryWithRLS(foreign.actor.userId, 'SELECT id FROM feed_generation_estimates WHERE id=$1', [estimate.id])).rows).toHaveLength(0)
    expect((await queryWithRLS(f.actor.userId, 'SELECT id FROM feed_generation_estimates WHERE id=$1', [estimate.id])).rows).toHaveLength(1)
    const queued = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, brief: 'A different direction.', briefRevision: 1 } }] }] }])
    const active = await claimFeedRun(['text_generation']); await f.service.handler(active!, new AbortController().signal)
    const applications = (await pool.query("SELECT id,operation_id,artifact_refs FROM decision_applications WHERE assistant_id=$1 AND operation_kind='feed_generation'", [f.actor.assistantId])).rows
    expect(applications).toHaveLength(1); expect(applications[0]).toMatchObject({ operation_id: queued.id, artifact_refs: [{ kind: 'assistant_playbook_rule', id: rule }] })
    const snapshot = await getFeedCollaboration(f.actor); expect(snapshot.suggestions).toHaveLength(2); expect(snapshot.suggestions[0]!.applicationId).toBe(applications[0].id)
    await expect(f.command([{ kind: 'decide', suggestionId: snapshot.suggestions[0]!.id, outcome: 'accepted' }])).rejects.toMatchObject({ code: 'proposal_target_changed' })
    await expect(pool.query('UPDATE feed_draft_suggestions SET source_run_id=NULL WHERE id=$1', [snapshot.suggestions[0]!.id])).rejects.toThrow('immutable')
    expect((await getFeedCollaboration(f.actor)).copy!.content).toEqual(snapshot.copy!.content)
  })
})

import { createFeedGenerationPort } from '../generation-port.js'
import { createFilesApi, createSingletonFilesClientResolver } from '../../files/files-api.js'
import { createLocalFilesClient } from '../../files/local-files-client.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { createWorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import { aiStudioTransport } from '@use-brian/core'
import { exportFeedArticle, readFeedSaveProjection, assertFeedSavedReady } from '../projection.js'
import { createContentPlanningStore } from '../../db/content-planning-store.js'
import JSZip from 'jszip'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const imageBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='
describe('[COMP:feed/draft-generation] durable image and output integration', () => {
  it.each([false, true])('lets the Feed agent convert a fixed image into a patched generation slot with Undo (whole post: %s)', async wholePost => {
    const f = await generationFixture(); const dir = await mkdtemp(join(tmpdir(), 'feed-image-convert-'))
    try {
      const files = createFilesApi({ store: createDbWorkspaceFilesStore(), auditStore: createWorkspaceAuditStore(), resolver: createSingletonFilesClientResolver(createLocalFilesClient({ baseDir: dir }), 'feed-convert-fixture', 'file') })
      const uploaded = await files.writeBytes({ workspaceId: f.workspaceId, userId: f.actor.userId, assistantId: null, clearance: 'internal' }, { path: '/doc/fixed-image.png', bytes: Buffer.from(imageBytes, 'base64'), mime: 'image/png', sensitivity: 'internal' })
      if (!uploaded.ok) throw new Error('Fixture image required')
      const fixed = { type: 'image' as const, attrs: { id: f.slotId, fileId: uploaded.value.id, mimeType: 'image/png' as const, placement: 'attachment' as const, alt: 'Detailed orchard diagram' } }
      await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [fixed] }] }])
      const target = { kind: 'block' as const, segmentId: f.segmentId, blockId: f.slotId }
      const context = await resolveFeedTurnContext(f.actor.userId, f.actor.assistantId, { id: f.actor.sessionId, mode: 'draft', channelType: 'web', anchorKind: null }, { sessionId: f.actor.sessionId, revision: 4, ...(wholePost ? {} : { target }) })
      const tool = buildFeedCollaborationTools(context!, undefined, f.service).find(item => item.name === 'editFeedPlaceholder')!
      expect(tool.description).toContain('selected fixed image')
      await tool.execute({ mutationId: randomUUID(), action: 'convert', kind: 'image', ...(wholePost ? { target } : {}), patch: { brief: 'Use a simplified visual with three shapes.' } }, {} as ToolContext)
      const converted = (await getFeedCollaboration(f.actor)).copy!
      expect(converted.revision).toBe(5)
      expect(converted.content.composition!.segments[0]!.content[1]).toEqual({ type: 'generationPlaceholder', attrs: { id: f.slotId, kind: 'image', brief: 'Use a simplified visual with three shapes.', briefRevision: 0, references: [], baseImageFileId: fixed.attrs.fileId, altIntent: fixed.attrs.alt } })
      expect(f.call).not.toHaveBeenCalled()
      await f.command([{ kind: 'undo', revision: 5 }], 5)
      expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual(fixed)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it.each(['gemini', 'openai-codex'] as const)('scenarios 4-5 and 8-9: %s persists bytes once, accepts in place, exports ordered assets and blocks unfinished or stale approval', async imageProvider => {
    const f = await generationFixture(); const dir = await mkdtemp(join(tmpdir(), 'feed-image-'))
    try {
      await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, kind: 'image', briefRevision: 1, altIntent: 'Orchard diagram' } }] }] }])
      const files = createFilesApi({ store: createDbWorkspaceFilesStore(), auditStore: createWorkspaceAuditStore(), resolver: createSingletonFilesClientResolver(createLocalFilesClient({ baseDir: dir }), 'feed-fixture', 'file') })
      const reference = await files.writeBytes({ workspaceId: f.workspaceId, userId: f.actor.userId, assistantId: null, clearance: 'internal', writeCompartments: ['editorial'] }, { path: '/doc/fixture-reference.png', bytes: Buffer.from(imageBytes, 'base64'), mime: 'image/png', sensitivity: 'internal' })
      if (!reference.ok) throw new Error('Fixture source file required')
      const imageSlot = (await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]!
      if (imageSlot.type !== 'generationPlaceholder') throw new Error('Fixture slot required')
      await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: imageSlot, replacement: [{ ...imageSlot, attrs: { ...imageSlot.attrs, briefRevision: 2, references: [{ fileId: reference.value.id }] } }] }] }])
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: imageBytes } }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1120, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } })))
      const settle = vi.fn(async () => undefined)
      const codex = { inspect: vi.fn(async () => ({ model: 'gpt-image-2', orchestratorModel: 'gpt-5.6-sol', identity: 'fixture-identity' })), generate: vi.fn(async () => ({ image: { data: imageBytes, mimeType: 'image/png' as const }, usage: { inputTokens: 0, outputTokens: 0, measured: false } })) }
      const service = createFeedGenerationService(createFeedGenerationPort(async () => { throw new Error('Image must not use text provider') }, { files, codex, transport: aiStudioTransport('fixture-key'), fetcher, billing: { quote: () => 2, available: async () => 10, settle } }))
      let snapshot = await getFeedCollaboration(f.actor)
      const savedUnfinished = await readFeedSaveProjection(f.actor, snapshot.copy!.revision, 'threads')
      await expect(assertFeedSavedReady(f.actor, savedUnfinished!.canonical, 'threads')).rejects.toMatchObject({ code: 'unfinished_slot' })
      await expect(exportFeedArticle(f.actor, snapshot.copy!.revision, false, files)).rejects.toMatchObject({ code: 'acknowledge_omitted_slots' })
      const draftZip = await JSZip.loadAsync(await exportFeedArticle(f.actor, snapshot.copy!.revision, true, files)); expect(await draftZip.file('article.html')!.async('string')).not.toContain(f.slot.brief)
      const estimate = await service.estimate(f.actor, { ...f.request, expectedRevision: snapshot.copy!.revision, count: 1, imageProvider })
      expect(estimate.price).toMatchObject(imageProvider === 'gemini' ? { billing: 'metered', credits: 2 } : { billing: 'subscription', maximumUsd: null }); expect(fetcher).not.toHaveBeenCalled(); expect(codex.generate).not.toHaveBeenCalled()
      const queued = await service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
      const active = (await claimFeedRun(['image_generation']))!; expect(active.id).toBe(queued.id)
      await service.handler(active, new AbortController().signal)
      snapshot = await getFeedCollaboration(f.actor); const candidate = snapshot.suggestions[0]!
      expect(snapshot.copy!.revision).toBe(estimate.revision); expect(candidate.sourceRunId).toBe(queued.id)
      expect(fetcher).toHaveBeenCalledTimes(imageProvider === 'gemini' ? 1 : 0); expect(codex.generate).toHaveBeenCalledTimes(imageProvider === 'openai-codex' ? 1 : 0); expect(settle).toHaveBeenCalledTimes(imageProvider === 'gemini' ? 1 : 0)
      const row = (await pool.query("SELECT id,mime,metadata,storage_uri,sensitivity,compartments FROM workspace_files WHERE workspace_id=$1 AND path LIKE '/doc/feed/%'", [f.workspaceId])).rows[0]
      expect(row).toMatchObject({ mime: 'image/png', sensitivity: 'internal', compartments: ['editorial'], metadata: { feedGeneration: { runId: queued.id, sourceRevision: estimate.revision } } }); expect(row.storage_uri).toMatch(/^file:/)
      await pool.query("UPDATE feed_editorial_runs SET status='pending' WHERE id=$1", [queued.id]); await service.handler((await claimFeedRun(['image_generation']))!, new AbortController().signal)
      expect(fetcher).toHaveBeenCalledTimes(imageProvider === 'gemini' ? 1 : 0); expect(codex.generate).toHaveBeenCalledTimes(imageProvider === 'openai-codex' ? 1 : 0); expect(settle).toHaveBeenCalledTimes(imageProvider === 'gemini' ? 1 : 0)
      expect((await pool.query("SELECT id FROM workspace_files WHERE workspace_id=$1", [f.workspaceId])).rows).toHaveLength(2)
      await f.command([{ kind: 'decide', suggestionId: candidate.id, outcome: 'accepted' }])
      snapshot = await getFeedCollaboration(f.actor); const archive = await exportFeedArticle(f.actor, snapshot.copy!.revision, false, files)
      expect(archive.equals(await exportFeedArticle(f.actor, snapshot.copy!.revision, false, files))).toBe(true)
      const zip = await JSZip.loadAsync(archive); expect((await zip.file(`assets/${row.id}.png`)!.async('nodebuffer')).toString('base64')).toBe(imageBytes)
      const html = await zip.file('article.html')!.async('string'); expect(html.indexOf('Opening paragraph')).toBeLessThan(html.indexOf('<img')); expect(html).not.toContain('Private direction'); expect(html).not.toContain('http://'); expect(html).not.toContain('token=')
      const saved = await readFeedSaveProjection(f.actor, snapshot.copy!.revision, 'threads'); expect(await assertFeedSavedReady(f.actor, saved!.canonical, 'threads')).not.toBeNull()
      await f.command([{ kind: 'context', title: 'Revised title' }]); await expect(assertFeedSavedReady(f.actor, saved!.canonical, 'threads')).rejects.toMatchObject({ code: 'revision_conflict' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('scenarios 7-9: both saved projection and open approval require the canonical revision and reject client text overrides', async () => {
    const f = await fixture('Canonical accepted paragraph.'); await f.upgrade(); const store = createContentPlanningStore()
    await expect(store.saveDraft({ assistantId: f.actor.assistantId, sessionId: f.actor.sessionId, userId: f.actor.userId, platform: 'threads', text: 'Forged client copy.' })).rejects.toMatchObject({ code: 'revision_conflict' })
    const saved = await store.saveDraft({ assistantId: f.actor.assistantId, sessionId: f.actor.sessionId, userId: f.actor.userId, platform: 'threads', text: 'Forged client copy.', expectedRevision: 2 })
    expect(saved?.draftText).toBe('Canonical accepted paragraph.'); expect(saved?.formatData.feedCanonical).toMatchObject({ revision: 2 })
    await expect(store.approve({ assistantId: f.actor.assistantId, draftId: saved!.id, userId: f.actor.userId, finalText: 'Bypass the command journal.' })).rejects.toMatchObject({ code: 'canonical_edit_required' })
    expect(await store.approve({ assistantId: f.actor.assistantId, draftId: saved!.id, userId: f.actor.userId })).toBe(true)
    const confirmations = (await pool.query('SELECT id,source_revision FROM feed_post_confirmations WHERE session_id=$1', [f.actor.sessionId])).rows
    expect(confirmations).toEqual([{ id: expect.any(String), source_revision: 2 }])
    expect((await pool.query("SELECT id FROM feed_editorial_runs WHERE session_id=$1 AND kind='confirmation_learning'", [f.actor.sessionId])).rows).toHaveLength(1)
    expect(await store.approve({ assistantId: f.actor.assistantId, draftId: saved!.id, userId: f.actor.userId })).toBe(false)
    expect(await store.markPosted({ assistantId: f.actor.assistantId, draftId: saved!.id, userId: f.actor.userId, permalink: 'https://example.com/posted' })).toBe(true)
    expect((await pool.query('SELECT id,source_revision FROM feed_post_confirmations WHERE session_id=$1', [f.actor.sessionId])).rows).toEqual(confirmations)

  })
})

describe('[COMP:feed/draft-generation] anchored visual refinement', () => {
  it('tracks explicit source pixels in the draft audience footprint and refuses foreign file anchors', async () => {
    const f = await generationFixture(), foreign = await generationFixture()
    const file = async (workspaceId: string) => (await pool.query<{ id: string }>("INSERT INTO workspace_files(workspace_id,path,name,mime,storage_uri,sensitivity) VALUES($1,$2,'Source diagram','image/png','file:///fixture-source','internal') RETURNING id", [workspaceId, `/${randomUUID()}.png`])).rows[0]!.id
    const baseImageFileId = await file(f.workspaceId)
    const change = (id: string): FeedCommand[] => [{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: { ...f.slot, kind: 'image', briefRevision: 1, baseImageFileId: id } }] }] }]
    await expect(f.command(change(await file(foreign.workspaceId)))).rejects.toMatchObject({ code: 'file_not_available_to_draft' })
    await f.command(change(baseImageFileId))
    const copy = (await getFeedCollaboration(f.actor)).copy!
    expect(copy.content.sourceFileIds).toContain(baseImageFileId)
    expect(copy.content.sourceSensitivity).toBe('internal')
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.other.userId])
    await expect(getFeedCollaboration(f.actor)).rejects.toMatchObject({ code: 'draft_source_access_required' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('freezes the first reviewable image without mutating the slot, detects changed bytes, and sends the frozen source to the provider', async () => {
    const f = await generationFixture()
    const slot = { ...f.slot, kind: 'image' as const, briefRevision: 1 }
    await f.command([{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: f.segmentId, blockId: f.slotId, preimage: { type: 'generationPlaceholder', attrs: f.slot }, replacement: [{ type: 'generationPlaceholder', attrs: slot }] }] }])
    const fileId = randomUUID()
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,mime,storage_uri,sensitivity) VALUES($1,$2,$3,'Generated diagram','image/png','file:///fixture-image','internal')", [fileId, f.workspaceId, `/${fileId}.png`])
    const image = { data: 'fixture-authorized-image-bytes', mimeType: 'image/png' as const }
    const call = vi.fn(async (_input: unknown) => ({ text: '', imageReceipt: { image, usage: { inputTokens: 100, outputTokens: 50, measured: true } } }))
    const model = await f.port.resolve({ ...f.actor, workspaceId: f.workspaceId }, 'image', 'standard')
    f.port.resolve = vi.fn(async () => ({ ...model, call }))
    f.port.persistImage = vi.fn(async () => ({ fileId, mimeType: 'image/png' as const, alt: 'Diagram' }))
    const readImage = vi.fn(async () => ({ fileId, image, hash: 'original-bytes', inputTokens: 258 }))
    f.port.readImage = readImage
    const request = { ...f.request, mutationId: randomUUID(), count: 1, expectedRevision: 4 }
    const initial = await f.service.estimate(f.actor, request)
    await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: initial.id, confirmed: true })
    await f.service.handler((await claimFeedRun(['image_generation']))!, new AbortController().signal)
    expect(readImage).not.toHaveBeenCalled()
    const estimate = await f.service.estimate(f.actor, { ...request, mutationId: randomUUID() })
    expect(estimate.slot.baseImageFileId).toBe(fileId)
    expect((await getFeedCollaboration(f.actor)).copy!.content.composition!.segments[0]!.content[1]).toEqual({ type: 'generationPlaceholder', attrs: slot })
    readImage.mockResolvedValueOnce({ fileId, image, hash: 'changed-bytes', inputTokens: 258 })
    await expect(f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })).rejects.toMatchObject({ code: 'generation_sources_changed' })
    const queued = await f.service.dispatch(f.actor, { mutationId: randomUUID(), estimateId: estimate.id, confirmed: true })
    const active = await claimFeedRun(['image_generation']); expect(active!.id).toBe(queued.id)
    await f.service.handler(active!, new AbortController().signal)
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ sourceImage: image }))
    const suggestions = (await getFeedCollaboration(f.actor)).suggestions
    expect(suggestions).toHaveLength(2)
    expect(suggestions[1]!.edits[0]).toMatchObject({ preimage: { type: 'generationPlaceholder', attrs: slot } })
    // Revocation is rechecked at preflight rather than silently regenerating a new picture.
    await pool.query('UPDATE workspace_files SET retracted_at=now() WHERE id=$1', [fileId])
    await expect(f.service.estimate(f.actor, { ...request, mutationId: randomUUID() })).rejects.toMatchObject({ code: 'file_not_available_to_draft' })
  })
})
