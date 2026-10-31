"use client";
/** Attended source conversion. [COMP:app-web/workspace-access] */
import {useT} from '@/lib/i18n/client';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {useCachedResource} from '@/lib/surface-cache';
import {useProtectedProjection} from '@/lib/use-protected-projection';
import {workspaceKnowledgeBindingCacheKey} from '@/lib/surface-prefetch';
import {fetchLegacyKnowledgeBindings,prepareLegacyKnowledgeBinding,applyLegacyKnowledgeBinding,type LegacyKnowledgeBindingReview,ORGANIZATION_CHANGED_EVENT} from '@/lib/api/workspace-access';
import {Button} from '@/components/ui/button';
import {SurfaceSkeletonFor} from '@/components/chrome/surface-skeleton';
import {useReviewedCommand} from './use-reviewed-command';
import {DepartmentChangeFeedback} from './use-department-change';

export function LegacyKnowledgeBindings({departmentId,departmentName}:{departmentId:string;departmentName:string}) {
 const {workspaceId,me}=useWorkspaceContext(),t=useT().accessMigration,a=useT().workspaceAccess;
 const key=workspaceKnowledgeBindingCacheKey(workspaceId,me.id),resource=useCachedResource(key,()=>fetchLegacyKnowledgeBindings(workspaceId));
 type Prepared={id:string;payloadHash:string;validForMs:number;result:LegacyKnowledgeBindingReview};
 const change=useReviewedCommand<string,Prepared,{reviewId:string}>({workspaceId,contextKey:`knowledge-binding:${departmentId}`,cachePrefix:'workspace-access',
  prepare:async sourceId=>{
   const result=await prepareLegacyKnowledgeBinding(workspaceId,sourceId,departmentId);
   if(result.status!=='prepared')throw new Error('knowledge_binding_review_changed');
   return {id:result.reviewId,payloadHash:result.payloadHash,validForMs:Date.parse(result.expiresAt)-Date.now(),result};
  },
  apply:async saved=>{
   try{return await applyLegacyKnowledgeBinding(workspaceId,saved.id,saved.payloadHash);}
   catch(error){if(error instanceof Error&&(error.message.startsWith('knowledge_binding_review_')||error.message==='access_policy_conflict'))change.discardReview();throw error;}
  },
  renderReview:saved=><div className="max-h-[40dvh] space-y-2 overflow-y-auto text-sm"><p>{t.knowledgeBindingReview}</p><p>{t.defaultDepartment}: {departmentName}</p>
   <p className="break-all">{saved.result.sourceId}</p><p>{t.knowledgeBindingEntries}: {saved.result.entryCount}</p>
   <p className="break-all">{t.knowledgeBindingActor}: {saved.result.configuredByUserId}</p><p>{saved.result.binding.sensitivity}</p>
   <p className="break-all">{t.hash}: {saved.payloadHash}</p><p>{saved.result.expiresAt}</p></div>,
  errorMessage:code=>code==='knowledge_binding_department_access_required'?t.knowledgeBindingAccess
   :code==='knowledge_binding_source_busy'||code==='access_busy'?a.reviewBusy
   :code.startsWith('knowledge_binding_review_')||code==='access_policy_conflict'?a.stale:t.knowledgeBindingBlocked,
  onApplied:()=>{window.dispatchEvent(new CustomEvent(ORGANIZATION_CHANGED_EVENT,{detail:{workspaceId}}));},
 });
 const data=useProtectedProjection(key,resource.data,change.cancelReview,resource.refresh);
 if(!data)return resource.error?<p role="alert">{a.loadError} <Button variant="outline" onClick={()=>void resource.refresh()}>{a.reload}</Button></p>:<SurfaceSkeletonFor surface="organization" chrome={false}/>;
 if(!data.sources.length)return null;
 return <section className="space-y-2 rounded-lg border border-border p-3 text-sm"><h3 className="font-medium">{t.knowledgeBindingsTitle}</h3>
  {data.sources.map(source=><div key={source.id} className="space-y-1"><p className="break-all">{source.id}</p><p>{t.knowledgeBindingEntries}: {source.entryCount}</p>
   <Button className="max-sm:min-h-11" variant="outline" disabled={change.busy||change.retryAvailable} onClick={()=>void change.save(source.id,{title:t.knowledgeBindingAction,description:t.knowledgeBindingReview})}>{t.knowledgeBindingAction}: {departmentName}</Button></div>)}
  <DepartmentChangeFeedback change={change}/>
 </section>;
}
