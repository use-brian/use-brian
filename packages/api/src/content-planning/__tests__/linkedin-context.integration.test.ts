import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FeedLinkedInContext } from '@use-brian/shared'
import { getPool } from '../../db/client.js'
import { postWorkingCopiesStore } from '../../db/post-working-copies.js'
import { executeFeedCommands, getFeedCollaboration, type FeedActor } from '../../db/feed-collaboration-store.js'
import { confirmFeedPost, listFeedConfirmations } from '../confirmation.js'
import { buildFeedCollaborationTools } from '../collaboration-tools.js'
import { setFeedLinkedInTargetAuthority } from '../linkedin-authority.js'
import { projectFeedLinkedIn } from '@use-brian/doc-model'
import { feedOutputProjection } from '../projection.js'
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/absent')
if (!process.env.BRIAN_ASSURANCE_TOKEN || url.hostname !== '127.0.0.1' || url.pathname !== '/brian_assurance') throw new Error('LinkedIn tests require the disposable loopback fixture')
const pool = getPool(); const workspaces: string[] = []; const users: string[] = []
afterAll(async () => { for (const id of workspaces) await pool.query('DELETE FROM workspaces WHERE id=$1', [id]); for (const id of users) await pool.query('DELETE FROM users WHERE id=$1', [id]); await pool.end() })
async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  users.push(userId); workspaces.push(workspaceId)
  await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'Writer fixture')", [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Orchard fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,can_draft) VALUES($1,$2,'owner',true)", [workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,app_type,clearance) VALUES($1,'Writer fixture',$2,$3,'app','distribution','public')", [assistantId,workspaceId,userId])
  await postWorkingCopiesStore.put(assistantId,sessionId,userId,{ revision:0,mutationId:randomUUID(),create:{platform:'linkedin'},content:{title:'Story',privateBrief:'',text:'An orchard story.',postFormat:'post',threadSegments:[],article:{sourceUrl:'',title:'',description:''},media:[]} })
  const actor: FeedActor = {userId,assistantId,sessionId,kind:'user'}
  await executeFeedCommands(actor,{expectedRevision:1,mutationId:randomUUID(),commands:[{kind:'upgrade'}]})
  return { actor, workspaceId }
}
const metadata: FeedLinkedInContext = {version:1,mode:'post',destinationId:null,authorKind:'person'}
describe('[COMP:feed/linkedin-context] canonical context authority', () => {
  it('UI and Brian invoke the same revisioned command and invalidate confirmations', async () => {
    const f = await fixture()
    const confirmation = await confirmFeedPost(f.actor,{expectedRevision:2,mutationId:randomUUID(),locale:'en'})
    await executeFeedCommands(f.actor,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata}]})
    expect((await listFeedConfirmations(f.actor)).find(c=>c.id===confirmation.confirmation.id)?.current).toBe(false)
    const copy = (await getFeedCollaboration(f.actor)).copy!
    const tools = buildFeedCollaborationTools({snapshot: await getFeedCollaboration(f.actor), selectedQuote:'', actor:{...f.actor,kind:'assistant'},reference:{sessionId:f.actor.sessionId,revision:3}},undefined,undefined,async () => { throw new Error('unused') })
    expect(tools.find(t=>t.name==='applyFeedDraftCommands')?.inputSchema.safeParse({expectedRevision:3,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata}]}).success).toBe(true)
    const tool = tools.find(t=>t.name==='applyFeedDraftCommands')!
    await tool.execute({expectedRevision:3,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata}]},{userId:f.actor.userId,assistantId:f.actor.assistantId,sessionId:f.actor.sessionId,appId:'fixture',channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal})
    expect((await getFeedCollaboration(f.actor)).copy!.content.linkedin).toEqual(copy.content.linkedin)
    expect(copy.content.linkedin).toEqual(metadata)
    expect(feedOutputProjection(copy.content as Parameters<typeof feedOutputProjection>[0],'linkedin').linkedin).toEqual(projectFeedLinkedIn(copy.content.composition!,metadata,copy.content))
    await executeFeedCommands(f.actor,{expectedRevision:4,mutationId:randomUUID(),commands:[{kind:'undo',revision:3}]})
    expect((await getFeedCollaboration(f.actor)).copy!.content.linkedin).toBeUndefined()
  })
  it('rejects unauthorized targets and cover references without changing the revision', async () => {
    const f = await fixture()
    setFeedLinkedInTargetAuthority(async (_actor, scope, target) => { if(scope.workspaceId!==f.workspaceId || target.destinationId) throw new Error('destination_scope_mismatch'); return {authorUrn:'urn:li:person:fixture',displayName:'Fixture'} })
    await expect(executeFeedCommands(f.actor,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata:{...metadata,destinationId:randomUUID()}}]})).rejects.toThrow('destination_scope_mismatch')
    await expect(executeFeedCommands(f.actor,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata:{...metadata,mode:'newsletter_edition',newsletter:{name:'Orchard',url:'https://www.linkedin.com/newsletters/123456789',editionTitle:'Story',coverFileId:randomUUID()}}}]})).rejects.toMatchObject({code:'file_not_available_to_draft'})
    expect((await getFeedCollaboration(f.actor)).copy!.revision).toBe(2)
  })
  it('rejects stale metadata undo instead of overwriting a newer author choice', async () => {
    const f = await fixture()
    await executeFeedCommands(f.actor,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata}]})
    await executeFeedCommands(f.actor,{expectedRevision:3,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata:{...metadata,authorKind:'organization'}}]})
    await expect(executeFeedCommands(f.actor,{expectedRevision:4,mutationId:randomUUID(),commands:[{kind:'undo',revision:3}]})).rejects.toMatchObject({code:'preimage_conflict'})
  })
})

