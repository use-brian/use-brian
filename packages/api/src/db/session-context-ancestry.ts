/** Metadata-only persistent obligations behind native references. [COMP:api/application-persistence] */
import { z } from 'zod'
import { DerivedScopeError,resourceScopeKey,type ScopeSource } from '@use-brian/core'
import { getPool } from './client.js'
import type { PoolClient } from 'pg'
const metadata=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 resourceKind:z.literal('session_context_revision'),resourceId:z.string().uuid(),version:z.literal('1'),held:z.literal(false),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())})
function changed():never{throw new DerivedScopeError('scope_source_changed')}
/** Metadata discovery grants no rights; supplied transactions admit every parent. */
export async function readPersistentSessionContextAncestors(workspaceId:string,rawRoots:readonly ScopeSource[],client?:Pick<PoolClient,'query'>):Promise<ScopeSource[]> {
 const roots=structuredClone(rawRoots),found=new Map<string,ScopeSource>()
 if(roots.some(source=>source.workspaceId!==workspaceId))changed()
 for(let offset=0;offset<roots.length;offset+=100){
  const part=roots.slice(offset,offset+100)
  const rows=(await (client ?? getPool()).query<{nodeVersion:string;source:unknown}>(client
   ? `SELECT node_version AS "nodeVersion",source FROM read_admitted_session_context_dependencies($1,$2,$3,$4)`
   : `SELECT node.version AS "nodeVersion",read_scope_source($1,node.kind,node.id) AS source
      FROM application_scope_lineage($1,$2,$3,$4) node WHERE node.kind='session_context_revision'`,
   [workspaceId,part.map(source=>source.resourceKind),part.map(source=>source.resourceId),part.map(source=>source.version)])).rows
  for(const row of rows){
   const parsed=metadata.safeParse(row.source)
   if(!parsed.success || parsed.data.workspaceId!==workspaceId || parsed.data.version!==row.nodeVersion)changed()
   const {held:_,...source}=parsed.data,prior=found.get(source.resourceId)
   if(prior && (prior.version!==source.version || resourceScopeKey(prior)!==resourceScopeKey(source)))changed()
   found.set(source.resourceId,source)
  }
 }
 return [...found.values()]
}
