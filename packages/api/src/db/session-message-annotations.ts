/** Canonical generated annotations, separate from authored bodies. [COMP:api/session-message-annotations] */
import { z } from 'zod'
import { bindScopeSources,boundScopeSources,DerivedScopeError,type SessionContextAuthority,type TopicClassification } from '@use-brian/core'
import { readSessionContextRevisions,writeSessionContextRevision,prepareSessionContextRevision,type SessionContextRevision } from './session-context-revisions.js'
const payload=z.object({topicLabel:z.string().min(1).max(200),topicConfidence:z.number().finite().min(0).max(1),replyToText:z.string().max(8000).nullable()}).strict()
export type SessionMessageAnnotation={messageId:string;sessionId:string;revisionId:string;topicLabel:string;topicConfidence:number;replyToText:string|null}
function record(row:SessionContextRevision):SessionMessageAnnotation {
 return bindScopeSources({messageId:row.parentId,sessionId:row.sessionId,revisionId:row.id,...payload.parse(row.content)},boundScopeSources(row))
}
type AnnotationInput={sessionId:string;messageId:string;classification:TopicClassification;replyToText:string|null;
 authority?:SessionContextAuthority;expectedRevision?:string}
function annotationCommand(input:AnnotationInput){
 const sources=boundScopeSources(input.classification)
 if(!input.authority || !sources.length)throw new DerivedScopeError('scope_evidence_missing')
 const marker='[truncated]',reply=input.replyToText
 const content=payload.parse({topicLabel:input.classification.topic_label,topicConfidence:input.classification.confidence,
  replyToText:reply && reply.length>8000 ? reply.slice(0,8000-marker.length)+marker : reply})
 return{sessionId:input.sessionId,parentId:input.messageId,kind:'message_annotation' as const,content,
  authority:input.authority,expectedRevision:input.expectedRevision,derivation:{producer:'session:message-annotation',sources}}
}
/** The command has no write/allow effect until its actual native publication frame. */
export function prepareSessionMessageAnnotation(input:AnnotationInput):Promise<object>{
 return prepareSessionContextRevision(annotationCommand(input))
}
/** The native message is admitted by the canonical transaction, never by caller metadata. */
export async function writeSessionMessageAnnotation(input:AnnotationInput):Promise<SessionMessageAnnotation|null> {
 const row=await writeSessionContextRevision(annotationCommand(input))
 return row ? record(row) : null
}
/** Historical scalar fields are never an annotation receipt. */
export async function readSessionMessageAnnotation(sessionId:string,messageId:string,authority?:SessionContextAuthority):Promise<SessionMessageAnnotation|null> {
 const rows=await readSessionContextRevisions(sessionId,'message_annotation',authority,{parentId:messageId})
 return rows[0] ? record(rows[0]) : null
}
