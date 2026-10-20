"use client";

/** Native management views over the canonical R2 service. [COMP:app-web/application-admin] */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApplicationManagementCommand, ApplicationManagementOverview, ApplicationManagementResult, ManagementReview } from '@use-brian/shared';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { projectionRemainingMs, useProtectedProjection } from '@/lib/use-protected-projection';
import { applicationManagementCacheKey, ApplicationManagementError, executeApplicationManagement, fetchApplicationManagement } from '@/lib/api/applications';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';

type Surface='apps'|'credentials'|'sources'|'access'|'all';
type Copy=ReturnType<typeof useT>['applicationManagement'];
const fieldClass='min-h-8 max-sm:min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm';
const pretty=(value:unknown)=>JSON.stringify(value,null,2);
export function ApplicationManagement({surface='all',targetUserId}:{surface?:Surface;targetUserId?:string}){
 const {workspaceId,me}=useWorkspaceContext();
 return <Selection key={`${workspaceId}:${me.id}`} workspaceId={workspaceId} viewerId={me.id} surface={surface} targetUserId={targetUserId}/>;
}
function Selection(props:{workspaceId:string;viewerId:string;surface:Surface;targetUserId?:string}){
 const [appId,setAppId]=useState(''),[moduleKey,setModuleKey]=useState('');
 return <ManagementPanel key={`${appId}:${moduleKey}:${props.surface}:${props.targetUserId??''}`} {...props} appId={appId} moduleKey={moduleKey} onModule={setModuleKey} onSelect={id=>{setAppId(id);setModuleKey('');}}/>;
}
function ManagementPanel({workspaceId,viewerId,appId,moduleKey,onModule,onSelect,surface,targetUserId}:{workspaceId:string;viewerId:string;appId:string;moduleKey:string;onModule:(value:string)=>void;onSelect:(id:string)=>void;surface:Surface;targetUserId?:string}){
 const t=useT().applicationManagement,key=applicationManagementCacheKey(workspaceId,viewerId,appId||undefined,moduleKey||undefined);
 const [message,setMessage]=useState<keyof Copy|null>(null),[busy,setBusy]=useState(false),[secret,setSecret]=useState<string|null>(null);
 const [uncertain,setUncertain]=useState(false);
 const blocked=busy||uncertain;
 const [receipt,setReceipt]=useState<ApplicationManagementResult|null>(null);
 const [review,setReview]=useState<{value:ManagementReview;command:ApplicationManagementCommand;enabled:boolean}|null>(null);
 const pending=useRef(false);
 const dialog=useRef<AbortController|null>(null),alive=useRef(true),generation=useRef(0);
 const purge=useCallback(()=>{generation.current++;dialog.current?.abort();setReview(null);setSecret(null);setReceipt(null);setMessage(null);setBusy(false);pending.current=false;},[]);
 const resource=useCachedResource(key,()=>fetchApplicationManagement(workspaceId,viewerId,appId||undefined,moduleKey||undefined),{expiresInMs:projectionRemainingMs});
 const data=useProtectedProjection(key,resource.data,purge,resource.refresh);
 useEffect(()=>{
  alive.current=true;
  const changed=(event:Event)=>{const detail=(event as CustomEvent<{workspaceId?:string}>).detail;if(detail?.workspaceId&&detail.workspaceId!==workspaceId)return;purge();invalidateSurfaceCache(`application-management:${workspaceId}:`);};
  window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,changed);window.addEventListener(ORGANIZATION_CHANGED_EVENT,changed);
  return()=>{alive.current=false;generation.current++;dialog.current?.abort();window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,changed);window.removeEventListener(ORGANIZATION_CHANGED_EVENT,changed);invalidateSurfaceCache(key);};
 },[workspaceId,key,purge]);
 async function run(command:ApplicationManagementCommand,reviewKind?:'grant'|'credential'|'schema'|'governance'){
  if(pending.current||uncertain||!data)return;
  pending.current=true;
  const epoch=generation.current;setBusy(true);setMessage(null);
  try{
   const result=await executeApplicationManagement(workspaceId,command);
   if(!alive.current||generation.current!==epoch)return;
   if(reviewKind){const value=result as ManagementReview;if(typeof value.id!=='string')throw new Error('invalid_review');const selected=data.selectedAppId!;
    const apply:ApplicationManagementCommand=reviewKind==='grant'?{kind:'grant.apply',appId:selected,reviewId:value.id}:reviewKind==='credential'?{kind:'credential.deliver',appId:selected,reviewId:value.id}:reviewKind==='schema'?{kind:'schema.apply',reviewId:value.id,input:{}}:{kind:'governance.apply',reviewId:value.id,input:{}};
    setReview({value,command:apply,enabled:reviewKind==='schema'||reviewKind==='governance'?value.canApply!==false:value.canIssue===true});
   }else{
    if(typeof result.secret==='string')setSecret(result.secret);
    setReceipt(Object.fromEntries(Object.entries(result).filter(([field])=>field!=='secret')));
    setReview(null);setMessage('saved');await resource.refresh();
   }
  }catch(error){if(alive.current&&generation.current===epoch){if(error instanceof ApplicationManagementError&&error.uncertain){setUncertain(true);setMessage('uncertain');}else setMessage(error instanceof ApplicationManagementError&&error.code==='invalid_value'?'invalid':'unavailable');setReview(null);}}
  finally{if(alive.current&&generation.current===epoch){setBusy(false);pending.current=false;}}
 }
 async function reconcile(){
  const refreshed=await resource.refresh();
  if(alive.current&&refreshed){setUncertain(false);setMessage(null);}
 }
 async function confirmed(command:ApplicationManagementCommand,value:unknown){
  dialog.current?.abort();const controller=new AbortController();dialog.current=controller;const epoch=generation.current;
  const approved=await confirmDialog({signal:controller.signal,title:t.exactReview,description:t.exactReview,confirmLabel:t.apply,cancelLabel:t.cancel,content:<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(value)}</pre>});
  if(approved&&!controller.signal.aborted&&generation.current===epoch)await run(command);
 }
 const show=(area:Surface)=>surface===area||surface==='all';
 if(!data)return <section className="my-4 rounded-xl border p-4" aria-label={t.title}><h2>{t.title}</h2><p role="status">{uncertain?t.uncertain:resource.error?t.unavailable:t.loading}</p><Button onClick={()=>void reconcile()}>{uncertain?t.reconcile:t.retry}</Button></section>;
 const selected=data.clients.find(client=>client.id===data.selectedAppId);
 return <section className="my-4 min-w-0 space-y-4 max-sm:[&_button]:min-h-11 rounded-xl border border-border p-4" aria-label={t.title}>
  <h2 className="text-lg font-semibold">{t.title}</h2>
  <p role="status" className="text-sm">{t.unqualified}</p>
  <p className="break-all text-xs">{t.identity}: {data.actor.userId} / {data.actor.assistantId}</p>
  <SearchableSelect className="text-base md:text-sm" popupClassName="[&_input]:text-base md:[&_input]:text-sm" aria-label={t.application} value={data.selectedAppId??''} onValueChange={onSelect} items={data.clients.map(client=>({value:client.id,label:client.name}))} placeholder={t.application} searchPlaceholder={t.application} emptyMessage={t.empty}/>
  {selected&&<div className="space-y-2"><p>{t.status}: {t[selected.status]}</p><div className="flex flex-wrap gap-2"><Button disabled={blocked||selected.status!=='active'} onClick={()=>void confirmed({kind:'status',appId:selected.id,status:'suspended'},selected)}>{t.suspend}</Button><Button disabled={blocked||selected.status==='revoked'} onClick={()=>void confirmed({kind:'status',appId:selected.id,status:'revoked'},selected)}>{t.revoke}</Button><Button disabled title={t.unqualified}>{t.activate}</Button></div></div>}
  {show('apps')&&<><Registration t={t} modules={data.modules} busy={blocked} submit={command=>void run(command)}/><SchemaEditor t={t} data={data} busy={blocked} submit={command=>void run(command,'schema')}/></>}
  {show('credentials')&&selected&&<>
   <JsonReview title={t.grants} t={t} busy={blocked} initial={{principal:{kind:'member',userId:viewerId},origin:{kind:'generic',entityTypeId:''},typeKey:'',actions:['read'],readFields:[],writeFields:[],selector:{kind:'ids',ids:[]},expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'internal'}} submit={input=>void run({kind:'grant.review',appId:selected.id,input:input as never},'grant')}/>
   <Metadata title={t.grants} items={data.grants} empty={t.empty} renderAction={item=><Button disabled={blocked||item.status==='revoked'} onClick={()=>void confirmed({kind:'grant.revoke',appId:selected.id,grantId:item.id},item)}>{t.revoke}</Button>}/>
   <ServiceIdentity t={t} busy={blocked} submit={input=>void run({kind:'service.prepare',appId:selected.id,input})}/>
   <JsonReview title={t.credentials} t={t} busy={blocked} initial={{name:'',kind:'service',serviceUserId:'',grantIds:[],expiresAt:null}} submit={input=>void run({kind:'credential.review',appId:selected.id,input:input as never},'credential')}/>
   <Metadata title={t.credentials} items={data.credentials} empty={t.empty} renderAction={item=><Button disabled={blocked||item.status==='revoked'} onClick={()=>void confirmed({kind:'credential.revoke',appId:selected.id,credentialId:item.id},item)}>{t.revoke}</Button>}/>
  </>}
  {show('access')&&<GovernanceEditor t={t} data={data} onModule={onModule} targetUserId={targetUserId??viewerId} busy={blocked} submit={command=>void run(command,'governance')}/>}
  {show('sources')&&<><h3>{t.sources}</h3><p>{t.sourceUnavailable}</p><Metadata title={t.sources} items={data.sources.items} empty={t.empty}/><a className="underline" href={data.links.connectors}>{t.sources}</a></>}
  <p>{t.legacyUnavailable}</p><a className="underline" href={data.links.access}>{t.access}</a>
  {review&&<div className="space-y-2 rounded-lg bg-muted/40 p-3"><h3>{t.exactReview}</h3><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(review.value)}</pre><Button disabled={blocked||!review.enabled} onClick={()=>void confirmed(review.command,review.value)}>{t.apply}</Button><Button onClick={()=>setReview(null)}>{t.cancel}</Button>{!review.enabled&&<p>{t.unqualified}</p>}</div>}
  {receipt&&<div><h3>{t.receipt}</h3><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(receipt)}</pre></div>}
  {secret&&<div><h3>{t.secret}</h3><p>{t.secretOnce}</p><code className="break-all">{secret}</code><Button onClick={()=>setSecret(null)}>{t.close}</Button></div>}
  {(uncertain||message)&&<div role="status"><p>{t[uncertain?'uncertain':message!]}</p><Button onClick={()=>void reconcile()}>{uncertain?t.reconcile:t.retry}</Button></div>}
 </section>;
}
function Registration({t,modules,busy,submit}:{t:Copy;modules:string[];busy:boolean;submit:(command:ApplicationManagementCommand)=>void}){
 const [moduleKey,setModule]=useState(modules[0]??''),[mode,setMode]=useState<'home_app'|'external_frontend'|'api_client'>('external_frontend');
 return <form className="space-y-2" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget),lines=(key:string)=>String(form.get(key)??'').split('\n').map(s=>s.trim()).filter(Boolean);submit({kind:'register',input:{moduleKey,name:String(form.get('name')),mode,origins:mode==='external_frontend'?lines('origins'):[],redirectUris:mode==='external_frontend'?lines('redirects'):[],...(mode==='home_app'?{homeAppId:String(form.get('homeAppId'))}:{})}});}}><h3>{t.register}</h3><label>{t.name}<input className={fieldClass} name="name" required maxLength={128}/></label><SearchableSelect className="text-base md:text-sm" popupClassName="[&_input]:text-base md:[&_input]:text-sm" aria-label={t.module} value={moduleKey} onValueChange={setModule} items={modules.map(value=>({value,label:value}))} placeholder={t.module} searchPlaceholder={t.module} emptyMessage={t.empty}/><SearchableSelect className="text-base md:text-sm" popupClassName="[&_input]:text-base md:[&_input]:text-sm" aria-label={t.mode} value={mode} onValueChange={value=>setMode(value as typeof mode)} items={[{value:"home_app",label:t.homeApp},{value:"external_frontend",label:t.externalFrontend},{value:"api_client",label:t.apiClient}]} placeholder={t.mode} searchPlaceholder={t.mode} emptyMessage={t.empty}/>{mode==="home_app"&&<label>{t.homeAppId}<input name="homeAppId" required className={fieldClass}/></label>}{mode==="external_frontend"&&<><label>{t.origins}<textarea name="origins" className={fieldClass} required/></label><label>{t.redirects}<textarea name="redirects" className={fieldClass} required/></label></>}<Button disabled={busy||!moduleKey} type="submit">{t.register}</Button></form>;
}
function JsonReview({title,t,initial,busy,submit}:{title:string;t:Copy;initial:unknown;busy:boolean;submit:(input:unknown)=>void}){
 const [value,setValue]=useState(pretty(initial)),[invalid,setInvalid]=useState(false);
 return <form className="space-y-2" onSubmit={event=>{event.preventDefault();try{const input=JSON.parse(value);setInvalid(false);submit(input);}catch{setInvalid(true);}}}><h3>{title}</h3><label>{t.proposal}<textarea className={`${fieldClass} min-h-40 font-mono`} value={value} onChange={e=>setValue(e.target.value)} spellCheck={false}/></label>{invalid&&<p role="alert">{t.invalid}</p>}<Button disabled={busy} type="submit">{t.review}</Button></form>;
}
function SchemaEditor({t,data,busy,submit}:{t:Copy;data:ApplicationManagementOverview;busy:boolean;submit:(command:ApplicationManagementCommand)=>void}){
 const [id,setId]=useState(data.schemas.items[0]?.id??'');const schema=data.schemas.items.find(item=>item.id===id);
 return <div className="space-y-2"><h3>{t.schemas}</h3><SearchableSelect className="text-base md:text-sm" popupClassName="[&_input]:text-base md:[&_input]:text-sm" aria-label={t.schema} value={id} onValueChange={setId} items={data.schemas.items.map(item=>({value:item.id,label:`${item.name} (${item.schemaVersion})`}))} placeholder={t.schema} searchPlaceholder={t.schema} emptyMessage={t.empty}/>{schema?<JsonReview key={`${id}:${schema.schemaVersion}`} title={t.properties} t={t} initial={schema.properties} busy={busy} submit={properties=>submit({kind:'schema.preview',schemaId:id,input:{expectedVersion:schema.schemaVersion,properties:properties as unknown[]}})}/>:<p>{data.schemas.state==='unavailable'?t.unavailable:t.empty}</p>}</div>;
}
function ServiceIdentity({t,busy,submit}:{t:Copy;busy:boolean;submit:(input:{name:string;idempotencyKey:string})=>void}){
 const id=useRef(crypto.randomUUID());
 return <form className="space-y-2" onSubmit={event=>{event.preventDefault();submit({name:String(new FormData(event.currentTarget).get('name')),idempotencyKey:id.current});}}><h3>{t.service}</h3><label>{t.name}<input className={fieldClass} name="name" required maxLength={128}/></label><Button type="submit" disabled={busy}>{t.prepare}</Button></form>;
}
function Metadata<T extends {id:string}>({title,items,empty,renderAction}:{title:string;items:T[];empty:string;renderAction?:(item:T)=>React.ReactNode}){
 return <div><h3>{title}</h3>{!items.length&&<p>{empty}</p>}<ul className="space-y-2">{items.map(item=><li key={item.id} className="rounded-lg border p-2"><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(item)}</pre>{renderAction?.(item)}</li>)}</ul></div>;
}
function GovernanceEditor({t,data,onModule,targetUserId,busy,submit}:{t:Copy;data:ApplicationManagementOverview;onModule:(value:string)=>void;targetUserId:string;busy:boolean;submit:(command:ApplicationManagementCommand)=>void}){
 const catalog=data.governance?.catalog,moduleKey=data.governance?.moduleKey??'';
 return <div className="space-y-2"><h3>{t.governance}</h3><SearchableSelect className="text-base md:text-sm" popupClassName="[&_input]:text-base md:[&_input]:text-sm" aria-label={t.module} value={moduleKey} onValueChange={onModule} items={data.modules.map(value=>({value,label:value}))} placeholder={t.module} searchPlaceholder={t.module} emptyMessage={t.empty}/>{!catalog?<p>{t.unavailable}</p>:<><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(catalog)}</pre><JsonReview key={`${moduleKey}:${catalog.revision}`} title={t.governance} t={t} initial={{kind:'assign_role',userId:targetUserId,roleKey:catalog.roleKeys[0]??'',startsAt:new Date().toISOString(),expiresAt:null}} busy={busy} submit={operation=>submit({kind:'governance.preview',input:{moduleKey,expectedRevision:catalog.revision,operation}})}/></>}</div>;
}
