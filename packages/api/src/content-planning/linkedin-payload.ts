import { assertFeedLinkedInDestination } from './linkedin-authority.js'
/** Byte-backed approval projection. No provider transport lives in this OSS module. */
import { createHash } from 'node:crypto'
import { prepareLinkedInImage, type FilesApi } from '@use-brian/core'
import { feedLinkedInFileIds, type FeedLinkedInProjection } from '@use-brian/shared'
import { canonicalFeedValue, projectFeedLinkedIn } from '@use-brian/doc-model'
import { assertFeedFiles, readFeedCopy, requireFeedComposition, withFeedTransaction, FeedCollaborationError, type FeedActor, type FeedScope, type StructuredFeedContent } from '../db/feed-collaboration-store.js'
export type LinkedInPayload={version:1;revision:number;authorUrn:string|null;projection:FeedLinkedInProjection;assets:Array<{fileId:string;sourceHash:string;hash:string;mimeType:string;size:number;derivativeVersion:1}>}
let fileService:FilesApi|undefined
export function configureFeedLinkedInFiles(files:FilesApi|undefined){fileService=files}
export const linkedinPayloadHash=(value:LinkedInPayload)=>createHash('sha256').update(canonicalFeedValue(value)).digest('hex')
export async function buildLinkedInPayload(actor:FeedActor,scope:FeedScope,content:StructuredFeedContent,revision:number,files=fileService){
  const projection=projectFeedLinkedIn(content.composition,content.linkedin,content)
  if(projection.blockers.length)throw new FeedCollaborationError(409,projection.blockers[0]!.code)
  const ids=[...new Set([...projection.media.map(m=>m.fileId),...(projection.mode==='newsletter_edition'?feedLinkedInFileIds(content.linkedin):projection.article?.thumbnailFileId?[projection.article.thumbnailFileId]:[])])]
  const assets:LinkedInPayload['assets']=[];const bytes=new Map<string,Buffer>();let total=0
  for(const fileId of ids){
    if(!files)throw new FeedCollaborationError(503,'image_storage_unavailable')
    const result=await files.readBytes({workspaceId:scope.workspaceId,userId:actor.userId,assistantId:actor.assistantId,assistantKind:'app',clearance:scope.memberClearance as 'public'|'internal'|'confidential',compartments:scope.memberCompartments},fileId)
    if(!result.ok)throw new FeedCollaborationError(403,'file_unavailable')
    total+=result.value.bytes.length;if(total>100*1024*1024)throw new FeedCollaborationError(413,'article_assets_too_large')
    let prepared:Awaited<ReturnType<typeof prepareLinkedInImage>>
    try{prepared=await prepareLinkedInImage(result.value.bytes,result.value.file.mime)}catch{throw new FeedCollaborationError(422,'image_upload_failed')}
    if([...bytes.values()].reduce((n,b)=>n+b.length,0)+prepared.bytes.length>100*1024*1024)throw new FeedCollaborationError(413,'article_assets_too_large')
    assets.push({fileId,sourceHash:prepared.sourceHash,hash:prepared.hash,mimeType:prepared.mimeType,size:prepared.bytes.length,derivativeVersion:1});bytes.set(fileId,prepared.bytes)
  }
  const target=content.linkedin?.destinationId ? await assertFeedLinkedInDestination(actor,scope,content.linkedin) : null
  const payload:LinkedInPayload={version:1,revision,authorUrn:target?.authorUrn??null,projection,assets}
  return {payload,hash:linkedinPayloadHash(payload),bytes}
}
export async function readLinkedInPreview(actor:FeedActor,expectedRevision:number){return withFeedTransaction(actor,async(client,scope)=>{
  const copy=await readFeedCopy(client,actor.sessionId);if(!copy||copy.revision!==expectedRevision)throw new FeedCollaborationError(409,'revision_conflict')
  const content=requireFeedComposition(copy.content);await assertFeedFiles(client,actor,scope,content.composition,[],content.linkedin)
  const result=await buildLinkedInPayload(actor,scope,content,copy.revision)
  return {payload:result.payload,hash:result.hash}
},false)}
