"use client";

/** Shared native forms, cursor lists and durable request references. [COMP:app-web/association] */
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { associationPageCacheKey, associationIntentKey } from "@/lib/surface-prefetch";
import { useCachedResource, markSurfaceCacheStale } from "@/lib/surface-cache";
import { listAssociationPage, type AssociationResource, type AssociationListQuery } from "@/lib/api/association";
import { fetchCrmLookup, type CrmLookupRow } from "@/lib/api/crm";
import { requestBrainRefresh } from "@/lib/brain-events";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { TechnicalDetails } from "./ui";

const associationInputClass="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base outline-none transition-shadow focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60 md:min-h-9 md:text-sm";
/** Label text stays the first node so tests and screen readers read the field by its label. */
export function AssociationField({label,value,onChange,multiline=false,help,end,list,...props}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean;help?:string;end?:ReactNode;list?:readonly string[]}&Omit<InputHTMLAttributes<HTMLInputElement>,"onChange"|"value"|"list">) {
  const listId=list?`${props.id ?? props.name ?? label.replace(/\W+/g,"-")}-options`:undefined;
  return <label className="flex min-w-0 flex-col gap-1 text-sm">{label}
    <span className="relative block">{multiline
      ? <textarea className={associationInputClass} value={value} onChange={e=>onChange(e.target.value)} disabled={props.disabled} required={props.required} placeholder={props.placeholder} maxLength={props.maxLength} rows={3} />
      : <input {...props} list={listId} step={props.step ?? (props.type==="datetime-local" ? (value.length>16 ? "0.001" : "60") : undefined)} className={`${associationInputClass}${end?" pr-14":""}`} value={value} onChange={e=>onChange(e.target.value)} />}
      {end?<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-muted-foreground">{end}</span>:null}
      {listId?<datalist id={listId}>{list!.map(option=><option key={option} value={option}/>)}</datalist>:null}
    </span>
    {help?<span className="text-xs text-muted-foreground">{help}</span>:null}</label>;
}
export function AssociationChoice({label,value,onChange,values,disabled=false,labels}:{label:string;value:string;onChange:(value:string)=>void;values:readonly string[];disabled?:boolean;labels?:Record<string,string>}) {
  const options=useT().associationPage.manage.options as Record<string,string>;
  const text=(v:string)=>labels?.[v] ?? options[v] ?? v;
  return <label className="flex min-w-0 flex-col gap-1 text-sm">{label}<Select items={values.map(v=>({value:v,label:text(v)}))} value={value} onValueChange={v=>{if(v)onChange(v);}} disabled={disabled}>
    <SelectTrigger className="min-h-11 w-full text-base md:min-h-9 md:text-sm" aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{values.map(v=><SelectItem value={v} key={v}>{text(v)}</SelectItem>)}</SelectContent>
  </Select></label>;
}
export function AssociationToggle({label,checked,onChange,disabled=false}:{label:string;checked:boolean;onChange:(checked:boolean)=>void;disabled?:boolean}) {
  return <label className="flex min-h-8 max-sm:min-h-11 items-center gap-2 text-sm"><Checkbox checked={checked} disabled={disabled} onCheckedChange={v=>onChange(v===true)} />{label}</label>;
}
export function useAssociationPage<K extends AssociationResource>(workspaceId:string,resource:K,query:AssociationListQuery={},enabled=true) {
  const scope=JSON.stringify(query);
  const [position,setPosition]=useState({scope,stack:[undefined] as (string|undefined)[]});
  const stack=position.scope===scope?position.stack:[undefined];
  const cursor=stack.at(-1);
  const read=useCachedResource(enabled?associationPageCacheKey(workspaceId,resource,{...query,cursor}):null,()=>listAssociationPage(workspaceId,resource,{...query,cursor}));
  return {...read,previous:stack.length>1?()=>setPosition({scope,stack:stack.slice(0,-1)}):undefined,
    next:read.data?.nextCursor && !stack.includes(read.data.nextCursor)?()=>setPosition({scope,stack:[...stack,read.data!.nextCursor!]}):undefined};
}
export function AssociationListState({data,error,refresh,previous,next,children,compact=false}:{data:unknown;error:unknown;refresh:()=>unknown;previous?:()=>void;next?:()=>void;children:ReactNode;compact?:boolean}) {
  const t=useT().associationPage;
  return <div className="space-y-3">
    {error?<p role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{t.manage.loadFailed}</p>:!data?<ListSurfaceSkeleton rows={3}/>:null}
    {data?children:null}
    <div className={`flex flex-wrap gap-2 ${compact?"justify-end":""}`}><Button type="button" className="min-h-11 md:min-h-8" variant="ghost" size="sm" onClick={()=>void refresh()}>{t.refresh}</Button>
      {(previous||next)&&<><Button type="button" className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={!previous} onClick={previous}>{t.previous}</Button><Button type="button" className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={!next || !!error} onClick={next}>{t.next}</Button></>}
    </div>
  </div>;
}
/** `review` describes the confirmation; `false` writes directly (catalogue saves that move no money). */
export function useAssociationAction(workspaceId:string) {
  const t=useT().associationPage,lock=useRef(false);
  const [pending,setPending]=useState(false),[outcome,setOutcome]=useState<"saved"|"failed"|null>(null);
  async function run(label:string,job:()=>Promise<unknown>,review?:{description:string;destructive?:boolean}|false) {
    if(lock.current)return false;
    lock.current=true;setPending(true);setOutcome(null);
    try {
      if(review!==false && !await confirmDialog({title:label,description:review?.description ?? t.manage.confirm,confirmLabel:label,cancelLabel:t.cancel,variant:review?.destructive?"destructive":"default"}))return false;
      await job();setOutcome("saved");requestBrainRefresh(workspaceId);
      markSurfaceCacheStale(`crm:${workspaceId}:`);markSurfaceCacheStale(`association-orders:${workspaceId}`);markSurfaceCacheStale(`association-module:${workspaceId}`);
      return true;
    } catch {setOutcome("failed");return false;}
    finally {lock.current=false;setPending(false);}
  }
  return {pending,run,outcome,feedback:outcome?<p role={outcome==="failed"?"alert":"status"} className={`rounded-xl px-4 py-3 text-sm ${outcome==="failed"?"bg-destructive/10 text-destructive":"bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{t.manage[outcome]}</p>:null};
}
export function useAssociationIntent(workspaceId:string,operation:string,target:string) {
  const t=useT().associationPage;
  const key=associationIntentKey(workspaceId,operation,target);
  const [stored,setStored]=useState<{key:string;id:string}|null>(null);
  useEffect(()=>{try {setStored({key,id:sessionStorage.getItem(key) ?? ""});}catch{setStored(null);}},[key]);
  function identity() {
    const current=sessionStorage.getItem(key) ?? crypto.randomUUID();
    if(!/^[a-f0-9-]{36}$/i.test(current))throw new Error("Invalid request identity");
    sessionStorage.setItem(key,current);setStored({key,id:current});return current;
  }
  async function reset(copy?:{title:string;description:string}) {
    const title=copy?.title ?? t.manage.newRequest;
    if(!await confirmDialog({title,description:copy?.description ?? t.manage.newRequestHelp,confirmLabel:title,cancelLabel:t.cancel}))return false;
    try {sessionStorage.removeItem(key);setStored({key,id:""});return true;}catch{return false;}
  }
  return {identity,reference:stored?.key===key?stored.id:"",hasReference:()=>sessionStorage.getItem(key)!==null,reset};
}
/** Debounced person search over CRM contacts; the chosen person renders as a removable chip. */
export function AssociationContactPicker({workspaceId,onSelect,selected,onClear,label}:{workspaceId:string;onSelect:(row:CrmLookupRow)=>void;selected?:CrmLookupRow|null;onClear?:()=>void;label?:string}) {
  const t=useT().associationPage,m=t.manage;
  const [draft,setDraft]=useState(""),[query,setQuery]=useState("");
  useEffect(()=>{const handle=setTimeout(()=>setQuery(draft.trim()),300);return ()=>clearTimeout(handle);},[draft]);
  const data=useCachedResource(selected?null:associationPageCacheKey(workspaceId,"contact-lookup",{query}),()=>fetchCrmLookup(workspaceId,"contact",query,50));
  if(selected)return <div className="flex max-sm:min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl bg-primary/5 px-3 py-2 text-sm" data-selected-contact>
    <span className="min-w-0"><span className="block font-medium">{selected.name}</span>{selected.hint?<span className="block text-xs text-muted-foreground">{selected.hint}</span>:null}</span>
    {onClear?<Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={onClear}><X aria-hidden className="size-4"/>{t.ux.clear}</Button>:null}
  </div>;
  return <div className="space-y-2">
    <div className="relative"><Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"/>
      <label className="flex min-w-0 flex-col gap-1 text-sm">{label ?? m.contactSearch}<input className={`${associationInputClass} pl-9`} value={draft} placeholder={t.ux.searchPeople} autoComplete="off" onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();setQuery(draft.trim());}}}/></label></div>
    {data.error?<p role="alert" className="text-sm text-destructive">{m.loadFailed}</p>:null}
    {!data.data&&!data.error?<ListSurfaceSkeleton rows={2}/>:null}
    <div className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">{data.data?.map(row=><button key={row.id} type="button" className="flex min-h-8 max-sm:min-h-11 w-full flex-wrap items-center justify-between gap-2 px-3 text-left text-sm hover:bg-accent" disabled={!!data.error} onClick={()=>onSelect(row)}><span>{row.name}</span><span className="text-muted-foreground">{row.hint}</span></button>)}{data.data?.length===0?<p className="p-3 text-sm text-muted-foreground">{m.empty}</p>:null}</div>
  </div>;
}
/** Stable request reference, kept out of the way inside a collapsed technical line. */
export function AssociationIntentNotice({reference,onReset,disabled}:{reference:string;onReset:()=>unknown;disabled:boolean}) {
  const t=useT().associationPage;
  return reference?<TechnicalDetails rows={[[t.ux.requestId,reference]]}><Button type="button" className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={disabled} onClick={()=>void onReset()}>{t.manage.newRequest}</Button></TechnicalDetails>:null;
}
export function associationLocalTime(instant:string|null|undefined):string {
  if(!instant)return "";
  const date=new Date(instant);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,23);
}
export function associationInstant(value:string):string|null {return value?new Date(value).toISOString():null;}
