/** Canonical operator-confirmed publication. Preparation never creates a receipt. */
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type pg from 'pg'
import {canonicalFeedValue,projectFeedLinkedIn} from '@use-brian/doc-model'
import {withFeedTransaction,readFeedCopy,requireFeedComposition,assertFeedFiles,FeedCollaborationError,type FeedActor} from '../db/feed-collaboration-store.js'
import {readFeedConfirmation,isFeedConfirmationRevoked} from './confirmation.js'
import {appendDecisionEvent} from '../db/decision-event-store.js'
import {notifyWorkspaceChange} from '../brain-stream/notify.js'
export function linkedInPublishedUrl(raw:string){try{const url=new URL(raw);if(url.protocol!=='https:'||!['www.linkedin.com','linkedin.com'].includes(url.hostname)||url.port||url.username||url.password||!/^\/(pulse\/[^/]+\/?|feed\/update\/urn:li:(share|ugcPost):\d+\/?)$/.test(url.pathname))throw new Error();url.search='';url.hash='';return url.toString()}catch{throw new FeedCollaborationError(400,'linkedin_published_url_required')}}
export const linkedinManualCommand=z.object({mutationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),confirmationId:z.string().uuid(),url:z.string().max(2048)}).strict()
export type LinkedInManualReceipt={id:string;revision:number;confirmationId:string;url:string;author:unknown;actorUserId:string;at:string;verification:'operator_confirmed'}
let sink:((client:pg.PoolClient,actor:FeedActor,receipt:LinkedInManualReceipt)=>Promise<void>)|undefined
export function setLinkedInManualSink(port:NonNullable<typeof sink>){sink=port}
export async function readLinkedInManualReceipt(actor:FeedActor){return withFeedTransaction(actor,async client=>(await client.query("SELECT receipt FROM feed_linkedin_manual_receipts WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",[actor.sessionId])).rows[0]?.receipt as LinkedInManualReceipt|undefined,false)}
export async function completeLinkedInManual(actor:FeedActor,raw:z.infer<typeof linkedinManualCommand>){
 const input=linkedinManualCommand.parse(raw),url=linkedInPublishedUrl(input.url)
 if(actor.kind!=='user')throw new FeedCollaborationError(403,'member_confirmation_required')
 const result=await withFeedTransaction(actor,async(client,scope)=>{
  const copy=await readFeedCopy(client,actor.sessionId);if(!copy||copy.revision!==input.expectedRevision)throw new FeedCollaborationError(409,'revision_conflict')
  const content=requireFeedComposition(copy.content),projection=projectFeedLinkedIn(content.composition,content.linkedin,content)
  if(!['newsletter_edition','legacy_article'].includes(projection.mode))throw new FeedCollaborationError(409,'manual_edition_required')
  if(projection.blockers.length)throw new FeedCollaborationError(409,projection.blockers[0]!.code)
  if(!new URL(url).pathname.startsWith('/pulse/'))throw new FeedCollaborationError(400,'linkedin_edition_url_required')
  await assertFeedFiles(client,actor,scope,content.composition,[],content.linkedin)
  const confirmed=await readFeedConfirmation(client,actor.sessionId,input.confirmationId)
  if(confirmed.revision!==copy.revision||canonicalFeedValue(confirmed.content)!==canonicalFeedValue(content)||await isFeedConfirmationRevoked(client,confirmed.id))throw new FeedCollaborationError(409,'confirmation_required')
  const release=(await client.query('SELECT public_release FROM feed_post_working_copies WHERE session_id=$1',[actor.sessionId])).rows[0]?.public_release
  if(release?.revision!==copy.revision||release.audience!=='public')throw new FeedCollaborationError(409,'public_release_required')
  const existing=(await client.query("SELECT receipt FROM feed_linkedin_manual_receipts WHERE session_id=$1 AND source_revision=$2",[actor.sessionId,String(copy.revision)])).rows[0]?.receipt as LinkedInManualReceipt|undefined
  if(existing){if(existing.url!==url)throw new FeedCollaborationError(409,'manual_receipt_conflict');return {receipt:existing,workspaceId:scope.workspaceId}}
  const receipt:LinkedInManualReceipt={id:input.mutationId,revision:copy.revision,confirmationId:confirmed.id,url,author:content.linkedin??{authorKind:'person',authorDisplay:content.title},actorUserId:actor.userId,at:new Date().toISOString(),verification:'operator_confirmed'}
  await client.query('INSERT INTO feed_linkedin_manual_receipts(id,workspace_id,assistant_id,session_id,source_revision,confirmation_id,actor_user_id,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[receipt.id,scope.workspaceId,actor.assistantId,actor.sessionId,copy.revision,confirmed.id,actor.userId,JSON.stringify(receipt)])
  await appendDecisionEvent({idempotencyKey:`feed:linkedin-manual:${actor.sessionId}:${copy.revision}`,workspaceId:scope.workspaceId,actorUserId:actor.userId,assistantId:actor.assistantId,sessionId:actor.sessionId,sourceKind:'feed_confirmation',sourceId:confirmed.id,declaredScope:'instance',visibility:'workspace',sensitivity:'internal',eventKind:'feed.linkedin_manual_published',payload:{receiptId:receipt.id,revision:copy.revision,confirmationId:confirmed.id}},client)
  await client.query("UPDATE content_planning_drafts SET status='posted',posted_permalink=$3,resolved_by=$4,resolved_at=now(),updated_at=now() WHERE session_id=$1 AND assistant_id=$2 AND status='ready' AND (format_data#>>'{feedCanonical,revision}')::int=$5",[actor.sessionId,actor.assistantId,url,actor.userId,copy.revision])
  if(sink)await sink(client,actor,receipt)
  return {receipt,workspaceId:scope.workspaceId}
 })
 notifyWorkspaceChange(result.workspaceId,'session','update',actor.sessionId);return result.receipt
}

/** Explicit follow-up creates a separate canonical draft, with its own future approval. */
export async function createLinkedInPromotion(actor:FeedActor,expectedRevision:number,sessionId:string){
 const receipt=await readLinkedInManualReceipt(actor)
 if(!receipt||receipt.revision!==expectedRevision)throw new FeedCollaborationError(409,'manual_receipt_required')
 const content=await withFeedTransaction(actor,async client=>{const copy=await readFeedCopy(client,actor.sessionId);if(copy?.revision!==expectedRevision)throw new FeedCollaborationError(409,'revision_conflict');return requireFeedComposition(copy.content)},false)
 const {postWorkingCopiesStore}=await import('../db/post-working-copies.js')
 const {executeFeedCommands}=await import('../db/feed-collaboration-store.js')
 const title=content.linkedin?.newsletter?.editionTitle??content.title
 await postWorkingCopiesStore.put(actor.assistantId,sessionId,actor.userId,{revision:0,mutationId:randomUUID(),create:{platform:'linkedin'},content:{title,privateBrief:'',text:content.linkedin?.newsletter?.launchCommentary??title,postFormat:'article',threadSegments:[],article:{sourceUrl:receipt.url,title,description:''},media:[],goalId:content.goalId}})
 const next={...actor,sessionId}
 await executeFeedCommands(next,{expectedRevision:1,mutationId:randomUUID(),commands:[{kind:'upgrade'}]})
 await executeFeedCommands(next,{expectedRevision:2,mutationId:randomUUID(),commands:[{kind:'linkedin',metadata:{version:1,mode:'link_post',destinationId:content.linkedin?.destinationId??null,authorKind:content.linkedin?.authorKind??'person',authorDisplay:content.linkedin?.authorDisplay}}]})
 return {sessionId}
}
