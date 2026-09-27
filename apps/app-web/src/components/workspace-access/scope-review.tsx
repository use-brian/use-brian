"use client";

/** Explicit legacy classification with persisted previews. [COMP:app-web/scope-review] */
import { useEffect, useState } from 'react';
import type { ScopeReview, ScopeReviewAction, ScopeReviewCommand, ScopeReviewKind } from '@use-brian/shared';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { scopeReviewCacheKey } from '@/lib/surface-prefetch';
import { useProtectedProjection } from '@/lib/use-protected-projection';
import { fetchScopeReview, saveScopeReview, ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { SurfaceSkeletonFor } from '@/components/chrome/surface-skeleton';

const fieldClass='min-h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] md:text-sm';
const knownImpact=(job:ScopeReview)=>[...new Map(job.items.flatMap(item=>item.impact?.descendants??[]).map(row=>[row.resourceId,row])).values()];
export function ScopeReviewPanel({teams,close}:{teams:Array<{id:string;name:string}>;close:()=>void}) {
  const {workspaceId,me}=useWorkspaceContext(),t=useT().scopeReview,a=useT().workspaceAccess;
  const [kind,setKind]=useState<ScopeReviewKind>('memory'),[after,setAfter]=useState(''),[reviewId,setReviewId]=useState(''),[reviewAfter,setReviewAfter]=useState('');
  const [selected,setSelected]=useState<string[]>([]),[action,setAction]=useState<ScopeReviewAction>('confirm_general'),[team,setTeam]=useState(''),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=scopeReviewCacheKey(workspaceId,me.id,kind,after,reviewId,reviewAfter);
  const resource=useCachedResource(key,()=>fetchScopeReview(workspaceId,kind,after||undefined,reviewId||undefined,reviewAfter||undefined));
  const data=useProtectedProjection(key,resource.data,()=>setSelected([]),resource.refresh);
  useEffect(()=>{
    const purge=(event:Event)=>{const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;setSelected([]);invalidateSurfaceCache(`scope-review:${workspaceId}:`);};
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};
  },[workspaceId]);
  const save=async(command:ScopeReviewCommand)=>{
    if(busy)return;
    const job=data?.selectedReview;
    if(command.type!=='scope.review.preview'){
      if(!job||job.id!==command.reviewId||job.version!==command.expectedVersion||job.payloadHash!==command.payloadHash)return;
      if(command.type==='scope.review.apply'&&job.items.some(item=>!item.impact))return;
      const target=job.targetTeamId?teams.find(team=>team.id===job.targetTeamId)?.name??job.targetCompartment:t.general;
      const impact=knownImpact(job);
      if(!await confirmDialog({title:t.confirmTitle,description:`${t[job.action]}: ${target}. ${job.reason}. ${job.items.filter(item=>item.status==='pending').length} ${t.pending}. ${command.type==='scope.review.cancel'?t.cancelHint:`${t.applyHint} ${t.impactCount}: ${impact.length}. ${t.alreadyHeld}: ${impact.filter(row=>row.held).length}. ${t.impactHint}`} ${t.generalHint} ${t.coverage}`,confirmLabel:a.confirm,cancelLabel:a.cancel}))return;
    }
    setBusy(true);setError('');
    try{const result=await saveScopeReview(workspaceId,command);setReviewId(result.id);setSelected([]);invalidateSurfaceCache(`scope-review:${workspaceId}:`);}
    catch(error){setError(error instanceof Error&&error.message==='scope_review_impact_too_large'?t.impactTooLarge:error instanceof Error&&error.message==='scope_review_impact_missing'?t.impactMissing:t.saveError);invalidateSurfaceCache(key);}
    finally{setBusy(false);}
  };
  const sensitivityLabel=(value:string)=>value==='public'?t.public:value==='internal'?t.internal:value==='confidential'?t.confidential:t.unknown;
  const picker=(label:string,value:string,onChange:(v:string)=>void,items:Array<{value:string;label:string}>)=><label className="grid min-w-0 gap-1 text-sm"><span>{label}</span><SearchableSelect aria-label={label} placeholder={label} value={value} onValueChange={onChange} items={items} disabled={busy} className="min-h-11 min-w-0 max-w-full" searchPlaceholder={a.search} emptyMessage={a.noResults}/></label>;
  const header=<header className="space-y-3"><Button variant="outline" className="min-h-11" onClick={close}>{t.back}</Button><Button variant="ghost" className="min-h-11" disabled={busy} onClick={()=>{setSelected([]);setError('');invalidateSurfaceCache(key);}}>{a.reload}</Button><h1 className="text-xl font-semibold">{t.title}</h1><p className="text-sm">{t.generalHint}</p><p role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{t.coverage}</p></header>;
  if(!data)return <section className="space-y-4 p-4">{header}{resource.error?<><p role="alert">{t.loadError}</p><Button className="min-h-11" onClick={()=>void resource.refresh()}>{a.reload}</Button></>:<SurfaceSkeletonFor surface="organization"/>}</section>;
  const job=data.selectedReview,canApply=job&&(job.status==='preview'||job.status==='running');
  const impact=job?knownImpact(job):[],impactMissing=job?.items.some(item=>!item.impact);
  const selectedRows=data.items.filter(row=>selected.includes(row.id));
  const reviewOptions=job&&!data.recentReviews.some(review=>review.id===job.id)?[job,...data.recentReviews]:data.recentReviews;
  return <section className="min-w-0 space-y-5 p-4 md:p-6">{header}
    {error||resource.error?<p role="alert" className="text-sm text-destructive">{error||t.loadError}</p>:null}
    <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">{picker(t.kind,kind,v=>{setKind(v as ScopeReviewKind);setAfter('');setSelected([]);},data.supportedKinds.map(k=>({value:k,label:t[k]})))}{picker(t.recent,reviewId,id=>{setReviewId(id);setSelected([]);},[{value:'',label:t.newReview},...reviewOptions.map(r=>({value:r.id,label:`${t[r.resourceKind]} · ${t[r.action]} · ${t[r.status]} · ${r.id}`}))])}</div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={busy||!reviewAfter} onClick={()=>{setReviewAfter('');setSelected([]);}}>{t.latestReviews}</Button><Button variant="outline" className="min-h-11" disabled={busy||!data.nextReviewCursor} onClick={()=>{setReviewAfter(data.nextReviewCursor??'');setSelected([]);}}>{t.olderReviews}</Button></div>
    {job?<article className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">{t.savedPreview}: {t[job.status]}</h2>
      <p className="break-words text-sm">{t[job.resourceKind]} · {t[job.action]}{job.targetTeamId?` · ${teams.find(row=>row.id===job.targetTeamId)?.name??job.targetCompartment}`:''}</p>
      <p className="break-words text-sm">{job.reason}</p><p className="text-sm">{t.applied}: {job.items.filter(i=>i.status==='applied').length} / {job.items.length}</p>
      {impactMissing?<p role="alert" className="text-sm">{t.impactMissing}</p>:<div className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm">
        <h3 className="font-semibold">{t.impactTitle}</h3><p>{t.impactCount}: {impact.length} · {t.alreadyHeld}: {impact.filter(row=>row.held).length}</p><p>{t.impactHint}</p>
        {impact.length?<details><summary className="min-h-11 cursor-pointer py-3">{t.impactRecords}</summary><ul className="max-h-64 space-y-2 overflow-auto">{impact.map(row=><li key={row.resourceId} className="break-all"><span className="font-mono">{row.resourceId}</span>{row.held?` · ${t.held}`:''}</li>)}</ul></details>:null}
      </div>}
      {job.status==='stale'?<p role="alert" className="text-sm">{t.staleHint}</p>:null}
      <ul className="max-h-80 space-y-2 overflow-auto">{job.items.map(item=><li key={item.resourceId} className="break-words rounded-lg bg-muted/30 p-3 text-sm"><span className="font-mono">{item.resourceId}</span><p>{t[item.status]} · {t.clearance}: {sensitivityLabel(item.source.sensitivity)} · {t.departments}: {item.source.compartments.join(', ')||t.general}</p><p>{t.visibility}: {item.source.userId||item.source.assistantId?t.private:t.workspace} · {t.projects}: {item.source.projectIds.length}</p></li>)}</ul>
      {canApply?<div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy||impactMissing} onClick={()=>void save({type:'scope.review.apply',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})}>{t.apply}</Button><Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void save({type:'scope.review.cancel',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})}>{t.cancelReview}</Button></div>:null}
      <Button variant="ghost" className="min-h-11" disabled={busy} onClick={()=>{setReviewId('');setSelected([]);}}>{t.newReview}</Button>
    </article>:<form className="space-y-4" onSubmit={event=>{event.preventDefault();if(!selectedRows.length||selectedRows.length!==selected.length||!reason.trim()||(action==='assign_team'&&!team)|| (action!=='hold'&&selectedRows.some(r=>!r.canClassify)))return;void save({type:'scope.review.preview',resourceKind:kind,resourceIds:selected,action,targetTeamId:action==='assign_team'?team:null,reason});}}>
      <h2 className="font-semibold">{t.inventory}: {data.total}</h2><p className="text-sm text-muted-foreground">{t.metadataHint}</p>
      {!data.items.length?<p className="text-sm">{t.empty}</p>:null}
      <ul className="space-y-2">{data.items.map(row=><li key={row.id} className="rounded-lg border border-border p-3"><label className="flex min-h-11 items-start gap-3 text-sm"><Checkbox aria-label={`${t.select} ${row.id}`} checked={selected.includes(row.id)} disabled={busy} onCheckedChange={checked=>setSelected(ids=>checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/><span className="min-w-0 break-words"><span className="font-mono">{row.id}</span><span className="block">{t.clearance}: {sensitivityLabel(row.sensitivity)} · {row.held?t.held:row.canClassify?t.unreviewed:t.historical}</span><span className="block">{t.departments}: {row.compartments.join(', ')||t.general} · {t.visibility}: {row.userId||row.assistantId?t.private:t.workspace} · {t.projects}: {row.projectIds.length}</span></span></label></li>)}</ul>
      <div className="flex flex-wrap gap-2"><Button variant="outline" type="button" className="min-h-11" disabled={busy||!after} onClick={()=>{setAfter('');setSelected([]);}}>{t.first}</Button><Button variant="outline" type="button" className="min-h-11" disabled={busy||!data.nextCursor} onClick={()=>{setAfter(data.nextCursor??'');setSelected([]);}}>{t.next}</Button></div>
      {picker(t.action,action,value=>setAction(value as ScopeReviewAction),(['confirm_general','assign_team','hold'] as const).map(value=>({value,label:t[value]})))}
      {action==='assign_team'?picker(a.team,team,setTeam,teams.map(row=>({value:row.id,label:row.name}))):null}
      <label className="grid gap-1 text-sm">{a.reason}<textarea className={`${fieldClass} min-h-24 py-2`} required maxLength={1000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
      {action!=='hold'&&selectedRows.some(row=>!row.canClassify)?<p role="alert" className="text-sm">{t.releaseRequired}</p>:null}
      <Button type="submit" className="min-h-11" disabled={busy||!selectedRows.length||!reason.trim()||(action==='assign_team'&&!team)||(action!=='hold'&&selectedRows.some(row=>!row.canClassify))}>{t.createPreview} ({selectedRows.length})</Button>
    </form>}
  </section>;
}
