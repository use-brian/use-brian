/** Canonical generated annotations, separate from authored bodies. [COMP:api/session-message-annotations] */
import { z } from 'zod'
import { bindScopeSources,boundScopeSources,DerivedScopeError,type SessionContextAuthority,type TopicClassification } from '@use-brian/core'
import { readSessionContextRevisions,writeSessionContextRevision,type SessionContextRevision } from './session-context-revisions.js'
const payload=z.object({topicLabel:z.string().min(1).max(200),topicConfidence:z.number().finite().min(0).max(1),replyToText:z.string().max(8000).nullable()}).strict()
export type SessionMessageAnnotation={messageId:string;sessionId:string;revisionId:string;topicLabel:string;topicConfidence:number;replyToText:string|null}
function record(row:SessionContextRevision):SessionMessageAnnotation {
 return bindScopeSources({messageId:row.parentId,sessionId:row.sessionId,revisionId:row.id,...payload.parse(row.content)},boundScopeSources(row))
}
/** The native message is admitted by the canonical transaction, never by caller metadata. */
export async function writeSessionMessageAnnotation(input:{sessionId:string;messageId:string;classification:TopicClassification;replyToText:string|null;
 authority?:SessionContextAuthority;expectedRevision?:string}):Promise<SessionMessageAnnotation|null> {
 const sources=boundScopeSources(input.classification)
 if(!input.authority || !sources.length)throw new DerivedScopeError('scope_evidence_missing')
 const marker='[truncated]',reply=input.replyToText
 const content=payload.parse({topicLabel:input.classification.topic_label,topicConfidence:input.classification.confidence,
  replyToText:reply && reply.length>8000 ? reply.slice(0,8000-marker.length)+marker : reply})
 const row=await writeSessionContextRevision({sessionId:input.sessionId,parentId:input.messageId,kind:'message_annotation',content,
  authority:input.authority,expectedRevision:input.expectedRevision,derivation:{producer:'session:message-annotation',sources}})
 return row ? record(row) : null
}
/** Historical scalar fields are never an annotation receipt. */
export async function readSessionMessageAnnotation(sessionId:string,messageId:string,authority?:SessionContextAuthority):Promise<SessionMessageAnnotation|null> {
 const rows=await readSessionContextRevisions(sessionId,'message_annotation',authority,{parentId:messageId})
 return rows[0] ? record(rows[0]) : null
}
