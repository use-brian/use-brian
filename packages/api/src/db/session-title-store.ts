/** Canonical native titles. [COMP:api/application-persistence] */
import {z} from 'zod'
import {isDeepStrictEqual} from 'node:util'
import {bindScopeSources,boundScopeSources,DerivedScopeError,type DerivedWriteEvidence,type SessionContextAuthority} from '@use-brian/core'
import {readExternalSourceAncestors} from '../application-platform/external-source-ancestry.js'
import type {ScopeSource} from '@use-brian/core'
import {getPool} from './client.js'
import {readSessionContextRevisions,writeSessionContextRevision,readRetainedContextFrame} from './session-context-revisions.js'
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


/** Optional closed native group. Null retains every original individual read.
 * The existing retained transaction still validates caller/scalar evidence. */
export async function readSessionTitlesGrouped(input:readonly {sessionId:string;revisionId:string}[],authority:SessionContextAuthority):Promise<Map<string,SessionTitle>|null>{
 const heads=structuredClone(input),workspaceId=authority.execution.security.access.workspaceId
 if(heads.length<2||heads.length>50||new Set(heads.map(head=>head.sessionId)).size!==heads.length)return null
 await authority.execution.security.authority.assertCurrent()
 const discovered=(await getPool().query<{sessionId:string;revisionId:string;source:ScopeSource&{held?:boolean}}>(`SELECT h.session_id AS "sessionId",h.scope_revision_id AS "revisionId",
  read_scope_source(h.workspace_id,'session_context_revision',h.scope_revision_id) AS source
  FROM session_title_heads h JOIN unnest($2::uuid[],$3::uuid[]) wanted(session_id,revision_id)
   ON wanted.session_id=h.session_id AND wanted.revision_id=h.scope_revision_id WHERE h.workspace_id=$1`,
 [workspaceId,heads.map(head=>head.sessionId),heads.map(head=>head.revisionId)])).rows
 if(discovered.length!==heads.length||discovered.some(row=>!row.source||row.source.held!==false||row.source.resourceKind!=='session_context_revision'||row.source.resourceId!==row.revisionId||row.source.version!=='1'))return null
 const sources:ScopeSource[]=discovered.map(({source})=>({workspaceId:source.workspaceId,userId:source.userId,assistantId:source.assistantId,
  sensitivity:source.sensitivity,compartments:source.compartments,projectIds:source.projectIds,resourceKind:source.resourceKind,resourceId:source.resourceId,version:source.version}))
 if((await readExternalSourceAncestors(workspaceId,sources)).length)return null
 const raw=await readRetainedContextFrame(authority,sources,async client=>(await client.query<{value:unknown}>(
  'SELECT read_native_personal_title_group($1,$2,$3) AS value',[workspaceId,heads.map(head=>head.sessionId),heads.map(head=>head.revisionId)])).rows[0]?.value)
 if(raw===null)return null
 const values=z.array(z.object({sessionId:z.string().uuid(),revisionId:z.string().uuid(),content:payload,source:z.unknown()}).strict()).parse(raw)
 if(values.length!==heads.length)return null
 const result=new Map<string,SessionTitle>()
 for(const [index,value] of values.entries()){
  const expected=heads[index],source=sources.find(source=>source.resourceId===expected.revisionId)
  if(!source||value.sessionId!==expected.sessionId||value.revisionId!==expected.revisionId||!isDeepStrictEqual(value.source,source))changed()
  const title=bindScopeSources({...value.content,revisionId:value.revisionId},[source])
  result.set(value.sessionId,title)
 }
 authority.accumulator.note({sources:values.flatMap(value=>boundScopeSources(result.get(value.sessionId)!))})
 return result
}
