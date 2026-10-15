"use client";

/** Scoped Chat pickup. No send, assignment, work execution or reminder port.
 * [COMP:app-web/client-delivery-oversight]
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/skeleton";
import { format, useLocale, useT } from "@/lib/i18n/client";
import { fetchDeliveryCommitments, fetchDeliveryDetail, executeDeliveryCommand,
  type DeliveryPage, type DeliveryDetail, type DeliveryUiCommand } from "@/lib/api/crm-delivery-oversight";
import { CrmReferenceRequestError } from "@/lib/api/crm-references";
import type { WorkScope } from "@/lib/api/work";
import { deliveryCommitmentsCacheKey, deliveryDetailCacheKey } from "@/lib/surface-prefetch";
import { invalidateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { projectionRemainingMs, useProtectedProjection, type ProtectedProjection } from "@/lib/use-protected-projection";
import { workspaceSearchHref } from "@/lib/workspace-search-navigation";
import { brainRowUrl } from "@/lib/brain-deep-link";

const lifecycle={expiresInMs:projectionRemainingMs,keepInflightOnExpiry:true};
export function ClientDeliveryOversight({workspaceId,scope,onDraft,chatId,hideWhenEmpty=true}:{
  workspaceId:string;scope:WorkScope;onDraft:(draft:string)=>void;chatId?:string;hideWhenEmpty?:boolean;
}) {
  const t=useT().clientDelivery;
  const [cursor,setCursor]=useState<string|undefined>();
  const [selected,setSelected]=useState<string|null>(null);
  const scopeKey=deliveryCommitmentsCacheKey(workspaceId,scope,'',chatId);
  const key=deliveryCommitmentsCacheKey(workspaceId,scope,cursor,chatId);
  const resource=useCachedResource<ProtectedProjection<DeliveryPage>>(key,()=>fetchDeliveryCommitments(workspaceId,scope,cursor,chatId),lifecycle);
  const page=useProtectedProjection(key,resource.data,()=>setSelected(null));
  useEffect(()=>{setCursor(undefined);setSelected(null)},[scopeKey]);
  if(!page) return resource.error ? <div role="alert" className="space-y-2 text-sm"><p>{t.unavailable}</p><Button variant="outline" onClick={()=>void resource.refresh()} className="min-h-8 max-sm:min-h-11">{t.retry}</Button></div>
    : <div aria-label={t.loading} className="space-y-2"><Skeleton className="h-8 w-40"/><Skeleton className="h-11 w-full"/></div>;
  if(page.commitments.length===0)return hideWhenEmpty?null:<p className="text-sm text-muted-foreground">{t.empty}</p>;
  return <section aria-label={t.title} className="min-w-0 space-y-3 border-t pt-3" data-testid="client-delivery-oversight">
    <h2 className="text-sm font-medium">{t.title}</h2>
    <ul className="space-y-1">
      {page.commitments.map(c=><li key={c.id} className="min-w-0">
        <button type="button" className="flex min-h-8 max-sm:min-h-11 w-full min-w-0 flex-col items-start gap-1 rounded px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2"
          aria-expanded={selected===c.id} aria-label={`${t.inspect}: ${c.outcome}`} onClick={()=>{if(projectionRemainingMs(page)>0)setSelected(c.id)}}>
          <span className="break-words font-medium">{c.outcome}</span>
          <span className="text-xs text-muted-foreground">{t.recognition[c.recognitionState]}</span>
          {c.dueDate?<span className="text-xs text-muted-foreground">{format(t.due,{date:c.dueDate})}</span>:null}
        </button>
        {selected===c.id?<DeliveryDetailPane key={`${scopeKey}:${c.id}`} workspaceId={workspaceId} id={c.id} chatId={chatId}
          onClose={()=>setSelected(null)} onDraft={onDraft}/>:null}
      </li>)}
    </ul>
    {page.nextCursor?<Button variant="outline" className="min-h-8 max-sm:min-h-11" onClick={()=>{setSelected(null);setCursor(page.nextCursor!)}}>{t.more}</Button>:null}
  </section>;
}

function DeliveryDetailPane({workspaceId,id,chatId,onClose,onDraft}:{workspaceId:string;id:string;chatId?:string;onClose:()=>void;onDraft:(draft:string)=>void}) {
  const t=useT().clientDelivery,locale=useLocale();
  const key=deliveryDetailCacheKey(workspaceId,id,chatId);
  const keyRef=useRef(key);keyRef.current=key;
  const resource=useCachedResource<ProtectedProjection<DeliveryDetail>>(key,()=>fetchDeliveryDetail(workspaceId,id,chatId),lifecycle);
  const [reviewing,setReviewing]=useState(false),[reason,setReason]=useState(''),[outcome,setOutcome]=useState('');
  const [pending,setPending]=useState(false),[error,setError]=useState<'failed'|'uncertain'|null>(null);
  const controller=useRef(new AbortController()),latched=useRef(false),retry=useRef<DeliveryUiCommand|null>(null);
  const data=useProtectedProjection(key,resource.data,()=>{
    controller.current.abort();controller.current=new AbortController();setReviewing(false);setReason('');setOutcome('');retry.current=null;
  });
  useEffect(()=>()=>controller.current.abort(),[key]);
  const time=(value:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
  async function apply(command:DeliveryUiCommand) {
    if(latched.current||!data||projectionRemainingMs(data)<=0)return;
    latched.current=true;setPending(true);setError(null);
    try {
      retry.current=command;
      await executeDeliveryCommand(workspaceId,command);
      if(keyRef.current!==key)return;
      retry.current=null;setReviewing(false);setReason('');
      invalidateSurfaceCache(`delivery:${workspaceId}:`);
    } catch(cause) {
      if(keyRef.current!==key)return;
      const uncertain=cause instanceof CrmReferenceRequestError&&cause.uncertain;
      setError(uncertain?'uncertain':'failed');
      if(!uncertain){retry.current=null;invalidateSurfaceCache(`delivery:${workspaceId}:`)}
    } finally {latched.current=false;if(keyRef.current===key)setPending(false)}
  }
  async function review(decision:'recognise'|'correct'|'dismiss') {
    if(!data||!reason.trim()||pending||latched.current||projectionRemainingMs(data)<=0)return;
    const command:DeliveryUiCommand={kind:'review_delivery_recognition',operationId:crypto.randomUUID(),commitmentId:id,expectedVersion:data.commitment.version,
      decision,reason:reason.trim(),...(decision==='correct'?{outcome:outcome.trim()}:{} )};
    const source=data.commitment.source.quote;
    latched.current=true;setPending(true);
    let accepted=false;
    try { accepted=await confirmDialog({signal:controller.current.signal,title:t.confirmTitle,
      description:format(t.confirmDescription,{outcome:decision==='correct'?outcome:data.commitment.outcome}),
      content:<blockquote className="whitespace-pre-wrap break-words text-sm">{source}</blockquote>,confirmLabel:t[decision],cancelLabel:t.cancel});
    } finally { latched.current=false;setPending(false); }
    if(accepted&&keyRef.current===key&&!controller.current.signal.aborted)await apply(command);
  }
  if(!data)return <div className="space-y-2 px-2 py-3">{resource.error?<><p role="alert" className="text-sm">{t.unavailable}</p><Button className="min-h-8 max-sm:min-h-11" variant="outline" onClick={()=>void resource.refresh()}>{t.retry}</Button></>:<div aria-label={t.loading}><Skeleton className="h-20 w-full"/></div>}</div>;
  const {commitment:c,assessment:a,observations,linkedWork=[]}=data;
  const actionWork=a.nextAction?linkedWork.find(w=>w.id===a.nextAction!.workId):undefined;
  return <div className="min-w-0 space-y-3 px-2 py-3 text-sm" data-testid="delivery-detail">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t.evidence}</h3><Button variant="ghost" className="min-h-8 max-sm:min-h-11" onClick={onClose}>{t.close}</Button></div>
    <p>{t.coverage[a.coverage]}</p><p>{t.outcomes[a.outcome]}</p>
    {a.lastKnownAt?<p className="text-xs text-muted-foreground">{format(t.lastKnown,{time:time(a.lastKnownAt)})}</p>:<p className="text-muted-foreground">{t.noObservation}</p>}
    <p className="text-xs text-muted-foreground">{format(t.evaluated,{time:time(a.evaluatedAt)})}</p>
    {a.partial||data.evidenceCursor?<p>{t.partial}</p>:null}
    {c.agreeingName?<p>{format(t.agreedBy,{name:c.agreeingName})}</p>:null}
    <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3">{c.source.quote}</blockquote>
    {c.sourceNavigation?<Link className="inline-flex min-h-8 max-sm:min-h-11 items-center underline" href={workspaceSearchHref(workspaceId,c.sourceNavigation)}>{t.openSource}</Link>:null}
    {observations.map(o=><div key={o.id} className="space-y-1 border-t pt-2">
      <p className="font-medium">{t.evidenceKinds[o.kind]}</p><p className="whitespace-pre-wrap break-words">{o.statement}</p>
      <p className="text-xs text-muted-foreground">{o.kind==='human_report'?format(t.reportedWho,{name:o.reporterName??t.unknownReporter,time:time(o.occurredAt)}):format(t.observedAt,{time:time(o.occurredAt)})}</p>
      {o.sourceNavigation?<Link className="inline-flex min-h-8 max-sm:min-h-11 items-center underline" href={workspaceSearchHref(workspaceId,o.sourceNavigation)}>{t.openSource}</Link>:o.statement!==o.source.quote?<blockquote className="whitespace-pre-wrap break-words text-muted-foreground">{o.source.quote}</blockquote>:null}
    </div>)}
    {actionWork?<Link className="inline-flex min-h-8 max-sm:min-h-11 items-center underline" href={brainRowUrl('',workspaceId,actionWork.taskId,'task')}>{t.nextAction}</Link>:null}
    {linkedWork.length?<div className="space-y-2"><h4 className="font-medium">{t.linkedWork}</h4>{linkedWork.map(w=><div key={w.id} className="space-y-1">
      <Link className="inline-flex min-h-8 max-sm:min-h-11 items-center break-words underline" href={brainRowUrl('',workspaceId,w.taskId,'task')}>{w.title}</Link>
      <p>{format(t.workState,{status:t.workStates[w.status as keyof typeof t.workStates]??t.unknownStatus})}</p>
      <p className="text-xs text-muted-foreground">{format(t.executor,{name:w.executorLabel??t.notAssigned})}</p><p className="text-xs text-muted-foreground">{format(t.followUp,{name:w.followUpLabel??t.seeTask})}</p>
    </div>)}</div>:null}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" className="min-h-8 max-sm:min-h-11" disabled={pending||error==='uncertain'} onClick={()=>{if(projectionRemainingMs(data)>0)onDraft(format(t.updateDraft,{id:c.id}))}}>{t.askUpdate}</Button>
      <Button variant="outline" className="min-h-8 max-sm:min-h-11" disabled={pending||error==='uncertain'} onClick={()=>void apply({kind:'refresh_delivery_assessment',operationId:crypto.randomUUID(),commitmentId:id,expectedVersion:c.version})}>{t.refresh}</Button>
      <Button variant="ghost" className="min-h-8 max-sm:min-h-11" disabled={pending||error==='uncertain'} onClick={()=>{setReviewing(!reviewing);setOutcome(c.outcome)}}>{t.review}</Button>
    </div>
    {reviewing?<div className="space-y-2">
      <label className="block space-y-1"><span>{t.outcomeLabel}</span><input type="text" className="w-full rounded-md border bg-background px-3 py-2 text-base" value={outcome} maxLength={2000} onChange={e=>setOutcome(e.target.value)} disabled={pending||error==='uncertain'}/></label>
      <label className="block space-y-1"><span>{t.reason}</span><textarea className="w-full rounded-md border bg-background px-3 py-2 text-base" value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)} disabled={pending||error==='uncertain'}/></label>
      <div className="flex flex-wrap gap-2">{(['recognise','correct','dismiss'] as const).map(decision=><Button key={decision} className="min-h-8 max-sm:min-h-11" variant="outline" disabled={pending||!reason.trim()||decision==='correct'&&!outcome.trim()} onClick={()=>void review(decision)}>{t[decision]}</Button>)}</div>
    </div>:null}
    {error?<p role="alert">{error==='uncertain'?t.uncertain:t.saveError}</p>:null}
    {error==='uncertain'&&retry.current?<Button className="min-h-8 max-sm:min-h-11" variant="outline" disabled={pending} onClick={()=>{if(retry.current)void apply(retry.current)}}>{t.retryReview}</Button>:null}
  </div>;
}
