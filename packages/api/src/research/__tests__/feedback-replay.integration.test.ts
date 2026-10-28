/** Real persisted-message replay; only the one-shot transport failure is injected. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { interpretResearchFollowup } from '@use-brian/core'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import * as researchStore from '../../db/research-store.js'
import { createProjectSharedStore } from '../../db/project-shared-store.js'
import { flushWorkspaceData } from '../../db/workspace-flush.js'
import { beginResearchActivity, captureResearchFollowupForMessage } from '../runtime.js'
import { outputKeyFor } from '../feedback.js'
import { addSessionMessage } from '../../db/sessions.js'
import { getUserAssistant } from '../../db/users.js'
import { resolveTurnScopeSystem, sessionMessageInputScope } from '../../context-scope/resolve-turn-scope.js'
import { classifySession, sessionPolicy, type SessionKindRow } from '../../session-kind.js'
import { crossAssistantSendPolicy } from '../../routes/_room-binding.js'
import { gateSessionRead } from '../../session-read-authority.js'
import { briefFixture, researchMessage, researchSession, savedResearch, type BriefFixture } from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterEach(() => vi.restoreAllMocks())
afterAll(async () => { await getAppPool().end(); await pool.end() })
type Saved = Awaited<ReturnType<typeof savedResearch>>

function capture(f: BriefFixture, r: Saved, messageId: string, extra: Partial<Parameters<typeof captureResearchFollowupForMessage>[0]> = {}) {
  return captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId: r.sessionId,
    assistantId: f.assistants.brian, messageId, actorUserId: f.people.member, externalPrincipal: false, ...extra })
}
async function row(messageId: string) {
  return (await pool.query(`SELECT message_id, message_version::int, activity_id, actor_user_id, output_key, association,
    current_revision, decision_event_id FROM research_feedback WHERE message_id=$1`, [messageId])).rows
}
async function counts(messageId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM research_feedback WHERE message_id=$1) AS feedback,
    (SELECT count(*)::int FROM research_feedback_revisions r JOIN research_feedback f ON f.id=r.feedback_id WHERE f.message_id=$1) AS revisions,
    (SELECT count(*)::int FROM decision_events WHERE event_kind='research.followup_recorded' AND source_id=$1::text) AS events`, [messageId])).rows[0]
}
async function failCaptureOnce(f: BriefFixture, r: Saved, messageId: string, extra: Partial<Parameters<typeof captureResearchFollowupForMessage>[0]> = {}) {
  const original = researchStore.recordResearchFeedbackSystem
  const transportFailure = new Error('synthetic feedback transport interruption')
  const errors: unknown[] = []
  let injected = 0
  // Delegate all native reader/SQL/authority and every other write unchanged.
  // Fail immediately before this target's native write, once, like a transport
  // interruption. This is not a fake feedback row or a fake tail selector.
  const spy = vi.spyOn(researchStore, 'recordResearchFeedbackSystem').mockImplementation(async input => {
    if (input.messageId === messageId && injected === 0) { injected++; throw transportFailure }
    return original(input)
  })
  try {
    expect(await capture(f, r, messageId, { ...extra,onError: error => errors.push(error) })).toBeNull()
    expect(injected).toBe(1)
    expect(errors).toEqual([transportFailure])
    expect(await counts(messageId)).toEqual({ feedback: 0, revisions: 0, events: 0 })
  } finally { spy.mockRestore() }
}
async function expectedIdentity(f: BriefFixture, r: Saved, messageId: string) {
  const source = await researchStore.getResearchMessageSystem(messageId)
  const detail = await researchStore.getResearchActivityForViewer(f.people.member, f.workspaceId, r.activity.id)
  expect(source).not.toBeNull()
  expect(detail).not.toBeNull()
  return { message_id: messageId, message_version: source!.version, activity_id: r.activity.id,
    actor_user_id: f.people.member, output_key: outputKeyFor(detail!.activity, detail!.artifacts),
    association: 'same_chat_continuation', current_revision: 1, decision_event_id: expect.any(String) }
}


/** The same neutral human envelope and writer used by real Chat turns. */
async function canonicalHuman(f: BriefFixture, r: Saved, text: string, sharedAudience=false) {
  const assistant=await getUserAssistant(f.people.member,f.assistants.brian)
  if(!assistant) throw new Error('Missing admitted fixture assistant')
  const turn=await resolveTurnScopeSystem({userId:f.people.member,workspaceId:f.workspaceId,assistant})
  const scope=sessionMessageInputScope({scope:turn,workspaceId:f.workspaceId,userId:f.people.member,sharedAudience})
  expect(scope?.assistantId).toBeNull()
  const message=await addSessionMessage({sessionId:r.sessionId,role:'user',senderUserId:f.people.member,
    content:[{type:'text',text}],scope})
  expect((await pool.query('SELECT assistant_id,sender_user_id,workspace_id FROM session_messages WHERE id=$1',[message.id])).rows)
    .toEqual([{assistant_id:null,sender_user_id:f.people.member,workspace_id:f.workspaceId}])
  expect((await queryWithRLS(f.people.member,'SELECT id FROM session_messages WHERE id=$1',[message.id])).rows).toEqual([{id:message.id}])
  return message.id
}
async function nativeSessionGate(f:BriefFixture,r:Saved) {
  const session=(await pool.query(`SELECT id,user_id AS "userId",assistant_id AS "assistantId",channel_type AS "channelType",anchor_kind AS "anchorKind",
    visibility,mode,effective_clearance AS "effectiveClearance",context_compartments AS "contextCompartments",context_project_id AS "contextProjectId"
    FROM sessions WHERE id=$1`,[r.sessionId])).rows[0]
  return gateSessionRead(f.people.member,session)
}
async function nativeTurnVerdict(f:BriefFixture,r:Saved,executing:string) {
  if(await nativeSessionGate(f,r)) return 'session_unreadable'
  const assistant=await getUserAssistant(f.people.member,executing)
  if(!assistant) return 'unreachable'
  if(assistant.blockedUserIds.includes(f.people.member)) return 'blocked'
  const session=(await pool.query<SessionKindRow & {assistantId:string;boundWorkspace:string;effectiveClearance:string|null}>(`SELECT s.assistant_id AS "assistantId",a.workspace_id AS "boundWorkspace",
    s.visibility,s.mode,s.channel_type AS "channelType",s.channel_id AS "channelId",s.anchor_kind AS "anchorKind",s.anchor_ref AS "anchorRef",s.app_origin AS "appOrigin",s.transient,
    s.effective_clearance AS "effectiveClearance" FROM sessions s JOIN assistants a ON a.id=s.assistant_id WHERE s.id=$1`,[r.sessionId])).rows[0]!
  if(session.assistantId===assistant.id) return assistant.workspaceId===f.workspaceId ? 'allow':'reject'
  const policy=sessionPolicy(classifySession(session))
  return crossAssistantSendPolicy({isSharedSession:policy.crossAssistantSend==='room',isDocSurfaceSession:policy.crossAssistantSend==='doc',
    ownerOnly:policy.read.rule==='owner',sameWorkspace:assistant.workspaceId===f.workspaceId && session.boundWorkspace===assistant.workspaceId,
    assistantClearance:assistant.clearance,sessionClearance:session.effectiveClearance})
}
async function journalAssistant(messageId:string) {
  return (await pool.query("SELECT assistant_id FROM decision_events WHERE event_kind='research.followup_recorded' AND source_id=$1",[messageId])).rows
}

