/** Closed native session evidence read. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,resourceScopeKey,type ResourceScope,type ScopeEvidence,type ScopeSource} from '@use-brian/core'
const scope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','session_context_revision','session_message','memory']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const labelScope=scope.pick({workspaceId:true,userId:true,assistantId:true,sensitivity:true,compartments:true,projectIds:true}).strict()
const historyResult=z.discriminatedUnion('available',[
 z.object({purpose:z.literal('memory_history'),available:z.literal(false)}).strict(),
 z.object({purpose:z.literal('memory_history'),available:z.literal(true),root:scope,scopes:z.array(labelScope).max(8192)}).strict(),
])
type NativeEvidence={kind:'complete';evidence:ScopeEvidence;current:ScopeSource[]}
 |{kind:'memory_history';available:false}|{kind:'memory_history';available:true;root:ScopeSource;scopes:ResourceScope[]}
const result=z.discriminatedUnion('admitted',[
 z.object({admitted:z.literal(false)}).strict(),
 z.object({admitted:z.literal(true),immutable:z.array(scope),current:z.array(scope)}).strict(),
])
/** Null means an unchanged original-family fallback; no authorization result is cached. */
export async function readNativeSessionEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,roots:readonly ScopeSource[]):Promise<NativeEvidence|null>{
 if(!roots.length||roots.length>100||!roots.some(root=>root.resourceKind==='application_field'||root.resourceKind==='session_context_revision')||roots.some(root=>!['application_field','session_context_revision','session_message','memory'].includes(root.resourceKind)))return null
 // Field observations can hide Memory ancestors too. The closed validator
 // discovers the complete native closure and preserves its original fallback.
 const sql='SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value'
 const raw=(await client.query<{value:unknown}>(sql,
  [workspaceId,roots.map(root=>root.resourceKind),roots.map(root=>root.resourceId),roots.map(root=>root.version)])).rows[0]?.value
 if(raw===null)return null
 if(typeof raw==='object'&&raw!==null&&'purpose'in raw&&raw.purpose==='memory_history'){
  const history=historyResult.parse(raw)
  if(!history.available)return{kind:'memory_history',available:false}
  if(roots.length!==1||history.root.resourceKind!=='application_field'
   ||history.root.resourceId!==roots[0].resourceId||history.root.version!==roots[0].version
   ||resourceScopeKey(history.root)!==resourceScopeKey(roots[0])||history.scopes.some(value=>value.workspaceId!==workspaceId))throw new Error('Native history evidence unavailable')
  return{kind:'memory_history',available:true,root:history.root,scopes:history.scopes}
 }
 const parsed=result.parse(raw)
 if(!parsed.admitted)throw new Error('Native session evidence unavailable')
 if([...parsed.immutable,...parsed.current].some(source=>source.workspaceId!==workspaceId))throw new Error('Native session evidence unavailable')
 const evidence=new ContextScopeAccumulator({sources:[...roots,...parsed.immutable]}).evidence
 return{kind:'complete',evidence,current:parsed.current}
}
