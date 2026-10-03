"use client";
/** Bounded principal/resource progress. No mode activation. [COMP:app-web/workspace-access] */
import {useEffect,useRef,useState} from 'react';
import type {DepartmentCommandReview,DepartmentAccessCommand,WorkspaceDepartmentRegistry} from '@use-brian/shared';
import {useT} from '@/lib/i18n/client';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {useCachedResource,invalidateSurfaceCache,markSurfaceCacheStale} from '@/lib/surface-cache';
import {useProtectedProjection,projectionRemainingMs} from '@/lib/use-protected-projection';
import {workspaceAccessModeCacheKey,workspaceAccessMigrationCacheKey,workspaceDepartmentRegistryCacheKey} from '@/lib/surface-prefetch';
import {fetchWorkspaceDepartmentRegistry,fetchWorkspaceAccessMode,fetchMigrationPlans,fetchMigrationPlan,prepareMigrationItem,applyMigrationItem,setMigrationPlanState,ORGANIZATION_CHANGED_EVENT,isResourceMigrationItem,type MigrationItem,type PrincipalMigrationItem,type ResourceMigrationItem,type MigrationItemReviewResult,type MigrationItemApplyResult,type MigrationProjection} from '@/lib/api/workspace-access';
import {WORKSPACE_IDENTITY_REFRESH_EVENT,isCatchUpRefresh} from '@/lib/workspace-identity-events';
import {Button} from '@/components/ui/button';
import {RefreshCw} from 'lucide-react';
import {HowItWorks} from '@/components/organization/org-visuals';
import {confirmDialog} from '@/components/ui/confirm-dialog';
import {SurfaceSkeletonFor} from '@/components/chrome/surface-skeleton';
import {ScopeReviewEvidence} from './scope-review';
import {CommandReviewEffects} from './command-review-effects';
import {useReviewedCommand} from './use-reviewed-command';
import {DepartmentChangeFeedback} from './use-department-change';

