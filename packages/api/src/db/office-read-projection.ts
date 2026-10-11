/** Consistent, revalidated Office metadata reads. [COMP:api/office-routes] */
import {AsyncLocalStorage} from 'node:async_hooks'
import {currentAgentAccess} from './agent-access-context.js'
import {getAppPool,applyRLSGucs,rollbackAndRelease} from './client.js'
import type {OfficeDbQuery} from './office-artifacts.js'

type ReadContext={userId:string;active:boolean;ceiling:string|undefined;query:OfficeDbQuery}
const contexts=new AsyncLocalStorage<ReadContext>()

/** Only the existing Office store/query seam participates in this read snapshot. */
export function officeProjectionQuery(userId:string):OfficeDbQuery|undefined {
  const context=contexts.getStore()
  if(!context)return undefined
  if(!context.active||context.userId!==userId||context.ceiling!==JSON.stringify(currentAgentAccess()))throw new Error('office_projection_context_mismatch')
  return context.query
}

const requestOrigin=Symbol('office-projection-request-origin')
export type OfficeMetadataReply={workspaceId?:string;body:unknown;status?:number;validForMs?:number;
  readonly [requestOrigin]?:{started:number;allowance:number}}

/** Metadata HTTP clients subtract their complete request duration from this
 * allowance. Internal/media consumers retain the existing remaining TTL. */
export function officeProjectionHeaderLifetime(reply:OfficeMetadataReply):number|undefined {
  const origin=reply[requestOrigin]
  if(!origin)return reply.validForMs
  const elapsed=performance.now()-origin.started
  return Number.isFinite(elapsed)&&elapsed>=0&&elapsed<origin.allowance?origin.allowance:0
}

export async function readOfficeProjection(userId:string,read:()=>Promise<OfficeMetadataReply>):Promise<OfficeMetadataReply> {
  if(contexts.getStore())throw new Error('office_projection_nested')
  const started=performance.now(),client=await getAppPool().connect()
  const statements:Array<{sql:string;params:unknown[];rows:string}>=[]
  const context:ReadContext={userId,active:true,ceiling:JSON.stringify(currentAgentAccess()),query:async<T>(actor:string,sql:string,params:unknown[])=>{
    if(!context.active||actor!==userId||context.ceiling!==JSON.stringify(currentAgentAccess()))throw new Error('office_projection_context_mismatch')
    const result=await client.query(sql,params)
    statements.push({sql,params:structuredClone(params),rows:JSON.stringify(result.rows)})
    return {rows:result.rows as T[]}
  }}
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await applyRLSGucs(client,userId)
    const reply=await contexts.run(context,read)
    context.active=false
    await client.query('COMMIT')
    if((reply.status??200)>=400)return reply
    if(!reply.workspaceId||!statements.length)throw new Error('office_projection_unbound')
    // Recheck the actual authorized rows, not merely a workspace policy counter.
    // Root/file/member changes can alter visibility without changing that counter.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await applyRLSGucs(client,userId)
    for(const statement of statements){
      const current=await client.query(statement.sql,statement.params)
      if(JSON.stringify(current.rows)!==statement.rows)return {status:409,body:{error:'office_projection_changed'}}
    }
    // SQL returns remaining time at its own evaluation. Sampling before the
    // query keeps query/response latency from extending an authority deadline.
    const lifetimeStarted=performance.now()
    const lifetime=await client.query<{ttl:number}>('SELECT department_media_valid_for_ms($1) AS ttl',[reply.workspaceId])
    const ttl=lifetime.rows[0]?.ttl??0
    const elapsed=performance.now()-started
    const validForMs=Math.floor(Math.min(30_000,ttl,reply.validForMs??Number.POSITIVE_INFINITY)-elapsed)
    if(!Number.isFinite(validForMs)||validForMs<=0)return {status:404,body:{error:'Office metadata unavailable'}}
    const allowance=Math.floor(Math.min(30_000,ttl+(lifetimeStarted-started),reply.validForMs??Number.POSITIVE_INFINITY))
    if(!Number.isFinite(ttl)||ttl<=0||!Number.isFinite(lifetimeStarted-started)||lifetimeStarted<started||!Number.isFinite(allowance)||allowance<=elapsed)
      return {status:404,body:{error:'Office metadata unavailable'}}
    await client.query('COMMIT')
    const result:OfficeMetadataReply={...reply,validForMs}
    Object.defineProperty(result,requestOrigin,{value:{started,allowance}})
    return result
  } finally {
    context.active=false
    await rollbackAndRelease(client)
  }
}
