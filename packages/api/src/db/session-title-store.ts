/** Canonical native titles. [COMP:api/application-persistence] */
import {z} from 'zod'
import {bindScopeSources,boundScopeSources,DerivedScopeError,type DerivedWriteEvidence,type SessionContextAuthority} from '@use-brian/core'
import {getPool} from './client.js'
import {readSessionContextRevisions,writeSessionContextRevision} from './session-context-revisions.js'
const payload=z.object({title:z.string().trim().min(1).max(200),manual:z.boolean()}).strict()
export type SessionTitle=z.infer<typeof payload>&{revisionId:string}
function changed():never{throw new DerivedScopeError('scope_source_changed')}
/** CAS metadata only; a revision ID never admits its title bytes. */
export async function sessionTitleHead(sessionId:string,authority:SessionContextAuthority):Promise<string|null>{
 const {execution}=authority
 if(execution.lifecycle.sessionId!==sessionId||execution.lifecycle.sessionPersisted===false)changed()
 await execution.security.authority.assertCurrent()
 const id=(await getPool().query<{id:string}>('SELECT scope_revision_id AS id FROM session_title_heads WHERE workspace_id=$1 AND session_id=$2 AND session_recording_read_allowed(session_id)',
  [execution.security.access.workspaceId,sessionId])).rows[0]?.id??null
 await execution.security.authority.assertCurrent();return id
}
/** Only the current immutable head is considered; legacy scalars stay held. */
export async function readSessionTitle(sessionId:string,authority:SessionContextAuthority):Promise<SessionTitle|null>{
 if(authority.execution.lifecycle.sessionId!==sessionId)changed()
 const rows=await readSessionContextRevisions(sessionId,'session_title',authority)
 if(rows.length>1)changed()
 const row=rows[0];if(!row)return null
 const result=bindScopeSources({...payload.parse(row.content),revisionId:row.id},boundScopeSources(row))
 authority.accumulator.note({sources:boundScopeSources(result)})
 return result
}
/** Original semantic command and evidence are pinned before any async work. */
export async function publishSessionTitle(input:{sessionId:string;title:string;manual:boolean;expectedRevision:string|null;
 authority:SessionContextAuthority;derivation:DerivedWriteEvidence}):Promise<SessionTitle|null>{
 const {authority}=input,command=structuredClone({sessionId:input.sessionId,title:input.title,manual:input.manual,
  expectedRevision:input.expectedRevision,derivation:input.derivation})
 const content=payload.parse({title:command.title,manual:command.manual})
 const row=await writeSessionContextRevision({sessionId:command.sessionId,kind:'session_title',content,
  expectedRevision:command.expectedRevision??undefined,authority,derivation:command.derivation})
 return row?bindScopeSources({...content,revisionId:row.id},boundScopeSources(row)):null
}
