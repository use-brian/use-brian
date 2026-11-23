/** Current original-cohort source context. [COMP:api/application-persistence] */
import {z} from 'zod'
import {resourceScopeKey, type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {SourceProtocolError} from '@use-brian/brian-app/connector'
import {getPool} from '../db/client.js'
import {readExternalSourceAncestors} from './external-source-ancestry.js'
import type {PreparedExternalSourceAuthority} from './retained-source-authority.js'
type Prepare=(execution:ExecutionContext,sources:readonly ScopeSource[],action:'context')=>Promise<PreparedExternalSourceAuthority>
const source=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['session_message','session_context_revision','knowledge_entry','memory']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
function unavailable(cause?:unknown):never{throw Object.assign(new SourceProtocolError('source_unavailable'),cause===undefined?{}:{cause})}

// These readers handle distinct current query domains, but would otherwise
// each enumerate the same ancestry to discover whether their kind is present.
// Route using the canonical exact graph and keep each family's proof separate.
const READ_COHORT_SOURCES = `WITH families AS MATERIALIZED (
  SELECT DISTINCT CASE
    WHEN f.type_key IN ('session_message','session_message_annotation') THEN 'session'
    WHEN f.type_key = 'knowledge_entry' THEN 'knowledge'
    WHEN f.type_key = 'memory' THEN 'memory'
  END AS family
  FROM application_scope_lineage($1,$2,$3,$4) n
  JOIN application_field_resources f ON n.kind='application_field' AND f.workspace_id=$1 AND f.id=n.id
  WHERE f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
), eligible AS MATERIALIZED (
  SELECT family, $1::uuid AS workspace_id, $2::text[] AS kinds, $3::uuid[] AS ids, $4::text[] AS versions
  FROM families WHERE family IS NOT NULL
)
SELECT q.source FROM (SELECT * FROM eligible WHERE family='session' OFFSET 0) r
CROSS JOIN LATERAL read_native_session_query_cohort_sources(r.workspace_id,r.kinds,r.ids,r.versions) q
UNION ALL
SELECT q.source FROM (SELECT * FROM eligible WHERE family='knowledge' OFFSET 0) r
CROSS JOIN LATERAL read_native_knowledge_query_cohort_sources(r.workspace_id,r.kinds,r.ids,r.versions) q
UNION ALL
SELECT q.source FROM (SELECT * FROM eligible WHERE family='memory' OFFSET 0) r
CROSS JOIN LATERAL read_native_memory_query_cohort_sources(r.workspace_id,r.kinds,r.ids,r.versions) q`

/** Metadata authorizes nothing; every added root gets a fresh actual source decision. */
export async function nativeSessionQueryContextSources(execution:ExecutionContext,rawSources:readonly ScopeSource[],prepare?:Prepare):Promise<{sources:ScopeSource[];independent:boolean}>{
 const roots=rawSources.map(root=>structuredClone(root)),workspaceId=execution.security.access.workspaceId,cohort=new Map<string,ScopeSource>()
 if(roots.some(root=>root.workspaceId!==workspaceId))unavailable()
 try{
  for(let offset=0;offset<roots.length;offset+=100){
   const part=roots.slice(offset,offset+100),rows=(await getPool().query<{source:unknown}>(READ_COHORT_SOURCES,
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
   return{sources:[...combined.values()],independent:true}
 }catch(error){if(error instanceof SourceProtocolError)throw error;unavailable(error)}
}