type Copy=ReturnType<typeof useT>['accessMigration'];
export function migrationMessage(code:string,t:Copy):string|undefined {
  switch(code){
    case 'full_inventory_required':case 'intake_certification_required':case 'mode_finalizer_unavailable':
    case 'scope_review_action_unsupported':case 'migration_source_floor_review_required':case 'scope_review_source_floor_unsupported':case 'scope_review_changed':case 'scope_review_expired':case 'scope_review_impact_missing':case 'scope_review_impact_too_large':case 'scope_review_conflict':
    case 'migration_busy':case 'migration_not_active':case 'migration_item_applied':return t[code];
    case 'migration_actor_required':return t.actor;
    case 'migration_expired':return t.expired;
    default:return undefined;
  }
}
function statusLabel(status:string,t:Copy){
  switch(status){case 'proposed':case 'awaiting_confirmation':case 'paused':case 'cancelled':case 'blocked':case 'pending':case 'applied':case 'stale':return t[status];
    case 'applying':case 'verifying':return t.processing;default:return t.unknown;}
}
type Names=Pick<WorkspaceDepartmentRegistry,'people'|'assistants'|'teams'>;
function NamedId({id,kind,names}:{id:string;kind:'people'|'assistants'|'teams';names:Names}){
  const t=useT().workspaceAccess;
  return <span className="break-words">{names[kind].find(row=>row.id===id)?.name||t.unnamed} <span className="break-all text-xs text-muted-foreground">({id})</span></span>;
}
function DepartmentSet({ids,names,unlisted=false}:{ids:string[]|null;names:Names;unlisted?:boolean}){
  const t=useT().workspaceAccess;
  return <>{ids===null?t.allDepartments:ids.length?ids.map((id,index)=><span key={id}>{index?', ':''}<NamedId id={id} kind="teams" names={names}/></span>):t.generalOnly}{unlisted?` · ${t.unlistedScope}`:''}</>;
}
function ActionSummary({command,names}:{command:DepartmentAccessCommand;names:Names}){
  const t=useT().workspaceAccess;
  if(command.type==='member.access.set')return <p>{t.member}: <NamedId id={command.userId} kind="people" names={names}/> · {t.scopeMode}: {command.teamScopeMode==='assigned'?t.assignedMode:t.legacyMode} · {t.clearance}: {t[command.clearance]}</p>;
  if(command.type==='department.member.set'||command.type==='department.assistant.set')return <p>{t.reviewMembership}: <NamedId id={command.teamId} kind="teams" names={names}/> · {'userId' in command?<NamedId id={command.userId} kind="people" names={names}/>:<NamedId id={command.assistantId} kind="assistants" names={names}/>} · {command.enabled?t.enabled:t.disabled}</p>;
  if(command.type==='assistant.audience.set')return <div className="space-y-1"><p>{t.reviewAssistants}: <NamedId id={command.assistantId} kind="assistants" names={names}/></p><p>{t.departments}: <DepartmentSet ids={command.teamMode==='all'?null:command.teamIds} names={names}/></p><p>{t.reviewDefaultDepartment}: {command.defaultGroupId?<NamedId id={command.defaultGroupId} kind="teams" names={names}/>:t.reviewNone}</p></div>;
  return null;
}
function ReachState({state,names}:{state:MigrationProjection;names:Names}){
  const t=useT().workspaceAccess,m=useT().accessMigration;
  const access=state.person?.access;
  if(state.kind==='member'&&access)return <><p>{t.readReach}: <DepartmentSet ids={access.readTeamIds} names={names} unlisted={access.hasUnlistedReadScope}/></p><p>{m.editReach}: <DepartmentSet ids={access.membershipTeamIds} names={names} unlisted={access.hasUnlistedMembershipScope}/></p></>;
  // Assistant projections expose compartment keys, not a canonical key-to-name
  // mapping. Never guess that registry slugs or configured memberships are reach.
  const scope=(value:string[]|null|undefined)=>value===null?t.allDepartments:value?.length===0?t.generalOnly:m.unavailableScope;
  return <><p>{t.readReach}: {scope(state.readCompartments)}</p><p>{m.editReach}: {scope(state.mutationCompartments)}</p>{state.config?<p>{m.configuredTeams}: {state.config.teamIds.length?<DepartmentSet ids={state.config.teamIds} names={names}/>:t.reviewNone}</p>:null}</>;
}
function ReachPreview({item,names}:{item:PrincipalMigrationItem;names:Names}){
  const t=useT().workspaceAccess,m=useT().accessMigration;
  return <section className="space-y-2 rounded-lg border border-border p-3"><h4 className="font-medium">{m.simulation}</h4>
    {item.before_state&&item.after_state?<div className="grid gap-3 md:grid-cols-2">{([['before_state',t.reviewBefore],['after_state',t.reviewAfter]] as const).map(([key,label])=><div key={key}><h5 className="font-medium">{label}</h5><ReachState state={item[key]!} names={names}/></div>)}</div>:<p>{m.unavailableScope}</p>}
    <p>{m.resourceDisclaimer}</p>{item.subject_kind==='assistant'||item.before_state?.humanIntersectionRequired||item.after_state?.humanIntersectionRequired?<p>{m.humanDisclaimer}</p>:null}
  </section>;
}
function ResourceSummary({item,names}:{item:ResourceMigrationItem;names:Names}){
  const t=useT().scopeReview,command=item.proposed_action;
  return <div className="space-y-1"><h4 className="font-semibold break-words">{item.before_state.content?.title??t.unknown}</h4><p className="break-all">{command.resourceId}</p><p>{t[command.resourceKind]} · {t[command.action]}{command.targetTeamId?<> · <NamedId id={command.targetTeamId} kind="teams" names={names}/></>:null}</p></div>;
}
export function MigrationProgressPanel(){
  const {workspaceId,me}=useWorkspaceContext();
  return <MigrationPanel key={`${workspaceId}:${me.id}`}/>;
}
function MigrationPanel(){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().accessMigration;
  const [plan,setPlan]=useState<string|null>(null),[after,setAfter]=useState('');
  useEffect(()=>{
    const purge=(event:Event)=>{const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;if(isCatchUpRefresh(event))markSurfaceCacheStale(`workspace-access:${workspaceId}:`);else invalidateSurfaceCache(`workspace-access:${workspaceId}:`);};
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};
  },[workspaceId]);
  return <section className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">{t.title}</h2>
    <ModeSummary/>
    <HowItWorks summary={t.aboutPlans}><p>{t.limitation}</p><p className="font-medium text-foreground">{t.warning}</p></HowItWorks>
    {plan?<><Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={()=>setPlan(null)}>{t.back}</Button><PlanDetail key={plan} planId={plan}/></>:<PlanList key={after} after={after} setAfter={setAfter} inspect={setPlan}/>}
  </section>;
}
function LoadState({error,refresh}:{error:unknown;refresh:()=>Promise<unknown>}){
  const t=useT().workspaceAccess;
  return error?<div role="alert"><p>{t.loadError}</p><Button className="max-sm:min-h-11" variant="outline" onClick={()=>void refresh()}>{t.reload}</Button></div>:<SurfaceSkeletonFor surface="organization" chrome={false}/>;
}
function ModeSummary(){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().accessMigration;
  const key=workspaceAccessModeCacheKey(workspaceId,me.id),resource=useCachedResource(key,()=>fetchWorkspaceAccessMode(workspaceId));
  const mode=useProtectedProjection(key,resource.data,()=>{},resource.refresh);
  return mode?<dl className="grid gap-2 text-sm sm:grid-cols-3">{([[t.current,t[mode.mode]],[t.setup,t[mode.setupState]],[t.defaultDepartment,mode.defaultDepartmentName??t.missing]] as const).map(([label,value])=>
    <div key={label} className="min-w-0 rounded-lg bg-muted/50 px-3 py-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words font-medium">{value}</dd></div>)}</dl>:<LoadState error={resource.error} refresh={resource.refresh}/>;
}
function PlanList({after,setAfter,inspect}:{after:string;setAfter:(value:string)=>void;inspect:(id:string)=>void}){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().accessMigration,a=useT().workspaceAccess;
  const key=workspaceAccessMigrationCacheKey(workspaceId,me.id,'list',after),resource=useCachedResource(key,()=>fetchMigrationPlans(workspaceId,after));
  const data=useProtectedProjection(key,resource.data,()=>{},resource.refresh);
  return <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t.plans}</h3><Button variant="ghost" size="sm" className="max-sm:min-h-11" onClick={()=>void resource.refresh()}><RefreshCw aria-hidden className="size-3.5"/>{a.reload}</Button></div>
    {!data?<LoadState error={resource.error} refresh={resource.refresh}/>:<>{!data.plans.length?<p className="text-sm text-muted-foreground">{t.empty}</p>:data.plans.map(plan=><article className="space-y-2 border-t border-border pt-3 text-sm" key={plan.id}>
      <p className="break-all">{plan.id}</p><p>{statusLabel(plan.status,t)} · {t.target}: {t[plan.target_mode]}</p>
      <p>{t.appliedCount}: {plan.summary_counts.applied??0} / {plan.summary_counts.total??0}</p>
      <Button className="max-sm:min-h-11" variant="outline" onClick={()=>inspect(plan.id)}>{t.inspect}</Button>
    </article>)}<div className="flex flex-wrap gap-2">{after?<Button className="max-sm:min-h-11" variant="outline" onClick={()=>setAfter('')}>{t.back}</Button>:null}{data.plans.length===50?<Button className="max-sm:min-h-11" variant="outline" onClick={()=>setAfter(data.plans.at(-1)!.id)}>{t.next}</Button>:null}</div></>}
  </div>;
}
function PlanDetail({planId}:{planId:string}){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().accessMigration,a=useT().workspaceAccess;
  const key=workspaceAccessMigrationCacheKey(workspaceId,me.id,'plan',planId),resource=useCachedResource(key,()=>fetchMigrationPlan(workspaceId,planId));
  const registryKey=workspaceDepartmentRegistryCacheKey(workspaceId,me.id),registryResource=useCachedResource(registryKey,()=>fetchWorkspaceDepartmentRegistry(workspaceId));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const stateConfirmation=useRef<AbortController|null>(null);
  type Prepared={id:string;payloadHash:string;validForMs:number;itemId:string;names:Names;result:MigrationItemReviewResult};
  const change=useReviewedCommand<string,Prepared,MigrationItemApplyResult>({workspaceId,contextKey:planId,cachePrefix:'workspace-access',
    prepare:async(itemId,_revision,signal)=>{
      if(!registry)return null;
      const result=await prepareMigrationItem(workspaceId,planId,itemId);
      if(signal.aborted)return null;
      if(result.kind==='resource'&&(result.review.status!=='preview'||result.review.items.some(item=>!item.impact||result.review.action==='consolidate_default'&&(item.impact.version!==2||!item.impact.consolidation))))throw new Error(result.review.status!=='preview'?'scope_review_changed':'scope_review_impact_missing');
      if(result.kind==='resource'&&(result.confirmation.reviewId!==result.review.id||result.confirmation.payloadHash!==result.review.payloadHash||result.confirmation.expectedVersion!==result.review.version))throw new Error('scope_review_changed');
      const expiry=result.kind==='resource'?Date.parse(result.confirmation.expiresAt)-Date.now():Infinity;
      return {id:result.review.id,payloadHash:result.review.payloadHash,validForMs:Math.min(result.review.validForMs,projectionRemainingMs(registry),expiry),itemId,names:registry,result};
    },
    apply:async saved=>{
      const result=saved.result;
      try{
        const receipt=await applyMigrationItem(workspaceId,planId,saved.itemId,result.kind==='resource'?result.confirmation:{type:'access.command.apply',reviewId:result.review.id,payloadHash:result.review.payloadHash});
        // A 200 can carry stale/cancelled evidence. Never present that as applied.
        if('kind' in receipt&&receipt.kind==='resource'&&(receipt.status!=='applied'||receipt.review.status!=='complete'))throw new Error('scope_review_changed');
        return receipt;
      }catch(cause){
        const code=cause instanceof Error?cause.message:'';
        if(code.startsWith('scope_review_')||code==='migration_source_floor_review_required')change.discardReview();
        throw cause;
      }
    },
    errorMessage:code=>migrationMessage(code,t),
    renderReview:saved=>{const result=saved.result;return <div className="max-h-[40dvh] min-w-0 space-y-3 overflow-y-auto"><p>{t.warning}</p><p className="break-words">{result.item.reason}</p>{result.kind==='resource'?<><ResourceSummary item={result.item} names={saved.names}/><ScopeReviewEvidence job={result.review} expiresAt={result.confirmation.expiresAt} names={saved.names}/><p>{t.resourceDisclaimer}</p></>:<><ActionSummary command={result.review.command} names={saved.names}/><ReachPreview item={result.item} names={saved.names}/><CommandReviewEffects review={result.review}/></>}<p>{t.revision}: {result.review.policyRevision}</p><p className="break-all">{t.hash}: {saved.payloadHash}</p></div>;},
  });
  const registry=useProtectedProjection(registryKey,registryResource.data,()=>{change.cancelReview();stateConfirmation.current?.abort();},registryResource.refresh);
  const data=useProtectedProjection(key,resource.data,()=>{change.cancelReview();stateConfirmation.current?.abort();},resource.refresh);
  useEffect(()=>()=>stateConfirmation.current?.abort(),[]);
  async function state(value:'paused'|'cancelled'|'proposed'){
    if(busy||change.busy)return;
    setBusy(true);setError('');const controller=new AbortController();stateConfirmation.current=controller;
    try{
      const confirmed=await confirmDialog({signal:controller.signal,title:value==='paused'?t.pause:value==='cancelled'?t.cancel:t.resume,description:t.warning,confirmLabel:a.confirm,cancelLabel:a.cancel});
      if(!confirmed||controller.signal.aborted)return;
      await setMigrationPlanState(workspaceId,planId,value);
      change.discardReview();
    }catch(cause){if(!controller.signal.aborted)setError(migrationMessage(cause instanceof Error?cause.message:'',t)??a.saveError);}
    finally{setBusy(false);}
  }
  if(!data)return <LoadState error={resource.error} refresh={resource.refresh}/>;
  if(!registry)return <LoadState error={registryResource.error} refresh={registryResource.refresh}/>;
  if(!registry.canAdminister)return null;
  const expired=Date.parse(data.expires_at)<=Date.now(),stopped=['paused','cancelled','completed'].includes(data.status);
  const applied=data.items.filter(item=>item.status==='applied').length;
  return <div className="min-w-0 space-y-3 text-sm"><p className="break-all">{data.id}</p><p>{statusLabel(data.status,t)} · {t.target}: {t[data.target_mode]}</p>
    <p role="status">{t.appliedCount}: {applied} / {data.items.length}</p><p>{a.expires}: <time dateTime={data.expires_at}>{new Date(data.expires_at).toLocaleString()}</time></p>
    {expired?<p role="status">{t.expired}</p>:null}
    <ul className="list-inside list-disc">{data.blockers.map(code=><li key={code}>{migrationMessage(code,t)??t.unknownBlocker}</li>)}</ul>
    <p>{t.refreshHint}</p><div className="flex flex-wrap gap-2"><Button variant="outline" className="max-sm:min-h-11" disabled={busy||change.busy} onClick={()=>void resource.refresh()}>{a.reload}</Button>
      {data.status!=='cancelled'?<><Button variant="outline" className="max-sm:min-h-11" disabled={busy||change.busy||(data.status==='paused'&&expired)} onClick={()=>void state(data.status==='paused'?'proposed':'paused')}>{data.status==='paused'?t.resume:t.pause}</Button><Button variant="outline" className="max-sm:min-h-11" disabled={busy||change.busy} onClick={()=>void state('cancelled')}>{t.cancel}</Button></>:null}</div>
    {error?<p role="alert">{error}</p>:null}<DepartmentChangeFeedback change={change}/>
    {data.actor_user_id!==me.id?<p>{t.actor}</p>:null}
    {data.items.map(item=><article key={item.id} className="space-y-2 border-t border-border pt-3">{isResourceMigrationItem(item)?<><ResourceSummary item={item} names={registry}/><ScopeReviewEvidence job={{action:item.proposed_action.action,items:[{resourceId:item.proposed_action.resourceId,source:item.before_state.source,content:item.before_state.content,impact:item.after_state.impact??null,status:item.status==='applied'?'applied':item.status==='stale'?'stale':item.status==='cancelled'?'cancelled':'pending'}]}} names={registry}/><p>{t.resourceDisclaimer}</p></>:<><ActionSummary command={item.proposed_action} names={registry}/><ReachPreview item={item} names={registry}/></>}<p className="break-words">{item.reason}</p><p>{statusLabel(item.status,t)}</p>
      {item.diagnostic_code?<p>{migrationMessage(item.diagnostic_code,t)??t.unknownBlocker}</p>:null}
      {item.status!=='applied'?<Button variant="outline" className="max-sm:min-h-11" disabled={busy||change.busy||change.retryAvailable||expired||stopped||data.actor_user_id!==me.id||item.diagnostic_code==='scope_review_action_unsupported'} onClick={()=>void change.save(item.id,t.warning)}>{t.review}</Button>:null}
    </article>)}
  </div>;
}
