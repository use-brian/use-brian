/** Per-call, transaction-bound capability for a canonical configured-intake
 * Episode. Attribution is never installed as an executing human identity. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import { resourceScopeKey, type ScopeSource, type DerivedWriteEvidence, type ResourceScope } from '@use-brian/core'
import { programmaticIntakeClient, programmaticIntakeClaims } from '../db/programmatic-intake-context.js'

type Capability={client:PoolClient;source:ScopeSource;kind:'memory'|'entity'|'task';actor:string}
const execution=new AsyncLocalStorage<Capability>()
export async function withProgrammaticCandidate<T>(client:PoolClient,batchId:string,source:ScopeSource,kind:Capability['kind'],actor:string,write:()=>Promise<T>):Promise<T>{
 if(client!==programmaticIntakeClient.getStore() || !programmaticIntakeClaims.getStore()?.has(batchId))throw new Error('capture_claim_required')
 await client.query("SELECT set_config('app.programmatic_candidate_source',$1,true)",[JSON.stringify({batchId,source,kind,actor})])
 try{return await execution.run({client,source,kind,actor},write)}
 finally{await client.query("SELECT set_config('app.programmatic_candidate_source','',true),set_config('app.programmatic_candidate','',true)").catch(()=>{})}
}
export async function admitProgrammaticCandidate(client:PoolClient,workspaceId:string,actor:string,kind:string|undefined,input:Omit<ResourceScope,'workspaceId'|'assistantId'> & {assistantId?:string|null}){
 const authority=execution.getStore()
 if(!authority)return null
 if(client!==authority.client || actor!==authority.actor || kind!==authority.kind
  || resourceScopeKey({...input,workspaceId,assistantId:input.assistantId??null})!==resourceScopeKey(authority.source))throw new Error('capture_candidate_scope_mismatch')
 const current=(await client.query<{source:ScopeSource}>('SELECT programmatic_candidate_source() AS source')).rows[0]?.source
 if(!current || current.version!==authority.source.version || resourceScopeKey(current)!==resourceScopeKey(authority.source))throw new Error('capture_source_changed')
 await client.query("SELECT set_config('app.programmatic_candidate',current_setting('app.programmatic_candidate_source'),true)")
 return {visibility:'workspace' as const,sensitivity:current.sensitivity,compartments:current.compartments,projectIds:current.projectIds}
}
export const candidateEvidence=(source:ScopeSource):DerivedWriteEvidence=>({producer:'programmatic-capture',sources:[source]})
