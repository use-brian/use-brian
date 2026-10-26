import {createDbKnowledgeStore,type KnowledgeEntry} from '../../../db/knowledge-store.js'
import {createDbWorkspaceGroupStore} from '../../../db/workspace-group-store.js'
import type {persistentContextFixture} from './persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
type Fixture=Pick<Awaited<ReturnType<typeof persistentContextFixture>>,'pool'|'workspaceId'|'ownerId'>
/** Actual ready-mode configuration and sync lineage, never a fabricated binding. */
export async function configuredKnowledgeEntryFixture(f:Fixture,input:{source:{repo:string;branch?:string;rootPath?:string};entry:Pick<KnowledgeEntry,'path'|'title'|'content'|'sensitivity'>&Partial<Pick<KnowledgeEntry,'summary'|'tags'|'metadata'|'sourceSha'>>}){
 await assertLocalFixture();const store=createDbKnowledgeStore()
 const team=await createDbWorkspaceGroupStore().createTeam(f.ownerId,f.workspaceId,{name:'Fictional configured source',key:'fictional-configured-source'})
 await f.pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[f.workspaceId,team.id])
 const source=await store.createSource({workspaceId:f.workspaceId,sourceType:'local',...input.source,binding:{sensitivity:'internal',compartments:[],projectIds:[]}},{actorUserId:f.ownerId})
 if(!source.bindingCompartments||!source.bindingProjectIds)throw new Error('Actual configured source labels required')
 const authority=await store.captureSourceSync(source);if(!authority)throw new Error('Actual configured sync authority required')
 try{
  const entry=await store.upsertByPath({...input.entry,workspaceId:f.workspaceId,sourceId:source.id,sourceSha:input.entry.sourceSha??'fictional-source-revision',
   compartments:[...source.bindingCompartments],projectIds:[...source.bindingProjectIds],actorId:f.ownerId},authority)
  return{source,entry}
 }finally{await store.releaseSourceSync(authority)}
}