describe('[COMP:api/research-feedback] [COMP:api/research-feedback-replay] persisted replay exhaustion and source identity (PG18)', () => {
  it('recovers a failed eleventh message after ten real captured receipts, exactly once on the next turn', async () => {
    const f = await briefFixture(), r = await savedResearch(f, f.people.member, f.projectId)
    const prefix: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = await researchMessage(f, r.sessionId, 'user', 'You missed the support terms', f.people.member)
      expect(await capture(f, r, id)).toMatchObject({ outcome: 'recorded' })
      prefix.push(id)
    }
    const before = await Promise.all(prefix.map(row))
    const missed = await researchMessage(f, r.sessionId, 'user', 'You missed the regulatory angle', f.people.member)
    const identity = await expectedIdentity(f, r, missed)
    await failCaptureOnce(f, r, missed)
    const current = await researchMessage(f, r.sessionId, 'user', 'what time is it in Tokyo', f.people.member)
    // Establish the persisted ordered stream without constraining a repaired
    // selector to keep the original earliest-ten production behavior.
    const earliest = await pool.query(`SELECT id FROM session_messages WHERE session_id=$1 AND role='user'
      AND sequence_num>(SELECT sequence_num FROM session_messages WHERE id=$2) ORDER BY sequence_num LIMIT 10`, [r.sessionId, r.output])
    expect(earliest.rows.map(m => m.id)).toEqual(prefix)
    expect((await pool.query("SELECT count(*)::int AS n FROM session_messages WHERE session_id=$1 AND role='user'", [r.sessionId])).rows[0].n).toBe(13)
    await capture(f, r, current)
    expect(await row(missed)).toEqual([identity])
    expect(await counts(missed)).toEqual({ feedback: 1, revisions: 1, events: 1 })
    await capture(f, r, current)
    expect(await row(missed)).toEqual([identity])
    expect(await counts(missed)).toEqual({ feedback: 1, revisions: 1, events: 1 })
    expect(await Promise.all(prefix.map(row))).toEqual(before)
    expect(await row(current)).toEqual([])
  })

  it('does not let other speakers, quotes, unrelated text or held messages starve a later failed capture', async () => {
    const f = await briefFixture(), r = await savedResearch(f, f.people.member, f.projectId)
    const excluded: string[] = []
    for (let i = 0; i < 12; i++) {
      const other = await researchMessage(f, r.sessionId, 'user', 'You missed the pricing terms', f.people.member)
      await pool.query('UPDATE session_messages SET sender_user_id=$2 WHERE id=$1', [other, f.people.lead])
      expect((await researchStore.getResearchMessageSystem(other))?.senderUserId).toBe(f.people.lead)
      excluded.push(other)
      excluded.push(await researchMessage(f, r.sessionId, 'user', '> You missed the pricing terms', f.people.member))
      excluded.push(await researchMessage(f, r.sessionId, 'user', 'what time is it in Tokyo', f.people.member))
    }
    const held = await researchMessage(f, r.sessionId, 'user', 'You missed the delivery terms', f.people.member)
    await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [held])
    expect(await researchStore.getResearchMessageSystem(held)).toBeNull()
    excluded.push(held)
    const missed = await researchMessage(f, r.sessionId, 'user', 'You missed the regulatory angle', f.people.member)
    const identity = await expectedIdentity(f, r, missed)
    await failCaptureOnce(f, r, missed)
    const current = await researchMessage(f, r.sessionId, 'user', '> You missed the warranty terms', f.people.member)
    await capture(f, r, current)
    expect(await row(missed)).toEqual([identity])
    expect(await counts(missed)).toEqual({ feedback: 1, revisions: 1, events: 1 })
    await capture(f, r, current)
    expect(await counts(missed)).toEqual({ feedback: 1, revisions: 1, events: 1 })
    for (const id of [...excluded, current]) expect(await row(id)).toEqual([])
  })

  it('keeps held sources absent and binds recovered feedback to the current canonical version without rewriting a receipt', async () => {
    const f = await briefFixture(), r = await savedResearch(f, f.people.member, f.projectId)
    const missed = await researchMessage(f, r.sessionId, 'user', 'You missed the regulatory angle', f.people.member)
    await failCaptureOnce(f, r, missed)
    await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [missed])
    const current = await researchMessage(f, r.sessionId, 'user', 'what time is it in Tokyo', f.people.member)
    await capture(f, r, current)
    expect(await counts(missed)).toEqual({ feedback: 0, revisions: 0, events: 0 })
    await pool.query('UPDATE session_messages SET scope_held=false,content=$2::jsonb WHERE id=$1',
      [missed, JSON.stringify([{ type: 'text', text: 'You missed the current warranty terms' }])])
    const identity = await expectedIdentity(f, r, missed)
    expect(identity.message_version).toBeGreaterThan(1)
    await capture(f, r, current)
    expect(await row(missed)).toEqual([identity])
    const recorded = await row(missed)
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',
      [missed, JSON.stringify([{ type: 'text', text: 'Too long, use bullet points' }])])
    await capture(f, r, current)
    expect(await row(missed)).toEqual(recorded)
    expect(await counts(missed)).toEqual({ feedback: 1, revisions: 1, events: 1 })
  })

  it('retains current-message explicit reply selection and refuses to guess between independent outputs', async () => {
    const f = await briefFixture(), r = await savedResearch(f, f.people.member, f.projectId)
    const request = await researchMessage(f, r.sessionId, 'user', 'Research fictional warranty terms', f.people.member)
    const second = await beginResearchActivity({ workspaceId: f.workspaceId, sessionId: r.sessionId, requestMessageId: request,
      actorUserId: f.people.member, assistantId: f.assistants.brian, projectId: f.projectId, entry: 'explicit', runtime: {} })
    const secondOutput = await researchMessage(f, r.sessionId, 'assistant', 'Fictional warranty findings', f.people.member)
    await researchStore.settleResearchActivitySystem({ workspaceId: f.workspaceId, activityId: second.id, status: 'partial',
      outputMessageId: secondOutput, sources: [], gaps: [], findingsCount: 1, summary: null, saveError: null, links: [] })
    const ambiguous = await researchMessage(f, r.sessionId, 'user', 'You missed the regulatory angle', f.people.member)
    expect(await capture(f, r, ambiguous)).toMatchObject({ outcome: 'unlinked', reason: 'multiple_outputs' })
    const current = await researchMessage(f, r.sessionId, 'user', 'hmm ok', f.people.member)
    expect(await capture(f, r, current, { replyToMessageId: r.output })).toMatchObject({ outcome: 'recorded',
      feedback: { activityId: r.activity.id, association: 'explicit_reply', outputKey: expect.stringContaining(r.activity.plannedPageId!) } })
    const before = await row(current)
    await capture(f, r, current, { replyToMessageId: secondOutput })
    expect(await row(current)).toEqual(before)
    expect(await counts(current)).toEqual({ feedback: 1, revisions: 1, events: 1 })
    expect(await row(ambiguous)).toEqual([])
    const external = await researchMessage(f, r.sessionId, 'user', 'You missed the pricing terms', f.people.member)
    expect(await capture(f, r, external, { externalPrincipal: true })).toBeNull()
    expect(await counts(external)).toEqual({ feedback: 0, revisions: 0, events: 0 })
  })

  it('advances through 121 ineligible messages across bounded forty-candidate turns', async () => {
    const f = await briefFixture(), r = await savedResearch(f,f.people.member,f.projectId)
    const prefix: string[] = []
    for (let i=0;i<121;i++) prefix.push(await researchMessage(f,r.sessionId,'user',i%2 ? '> You missed the price' : 'what time is it in Tokyo',f.people.member))
    const missed = await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member)
    const current = await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    let previous = 0
    for (let turn=0;turn<4;turn++) {
      await capture(f,r,current)
      const evaluated = (await pool.query('SELECT count(*)::int AS n FROM research_feedback_attempts WHERE message_id=ANY($1::uuid[])',[prefix])).rows[0].n as number
      expect(evaluated-previous).toBeLessThanOrEqual(40)
      expect(evaluated).toBeGreaterThan(previous)
      previous=evaluated
      if (turn<3) expect(await row(missed)).toEqual([])
    }
    expect(previous).toBe(121)
    expect(await row(missed)).toEqual([await expectedIdentity(f,r,missed)])
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    for (const id of prefix) expect(await row(id)).toEqual([])
  })

  it('rotates more than ten failures and continues direct capture despite a permanent replay failure', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const failing=new Set<string>(),original=researchStore.recordResearchFeedbackSystem
    const errors: unknown[]=[]
    const spy=vi.spyOn(researchStore,'recordResearchFeedbackSystem').mockImplementation(async input => {
      if(failing.has(input.messageId)) throw new Error('synthetic retry transport failure')
      return original(input)
    })
    const pending:string[]=[]
    try {
      for(let i=0;i<12;i++) {
        const id=await researchMessage(f,r.sessionId,'user','You missed the support terms',f.people.member)
        failing.add(id);pending.push(id)
        expect(await capture(f,r,id,{onError:e=>errors.push(e)})).toBeNull()
      }
      failing.clear();failing.add(pending[0]!)
      for(let turn=0;turn<2;turn++) {
        const before=(await pool.query('SELECT message_id,attempt_count FROM research_feedback_attempts WHERE message_id=ANY($1::uuid[])',[pending])).rows
        const direct=await researchMessage(f,r.sessionId,'user','Too long, use bullet points',f.people.member)
        expect(await capture(f,r,direct,{onError:e=>errors.push(e)})).toMatchObject({outcome:'recorded'})
        const after=(await pool.query('SELECT message_id,attempt_count FROM research_feedback_attempts WHERE message_id=ANY($1::uuid[])',[pending])).rows
        expect(after.reduce((n,a)=>n+a.attempt_count-before.find(b=>b.message_id===a.message_id)!.attempt_count,0)).toBeLessThanOrEqual(10)
      }
      expect(errors.length).toBeGreaterThan(0)
      expect(await row(pending[0]!)).toEqual([])
      expect((await pool.query('SELECT state,lease_token FROM research_feedback_attempts WHERE message_id=$1',[pending[0]])).rows[0]).toEqual({state:'pending',lease_token:null})
      for(const id of pending.slice(1)) expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
    } finally {spy.mockRestore()}
  })

  it('recovers an explicit cross-chat selection without rebinding to a newer result', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const fresh=await researchSession(f,f.people.member,f.projectId)
    const chosen={...r,sessionId:fresh}
    const missed=await researchMessage(f,fresh,'user','You missed the warranty terms',f.people.member)
    const original=researchStore.recordResearchFeedbackSystem
    const error=new Error('synthetic selected output transport interruption')
    const spy=vi.spyOn(researchStore,'recordResearchFeedbackSystem').mockImplementation(async input=>{if(input.messageId===missed)throw error;return original(input)})
    const errors:unknown[]=[]
    try {expect(await capture(f,chosen,missed,{selectedActivityId:r.activity.id,onError:e=>errors.push(e)})).toBeNull();expect(errors).toEqual([error])}
    finally {spy.mockRestore()}
    const newest=await savedResearch(f,f.people.member,f.projectId)
    expect(newest.activity.id).not.toBe(r.activity.id)
    const capturedVersion=(await researchStore.getResearchMessageSystem(missed))!.version
    await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[missed])
    const edited=await researchMessage(f,fresh,'user','You missed the support terms',f.people.member)
    await failCaptureOnce(f,chosen,edited,{selectedActivityId:r.activity.id})
    const editedVersion=(await researchStore.getResearchMessageSystem(edited))!.version
    await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[edited])
    // Hold-only flags need not advance canonical version. An actual supported
    // content edit while held separately proves current-version intent renewal.
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[edited,JSON.stringify([{type:'text',text:'You missed the current warranty terms'}])])
    const current=await researchMessage(f,fresh,'user','what time is it in Tokyo',f.people.member)
    await capture(f,chosen,current)
    expect(await row(missed)).toEqual([]);expect(await row(edited)).toEqual([])
    expect((await pool.query('SELECT state,target_activity_id FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'pending',target_activity_id:r.activity.id})
    await pool.query('UPDATE session_messages SET scope_held=false WHERE id=$1',[missed])
    expect((await researchStore.getResearchMessageSystem(missed))!.version).toBe(capturedVersion)
    await capture(f,chosen,current)
    expect(await row(missed)).toEqual([{...await expectedIdentity(f,r,missed),association:'explicit_selection'}])
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await row(edited)).toEqual([])
    await pool.query('UPDATE session_messages SET scope_held=false WHERE id=$1',[edited])
    expect((await researchStore.getResearchMessageSystem(edited))!.version).toBeGreaterThan(editedVersion)
    await capture(f,chosen,current)
    expect(await row(edited)).toEqual([{...await expectedIdentity(f,r,edited),association:'explicit_selection'}])
    expect(await counts(edited)).toEqual({feedback:1,revisions:1,events:1})
  })

  it('rechecks ambiguity after the admitted output witness changes', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const request=await researchMessage(f,r.sessionId,'user','Research fictional warranty terms',f.people.member)
    const second=await beginResearchActivity({workspaceId:f.workspaceId,sessionId:r.sessionId,requestMessageId:request,actorUserId:f.people.member,
      assistantId:f.assistants.brian,projectId:f.projectId,entry:'explicit',runtime:{}})
    const output=await researchMessage(f,r.sessionId,'assistant','Fictional second result',f.people.member)
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:second.id,status:'partial',outputMessageId:output,
      sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
    const missed=await researchMessage(f,r.sessionId,'user','You missed the support terms',f.people.member)
    expect(await capture(f,r,missed)).toMatchObject({outcome:'unlinked',reason:'multiple_outputs'})
    expect((await pool.query('SELECT state FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'evaluated'})
    await pool.query('DELETE FROM research_activities WHERE id=$1',[second.id])
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    expect(await row(missed)).toEqual([await expectedIdentity(f,r,missed)])
  })

  it('expires a crash lease and converges two concurrent retries on one native receipt', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const missed=await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member)
    await failCaptureOnce(f,r,missed)
    await pool.query("UPDATE research_feedback_attempts SET lease_token=$2,lease_until=now()+interval '60 seconds' WHERE message_id=$1",[missed,randomUUID()])
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    expect(await row(missed)).toEqual([])
    await pool.query("UPDATE research_feedback_attempts SET lease_until=now()-interval '1 second' WHERE message_id=$1",[missed])
    await Promise.all([capture(f,r,current),capture(f,r,current)])
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect((await pool.query('SELECT state,lease_token,lease_until FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'complete',lease_token:null,lease_until:null})
  })

  it('rolls feedback, revision, journal and completion back together, then recovers once', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const missed=await researchMessage(f,r.sessionId,'user','You missed the support terms',f.people.member)
    const original=pg.Client.prototype.query
    let failed=false
    const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]) {
      const query=args[0],text=typeof query==='string'?query:(query as {text?:string})?.text
      if(!failed && text?.includes("UPDATE research_feedback_attempts SET state='complete'")) {failed=true;return Promise.reject(new Error('synthetic completion transaction interruption'))}
      return Reflect.apply(original,this,args)
    } as typeof pg.Client.prototype.query)
    try {expect(await capture(f,r,missed)).toBeNull();expect(failed).toBe(true)} finally {spy.mockRestore()}
    expect(await counts(missed)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT state FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'pending'})
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current);await capture(f,r,current)
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
  })

  it('exposes only source-admitted discovery metadata to the app role and cascades source deletion', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const id=await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member)
    await capture(f,r,id)
    expect((await queryWithRLS(f.people.member,'SELECT message_id,state FROM research_feedback_attempts WHERE message_id=$1',[id])).rows).toEqual([{message_id:id,state:'complete'}])
    expect((await queryWithRLS(f.people.outsider,'SELECT message_id,state FROM research_feedback_attempts WHERE message_id=$1',[id])).rows).toEqual([])
    for(const sql of ['SELECT * FROM research_feedback_attempts','SELECT target_output_key FROM research_feedback_attempts',"UPDATE research_feedback_attempts SET state='pending'",'DELETE FROM research_feedback_attempts']) {
      await expect(queryWithRLS(f.people.member,sql)).rejects.toMatchObject({code:'42501'})
    }
    await pool.query('DELETE FROM session_messages WHERE id=$1',[id])
    expect((await pool.query('SELECT message_id FROM research_feedback_attempts WHERE message_id=$1',[id])).rows).toEqual([])
  })


  it('keeps a temporarily unreadable selected output pending and recovers after canonical Project admission returns', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const fresh=await researchSession(f,f.people.member),chosen={...r,sessionId:fresh}
    const missed=await researchMessage(f,fresh,'user','You missed the warranty terms',f.people.member)
    await failCaptureOnce(f,chosen,missed,{selectedActivityId:r.activity.id})
    const projects=createProjectSharedStore()
    await projects.removeMember(f.people.lead,f.projectId,{kind:'user',id:f.people.member})
    expect((await researchStore.getResearchActivityForViewer(f.people.member,f.workspaceId,r.activity.id))?.artifacts).toEqual([])
    const current=await researchMessage(f,fresh,'user','> current quote',f.people.member)
    await capture(f,chosen,current)
    expect(await row(missed)).toEqual([])
    expect((await pool.query('SELECT state,target_activity_id FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'pending',target_activity_id:r.activity.id})
    await projects.setMember(f.people.lead,f.projectId,{kind:'user',id:f.people.member},null)
    expect((await researchStore.getResearchActivityForViewer(f.people.member,f.workspaceId,r.activity.id))!.artifacts.length).toBeGreaterThan(0)
    await capture(f,chosen,current)
    expect(await row(missed)).toEqual([{...await expectedIdentity(f,r,missed),association:'explicit_selection'}])
  })

  it('retains a missing-target tombstone instead of silently choosing a new result', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const missed=await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member)
    await failCaptureOnce(f,r,missed)
    await pool.query('DELETE FROM research_activities WHERE id=$1',[r.activity.id])
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    expect((await pool.query('SELECT state,target_activity_id FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'blocked',target_activity_id:r.activity.id})
    const request=await researchMessage(f,r.sessionId,'user','Research fictional supplier alternatives',f.people.member)
    const next=await beginResearchActivity({workspaceId:f.workspaceId,sessionId:r.sessionId,requestMessageId:request,actorUserId:f.people.member,
      assistantId:f.assistants.brian,projectId:f.projectId,entry:'explicit',runtime:{}})
    const output=await researchMessage(f,r.sessionId,'assistant','Fictional replacement output',f.people.member)
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:next.id,status:'partial',outputMessageId:output,sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
    await capture(f,r,current)
    expect(await row(missed)).toEqual([])
    expect((await pool.query('SELECT state,target_activity_id FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]).toEqual({state:'blocked',target_activity_id:r.activity.id})
  })

  it('converges commit-before-ack and refuses stale lease reuse without changing native history', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const missed=await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member)
    const original=researchStore.recordResearchFeedbackSystem
    let failed=false,committed:Parameters<typeof original>[0]|undefined
    const spy=vi.spyOn(researchStore,'recordResearchFeedbackSystem').mockImplementation(async input=>{
      const result=await original(input)
      if(input.messageId===missed&&!failed){failed=true;committed=input;throw new Error('synthetic acknowledgement loss after commit')}
      return result
    })
    try {expect(await capture(f,r,missed)).toBeNull();expect(failed).toBe(true)} finally {spy.mockRestore()}
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    const before=await row(missed)
    expect(await capture(f,r,missed)).toMatchObject({outcome:'replayed'})
    await expect(original(committed!)).rejects.toThrow('research_feedback_attempt_stale')
    expect(await row(missed)).toEqual(before)
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    await flushWorkspaceData(f.people.owner,f.workspaceId)
    expect((await pool.query('SELECT message_id FROM research_feedback_attempts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })


  it('does not substitute a local result for an explicitly selected hidden activity', async () => {
    const f=await briefFixture(),local=await savedResearch(f,f.people.member,f.projectId)
    const hidden=await savedResearch(f,f.people.lead,null)
    expect(await researchStore.getResearchActivityForViewer(f.people.member,f.workspaceId,hidden.activity.id)).toBeNull()
    expect(await researchStore.getResearchActivityForViewer(f.people.member,f.workspaceId,local.activity.id)).not.toBeNull()
    const id=await researchMessage(f,local.sessionId,'user','You missed the warranty terms',f.people.member)
    const result=await capture(f,local,id,{selectedActivityId:hidden.activity.id})
    expect.soft(result?.outcome).toBe('unlinked')
    if(result && result.outcome==='unlinked') expect.soft(result.reason).toBe('not_visible')
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT activity_id FROM research_feedback WHERE message_id=$1',[id])).rows).toEqual([])
    // A real delivery re-settle advances the admitted local witness revision.
    // A rejected explicit identity must not become implicit feedback on replay.
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:local.activity.id,status:'saved',outputMessageId:local.output,
      sources:local.activity.sources,gaps:local.activity.gaps,findingsCount:local.activity.findingsCount,summary:local.activity.summary,saveError:null,links:[]})
    const current=await researchMessage(f,local.sessionId,'user','> current quote',f.people.member)
    await capture(f,local,current)
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT activity_id FROM research_feedback WHERE message_id=$1',[id])).rows).toEqual([])
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[id,JSON.stringify([{type:'text',text:'You missed the current support terms'}])])
    await capture(f,local,current)
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect(await capture(f,local,id,{selectedActivityId:local.activity.id})).toMatchObject({outcome:'recorded',feedback:{activityId:local.activity.id,association:'explicit_selection'}})
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
  })


  it('keeps a known incompatible output blocked after source edit and implicit direct capture', async () => {
    const f=await briefFixture(),sessionId=await researchSession(f,f.people.member)
    const request=await researchMessage(f,sessionId,'user','Research fictional warranty terms',f.people.member)
    const activity=await beginResearchActivity({workspaceId:f.workspaceId,sessionId,requestMessageId:request,actorUserId:f.people.member,assistantId:f.assistants.brian,projectId:null,entry:'explicit',runtime:{}})
    const output=await researchMessage(f,sessionId,'assistant','Fictional initial result',f.people.member)
    const settle=(outputMessageId:string)=>researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:activity.id,status:'partial',outputMessageId,sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
    const r={sessionId,request,output,activity:await settle(output)}
    const id=await researchMessage(f,sessionId,'user','You missed the warranty terms',f.people.member)
    await failCaptureOnce(f,r,id)
    const newer=await researchMessage(f,sessionId,'assistant','Fictional newer result',f.people.member)
    await settle(newer)
    const current=await researchMessage(f,sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    const expected={state:'blocked',target_activity_id:activity.id,target_output_key:`message:${output}`}
    expect((await pool.query('SELECT state,target_activity_id,target_output_key FROM research_feedback_attempts WHERE message_id=$1',[id])).rows[0]).toEqual(expected)
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[id,JSON.stringify([{type:'text',text:'You missed the current warranty terms'}])])
    await capture(f,r,current);await capture(f,r,id)
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT state,target_activity_id,target_output_key FROM research_feedback_attempts WHERE message_id=$1',[id])).rows[0]).toEqual(expected)
  })

  it('does not coerce edited unrelated implicit followup text into explicit uncertain feedback on retry', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const id=await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member)
    await failCaptureOnce(f,r,id)
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[id,JSON.stringify([{type:'text',text:'what time is it in Tokyo'}])])
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    const changed='Forget that, switch to competitor hiring instead'
    expect(interpretResearchFollowup(changed).kind).toBe('changed_objective')
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[id,JSON.stringify([{type:'text',text:changed}])])
    await capture(f,r,current)
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    const request=await researchMessage(f,r.sessionId,'user','Research fictional supplier alternatives',f.people.member)
    const newer=await beginResearchActivity({workspaceId:f.workspaceId,sessionId:r.sessionId,requestMessageId:request,actorUserId:f.people.member,
      assistantId:f.assistants.brian,projectId:f.projectId,entry:'explicit',runtime:{}})
    const output=await researchMessage(f,r.sessionId,'assistant','Fictional new output',f.people.member)
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:newer.id,status:'partial',outputMessageId:output,sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[id,JSON.stringify([{type:'text',text:'You missed the current warranty terms'}])])
    await capture(f,r,current)
    expect(await row(id)).toEqual([await expectedIdentity(f,r,id)])
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
  })


  it('keeps forty edited implicit pending sources out of the discovery budget', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const pending:string[]=[]
    for(let i=0;i<40;i++) pending.push(await researchMessage(f,r.sessionId,'user','You missed the warranty terms',f.people.member))
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    const original=researchStore.recordResearchFeedbackSystem,failures:unknown[]=[]
    const spy=vi.spyOn(researchStore,'recordResearchFeedbackSystem').mockImplementation(async input=>{
      if(pending.includes(input.messageId)) throw new Error('synthetic pending capture transport interruption')
      return original(input)
    })
    try {await capture(f,r,current,{onError:e=>failures.push(e)})} finally {spy.mockRestore()}
    expect(failures).toHaveLength(40)
    expect((await pool.query("SELECT count(*)::int AS n FROM research_feedback_attempts WHERE message_id=ANY($1::uuid[]) AND state='pending' AND association='same_chat_continuation'",[pending])).rows[0].n).toBe(40)
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=ANY($1::uuid[])',[pending,JSON.stringify([{type:'text',text:'what time is it in Tokyo'}])])
    expect((await pool.query('SELECT count(*)::int AS n FROM session_messages WHERE id=ANY($1::uuid[]) AND scope_version>1',[pending])).rows[0].n).toBe(40)
    const missed=await researchMessage(f,r.sessionId,'user','You missed the current support terms',f.people.member)
    for(let turn=0;turn<3;turn++) {
      await capture(f,r,current)
      expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    }
    for(const id of pending) expect(await row(id)).toEqual([])
    expect((await pool.query("SELECT count(*)::int AS n FROM research_feedback_attempts WHERE message_id=ANY($1::uuid[]) AND state='pending'",[pending])).rows[0].n).toBe(40)
  })

  it('does not replace a pending implicit output on a direct capture after source edit', async () => {
    const f=await briefFixture(),sessionId=await researchSession(f,f.people.member)
    const request=await researchMessage(f,sessionId,'user','Research fictional supplier terms',f.people.member)
    const activity=await beginResearchActivity({workspaceId:f.workspaceId,sessionId,requestMessageId:request,actorUserId:f.people.member,
      assistantId:f.assistants.brian,projectId:null,entry:'explicit',runtime:{}})
    const output=await researchMessage(f,sessionId,'assistant','Fictional initial output',f.people.member)
    const settle=(outputMessageId:string)=>researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:activity.id,status:'partial',outputMessageId,
      sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
    const r={sessionId,request,output,activity:await settle(output)}
    const id=await researchMessage(f,sessionId,'user','You missed the warranty terms',f.people.member)
    await failCaptureOnce(f,r,id)
    const before=(await pool.query('SELECT to_jsonb(a) AS value FROM research_feedback_attempts a WHERE message_id=$1',[id])).rows[0].value
    const newer=await researchMessage(f,sessionId,'assistant','Fictional newer output',f.people.member)
    await settle(newer)
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[id,JSON.stringify([{type:'text',text:'You missed the current warranty terms'}])])
    // Current source is excluded from replay, so this is the exact direct path.
    await capture(f,r,id)
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT to_jsonb(a) AS value FROM research_feedback_attempts a WHERE message_id=$1',[id])).rows[0].value).toEqual(before)
    // A genuine current admitted explicit selection at a newer source version
    // remains a supported resolution, unlike implicit output substitution.
    expect(await capture(f,r,id,{selectedActivityId:activity.id})).toMatchObject({outcome:'recorded',feedback:{association:'explicit_selection',outputKey:`message:${newer}`}})
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
  })

  it('does not rediscover forty quote-only sources when only the output witness changes', async () => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    const quotes:string[]=[]
    for(let i=0;i<40;i++) quotes.push(await researchMessage(f,r.sessionId,'user','> You missed the warranty terms',f.people.member))
    const missed=await researchMessage(f,r.sessionId,'user','You missed the current support terms',f.people.member)
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    expect(await row(missed)).toEqual([])
    const snapshot=()=>pool.query('SELECT to_jsonb(a) AS value FROM research_feedback_attempts a WHERE message_id=ANY($1::uuid[]) ORDER BY message_id',[quotes])
    const before=(await snapshot()).rows
    expect(before).toHaveLength(40)
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:r.activity.id,status:'saved',outputMessageId:r.output,
      sources:r.activity.sources,gaps:r.activity.gaps,findingsCount:r.activity.findingsCount,summary:r.activity.summary,saveError:null,links:[]})
    await capture(f,r,current)
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect((await snapshot()).rows).toEqual(before)
    for(const id of quotes) expect(await row(id)).toEqual([])
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[quotes[0],JSON.stringify([{type:'text',text:'You missed the current warranty terms'}])])
    await capture(f,r,current)
    expect(await counts(quotes[0]!)).toEqual({feedback:1,revisions:1,events:1})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
  })


  it.each([false,true])('does not rediscover unrelated or changed-objective prefixes when only witnesses change (multiple=%s)', async multiple => {
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    let secondActivity:string|null=null
    if(multiple) {
      const request=await researchMessage(f,r.sessionId,'user','Research another fictional vendor',f.people.lead)
      await pool.query('UPDATE session_messages SET sender_user_id=$2 WHERE id=$1',[request,f.people.lead])
      expect((await researchStore.getResearchMessageSystem(request))?.senderUserId).toBe(f.people.lead)
      const second=await beginResearchActivity({workspaceId:f.workspaceId,sessionId:r.sessionId,requestMessageId:request,actorUserId:f.people.lead,
        assistantId:f.assistants.brian,projectId:f.projectId,entry:'explicit',runtime:{}})
      const output=await researchMessage(f,r.sessionId,'assistant','Independent fictional result',f.people.lead)
      await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:second.id,status:'partial',outputMessageId:output,
        sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
      secondActivity=second.id
    }
    const prefix:string[]=[]
    const unrelated='what time is it in Tokyo',changed='Forget that, switch to competitor hiring instead'
    expect(interpretResearchFollowup(unrelated).uncertain).toBe(true)
    expect(interpretResearchFollowup(changed).kind).toBe('changed_objective')
    for(let i=0;i<40;i++) prefix.push(await researchMessage(f,r.sessionId,'user',i%2 ? unrelated : changed,f.people.member))
    const missed=await researchMessage(f,r.sessionId,'user','You missed the current support terms',f.people.member)
    const current=await researchMessage(f,r.sessionId,'user','> current quote',f.people.member)
    await capture(f,r,current)
    expect(await row(missed)).toEqual([])
    const snapshot=()=>pool.query('SELECT to_jsonb(a) AS value FROM research_feedback_attempts a WHERE message_id=ANY($1::uuid[]) ORDER BY message_id',[prefix])
    const before=(await snapshot()).rows
    expect(before).toHaveLength(40)
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:r.activity.id,status:'saved',outputMessageId:r.output,
      sources:r.activity.sources,gaps:r.activity.gaps,findingsCount:r.activity.findingsCount,summary:r.activity.summary,saveError:null,links:[]})
    await capture(f,r,current)
    if(multiple) {
      // The later source is reached without inventing attribution between two
      // actual outputs. It stays context-dependent until ambiguity resolves.
      expect(await counts(missed)).toEqual({feedback:0,revisions:0,events:0})
      expect((await pool.query('SELECT state,reason FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows)
        .toEqual([{state:'evaluated',reason:'multiple_outputs'}])
      expect((await snapshot()).rows).toEqual(before)
      await pool.query('DELETE FROM research_activities WHERE id=$1',[secondActivity])
      await capture(f,r,current)
    }
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect((await snapshot()).rows).toEqual(before)
    for(const id of prefix) expect(await row(id)).toEqual([])
    await pool.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1',[prefix[0],JSON.stringify([{type:'text',text:'You missed the current warranty terms'}])])
    await capture(f,r,current)
    expect(await counts(prefix[0]!)).toEqual({feedback:1,revisions:1,events:1})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
  })

  it.each(['chat','doc','room'] as const)('captures a native neutral human source on an admitted per-turn assistant in %s',async surface=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility=$2,app_origin=$3,anchor_kind='none' WHERE id=$1",
      [r.sessionId,surface==='room'?'workspace':'personal',surface==='doc'?'doc':'chat'])
    // Personal Chat/doc have no shared-room clearance cap; room B is internal.
    if(surface!=='room') await pool.query("UPDATE assistants SET clearance='confidential' WHERE id=$1",[f.assistants.ops])
    const id=await canonicalHuman(f,r,'You missed the current warranty terms',surface==='room')
    expect(await nativeTurnVerdict(f,r,f.assistants.ops)).toBe('allow')
    expect(await capture(f,r,id,{assistantId:f.assistants.ops})).toMatchObject({outcome:'recorded'})
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(id)).toEqual([{assistant_id:f.assistants.ops}])
    expect((await pool.query('SELECT assistant_id,state FROM research_feedback_attempts WHERE message_id=$1',[id])).rows)
      .toEqual([{assistant_id:f.assistants.ops,state:'complete'}])
  })

  it.each(['foreign','unsupported','above_floor','unreachable','blocked'] as const)('refuses a canonical per-turn assistant policy denial (%s)',async denial=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat',anchor_kind='none' WHERE id=$1",[r.sessionId])
    const id=await canonicalHuman(f,r,'You missed the current warranty terms')
    let executing=f.assistants.ops
    if(denial==='foreign') executing=(await briefFixture()).assistants.ops
    if(denial==='unsupported') await pool.query("UPDATE sessions SET channel_type='telegram',anchor_kind='channel',app_origin=NULL WHERE id=$1",[r.sessionId])
    if(denial==='above_floor') {
      await pool.query("UPDATE sessions SET visibility='workspace',effective_clearance='internal' WHERE id=$1",[r.sessionId])
      await pool.query("UPDATE assistants SET clearance='confidential' WHERE id=$1",[executing])
    }
    if(denial==='unreachable') {
      executing=randomUUID()
      await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,placement_department_id) VALUES($1,$2,'Fictional private assistant','standard','internal',$3)",[executing,f.workspaceId,f.finance])
      expect(await getUserAssistant(f.people.member,executing)).toBeNull()
    }
    if(denial==='blocked') {
      executing=f.assistants.brian
      await pool.query('UPDATE assistants SET blocked_user_ids=$2::uuid[] WHERE id=$1',[executing,[f.people.member]])
    }
    expect(await nativeTurnVerdict(f,r,executing)).not.toBe('allow')
    await capture(f,r,id,{assistantId:executing})
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query("SELECT 1 FROM research_feedback_attempts WHERE message_id=$1 AND state='complete'",[id])).rows).toEqual([])
  })

  it('uses the executing assistant reach without requiring the blocked session default assistant',async()=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    const id=await canonicalHuman(f,r,'You missed the current warranty terms')
    await pool.query('UPDATE assistants SET blocked_user_ids=$2::uuid[] WHERE id=$1',[f.assistants.brian,[f.people.member]])
    expect(await nativeTurnVerdict(f,r,f.assistants.brian)).toBe('blocked')
    expect(await nativeTurnVerdict(f,r,f.assistants.ops)).toBe('allow')
    expect(await capture(f,r,id,{assistantId:f.assistants.ops})).toMatchObject({outcome:'recorded'})
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(id)).toEqual([{assistant_id:f.assistants.ops}])
  })

  it.each([false,true])('recovers original assistant intent on another admitted turn while preserving attribution (blocked=%s)',async blocked=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    const missed=await canonicalHuman(f,r,'You missed the support terms')
    await failCaptureOnce(f,r,missed)
    const intent=(await pool.query('SELECT assistant_id,target_activity_id,target_output_key,association FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]
    expect(intent).toMatchObject({assistant_id:f.assistants.brian,target_activity_id:r.activity.id,association:'same_chat_continuation'})
    const current=await canonicalHuman(f,r,'You missed the current warranty terms')
    if(blocked) await pool.query('UPDATE assistants SET blocked_user_ids=$2::uuid[] WHERE id=$1',[f.assistants.brian,[f.people.member]])
    expect(await nativeTurnVerdict(f,r,f.assistants.ops)).toBe('allow')
    expect(await capture(f,r,current,{assistantId:f.assistants.ops})).toMatchObject({outcome:'recorded'})
    expect(await counts(current)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(current)).toEqual([{assistant_id:f.assistants.ops}])
    if(blocked) {
      expect(await counts(missed)).toEqual({feedback:0,revisions:0,events:0})
      expect((await pool.query('SELECT state FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows).toEqual([{state:'pending'}])
      await pool.query("UPDATE assistants SET blocked_user_ids='{}' WHERE id=$1",[f.assistants.brian])
      await capture(f,r,current,{assistantId:f.assistants.ops})
    }
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(missed)).toEqual([{assistant_id:f.assistants.brian}])
    expect((await pool.query('SELECT assistant_id,target_activity_id,target_output_key,association FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows).toEqual([intent])
    await capture(f,r,current,{assistantId:f.assistants.ops})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await counts(current)).toEqual({feedback:1,revisions:1,events:1})
  })

  it.each(['assistant','workspace'] as const)('refuses an inconsistent nonnull canonical source envelope (%s)',async axis=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    const id=await canonicalHuman(f,r,'You missed the current warranty terms')
    if(axis==='assistant') await pool.query('UPDATE session_messages SET assistant_id=$2 WHERE id=$1',[id,f.assistants.ops])
    else await pool.query('UPDATE session_messages SET workspace_id=$2 WHERE id=$1',[id,(await briefFixture()).workspaceId])
    await capture(f,r,id,{assistantId:f.assistants.ops})
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
  })

  it('keeps an unreachable original assistant pending and recovers its attribution after actual reach returns',async()=>{
    const base=await briefFixture(),original=randomUUID()
    await base.edge('user',base.people.member)
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,placement_department_id) VALUES($1,$2,'Fictional original assistant','standard','internal',$3)",[original,base.workspaceId,base.finance])
    await base.edge('assistant',original)
    const f={...base,assistants:{...base.assistants,brian:original}}
    expect(await getUserAssistant(f.people.member,original)).not.toBeNull()
    const r=await savedResearch(f,f.people.member,null)
    // Original A is a per-turn capture in a B-bound session. Revoking A
    // must not revoke the independently reachable bound session assistant B.
    await pool.query("UPDATE sessions SET assistant_id=$2,visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId,f.assistants.ops])
    expect(await nativeSessionGate(f,r)).toBeNull()
    expect(await nativeTurnVerdict(f,r,original)).toBe('allow')
    const missed=await canonicalHuman(f,r,'You missed the support terms')
    await failCaptureOnce(f,r,missed)
    const intent=(await pool.query('SELECT assistant_id,target_activity_id,target_output_key,association FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows[0]
    expect(intent).toMatchObject({assistant_id:original,target_activity_id:r.activity.id,association:'same_chat_continuation'})
    const current=await canonicalHuman(f,r,'> current quoted message')
    await pool.query("DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND principal_kind='user' AND user_id=$3",[f.workspaceId,f.finance,f.people.member])
    expect(await getUserAssistant(f.people.member,original)).toBeNull()
    expect(await nativeSessionGate(f,r)).toBeNull()
    expect(await nativeTurnVerdict(f,r,f.assistants.ops)).toBe('allow')
    await capture(f,r,current,{assistantId:f.assistants.ops})
    expect(await counts(missed)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT state FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows).toEqual([{state:'pending'}])
    expect(await journalAssistant(missed)).toEqual([])
    await base.edge('user',f.people.member)
    expect(await nativeSessionGate(f,r)).toBeNull()
    expect(await getUserAssistant(f.people.member,original)).not.toBeNull()
    await capture(f,r,current,{assistantId:f.assistants.ops})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(missed)).toEqual([{assistant_id:original}])
    expect((await pool.query('SELECT assistant_id,target_activity_id,target_output_key,association FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows).toEqual([intent])
    await capture(f,r,current,{assistantId:f.assistants.ops})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await counts(current)).toEqual({feedback:0,revisions:0,events:0})
  })

  it('refuses a foreign executing assistant even when the actor can reach both workspaces',async()=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId),other=await briefFixture()
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[other.workspaceId,f.people.member])
    expect(await getUserAssistant(f.people.member,other.assistants.ops)).not.toBeNull()
    const id=await canonicalHuman(f,r,'You missed the current warranty terms')
    expect(await nativeSessionGate(f,r)).toBeNull()
    expect(await nativeTurnVerdict(f,r,other.assistants.ops)).toBe('reject')
    await capture(f,r,id,{assistantId:other.assistants.ops})
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
  })

  it.each(['blocked','unreachable','foreign'] as const)('does not let a denied triggering assistant borrow a pending original assistant (%s)',async denial=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    const missed=await canonicalHuman(f,r,'You missed the support terms')
    await failCaptureOnce(f,r,missed)
    const before=(await pool.query('SELECT to_jsonb(a) AS value FROM research_feedback_attempts a WHERE message_id=$1',[missed])).rows[0].value
    const current=await canonicalHuman(f,r,'You missed the current warranty terms')
    let denied=f.assistants.ops,restored=f.assistants.ops
    if(denial==='blocked') await pool.query('UPDATE assistants SET blocked_user_ids=$2::uuid[] WHERE id=$1',[denied,[f.people.member]])
    if(denial==='unreachable') {
      denied=randomUUID();restored=denied
      await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,placement_department_id) VALUES($1,$2,'Fictional trigger assistant','standard','internal',$3)",[denied,f.workspaceId,f.finance])
      await f.edge('assistant',denied)
      expect(await getUserAssistant(f.people.member,denied)).toBeNull()
    }
    if(denial==='foreign') {
      const other=await briefFixture();denied=other.assistants.ops
      await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[other.workspaceId,f.people.member])
      expect(await getUserAssistant(f.people.member,denied)).not.toBeNull()
    }
    expect(await nativeSessionGate(f,r)).toBeNull()
    expect(await nativeTurnVerdict(f,r,denied)).not.toBe('allow')
    await capture(f,r,current,{assistantId:denied})
    expect(await counts(missed)).toEqual({feedback:0,revisions:0,events:0})
    expect(await counts(current)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT to_jsonb(a) AS value FROM research_feedback_attempts a WHERE message_id=$1',[missed])).rows[0].value).toEqual(before)
    if(denial==='blocked') await pool.query("UPDATE assistants SET blocked_user_ids='{}' WHERE id=$1",[denied])
    if(denial==='unreachable') await f.edge('user',f.people.member)
    expect(await nativeTurnVerdict(f,r,restored)).toBe('allow')
    expect(await capture(f,r,current,{assistantId:restored})).toMatchObject({outcome:'recorded'})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(missed)).toEqual([{assistant_id:f.assistants.brian}])
    expect(await counts(current)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(current)).toEqual([{assistant_id:restored}])
  })

  it('attributes the first admitted link to the current assistant after an earlier unlinked evaluation',async()=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    const request=await researchMessage(f,r.sessionId,'user','Research another fictional vendor',f.people.lead)
    await pool.query('UPDATE session_messages SET sender_user_id=$2 WHERE id=$1',[request,f.people.lead])
    expect((await researchStore.getResearchMessageSystem(request))?.senderUserId).toBe(f.people.lead)
    const second=await beginResearchActivity({workspaceId:f.workspaceId,sessionId:r.sessionId,requestMessageId:request,actorUserId:f.people.lead,
      assistantId:f.assistants.brian,projectId:f.projectId,entry:'explicit',runtime:{}})
    const output=await researchMessage(f,r.sessionId,'assistant','Independent fictional result',f.people.lead)
    await researchStore.settleResearchActivitySystem({workspaceId:f.workspaceId,activityId:second.id,status:'partial',outputMessageId:output,
      sources:[],gaps:[],findingsCount:1,summary:null,saveError:null,links:[]})
    const missed=await canonicalHuman(f,r,'You missed the current warranty terms')
    expect(await capture(f,r,missed)).toMatchObject({outcome:'unlinked',reason:'multiple_outputs'})
    expect(await counts(missed)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT assistant_id,state,association FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows)
      .toEqual([{assistant_id:f.assistants.brian,state:'evaluated',association:null}])
    await pool.query('DELETE FROM research_activities WHERE id=$1',[second.id])
    const current=await canonicalHuman(f,r,'> current quoted message')
    expect(await nativeTurnVerdict(f,r,f.assistants.ops)).toBe('allow')
    await capture(f,r,current,{assistantId:f.assistants.ops})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(missed)).toEqual([{assistant_id:f.assistants.ops}])
    expect((await pool.query('SELECT assistant_id,state,target_activity_id,association FROM research_feedback_attempts WHERE message_id=$1',[missed])).rows)
      .toEqual([{assistant_id:f.assistants.ops,state:'complete',target_activity_id:r.activity.id,association:'same_chat_continuation'}])
    await capture(f,r,current,{assistantId:f.assistants.ops})
    expect(await counts(missed)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(missed)).toEqual([{assistant_id:f.assistants.ops}])
  })

  it('attributes a fresh admitted explicit resolution to the current assistant after an unresolved selection',async()=>{
    const f=await briefFixture(),r=await savedResearch(f,f.people.member,f.projectId),other=await briefFixture()
    const hidden=await savedResearch(other,other.people.member,other.projectId)
    await pool.query("UPDATE sessions SET visibility='personal',app_origin='chat' WHERE id=$1",[r.sessionId])
    const id=await canonicalHuman(f,r,'You missed the current warranty terms')
    expect(await researchStore.getResearchActivityForViewer(f.people.member,f.workspaceId,hidden.activity.id)).toBeNull()
    expect(await capture(f,r,id,{selectedActivityId:hidden.activity.id})).toMatchObject({outcome:'unlinked',reason:'not_visible'})
    expect(await counts(id)).toEqual({feedback:0,revisions:0,events:0})
    expect((await pool.query('SELECT assistant_id,state,target_activity_id,target_output_key FROM research_feedback_attempts WHERE message_id=$1',[id])).rows)
      .toEqual([{assistant_id:f.assistants.brian,state:'blocked',target_activity_id:hidden.activity.id,target_output_key:null}])
    expect(await nativeTurnVerdict(f,r,f.assistants.ops)).toBe('allow')
    expect(await capture(f,r,id,{assistantId:f.assistants.ops,selectedActivityId:r.activity.id})).toMatchObject({outcome:'recorded'})
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(id)).toEqual([{assistant_id:f.assistants.ops}])
    expect((await pool.query('SELECT assistant_id,state,target_activity_id,association FROM research_feedback_attempts WHERE message_id=$1',[id])).rows)
      .toEqual([{assistant_id:f.assistants.ops,state:'complete',target_activity_id:r.activity.id,association:'explicit_selection'}])
    expect(await capture(f,r,id,{assistantId:f.assistants.ops,selectedActivityId:r.activity.id})).toMatchObject({outcome:'replayed'})
    expect(await counts(id)).toEqual({feedback:1,revisions:1,events:1})
    expect(await journalAssistant(id)).toEqual([{assistant_id:f.assistants.ops}])
  })

})
