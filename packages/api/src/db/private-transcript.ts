/** Same-owner conversation evidence, independent of upstream facts. [COMP:api/private-transcript] */
import {z} from 'zod'
import {bindScopeSources,boundScopeSources,ContextScopeAccumulator,DerivedScopeError,type ScopeSource,type SessionContextAuthority,type ExecutionContext} from '@use-brian/core'
import {applyRLSGucs,getAppPool,runWithAgentAccess,rollbackAndRelease} from './client.js'
import {privateHistoryText} from './session-legacy-history.js'
import type {SessionMessage} from './sessions.js'

export const PRIVATE_TRANSCRIPT_INSTRUCTION = 'Prior conversation turns record what you and the user said. Remember those choices, requests and statements. An earlier answer is not a fresh verification of external facts; check current sources when the present task needs current information. Preserve this distinction when summarizing.'

const capture=z.object({source:z.object({workspaceId:z.string().uuid(),userId:z.string().uuid(),assistantId:z.null(),
 resourceKind:z.literal('private_transcript'),resourceId:z.string().uuid(),version:z.literal('1'),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict(),
 rows:z.array(z.object({id:z.string().uuid(),sequence:z.number().int(),role:z.enum(['user','assistant']),timestamp:z.string(),
 available:z.literal(true),content:z.unknown()}))})

const nativeCredentials=new WeakMap<ExecutionContext,{userId:string;sessionId:string;authVersion:number}>()
/** Called by the canonical execution-context factory with middleware credentials. */
export function bindPrivateTranscriptCredential(execution:ExecutionContext,credential:{userId:string;sessionId:string;authVersion:number}):void{
 if(credential.userId!==execution.security.access.userId)throw new DerivedScopeError('scope_source_changed')
 nativeCredentials.set(execution,Object.freeze({...credential}))
}

/** Automatic repair for a native owner's next turn in a frozen legacy chat. */
export async function resumePrivateLegacySession(workspaceId:string,sessionId:string,credential:{userId:string;sessionId:string;authVersion:number}):Promise<boolean>{
 const client=await getAppPool().connect()
 try{
  await client.query('BEGIN')
  await applyRLSGucs(client,credential.userId)
  const resumed=(await client.query<{resumed:boolean}>('SELECT resume_private_legacy_session($1,$2,$3,$4) AS resumed',
   [workspaceId,sessionId,credential.sessionId,credential.authVersion])).rows[0]?.resumed===true
  await client.query('COMMIT')
  return resumed
 }catch(error){await client.query('ROLLBACK');throw error}
 finally{await rollbackAndRelease(client)}
}

/** Only a host native session lease can select this purpose; never a client flag. */
export async function readPrivateTranscript(authority:SessionContextAuthority,sessionId:string,throughSequence:number):Promise<SessionMessage[]|null>{
 const {execution,accumulator}=authority,{identity,security,lifecycle}=execution
 const credential=nativeCredentials.get(execution)
 if(identity.kind!=='attended'||identity.principal.kind!=='workspace_member'||identity.principal.authenticationKind!=='native_session'
  ||lifecycle.sessionId!==sessionId||lifecycle.channelType!=='web'||security.access.sharedAudience||security.access.applicationBound
  ||security.access.systemRead||execution.surface.systemRead||execution.surface.clientSelfMemory
  ||!credential||credential.userId!==security.access.userId)return null
 const workspaceId=security.access.workspaceId
 await security.authority.assertCurrent()
 return runWithAgentAccess(security.access,async()=>{
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN')
   await applyRLSGucs(client,security.access.userId)
   await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
   const raw=(await client.query<{value:unknown}>('SELECT capture_private_transcript($1,$2,$3,$4,$5) AS value',
    [workspaceId,sessionId,credential.sessionId,credential.authVersion,throughSequence])).rows[0]?.value
   if(raw===null){await client.query('ROLLBACK');return null}
   const parsed=capture.parse(raw),source:ScopeSource=parsed.source
   if(source.workspaceId!==workspaceId||source.userId!==security.access.userId)throw new DerivedScopeError('scope_source_changed')
   const rows=parsed.rows.flatMap(row=>{
    const text=privateHistoryText(row.content,row.role)
    return text?[bindScopeSources<SessionMessage>({id:row.id,sessionId,role:row.role,content:[{type:'text',text}],
     sequenceNum:row.sequence,createdAt:new Date(row.timestamp),replyToText:null,topicLabel:null,topicConfidence:null,
     channelMessageId:null,senderUserId:row.role==='user'?source.userId:null,senderAssistantId:null,attachments:[]},[source])]:[]
   })
   await security.authority.assertCurrent()
   await client.query('COMMIT')
   accumulator.note({sources:[source]})
   return bindScopeSources(rows,[source])
  }catch(error){await client.query('ROLLBACK');throw error}
  finally{await rollbackAndRelease(client)}
 })
}

/** Keep current tool/attachment context; fill historical dialogue by stored identity. */
export async function mergePrivateTranscript(authority:SessionContextAuthority,sessionId:string,rows:SessionMessage[],through:number):Promise<SessionMessage[]>{
 const captureAuthority={execution:authority.execution,accumulator:new ContextScopeAccumulator()}
 const transcript=await readPrivateTranscript(captureAuthority,sessionId,through)
 if(!transcript)return rows
 const currentIds=new Set(rows.map(row=>row.id))
 if(transcript.every(row=>currentIds.has(row.id)))return rows
 authority.accumulator.note(captureAuthority.accumulator.evidence)
 const merged=new Map(transcript.map(row=>[row.id,row]))
 for(const row of rows)merged.set(row.id,row)
 return bindScopeSources([...merged.values()].sort((a,b)=>a.sequenceNum-b.sequenceNum),
  [...boundScopeSources(rows),...boundScopeSources(transcript)])
}
