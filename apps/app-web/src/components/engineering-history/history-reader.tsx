"use client";
/** Human reader over the same service used by MCP. [COMP:app-web/engineering-history] */
import {useState,useEffect,useRef} from "react";
import Link from "next/link";
import {useT} from "@/lib/i18n/client";
import {Button} from "@/components/ui/button";
import {confirmDialog} from "@/components/ui/confirm-dialog";
import {RailSurfaceSkeleton} from "@/components/chrome/surface-skeleton";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import {useLeasedResource} from "@/lib/offline/surface-content-cache";
import {engineeringHistoryCacheKey} from "@/lib/surface-prefetch";
import {invalidateSurfaceCache} from "@/lib/surface-cache";
import {correctEngineeringHistory,exportEngineeringHistory,listEngineeringHistory,readEngineeringHistory,type HistoryEvent,type HistoryQuery} from "@/lib/api/engineering-history";
import {isPhoneViewport} from "@/lib/viewport";
import {CaptureSetup} from "./capture-preset";
const inputClass="min-h-8 max-sm:min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-base";
export function HistoryReader({workspaceId}:{workspaceId:string}){
 const t=useT().engineeringHistory;
 const [draft,setDraft]=useState<HistoryQuery>({}),[query,setQuery]=useState<HistoryQuery>({}),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState(false),[exportState,setExportState]=useState<"complete"|"partial"|"failed"|null>(null),[exportCursor,setExportCursor]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const resource=useLeasedResource(engineeringHistoryCacheKey(workspaceId,JSON.stringify(query)),()=>listEngineeringHistory(workspaceId,query));
 async function download(){setBusy(true);setError(false);try{const page=await exportEngineeringHistory(workspaceId,{...query,...(exportCursor?{cursor:exportCursor}:{})});
  if(page.jsonl){const url=URL.createObjectURL(new Blob([page.jsonl],{type:"application/x-ndjson"})),a=document.createElement("a");a.href=url;a.download="engineering-history.jsonl";a.click();setTimeout(()=>URL.revokeObjectURL(url),0)}
  setExportState(page.failureCode?"failed":page.status==="complete"?"complete":"partial");setExportCursor(page.nextCursor);
 }catch{setExportState("failed")}finally{setBusy(false)}}
 function apply(){setQuery({...draft,limit:50});setSelected(null);setExportState(null);setExportCursor(null)}
 return <div className="flex min-w-0 flex-col gap-5">
 <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">{t.title}</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t.description}</p></div><Link className="inline-flex min-h-8 max-sm:min-h-11 items-center text-sm underline" href={`/w/${workspaceId}/studio/programmatic-access`}>{t.configure}</Link></header>
 <div className="rounded-xl border border-border bg-card p-4 text-sm"><p>{resource.data&&!resource.error?t.serverHealth:t.serverUnknown}</p><p className="mt-2 font-medium">{t.localHealth}</p><p className="mt-1 text-muted-foreground">{t.localHealthHint}</p></div>
 <form onSubmit={e=>{e.preventDefault();apply()}} className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
 <label className="grid gap-1 text-sm sm:col-span-2">{t.search}<input className={inputClass} value={draft.query??""} maxLength={500} onChange={e=>setDraft({...draft,query:e.target.value})}/></label>
 <div className="grid gap-1 text-sm"><span>{t.provider}</span><Select value={draft.provider||"all"} items={{all:t.allProviders,codex:t.providerCodex,"claude-code":t.providerClaude}} onValueChange={v=>setDraft({...draft,provider:v==="all"?undefined:v??undefined})}><SelectTrigger className="min-h-8 max-sm:min-h-11" aria-label={t.provider}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">{t.allProviders}</SelectItem><SelectItem value="codex">{t.providerCodex}</SelectItem><SelectItem value="claude-code">{t.providerClaude}</SelectItem></SelectContent></Select></div>
 <details className="sm:col-span-2 lg:col-span-3"><summary className="min-h-8 max-sm:min-h-11 cursor-pointer text-sm">{t.advancedFilters}</summary><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
 {(["sessionId","profileId","keyId","since","until"] as const).map(field=><label key={field} className="grid min-w-0 gap-1 text-sm">{t[field==="sessionId"?"session":field==="profileId"?"profile":field==="keyId"?"key":field]}<input type={field==="since"||field==="until"?"datetime-local":"text"} className={inputClass} value={field==="since"||field==="until"?toLocalInput(draft[field]):draft[field]??""} onChange={e=>setDraft({...draft,[field]:e.target.value?(field==="since"||field==="until"?new Date(e.target.value).toISOString():e.target.value):undefined})}/></label>)}
 </div></details>
 <div className="flex flex-wrap items-end gap-2"><Button type="submit" className="min-h-8 max-sm:min-h-11">{t.apply}</Button><Button type="button" className="min-h-8 max-sm:min-h-11" variant="outline" onClick={()=>{invalidateSurfaceCache(`engineering-history:${workspaceId}`);setError(false);void resource.refresh()}}>{t.refresh}</Button></div>
 </form>
 {(error||!!resource.error)&&<p role="alert" className="text-sm text-destructive">{t.unavailable}</p>}
 {!resource.data&&!resource.error?<RailSurfaceSkeleton chrome={false} padded={false} rows={4}/>:resource.data&&<div className="grid min-w-0 gap-4 lg:grid-cols-2">
 <section className="min-w-0 rounded-xl border border-border bg-card"><ol className="divide-y divide-border">{resource.data.events.map(e=><li key={e.id}><button className="w-full min-h-8 max-sm:min-h-11 p-4 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary" aria-pressed={selected===e.id} onClick={()=>setSelected(e.id)}><span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{e.provider} · {t[e.role]}</span><time>{new Date(e.occurredAt).toLocaleString()}</time></span><span className="mt-2 block whitespace-pre-wrap break-words text-sm">{e.excerpt}</span><span className="mt-2 block truncate text-xs text-muted-foreground">{e.sessionId??t.none}</span><span className="mt-2 block text-xs underline">{t.detail}</span></button></li>)}</ol>{!resource.data.events.length&&<p className="p-5 text-sm text-muted-foreground">{t.empty}</p>}
 <div className="flex flex-wrap gap-2 border-t border-border p-3"><Button className="min-h-8 max-sm:min-h-11" variant="outline" disabled={!query.cursor} onClick={()=>{setQuery({...query,cursor:undefined});setSelected(null);setExportCursor(null);setExportState(null)}}>{t.first}</Button><Button className="min-h-8 max-sm:min-h-11" variant="outline" disabled={!resource.data.nextCursor} onClick={()=>{setQuery({...query,cursor:resource.data!.nextCursor!});setSelected(null);setExportCursor(null);setExportState(null)}}>{t.next}</Button></div></section>
 {selected&&<HistoryDetail key={selected} workspaceId={workspaceId} id={selected} onClose={()=>setSelected(null)}/>}</div>}
 <div className="flex flex-wrap items-center gap-3"><Button className="min-h-8 max-sm:min-h-11" variant="outline" disabled={busy||!resource.data} onClick={()=>void download()}>{exportCursor?t.exportMore:t.export}</Button>{exportState&&<p role="status" className="text-sm">{exportState==="complete"?t.exportComplete:exportState==="partial"?t.exportPartial:t.exportFailed}</p>}</div>
 <CaptureSetup/>
 </div>
}
function toLocalInput(value:string|undefined){if(!value)return "";const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function HistoryDetail({workspaceId,id,onClose}:{workspaceId:string;id:string;onClose:()=>void}){
 const t=useT().engineeringHistory,[text,setText]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const resource=useLeasedResource(engineeringHistoryCacheKey(workspaceId,`event:${id}`),()=>readEngineeringHistory(workspaceId,id));
 async function change(action:"annotate"|"exclude"|"delete",event:HistoryEvent){
  if(action!=="annotate"&&!await confirmDialog({title:t.confirmTitle,description:action==="delete"?t.confirmDelete:t.confirmExclude,confirmLabel:action==="delete"?t.delete:t.exclude,cancelLabel:t.cancel,variant:"destructive"}))return;
  setBusy(true);setError(false);try{await correctEngineeringHistory(workspaceId,event,action,text);setText("");if(action!=="annotate")onClose();else await resource.refresh()}catch{setError(true);invalidateSurfaceCache(`engineering-history:${workspaceId}`)}finally{setBusy(false)}
 }
 const e=resource.data,section=useRef<HTMLElement>(null);
 useEffect(()=>{if(e&&isPhoneViewport())section.current?.scrollIntoView?.({block:"start"})},[!!e]);
 return <section ref={section} className="scroll-mt-28 min-w-0 rounded-xl border border-border bg-card p-4 flex flex-col gap-4"><header className="flex items-center justify-between gap-2"><h2 className="font-semibold">{t.original}</h2><Button className="min-h-8 max-sm:min-h-11" variant="ghost" onClick={onClose}>{t.close}</Button></header>
 {(error||!!resource.error)&&<p role="alert" className="text-sm text-destructive">{t.unavailable}</p>}
 {!e&&!resource.error&&<RailSurfaceSkeleton chrome={false} padded={false} rows={3}/>}
 {e&&<><pre className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-sm">{e.content}</pre>
 <details><summary className="min-h-8 max-sm:min-h-11 cursor-pointer font-medium">{t.provenance}</summary><dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">{[[t.provider,e.provider],[t.sequence,e.sequence],[t.sourceIdentity,e.sourceEventId],[t.session,e.sessionId],[t.principal,`${e.principalKind}:${e.principalId}`],[t.actor,e.actorId],[t.claimed,e.claimedSubject],[t.profile,e.profileId],[t.occurred,e.occurredAt],[t.received,e.receivedAt],[t.delivery,t.archived]].map(([label,value])=><div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all">{value??t.none}</dd></div>)}</dl></details><p className="text-xs text-muted-foreground">{t.unverified}. {t.coverageHint}</p>
 <h3 className="text-sm font-medium">{t.annotations}</h3>{e.annotations.map(a=><div key={a.id} className="rounded-lg bg-muted/50 p-3 text-sm"><p className="whitespace-pre-wrap break-words">{a.text}</p><p className="mt-1 break-all text-xs text-muted-foreground">{a.actorId} · {new Date(a.createdAt).toLocaleString()}</p></div>)}
 <label className="grid gap-1 text-sm">{t.annotation}<textarea value={text} maxLength={4000} onChange={x=>setText(x.target.value)} className={`${inputClass} min-h-24 p-3`}/></label><Button className="min-h-8 max-sm:min-h-11" disabled={busy||!text.trim()} onClick={()=>void change("annotate",e)}>{t.saveAnnotation}</Button><div className="flex flex-wrap gap-2 border-t border-border pt-4"><Button className="min-h-8 max-sm:min-h-11" disabled={busy} variant="outline" onClick={()=>void change("exclude",e)}>{t.exclude}</Button><Button className="min-h-8 max-sm:min-h-11" disabled={busy} variant="destructive" onClick={()=>void change("delete",e)}>{t.delete}</Button></div></>}
 </section>
}
