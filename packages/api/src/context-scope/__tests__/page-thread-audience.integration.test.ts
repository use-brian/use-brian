import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ContextScopeAccumulator, scopeEvidenceFromRows, createGetCommentThreadTool, executionToolContext } from '@use-brian/core'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createDbCommentThreadStore } from '../../db/comment-thread-store.js'
import { createDbDocPageStore } from '../../db/doc-page-store.js'
import { addSessionMessage, readSessionById } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { readAttendedSessionHistory } from '../../routes/attended-session-context.js'
import { gateSessionRead } from '../../session-read-authority.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { resolveExecutionContextSystem } from '../execution-context.js'
import { createAttendedDeliveryAudienceAuthorizer } from '../attended-audience.js'
import { turnOutputWrite } from '../resolve-turn-scope.js'
import { readOptionalContext } from '../optional-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/page-thread-audience] current Page input and retained replies', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  async function setup(privatePage = false) {
    fixture = await persistentContextFixture()
    const f = fixture, space = randomUUID(), pageId = randomUUID()
    await f.pool.query("UPDATE assistants SET clearance='internal' WHERE id=$1", [f.assistantId])
    await f.pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by) VALUES($1,$2,'Fictional orchard','internal',$3)", [space,f.workspaceId,f.ownerId])
    for (const user of [f.ownerId, f.firstId]) await f.pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [space,user])
    await f.pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
      VALUES($1,$2,$3,'Fictional orchard plan','tasks','table',$4,'saved','internal',$5)`,
    [pageId,f.workspaceId,f.ownerId,JSON.stringify({ blocks: [{ kind: 'text', id: 'orchard', text: 'Three rows produce twelve crates.' }] }),privatePage ? null : space])
    const thread = await createDbCommentThreadStore().createThread({ userId:f.ownerId,workspaceId:f.workspaceId,
      assistantId:f.assistantId,pageId,anchorKind:'human_range' })
    const session = (await readSessionById(thread.sessionId))!
    const assistant = (await findAssistantById(f.assistantId))!
    const { executionContext: execution } = await resolveExecutionContextSystem({ userId:f.ownerId,workspaceId:f.workspaceId,assistant,
      sharedAudience:true,session,sessionAuthority:session,memberMode:'member',
      identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.ownerId,authenticationKind:'native_session'}},
      ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:session.id,channelType:session.channelType,
        channelId:session.channelId,abortSignal:new AbortController().signal} })
    const accumulator = new ContextScopeAccumulator(), authority = { execution, accumulator }
    const authorize = createAttendedDeliveryAudienceAuthorizer(execution)
    const audience = { workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,
      channelType:session.channelType,channelId:session.channelId,sessionId:session.id,recipientType:'group' as const }
    const envelope = { workspaceId:f.workspaceId,userId:null,assistantId:null,sensitivity:'internal' as const,compartments:[],projectIds:[] }
    return { f,space,pageId,thread,session,execution,accumulator,authority,authorize,audience,envelope }
  }

  it('admits the actual Page, omits private optional context, publishes and reopens the source-backed reply', async () => {
    const t = await setup()
    const input = await addSessionMessage({ sessionId:t.session.id,role:'user',content:'Summarize this Page.',scope:t.envelope })
    t.accumulator.note(scopeEvidenceFromRows([input]))
    const page = await createDbDocPageStore().getVersionedPage(t.f.ownerId,t.pageId,
      { userId:t.f.ownerId,assistantId:t.f.assistantId,appId:'fixture',sessionId:t.session.id,channelType:'web',
        channelId:t.session.channelId,abortSignal:t.execution.lifecycle.abortSignal,executionContext:t.execution,
        scopeAccumulator:t.accumulator,authority:t.execution.security.authority })
    expect(page?.page.blocks).toEqual([{ kind:'text',id:'orchard',text:'Three rows produce twelve crates.' }])
    const privateMemory = await t.f.memory('PRIVATE OPTIONAL ORCHARD MEMORY',t.f.ownerId)
    const privateCandidate = await createDbMemoryStore().getById({ ...t.execution.security.access,sharedAudience:false },privateMemory.id)
    expect(privateCandidate).not.toBeNull()
    expect(scopeEvidenceFromRows([privateCandidate]).sources).toEqual(expect.arrayContaining([expect.objectContaining({ userId:t.f.ownerId })]))
    const optional = await readOptionalContext({ execution:t.execution,accumulator:t.accumulator,
      read:async () => privateCandidate!.summary,evidence:() => scopeEvidenceFromRows([privateCandidate]),fallback:'',
      authorize:evidence => t.authorize({ ...t.audience,scopeEvidence:evidence }) })
    expect(optional).toBe('')
    const decision = await t.authorize({ ...t.audience,scopeEvidence:t.accumulator.evidence })
    expect(decision.allowed,JSON.stringify(decision)).toBe(true)
    if (!decision.allowed) throw new Error('Expected actual Page audience')
    t.accumulator.note(decision.evidence)
    const reply = await addSessionMessage({ sessionId:t.session.id,role:'assistant',senderAssistantId:t.f.assistantId,
      content:[{type:'text',text:'The orchard has three rows and a twelve-crate target.'}],
      ...turnOutputWrite({producer:'fixture:page-reply',accumulator:t.accumulator,envelope:t.envelope}),authority:t.authority })
    const edges = (await t.f.pool.query(`SELECT s.source_kind FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_id=$2`, [t.f.workspaceId,reply.id])).rows
    expect(edges).toContainEqual({ source_kind:'page_event_changed' })
    const history = await readAttendedSessionHistory(t.authority,t.session.id,null)
    expect(history.some(row => row.id === reply.id)).toBe(true)
    expect(JSON.stringify(history)).not.toContain('PRIVATE OPTIONAL')
    expect(await t.authorize({ ...t.audience,scopeEvidence:t.accumulator.evidence })).toMatchObject({ allowed:true })
    const discussion = new ContextScopeAccumulator()
    const result = await createGetCommentThreadTool({ commentThreadStore:createDbCommentThreadStore() }).execute(
      { threadId:t.thread.id }, { ...executionToolContext(t.execution,{ appId:'fixture' }),scopeAccumulator:discussion })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.data)).toContain('twelve-crate target')
    expect(discussion.evidence.sources?.length).toBeGreaterThan(0)
    expect(await t.authorize({ ...t.audience,scopeEvidence:discussion.evidence })).toMatchObject({ allowed:true })
  })

  it('gates raw and API transcript reads by the Page and withholds an unrelated Page', async () => {
    const t = await setup()
    expect(await gateSessionRead(t.f.secondId,t.session)).toMatchObject({ status:404 })
    expect((await queryWithRLS(t.f.secondId,'SELECT id FROM sessions WHERE id=$1',[t.session.id])).rows).toEqual([])
    const other = (await t.f.pool.query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
      VALUES($1,$2,'Fictional other Page','tasks','table','{"blocks":[]}','saved','internal',$3) RETURNING page_event_revision`,
    [t.f.workspaceId,t.f.ownerId,t.space])).rows[0]
    const source = (await t.f.pool.query("SELECT read_scope_source($1,'page_event_changed',$2) AS source",[t.f.workspaceId,other.page_event_revision])).rows[0].source
    expect(await t.authorize({ ...t.audience,scopeEvidence:{sources:[source]} })).toMatchObject({ allowed:false })
  })

  it('admits an owner-only Page only into its own Page-gated thread and refuses a later audience change', async () => {
    const t = await setup(true)
    const page = await createDbDocPageStore().getVersionedPage(t.f.ownerId,t.pageId,
      { userId:t.f.ownerId,assistantId:t.f.assistantId,appId:'fixture',sessionId:t.session.id,channelType:'web',
        channelId:t.session.channelId,abortSignal:t.execution.lifecycle.abortSignal,executionContext:t.execution,
        scopeAccumulator:t.accumulator,authority:t.execution.security.authority })
    expect(page).not.toBeNull()
    expect(await t.authorize({ ...t.audience,scopeEvidence:t.accumulator.evidence })).toMatchObject({ allowed:true })
    const reply = await addSessionMessage({ sessionId:t.session.id,role:'assistant',senderAssistantId:t.f.assistantId,
      content:[{ type:'text',text:'The owner-only orchard has three rows.' }],
      ...turnOutputWrite({ producer:'fixture:private-page-reply',accumulator:t.accumulator,envelope:t.envelope }),authority:t.authority })
    expect((await readAttendedSessionHistory(t.authority,t.session.id,null)).some(row => row.id === reply.id)).toBe(true)
    expect(await gateSessionRead(t.f.firstId,t.session)).toMatchObject({ status:404 })
    await t.f.pool.query('UPDATE saved_views SET teamspace_id=$2 WHERE id=$1',[t.pageId,t.space])
    expect(await t.authorize({ ...t.audience,scopeEvidence:t.accumulator.evidence })).toMatchObject({ allowed:false })
  })

  it('refuses copying Page-derived output to another Page thread at the actual publication constraint', async () => {
    const t = await setup()
    await createDbDocPageStore().getVersionedPage(t.f.ownerId,t.pageId,
      { userId:t.f.ownerId,assistantId:t.f.assistantId,appId:'fixture',sessionId:t.session.id,channelType:'web',
        channelId:t.session.channelId,abortSignal:t.execution.lifecycle.abortSignal,executionContext:t.execution,
        scopeAccumulator:t.accumulator,authority:t.execution.security.authority })
    const pageId = (await t.f.pool.query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
      VALUES($1,$2,'Fictional destination','tasks','table','{"blocks":[]}','saved','internal',$3) RETURNING id`,
    [t.f.workspaceId,t.f.ownerId,t.space])).rows[0].id
    const thread = await createDbCommentThreadStore().createThread({ userId:t.f.ownerId,workspaceId:t.f.workspaceId,
      assistantId:t.f.assistantId,pageId,anchorKind:'human_range' })
    const destination = (await readSessionById(thread.sessionId))!, execution = await t.f.execution(t.f.ownerId,destination)
    await expect(addSessionMessage({ sessionId:destination.id,role:'assistant',senderAssistantId:t.f.assistantId,
      content:[{type:'text',text:'Fictional forbidden Page copy'}],
      ...turnOutputWrite({producer:'fixture:forbidden-page-copy',accumulator:t.accumulator,envelope:t.envelope}),
      authority:{ execution,accumulator:t.accumulator } })).rejects.toThrow(/page_derivation_output_not_integrated/)
    expect((await t.f.pool.query('SELECT id FROM session_messages WHERE session_id=$1',[destination.id])).rows).toEqual([])
  })
})
