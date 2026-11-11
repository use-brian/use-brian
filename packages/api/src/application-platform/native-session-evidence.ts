/** Closed native session evidence read. [COMP:api/application-persistence] */
import {z} from 'zod'
import {readNativePrivateTitleEvidence} from './native-private-title-evidence.js'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator,resourceScopeKey,type ResourceScope,type ScopeEvidence,type ScopeSource} from '@use-brian/core'
const scope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','session_context_revision','session_message','memory','workspace_file']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const labelScope=scope.pick({workspaceId:true,userId:true,assistantId:true,sensitivity:true,compartments:true,projectIds:true}).strict()
const historyResult=z.discriminatedUnion('available',[
 z.object({purpose:z.literal('memory_history'),available:z.literal(false)}).strict(),
 z.object({purpose:z.literal('memory_history'),available:z.literal(true),root:scope,scopes:z.array(labelScope).max(8192)}).strict(),
])
type CompleteNativeEvidence={kind:'complete';evidence:ScopeEvidence;current:ScopeSource[]}
type NativeEvidence=CompleteNativeEvidence
 |{kind:'memory_history';available:false}|{kind:'memory_history';available:true;root:ScopeSource;scopes:ResourceScope[]}
const result=z.discriminatedUnion('admitted',[
 z.object({admitted:z.literal(false)}).strict(),
 z.object({admitted:z.literal(true),immutable:z.array(scope),current:z.array(scope)}).strict(),
])
const cohortProof=z.object({immutable:z.array(scope),current:z.array(scope)}).strict()
const publicationResult=z.object({admitted:z.literal(true),cohorts:z.tuple([cohortProof,cohortProof])}).strict()

/** Private host acquisition: the database independently projects each exact
 * original cohort. A union proof cannot stand in for either cohort's floor. */
export async function readNativePublicationCohorts(client:Pick<PoolClient,'query'>,workspaceId:string,
 rawCohorts:readonly [readonly ScopeSource[],readonly ScopeSource[]]):Promise<[CompleteNativeEvidence,CompleteNativeEvidence]|null>{
 const cohorts=structuredClone(rawCohorts)
 if(cohorts.some(roots=>!roots.length||roots.length>4096||roots.some(root=>root.workspaceId!==workspaceId
  ||!['application_field','session_context_revision','session_message','workspace_file'].includes(root.resourceKind))))return null
 const installed=(await client.query<{available:boolean}>(
  "SELECT to_regprocedure('public.read_native_turn_publication_cohorts(uuid,jsonb)') IS NOT NULL AS available")).rows[0]?.available===true
 if(!installed)return null
 const identities=cohorts.map(roots=>roots.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version})))
 const raw=(await client.query<{value:unknown}>('SELECT read_native_turn_publication_cohorts($1,$2) AS value',
  [workspaceId,JSON.stringify(identities)])).rows[0]?.value
 if(raw===null)return null
 const parsed=publicationResult.parse(raw)
 return parsed.cohorts.map((proof,index)=>{
  if([...proof.immutable,...proof.current].some(source=>source.workspaceId!==workspaceId)
   ||cohorts[index].some(root=>!proof.current.some(source=>source.resourceKind===root.resourceKind&&source.resourceId===root.resourceId)
    ||['application_field','session_context_revision'].includes(root.resourceKind)&&!proof.immutable.some(source=>
     source.resourceKind===root.resourceKind&&source.resourceId===root.resourceId&&source.version===root.version)))throw new Error('Native publication cohort unavailable')
  return{kind:'complete',evidence:new ContextScopeAccumulator({sources:[...cohorts[index],...proof.immutable]}).evidence,current:proof.current}
 }) as [CompleteNativeEvidence,CompleteNativeEvidence]
}
/** Null means an unchanged original-family fallback; no authorization result is cached. */
export async function readNativeSessionEvidence(client:Pick<PoolClient,'query'>,workspaceId:string,roots:readonly ScopeSource[]):Promise<NativeEvidence|null>{
 if(roots.length===1&&roots[0].resourceKind==='session_context_revision'&&roots[0].version==='1'){
  const privateTitle=await readNativePrivateTitleEvidence(client,workspaceId,roots)
  if(privateTitle)return privateTitle
 }
 if(!roots.length||roots.length>4096||!roots.some(root=>root.resourceKind==='application_field'||root.resourceKind==='session_context_revision')||roots.some(root=>!['application_field','session_context_revision','session_message','memory','workspace_file'].includes(root.resourceKind)))return null
 // Field observations can hide Memory ancestors too. The closed validator
 // discovers the complete native closure and preserves its original fallback.
 const args=[workspaceId,roots.map(root=>root.resourceKind),roots.map(root=>root.resourceId),roots.map(root=>root.version)]
 let raw:unknown=(await client.query<{value:unknown}>('SELECT read_native_turn_scope_evidence($1,$2) AS value',
  [workspaceId,JSON.stringify(roots.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version})))])).rows[0]?.value
 if(raw===null&&roots.length>100){
  raw=(await client.query<{value:unknown}>('SELECT read_native_covered_session_evidence($1,$2,$3,$4) AS value',args)).rows[0]?.value
 }else if(raw===null){
  raw=(await client.query<{value:unknown}>('SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',args)).rows[0]?.value
  if(raw===null)raw=(await client.query<{value:unknown}>('SELECT read_native_file_session_evidence($1,$2,$3,$4,true) AS value',args)).rows[0]?.value
  if(raw===null)raw=(await client.query<{value:unknown}>('SELECT read_native_empty_query_evidence($1,$2,$3,$4) AS value',args)).rows[0]?.value
 }
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