import {completeLinkedInManual,createLinkedInPromotion,readLinkedInManualReceipt} from '../linkedin-newsletter.js'
describe('[COMP:feed/linkedin-context] real manual edition completion',()=>{
 it('persists a revision-bound operator receipt once and creates a separate unconfirmed promotion',async()=>{
  const f=await fixture()
  await executeFeedCommands(f.actor,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata:{version:1,mode:'newsletter_edition',destinationId:null,authorKind:'organization',authorDisplay:'Orchard fixture',newsletter:{name:'Field notes',url:'https://www.linkedin.com/newsletters/123',editionTitle:'Edition one',launchCommentary:'Read the edition'}}}]})
  const confirmation=await confirmFeedPost(f.actor,{expectedRevision:3,mutationId:randomUUID(),locale:'en'})
  const input={mutationId:randomUUID(),expectedRevision:3,confirmationId:confirmation.confirmation.id,url:'https://www.linkedin.com/pulse/fictional-edition'}
  await expect(completeLinkedInManual(f.actor,input)).rejects.toMatchObject({code:'public_release_required'})
  await executeFeedCommands(f.actor,{expectedRevision:3,mutationId:randomUUID(),commands:[{kind:'release',audience:'public'}]})
  const receipt=await completeLinkedInManual(f.actor,input)
  expect(await completeLinkedInManual(f.actor,{...input,mutationId:randomUUID()})).toEqual(receipt)
  expect((await readLinkedInManualReceipt(f.actor))?.verification).toBe('operator_confirmed')
  const next=await createLinkedInPromotion(f.actor,3,randomUUID()),copy=(await getFeedCollaboration({...f.actor,sessionId:next.sessionId})).copy!
  expect(next.sessionId).not.toBe(f.actor.sessionId);expect(copy.content.linkedin?.mode).toBe('link_post');expect(copy.content.article?.sourceUrl).toBe(input.url);expect(await listFeedConfirmations({...f.actor,sessionId:next.sessionId})).toEqual([])
 })
})


import {createLocalLinkedInCloud} from '../linkedin-cloud.js'
import {readLinkedInPreview} from '../linkedin-payload.js'
import type {SelfHostFeedCloudLinkStore} from '../../db/self-host-feed-cloud-link-store.js'
describe('[COMP:feed/linkedin-cloud-link] local ambiguous receipt boundary',()=>{
 it('leaves the ready draft unresolved when the cloud create outcome is unknown',async()=>{
  const f=await fixture(),destinationId=randomUUID(),reservationId=randomUUID()
  const target={destinationId,authorUrn:'urn:li:person:fixture',displayName:'Writer',authorKind:'person',canPublishAs:true,capabilities:{post:true,link_post:true,newsletter_edition:false}}
  const fetcher=vi.fn(async(input:Parameters<typeof fetch>[0])=>{const url=String(input);if(url.endsWith('/targets'))return Response.json([target]);if(url.endsWith('/reserve'))return Response.json({reservationId,state:'reserved'});throw new Error('connection reset after create')})
  const store={getWithCredential:async()=>({link:{status:'linked',assistantId:f.actor.assistantId,cloudBaseUrl:'https://cloud.example'},credential:{accessToken:'fixture'}})} as unknown as SelfHostFeedCloudLinkStore
  const cloud=createLocalLinkedInCloud({store,fetchImpl:fetcher})
  setFeedLinkedInTargetAuthority(cloud.authorize)
  await executeFeedCommands(f.actor,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata:{version:1,mode:'post',destinationId,authorKind:'person'}}]})
  const preview=await readLinkedInPreview(f.actor,3)
  await confirmFeedPost(f.actor,{expectedRevision:3,mutationId:randomUUID(),locale:'en',linkedinPreviewHash:preview.hash})
  await executeFeedCommands(f.actor,{expectedRevision:3,mutationId:randomUUID(),commands:[{kind:'release',audience:'public'}]})
  await pool.query("INSERT INTO content_planning_drafts(assistant_id,session_id,platform,draft_text,status,created_by) VALUES($1,$2,'linkedin','Approved text','ready',$3)",[f.actor.assistantId,f.actor.sessionId,f.actor.userId])
  await expect(cloud.publish(f.actor,preview.hash)).rejects.toMatchObject({code:'delivery_ambiguous'})
  expect((await pool.query('SELECT status,posted_permalink FROM content_planning_drafts WHERE session_id=$1',[f.actor.sessionId])).rows[0]).toEqual({status:'ready',posted_permalink:null})
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/publish'))).toHaveLength(1)
 })
})
