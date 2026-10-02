"use client";

/** Explicit legacy classification with persisted previews. [COMP:app-web/scope-review] */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScopeReview, ScopeReviewAction, ScopeReviewCommand, ScopeReviewInventory, ScopeReviewKind } from '@use-brian/shared';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { scopeReviewCacheKey, workspaceAccessModeCacheKey } from '@/lib/surface-prefetch';
import { useProtectedProjection } from '@/lib/use-protected-projection';
import { fetchScopeReview, fetchWorkspaceAccessMode, saveScopeReview, ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { SurfaceSkeletonFor } from '@/components/chrome/surface-skeleton';
import { DepartmentChangeFeedback, useDepartmentChange } from './use-department-change';

const fieldClass='min-h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] md:text-sm';
type EvidenceJob=Pick<ScopeReview,'action'|'expiresAt'> & {status?:ScopeReview['status'];items:Array<Pick<ScopeReview['items'][number],'resourceId'|'source'|'content'|'impact'|'status'>>};
const knownImpact=(job:Pick<EvidenceJob,'items'>)=>[...new Map(job.items.flatMap(item=>item.impact?.descendants??[]).map(row=>[`${'resourceKind' in row?row.resourceKind:'memory'}:${row.resourceId}`,row])).values()];
export function ScopeReviewPanel({teams,close}:{teams:Array<{id:string;name:string}>;close:()=>void}) {
  const {workspaceId,me}=useWorkspaceContext();
  return <ScopeReviewWorkspace key={`${workspaceId}:${me.id}`} teams={teams} close={close}/>;
}
function ScopeReviewWorkspace({teams,close}:{teams:Array<{id:string;name:string}>;close:()=>void}) {
  const {workspaceId,me}=useWorkspaceContext(),t=useT().scopeReview,a=useT().workspaceAccess;
  const [kind,setKind]=useState<ScopeReviewKind>('memory'),[after,setAfter]=useState(''),[reviewId,setReviewId]=useState(''),[reviewAfter,setReviewAfter]=useState('');
  const [includeClassified,setIncludeClassified]=useState(false);
  const [selected,setSelected]=useState<string[]>([]),[action,setAction]=useState<ScopeReviewAction>('confirm_general'),[team,setTeam]=useState(''),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const operation=useRef<{controller:AbortController;submitted:boolean}|null>(null);
  const cancelConfirmation=useCallback(()=>{if(!operation.current?.submitted)operation.current?.controller.abort();},[]);
  const key=scopeReviewCacheKey(workspaceId,me.id,kind,after,reviewId,reviewAfter,includeClassified);
  const resource=useCachedResource(key,()=>fetchScopeReview(workspaceId,kind,after||undefined,reviewId||undefined,reviewAfter||undefined,includeClassified));
  const data=useProtectedProjection(key,resource.data,()=>{cancelConfirmation();setSelected([]);},resource.refresh);
  const modeKey=workspaceAccessModeCacheKey(workspaceId,me.id);
  const modeResource=useCachedResource(modeKey,()=>fetchWorkspaceAccessMode(workspaceId));
  const mode=useProtectedProjection(modeKey,modeResource.error?undefined:modeResource.data,()=>{cancelConfirmation();setSelected([]);},modeResource.refresh);
  const defaultTeam=mode?.canAdminister?mode.defaultDepartmentId:null;
  const [now,setNow]=useState(Date.now());
  const expiresAt=data?.selectedReview?.expiresAt;
  useEffect(()=>{
    setNow(Date.now());
    if(!expiresAt)return;
    const delay=Date.parse(expiresAt)-Date.now();
    if(!Number.isFinite(delay)||delay<=0)return;
    const timer=setTimeout(()=>{cancelConfirmation();setNow(Date.now());},Math.min(delay,2_147_483_647));
    return()=>clearTimeout(timer);
  },[expiresAt,cancelConfirmation]);
  const activation=useDepartmentChange(workspaceId,async()=>{invalidateSurfaceCache(`scope-review:${workspaceId}:`);await resource.refresh();},`${me.id}:strict-activation`);
  useEffect(()=>{
    const purge=(event:Event)=>{const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;if(event.type===WORKSPACE_IDENTITY_REFRESH_EVENT)operation.current?.controller.abort();else cancelConfirmation();setSelected([]);invalidateSurfaceCache(`scope-review:${workspaceId}:`);invalidateSurfaceCache(modeKey);};
    const visible=()=>{if(document.visibilityState==='visible')cancelConfirmation();};
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    window.addEventListener('focus',cancelConfirmation);document.addEventListener('visibilitychange',visible);
    return()=>{operation.current?.controller.abort();window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);window.removeEventListener('focus',cancelConfirmation);document.removeEventListener('visibilitychange',visible);};
  },[workspaceId,modeKey,cancelConfirmation]);
  const reviewExpired=(review:ScopeReview)=>review.expiresAt?!(Date.parse(review.expiresAt)>Math.max(now,Date.now())):review.action==='consolidate_default';
  const save=async(command:ScopeReviewCommand)=>{
    if(operation.current||!data)return;
    const job=data?.selectedReview;
    if(command.type!=='scope.review.preview'){
      if(!job||job.id!==command.reviewId||job.version!==command.expectedVersion||job.payloadHash!==command.payloadHash)return;
      if(command.type==='scope.review.apply'&&(job.status!=='preview'&&job.status!=='running'||reviewExpired(job)||job.items.some(item=>!item.impact||job.action==='consolidate_default'&&(item.impact.version!==2||!item.impact.consolidation))))return;
    }
    const active={controller:new AbortController(),submitted:false};
    operation.current=active;setBusy(true);setError('');
    const remaining=()=>Math.min(data.projectionDeadline-Date.now(),data.projectionMonotonicDeadline-performance.now(),command.type==='scope.review.apply'&&job?.expiresAt?Date.parse(job.expiresAt)-Date.now():Infinity,command.type==='scope.review.preview'&&command.action==='consolidate_default'?mode?Math.min(mode.projectionDeadline-Date.now(),mode.projectionMonotonicDeadline-performance.now()):0:Infinity);
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      if(!Number.isFinite(remaining())||remaining()<=0)return;
      timeout=setTimeout(()=>active.controller.abort(),Math.ceil(remaining()));
      if(command.type!=='scope.review.preview'&&job){
      const target=job.targetTeamId?teams.find(team=>team.id===job.targetTeamId)?.name??job.targetCompartment:t.general;
      const impact=knownImpact(job);
      if(!await confirmDialog({signal:active.controller.signal,title:t.confirmTitle,description:`${t[job.action]}: ${target}. ${job.reason}. ${job.items.filter(item=>item.status==='pending').length} ${t.pending}. ${command.type==='scope.review.cancel'?t.cancelHint:`${t.applyHint} ${t.impactCount}: ${impact.length}. ${t.alreadyHeld}: ${impact.filter(row=>row.held).length}. ${t.impactHint}`} ${job.action==='consolidate_default'?`${t.scopeOnly} ${t.futureMembers}`:t.generalHint} ${t.coverage}`,confirmLabel:a.confirm,cancelLabel:a.cancel}))return;
      }
      if(active.controller.signal.aborted||remaining()<=0)return;
      clearTimeout(timeout);timeout=undefined;active.submitted=true;
      const result=await saveScopeReview(workspaceId,command);
      if(active.controller.signal.aborted)return;
      setReviewId(result.id);setSelected([]);invalidateSurfaceCache(`scope-review:${workspaceId}:`);
    }
    catch(error){if(!active.controller.signal.aborted){setError(error instanceof Error&&error.message==='scope_review_impact_too_large'?t.impactTooLarge:error instanceof Error&&error.message==='scope_review_impact_missing'?t.impactMissing:t.saveError);invalidateSurfaceCache(key);}}
    finally{clearTimeout(timeout);if(operation.current===active){operation.current=null;setBusy(false);}}
  };
  const sensitivityLabel=(value:string|null)=>value==='public'?t.public:value==='internal'?t.internal:value==='confidential'?t.confidential:t.unknown;
  const picker=(label:string,value:string,onChange:(v:string)=>void,items:Array<{value:string;label:string}>)=><label className="grid min-w-0 gap-1 text-sm"><span>{label}</span><SearchableSelect aria-label={label} placeholder={label} value={value} onValueChange={onChange} items={items} disabled={busy} className="min-h-11 min-w-0 max-w-full" searchPlaceholder={a.search} emptyMessage={a.noResults}/></label>;
  const header=(mode?:ScopeReviewInventory['classificationMode'])=><header className="space-y-3"><Button variant="outline" className="min-h-11" onClick={close}>{t.back}</Button><Button variant="ghost" className="min-h-11" disabled={busy} onClick={()=>{setSelected([]);setError('');invalidateSurfaceCache(key);invalidateSurfaceCache(modeKey);}}>{a.reload}</Button><h1 className="text-xl font-semibold">{t.title}</h1><p className="text-sm">{t.generalHint}</p><p role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{mode==='strict'?t.activationActive:t.coverage}</p></header>;
  if(!data)return <section className="space-y-4 p-4">{header()}{resource.error?<><p role="alert">{t.loadError}</p><Button className="min-h-11" onClick={()=>void resource.refresh()}>{a.reload}</Button></>:<SurfaceSkeletonFor surface="organization" chrome={false}/>}</section>;
  const job=data.selectedReview,canApply=job&&(job.status==='preview'||job.status==='running');
  const impactMissing=job?.items.some(item=>!item.impact||job.action==='consolidate_default'&&(item.impact.version!==2||!item.impact.consolidation));
  const selectedRows=data.items.filter(row=>selected.includes(row.id));
  const classificationBlocked=action==='consolidate_default'?(!defaultTeam||selectedRows.some(row=>row.held)):action!=='hold'&&selectedRows.some(row=>!row.canClassify);
  const unsupportedAction=selectedRows.some(row=>!row.allowedActions.includes(action));
  const reviewOptions=job&&!data.recentReviews.some(review=>review.id===job.id)?[job,...data.recentReviews]:data.recentReviews;
  return <section className="min-w-0 space-y-5 p-4 md:p-6">{header(data.classificationMode)}
    {error||resource.error?<p role="alert" className="text-sm text-destructive">{error||t.loadError}</p>:null}
    <article className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">{t.activationTitle}</h2>
      <p className="text-sm">{t.classificationMode}: {t[data.classificationMode]}</p>
      {data.classificationMode==='strict'?<p role="status" className="text-sm">{t.activationActive}</p>:<>
        <p className="text-sm">{data.canActivateStrict?t.activationReady:t.activationBlocked}</p>
        {!data.completeCoverage?<p className="break-words text-sm">{t.coverageBlockers}: {data.uncovered.join(', ')||t.unknown}</p>:null}
        {!data.readiness.ready?<p className="break-words text-sm">{t.readinessBlockers}: {data.readiness.missingCapabilities.join(', ')||t.unknown}</p>:null}
        <Button className="min-h-11" disabled={busy||activation.busy||!data.canActivateStrict} onClick={()=>void activation.save({type:'workspace.classification.set',mode:'strict',expectedPolicyRevision:data.policyRevision,expectedInventoryRevision:data.registryRevision},`${t.activationConfirm} ${t.inventoryRevision}: ${data.registryRevision}.`,data.policyRevision)}>{t.activateStrict}</Button>
        <DepartmentChangeFeedback change={activation}/>
      </>}
    </article>
    <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">{picker(t.kind,kind,v=>{setKind(v as ScopeReviewKind);setAfter('');setSelected([]);},data.supportedKinds.map(k=>({value:k,label:t[k]})))}{picker(t.recent,reviewId,id=>{setReviewId(id);setSelected([]);},[{value:'',label:t.newReview},...reviewOptions.map(r=>({value:r.id,label:`${t[r.resourceKind]} · ${t[r.action]} · ${t[r.status]} · ${r.id}`}))])}</div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={busy||!reviewAfter} onClick={()=>{setReviewAfter('');setSelected([]);}}>{t.latestReviews}</Button><Button variant="outline" className="min-h-11" disabled={busy||!data.nextReviewCursor} onClick={()=>{setReviewAfter(data.nextReviewCursor??'');setSelected([]);}}>{t.olderReviews}</Button></div>
    {job?<article className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">{t.savedPreview}: {t[job.status]}</h2>
      <p className="break-words text-sm">{t[job.resourceKind]} · {t[job.action]}{job.targetTeamId?` · ${teams.find(row=>row.id===job.targetTeamId)?.name??job.targetCompartment}`:''}</p>
      <p className="break-words text-sm">{job.reason}</p><p className="text-sm">{t.applied}: {job.items.filter(i=>i.status==='applied').length} / {job.items.length}</p>
      <ScopeReviewEvidence job={job} expired={reviewExpired(job)}/>
      {canApply?<div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy||impactMissing||reviewExpired(job)} onClick={()=>void save({type:'scope.review.apply',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})}>{t.apply}</Button><Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void save({type:'scope.review.cancel',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})}>{t.cancelReview}</Button></div>:null}
      <Button variant="ghost" className="min-h-11" disabled={busy} onClick={()=>{setReviewId('');setSelected([]);}}>{t.newReview}</Button>
    </article>:<form className="space-y-4" onSubmit={event=>{event.preventDefault();if(!selectedRows.length||selectedRows.length!==selected.length||!reason.trim()||unsupportedAction||(action==='assign_team'&&!team)|| classificationBlocked)return;void save({type:'scope.review.preview',resourceKind:kind,resourceIds:selected,action,targetTeamId:action==='consolidate_default'?defaultTeam:action==='assign_team'?team:null,reason});}}>
      <label className="flex min-h-11 items-center gap-3 text-sm"><Checkbox aria-label={t.includeClassified} checked={includeClassified} disabled={busy} onCheckedChange={checked=>{cancelConfirmation();setSelected([]);setAfter('');setIncludeClassified(checked===true);invalidateSurfaceCache(`scope-review:${workspaceId}:`);}}/>{t.includeClassified}</label>
      <h2 className="font-semibold">{t.inventory}: {data.total}</h2><p className="text-sm text-muted-foreground">{t.metadataHint}</p>
      {!data.items.length?<p className="text-sm">{t.empty}</p>:null}
      <ul className="space-y-2">{data.items.map(row=><li key={row.id} className="rounded-lg border border-border p-3"><label className="flex min-h-11 items-start gap-3 text-sm"><Checkbox aria-label={`${t.select} ${row.id}`} checked={selected.includes(row.id)} disabled={busy} onCheckedChange={checked=>setSelected(ids=>checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/><span className="min-w-0 break-words"><strong className="block">{row.content.title}</strong><span className="line-clamp-3 block whitespace-pre-wrap">{row.content.text}</span><span className="font-mono">{row.id}</span><span className="block">{t.clearance}: {sensitivityLabel(row.sensitivity)} · {row.held?t.held:row.canClassify?t.unreviewed:t.historical}</span><span className="block">{t.departments}: {row.compartments?.join(', ')||t.general} · {t.visibility}: {row.userId||row.assistantId?t.private:t.workspace} · {t.projects}: {row.projectIds?.length??0}</span></span></label></li>)}</ul>
      <div className="flex flex-wrap gap-2"><Button variant="outline" type="button" className="min-h-11" disabled={busy||!after} onClick={()=>{setAfter('');setSelected([]);}}>{t.first}</Button><Button variant="outline" type="button" className="min-h-11" disabled={busy||!data.nextCursor} onClick={()=>{setAfter(data.nextCursor??'');setSelected([]);}}>{t.next}</Button></div>
      {picker(t.action,action,value=>setAction(value as ScopeReviewAction),(['confirm_general','assign_team','consolidate_default','hold'] as const).map(value=>({value,label:t[value]})))}
      {action==='consolidate_default'?<p role="status" className="text-sm">{t.defaultTarget}: {defaultTeam?(mode?.defaultDepartmentName??defaultTeam):t.defaultUnavailable}. {t.scopeOnly}</p>:null}
      {action==='assign_team'?picker(a.team,team,setTeam,teams.map(row=>({value:row.id,label:row.name}))):null}
      <label className="grid gap-1 text-sm">{a.reason}<textarea className={`${fieldClass} min-h-24 py-2`} required maxLength={1000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
      {classificationBlocked&&(action!=='consolidate_default'||selectedRows.some(row=>row.held))?<p role="alert" className="text-sm">{t.releaseRequired}</p>:null}
      {unsupportedAction?<p role="alert" className="text-sm">{t.actionUnsupported}</p>:null}
      <Button type="submit" className="min-h-11" disabled={busy||unsupportedAction||!selectedRows.length||!reason.trim()||(action==='assign_team'&&!team)||classificationBlocked}>{t.createPreview} ({selectedRows.length})</Button>
    </form>}
  </section>;
}

/** Frozen source/impact evidence. No mutation controls or inferred permissions. */
export function ScopeReviewEvidence({job,expired=false,expiresAt=job.expiresAt,names}:{job:EvidenceJob;expired?:boolean;expiresAt?:string|null;names?:{people:Array<{id:string;name:string}>;assistants:Array<{id:string;name:string}>}}){
  const dictionary=useT(),t=dictionary.scopeReview,m=dictionary.accessMigration;
  const impact=knownImpact(job),impactMissing=job.items.some(item=>!item.impact||job.action==='consolidate_default'&&(item.impact.version!==2||!item.impact.consolidation));
  const sensitivityLabel=(value:string|null)=>value==='public'?t.public:value==='internal'?t.internal:value==='confidential'?t.confidential:t.unknown;
  const name=(id:string,kind:'people'|'assistants')=>{const label=names?.[kind].find(row=>row.id===id)?.name;return label?`${label} (${id})`:id;};
  return <div className="min-w-0 space-y-3">
      {impactMissing?<p role="alert" className="text-sm">{t.impactMissing}</p>:<div className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm">
        <h3 className="font-semibold">{t.impactTitle}</h3><p>{t.impactCount}: {impact.length} · {t.alreadyHeld}: {impact.filter(row=>row.held).length}</p><p>{t.impactHint}</p>
        {impact.length?<details><summary className="min-h-11 cursor-pointer py-3">{t.impactRecords}</summary><ul className="max-h-64 space-y-2 overflow-auto">{impact.map(row=><li key={row.resourceId} className="break-all"><span className="font-mono">{row.resourceId}</span>{row.held?` · ${t.held}`:''}</li>)}</ul></details>:null}
      </div>}
      {expiresAt?<p className="text-sm">{t.expires}: <time dateTime={expiresAt}>{expiresAt}</time></p>:null}
      {expired?<p role="alert" className="text-sm">{t.expired}</p>:null}
      {job.action==='consolidate_default'?<div className="space-y-3 text-sm"><p>{t.scopeOnly}</p><p role="alert">{t.futureMembers}</p>{job.items.map(item=>{const snapshot=item.impact?.version===2?item.impact.consolidation:undefined;return snapshot?<div key={item.resourceId} className="space-y-2 break-words rounded-lg border border-border p-3"><strong>{item.resourceId}</strong>{(['before','after'] as const).map(side=><p key={side}>{t[side]}: {t.departments}: {snapshot[side].compartments?.join(', ')||t.general} · {t.clearance}: {sensitivityLabel(snapshot[side].sensitivity)} · {t.visibility}: {snapshot.visibility.visibility==='private'?t.private:snapshot.visibility.visibility==='workspace'?t.workspace:t.unknown} · {t.projects}: {snapshot[side].projectIds?.join(', ')||t.none}</p>)}<p>{t.visibility}: {snapshot.visibility.visibility==='private'?t.private:snapshot.visibility.visibility==='workspace'?t.workspace:t.unknown} · {t.person}: {typeof snapshot.visibility.userId==='string'?snapshot.visibility.userId:t.none} · {t.assistant}: {typeof snapshot.visibility.assistantId==='string'?snapshot.visibility.assistantId:t.none}</p><h3>{t.audienceScope}</h3><ul className="max-h-64 space-y-2 overflow-auto">{snapshot.audiences.map(row=><li key={`${row.userId}:${row.assistantId}`} className="break-all">{t.person}: {name(row.userId,'people')} · {t.assistant}: {row.assistantId?name(row.assistantId,'assistants'):t.none}<p>{t.readScope}: {row.readBefore?t.matches:t.noMatch} → {row.readAfter?t.matches:t.noMatch} · {t.editScope}: {row.editBefore?t.matches:t.noMatch} → {row.editAfter?t.matches:t.noMatch}</p></li>)}</ul></div>:null;})}</div>:null}
      {job.status==='stale'?<p role="alert" className="text-sm">{t.staleHint}</p>:null}
      <ul className="max-h-80 space-y-2 overflow-auto">{job.items.map(item=><li key={item.resourceId} className="break-words rounded-lg bg-muted/30 p-3 text-sm"><strong>{item.content?.title??t.unknown}</strong><p className="line-clamp-3 whitespace-pre-wrap">{item.content?.text??t.unknown}</p><span className="font-mono">{item.resourceId}</span><p>{t[item.status]} · {t.clearance}: {sensitivityLabel(item.source.sensitivity)} · {t.departments}: {item.source.compartments?.join(', ')||t.general}</p><p>{t.visibility}: {item.source.userId||item.source.assistantId?t.private:t.workspace} · {t.projects}: {item.source.projectIds?.length??0}</p></li>)}</ul>
    {job.items.map(item=>{const floor=item.impact?.version===2?item.impact.consolidation?.sourceFloor:undefined;return floor?<section key={item.resourceId} className="space-y-2 rounded-lg border border-border p-3 text-sm"><h4 className="font-semibold">{m.sourceFloor}</h4><p>{m.floorWarning}</p><ul>{floor.nodes.map(node=><li key={`${node.resourceKind}:${node.resourceId}`} className="break-words">{node.resourceId} · {t.clearance}: {sensitivityLabel(node.sensitivity)} · {t.departments}: {node.compartments?.join(', ')||t.general} · {t.projects}: {node.projectIds?.join(', ')||t.none} · {t.visibility}: {node.userId||node.assistantId?t.private:t.workspace}</li>)}</ul></section>:null;})}
  </div>;
}
