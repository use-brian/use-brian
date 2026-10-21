/** Current original-cohort source context. [COMP:api/application-persistence] */
import {z} from 'zod'
import {resourceScopeKey,type ExecutionContext,type ScopeSource} from '@use-brian/core'
import {SourceProtocolError} from '@use-brian/brian-app/connector'
import {getPool} from '../db/client.js'
import {readExternalSourceAncestors} from './external-source-ancestry.js'
import type {PreparedExternalSourceAuthority} from './retained-source-authority.js'
type Prepare=(execution:ExecutionContext,sources:readonly ScopeSource[],action:'context')=>Promise<PreparedExternalSourceAuthority>
const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['session_message','session_context_revision','knowledge_entry']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
function unavailable(cause?:unknown):never{throw Object.assign(new SourceProtocolError('source_unavailable'),cause===undefined?{}:{cause})}
/** Metadata authorizes nothing; every added root gets a fresh actual source decision. */
export async function nativeSessionQueryContextSources(execution:ExecutionContext,rawSources:readonly ScopeSource[],prepare?:Prepare):Promise<{sources:ScopeSource[];independent:boolean}>{
 await execution.security.authority.assertCurrent()
 const roots=rawSources.map(root=>structuredClone(root)),workspaceId=execution.security.access.workspaceId,cohort=new Map<string,ScopeSource>()
 if(roots.some(root=>root.workspaceId!==workspaceId))unavailable()
 try{
  for(let offset=0;offset<roots.length;offset+=100){
   const part=roots.slice(offset,offset+100),rows=(await getPool().query<{source:unknown}>('SELECT source FROM read_native_session_query_cohort_sources($1,$2,$3,$4) UNION ALL SELECT source FROM read_native_knowledge_query_cohort_sources($1,$2,$3,$4)',
    [workspaceId,part.map(root=>root.resourceKind),part.map(root=>root.resourceId),part.map(root=>root.version)])).rows
   for(const row of rows){
    const current=source.parse(row.source);if(current.workspaceId!==workspaceId)unavailable()
    const key=current.resourceKind+':'+current.resourceId,previous=cohort.get(key)
    if(previous&&(previous.version!==current.version||resourceScopeKey(previous)!==resourceScopeKey(current)))unavailable()
    cohort.set(key,current)
   }
  }
  const candidates=[...cohort.values()]
  // A fresh canonical union walk can prove this exact complete cohort has no
  // external references. This is neither a workspace assumption nor a cache.
  if(!candidates.length||!(await readExternalSourceAncestors(workspaceId,candidates)).length)return{sources:roots,independent:false}
  if(!prepare)unavailable()
  const admitted:ScopeSource[]=[]
  for(const candidate of candidates){
   if(!(await readExternalSourceAncestors(workspaceId,[candidate])).length)continue
   try{await prepare(execution,[candidate],'context');admitted.push(candidate)}
   catch(error){if(!(error instanceof SourceProtocolError)||error.code!=='source_access_denied')throw error}
  }
  const combined=new Map(roots.map(root=>[root.resourceKind+':'+root.resourceId,root]))
  for(const current of admitted){
   const key=current.resourceKind+':'+current.resourceId,previous=combined.get(key)
   if(previous&&(previous.version!==current.version||resourceScopeKey(previous)!==resourceScopeKey(current)))unavailable()
   combined.set(key,current)
  }
  await execution.security.authority.assertCurrent()
  return{sources:[...combined.values()],independent:true}
 }catch(error){if(error instanceof SourceProtocolError)throw error;unavailable(error)}
}
