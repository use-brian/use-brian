/** Local canonical approval and bounded authenticated Cloud Link transfer. */
import {withFeedTransaction,readFeedCopy,requireFeedComposition,assertFeedFiles,FeedCollaborationError,type FeedActor,type FeedScope} from '../db/feed-collaboration-store.js'
import {buildLinkedInPayload,linkedinPayloadHash} from './linkedin-payload.js'
import {readFeedConfirmation,isFeedConfirmationRevoked} from './confirmation.js'
import type {SelfHostFeedCloudLinkStore} from '../db/self-host-feed-cloud-link-store.js'
import type {FeedLinkedInContext} from '@use-brian/shared'
export function createLocalLinkedInCloud(options:{store:SelfHostFeedCloudLinkStore;fetchImpl?:typeof fetch}){
 const fetcher=options.fetchImpl??fetch
 async function request(workspaceId:string,assistantId:string,path:string,init:RequestInit={}){
  const record=await options.store.getWithCredential(workspaceId)
  if(!record?.credential.accessToken||record.link.status!=='linked'||record.link.assistantId!==assistantId)throw new FeedCollaborationError(409,'cloud_link_unavailable')
  let response:Response
  try{response=await fetcher(`${record.link.cloudBaseUrl}/api/self-host-feed/gateway/linkedin${path}`,{...init,headers:{...init.headers,authorization:`Bearer ${record.credential.accessToken}`},redirect:'error',signal:AbortSignal.timeout(120000)})}catch{throw new FeedCollaborationError(409,'delivery_ambiguous')}
  const data=await response.json().catch(()=>({})) as Record<string,unknown>
  if(response.status===402)await options.store.markPlanRequired(workspaceId)
  if(!response.ok)throw new FeedCollaborationError(response.status,typeof data.code==='string'?data.code:'cloud_unavailable')
  return data
 }
 async function targets(actor:FeedActor,scope:FeedScope){return request(scope.workspaceId,actor.assistantId,'/targets') as unknown as Promise<Array<{destinationId:string;authorKind:'person'|'organization';authorUrn:string;displayName:string;connectionStatus:string;canPublishAs:boolean;capabilities:{post:boolean;link_post:boolean;newsletter_edition:false}}>>}
 async function prepareActor(actor:FeedActor,previewHash:string){return withFeedTransaction(actor,async(client,scope)=>{
   const copy=await readFeedCopy(client,actor.sessionId);if(!copy)throw new FeedCollaborationError(404,'draft_not_found');const content=requireFeedComposition(copy.content)
   const row=(await client.query('SELECT id FROM feed_post_confirmations WHERE session_id=$1 AND source_revision=$2',[actor.sessionId,copy.revision])).rows[0]
   if(!row)throw new FeedCollaborationError(409,'confirmation_required');const confirmation=await readFeedConfirmation(client,actor.sessionId,row.id)
   if(await isFeedConfirmationRevoked(client,row.id))throw new FeedCollaborationError(409,'confirmation_required')
   const release=(await client.query('SELECT public_release FROM feed_post_working_copies WHERE session_id=$1',[actor.sessionId])).rows[0]?.public_release
   if(release?.revision!==copy.revision||release.audience!=='public')throw new FeedCollaborationError(409,'public_release_required')
   await assertFeedFiles(client,actor,scope,content.composition,[],content.linkedin)
   const prepared=await buildLinkedInPayload(actor,scope,content,copy.revision)
   if(!confirmation.projection.linkedinPayload||linkedinPayloadHash(confirmation.projection.linkedinPayload)!==previewHash||prepared.hash!==previewHash||!content.linkedin?.destinationId)throw new FeedCollaborationError(409,'linkedin_preview_changed')
   return {...prepared,scope,body:{sessionId:actor.sessionId,confirmationId:confirmation.id,expectedRevision:copy.revision,destinationId:content.linkedin.destinationId,previewHash,idempotencyKey:`draft:${actor.sessionId}:${copy.revision}`,publicReleaseRevision:copy.revision,payload:prepared.payload}}
  })}
 return {targets,async status(actor:FeedActor){return withFeedTransaction(actor,async(_db,scope)=>request(scope.workspaceId,actor.assistantId,`/deliveries?sessionId=${actor.sessionId}`),false)},async reconcile(actor:FeedActor,input:{expectedRevision:number;deliveryId:string;url:string}){const hash=await withFeedTransaction(actor,async db=>{const copy=await readFeedCopy(db,actor.sessionId);if(copy?.revision!==input.expectedRevision)throw new FeedCollaborationError(409,'revision_conflict');const row=(await db.query('SELECT projection FROM feed_post_confirmations WHERE session_id=$1 AND source_revision=$2',[actor.sessionId,copy.revision])).rows[0];if(!row?.projection?.linkedinPayload)throw new FeedCollaborationError(409,'confirmation_required');return linkedinPayloadHash(row.projection.linkedinPayload)},false);const approved=await prepareActor(actor,hash);const receipt=await request(approved.scope.workspaceId,actor.assistantId,`/${encodeURIComponent(input.deliveryId)}/reconcile`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({approval:approved.body,url:input.url})});if(typeof receipt.permalink!=='string')throw new FeedCollaborationError(409,'delivery_ambiguous');await withFeedTransaction(actor,async db=>{const copy=await readFeedCopy(db,actor.sessionId);if(copy?.revision!==input.expectedRevision)throw new FeedCollaborationError(409,'revision_conflict');await db.query("UPDATE content_planning_drafts SET status='posted',posted_permalink=$3,resolved_by=$4,resolved_at=now(),updated_at=now() WHERE session_id=$1 AND assistant_id=$2 AND status='ready' AND (format_data#>>'{feedCanonical,revision}')::int=$5",[actor.sessionId,actor.assistantId,receipt.permalink,actor.userId,input.expectedRevision])});return receipt},manage(workspaceId:string,assistantId:string,body:unknown,alias?:string){return request(workspaceId,assistantId,alias?`/targets/${encodeURIComponent(alias)}`:'/targets',{method:alias?'DELETE':'POST',headers:{'content-type':'application/json'},body:alias?undefined:JSON.stringify(body)})},async authorize(actor:FeedActor,scope:FeedScope,context:FeedLinkedInContext){const target=(await targets(actor,scope)).find(d=>d.destinationId===context.destinationId);if(!target||!target.canPublishAs||target.authorKind!==context.authorKind)throw new FeedCollaborationError(403,'linkedin_destination_unavailable');return target},
 async publish(actor:FeedActor,previewHash:string){
  const prepare=()=>prepareActor(actor,previewHash)
  const approved=await prepare(),json={headers:{'content-type':'application/json'},body:JSON.stringify(approved.body),method:'POST'}
  const reserved=await request(approved.scope.workspaceId,actor.assistantId,'/reserve',json)
  if(typeof reserved.reservationId!=='string')throw new FeedCollaborationError(409,'delivery_ambiguous')
  // A replay of a completed delivery needs no further asset transfer.
  if(reserved.state==='reserved')for(const asset of approved.payload.assets){await prepare();await request(approved.scope.workspaceId,actor.assistantId,`/${reserved.reservationId}/assets/${asset.fileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:new Uint8Array(approved.bytes.get(asset.fileId)!)})}
  await prepare()
  const receipt=await request(approved.scope.workspaceId,actor.assistantId,`/${reserved.reservationId}/publish`,json)
  if(typeof receipt.postId!=='string'||typeof receipt.permalink!=='string')throw new FeedCollaborationError(409,'delivery_ambiguous')
  return {status:'posted' as const,permalink:receipt.permalink}
 }}
}
