/** Closed native session evidence read. [COMP:api/application-persistence] */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,type ScopeEvidence,type ScopeSource} from '@use-brian/core'
const scope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','session_context_revision','session_message','memory']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const result=z.discriminatedUnion('admitted',[
 z.object({admitted:z.literal(false)}).strict(),
 z.object({admitted:z.literal(true),immutable:z.array(scope),current:z.array(scope)}).strict(),
])
/** Null means an unchanged original-family fallback; no authorization result is cached. */
export async function readNativeSessionEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,roots:readonly ScopeSource[]):Promise<{evidence:ScopeEvidence;current:ScopeSource[]}|null>{
 if(!roots.length||roots.length>100||!roots.some(root=>root.resourceKind==='application_field')||roots.some(root=>!['application_field','session_context_revision','session_message','memory'].includes(root.resourceKind)))return null
 const sql=roots.some(root=>root.resourceKind==='memory')
  ? 'SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value'
  : 'SELECT read_native_session_evidence($1,$2,$3,$4) AS value'
 const raw=(await client.query<{value:unknown}>(sql,
  [workspaceId,roots.map(root=>root.resourceKind),roots.map(root=>root.resourceId),roots.map(root=>root.version)])).rows[0]?.value
 if(raw===null)return null
 const parsed=result.parse(raw)
 if(!parsed.admitted)throw new Error('Native session evidence unavailable')
 if([...parsed.immutable,...parsed.current].some(source=>source.workspaceId!==workspaceId))throw new Error('Native session evidence unavailable')
 const evidence=new ContextScopeAccumulator({sources:[...roots,...parsed.immutable]}).evidence
 return{evidence,current:parsed.current}
}
