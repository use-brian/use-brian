"use client";
/** Shopify pending credentials are not an active connection. [COMP:app-web/shopify-setup] */
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {useT} from '@/lib/i18n/client';
import {useCreationContext,useWorkspaceAccessMode,ModeAwareCreationContext} from '@/components/context/mode-aware-context';
import {getShopifyReconnect,reconnectIntent,type ReconnectProjection,getSetup,reviewSetup,mutateSetup,stageShopify,type SetupIntent,type SetupReview} from '@/lib/api/connector-setups';
import {connectorSetupCacheKey,connectorReconnectCacheKey} from '@/lib/surface-prefetch';
import {useCachedResource,invalidateSurfaceCache,markSurfaceCacheStale} from '@/lib/surface-cache';
import {useProtectedProjection,projectionRemainingMs,type ProtectedProjection} from '@/lib/use-protected-projection';
import {Button} from '@/components/ui/button';
import {SearchableSelect} from '@/components/ui/searchable-select';
import {confirmDialog} from '@/components/ui/confirm-dialog';
import {SurfaceSkeletonFor} from '@/components/chrome/surface-skeleton';
import {normalizeShopifyShopDomain} from '@/lib/shopify-domain';
import {parseShopifySetupState,setupCookie} from '@/lib/shopify-setup-state';
import {ORGANIZATION_CHANGED_EVENT} from '@/lib/api/workspace-access';
import {WORKSPACE_IDENTITY_REFRESH_EVENT,isCatchUpRefresh} from '@/lib/workspace-identity-events';
import {OFFICIAL_OAUTH_SCOPES} from '@use-brian/shared/builtin-connectors';
const field='min-h-8 max-sm:min-h-11 w-full rounded border border-border bg-background px-3 text-[16px] md:text-sm';
function remember(id:string){const url=new URL(window.location.href);url.searchParams.delete('connected');url.searchParams.delete('instance');url.searchParams.set('shopifySetup',id);window.history.replaceState(null,'',url);}
export function ShopifySetupGate({legacy,reconnect=false,instanceId}:{legacy:ReactNode;reconnect?:boolean;instanceId?:string}){
 const mode=useWorkspaceAccessMode(),{workspaceId,me}=useWorkspaceContext(),t=useT().shopifySetup;
 // Once admitted to the reviewed reconnect UI, its own protected projection
 // is authoritative. Mode-cache invalidation must not unmount a staged setup.
 const reconnectScope=useRef<string|null>(null),scope=`${workspaceId}:${me.id}`;
 if(mode.data)reconnectScope.current=mode.data.setupState==='legacy'?null:scope;
 if(reconnect&&instanceId&&reconnectScope.current===scope)return <ShopifyReconnect key={`${scope}:${instanceId}`} instanceId={instanceId}/>;
 if(!mode.data)return <section>{mode.error?<p role="alert">{t.error}</p>:<SurfaceSkeletonFor surface="studio" chrome={false}/>}<Button className="max-sm:min-h-11" onClick={()=>void mode.refresh()}>{t.review}</Button></section>;
 if(mode.data.setupState==='legacy')return legacy;
 if(reconnect)return instanceId?<ShopifyReconnect key={`${workspaceId}:${me.id}:${instanceId}`} instanceId={instanceId}/>:<p role="status">{t.reconnect}</p>;
 return <ShopifySetupForm key={`${workspaceId}:${me.id}`}/>;
}
export function ShopifySetupResume(){
 const {workspaceId,me}=useWorkspaceContext();const [id,setId]=useState<string|null>(null);
 useEffect(()=>{const value=new URLSearchParams(window.location.search).get('shopifySetup');setId(value&&/^[a-f0-9-]{36}$/i.test(value)?value:null);},[workspaceId,me.id]);
 return id?<SetupProgress key={`${workspaceId}:${me.id}:${id}`} id={id}/>:null;
}
function ShopifyReconnect({instanceId}:{instanceId:string}){
 const {workspaceId,me}=useWorkspaceContext(),t=useT().shopifySetup,a=useT().workspaceAccess;
 const key=connectorReconnectCacheKey(workspaceId,me.id,instanceId),resource=useCachedResource(key,()=>getShopifyReconnect(workspaceId,me.id,instanceId));
 const [reviewNeeded,setReviewNeeded]=useState(false);
 const data=useProtectedProjection(key,resource.error?undefined:resource.data,()=>setReviewNeeded(true));
 useEffect(()=>{const purge=(event:Event)=>{const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;if(isCatchUpRefresh(event)){markSurfaceCacheStale(key);return;}setReviewNeeded(true);invalidateSurfaceCache(key);};window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};},[key,workspaceId]);
 return <><p>{t.reconnect}</p>{!data&&!resource.error&&!reviewNeeded?<SurfaceSkeletonFor surface="studio" chrome={false}/>:null}{!data||reviewNeeded?<Button className="max-sm:min-h-11" onClick={async()=>{try{await resource.refresh();setReviewNeeded(false);}catch{setReviewNeeded(true);}}}>{a.reload}</Button>:null}{resource.error?<p role="alert">{t.error}</p>:null}{data&&!data.eligibility.eligible?<p role="status">{t[data.eligibility.reason??'scope_unavailable']}</p>:null}<ShopifySetupForm reconnect={data&&!reviewNeeded&&data.eligibility.eligible?data:undefined} reconnecting onReconnectFailure={()=>{setReviewNeeded(true);invalidateSurfaceCache(key);}}/></>;
}
function ShopifySetupForm({reconnect,reconnecting=false,onReconnectFailure}:{reconnect?:ProtectedProjection<ReconnectProjection>;reconnecting?:boolean;onReconnectFailure?:()=>void}={}){
 const {workspaceId}=useWorkspaceContext(),t=useT().shopifySetup,a=useT().workspaceAccess;
 const context=useCreationContext(reconnecting?'existing':'new-shared');
 const [ownership,setOwnership]=useState<'personal'|'workspace'>('personal'),[sensitivity,setSensitivity]=useState<'public'|'internal'|'confidential'>('internal');
 const [shop,setShop]=useState(''),[clientId,setClientId]=useState(''),[secret,setSecret]=useState(''),[token,setToken]=useState(''),[manual,setManual]=useState(false),[id,setId]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [uncertain,setUncertain]=useState(false);
 const reconnectRef=useRef(reconnect);reconnectRef.current=reconnect;
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{if(!context.mode.data||context.reviewNeeded||(reconnecting&&!reconnect)){setSecret('');setToken('');}},[context.mode.data,context.reviewNeeded,reconnecting,reconnect]);
 if(id)return <SetupProgress id={id}/>;
 async function start(){
  const mode=context.mode.data,domain=normalizeShopifyShopDomain(shop);if(busy||uncertain||!domain)return;
  if(reconnecting?(!reconnect||projectionRemainingMs(reconnect)<=0):(!mode||projectionRemainingMs(mode)<=0||mode.setupState!=='ready'||context.reviewNeeded))return;
  const destination=!reconnecting&&ownership==='workspace'?context.snapshot():null;if(!reconnecting&&ownership==='workspace'&&!destination)return;
  const setup:SetupIntent=reconnecting?reconnectIntent(reconnect!):{workspaceId,operation:'create',ownership,sensitivity,expectedPolicyRevision:mode!.policyRevision,...(destination?{destination:destination.contextGroupId?{kind:'department' as const,departmentId:destination.contextGroupId,...(destination.contextProjectId?{projectId:destination.contextProjectId}:{})}:{kind:'general' as const,...(destination.contextProjectId?{projectId:destination.contextProjectId}:{})}}:{})};
  setBusy(true);setError('');const credentials=manual?{shopDomain:domain,accessToken:token}:{shopDomain:domain,clientId,clientSecret:secret,scopes:[...(OFFICIAL_OAUTH_SCOPES.shopify??['read_products'])]};setSecret('');setToken('');
  try{
   const result=await stageShopify(setup,credentials);if(!live.current)return;remember(result.id);setId(result.id);
   if(!manual){
    if(reconnecting?(!reconnectRef.current||reconnectRef.current.instanceVersion!==reconnect?.instanceVersion||reconnectRef.current.policyRevision!==reconnect?.policyRevision||projectionRemainingMs(reconnectRef.current)<=0):!context.isCurrent())return;
    if(!result.state||!result.authorizeUrl||parseShopifySetupState(result.state)?.id!==result.id)throw new Error('binding');
    const target=new URL(result.authorizeUrl);if(target.protocol!=='https:'||target.hostname!==domain||target.searchParams.get('state')!==result.state)throw new Error('binding');
    document.cookie=setupCookie(workspaceId,result.state);window.location.assign(target.href);
   }
  }catch(error){if(live.current){setError(t.error);if(reconnecting){if(!(error instanceof Error)||!/^connector_setup_(target_changed|scope_changed|forbidden|request_invalid|stale|policy)/.test(error.message))setUncertain(true);onReconnectFailure?.();}else context.fail();}}finally{if(live.current)setBusy(false);}
 }
 return <section className="space-y-3 rounded-lg border border-border p-3 text-sm"><h3 className="font-semibold">{t.title}</h3><p>{t.pendingHint}</p>
  {reconnecting?<>{reconnect?<div className="break-words"><p>{t.ownership}: {reconnect.ownership==='personal'?t.personal:t.workspace}</p><p>{a.clearance}: {a[reconnect.sensitivity]}</p><p>{a.departments}: {reconnect.binding.compartments.join(', ')||a.generalOnly}</p><p>{a.reviewProjects}: {reconnect.binding.projectIds.join(', ')||a.reviewNone}</p></div>:<p role="status">{t.refreshReconnect}</p>}</>:<><label className="grid gap-1">{t.ownership}<SearchableSelect aria-label={t.ownership} className="max-sm:min-h-11" value={ownership} onValueChange={v=>setOwnership(v as typeof ownership)} items={[{value:'personal',label:t.personal},...(context.mode.data?.canAdminister?[{value:'workspace',label:t.workspace}]:[])]}/></label>
  {ownership==='workspace'?<ModeAwareCreationContext context={context}/>:<><p>{t.personalHint}</p>{context.reviewNeeded?<Button className="max-sm:min-h-11" onClick={context.review}>{a.reload}</Button>:null}</>}
  <label className="grid gap-1">{a.clearance}<SearchableSelect aria-label={a.clearance} className="max-sm:min-h-11" value={sensitivity} onValueChange={v=>setSensitivity(v as typeof sensitivity)} items={(['public','internal','confidential'] as const).map(value=>({value,label:a[value]}))}/></label></>}
  <label className="grid gap-1">{t.shop}<input className={field} value={shop} onChange={e=>setShop(e.target.value)} autoComplete="off"/></label>
  <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>{setManual(!manual);setSecret('');setToken('');}}>{manual?t.oauth:t.manual}</Button>
  {manual?<label className="grid gap-1">{t.token}<input type="password" className={field} autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>:<><label className="grid gap-1">{t.clientId}<input className={field} value={clientId} autoComplete="off" onChange={e=>setClientId(e.target.value)}/></label><label className="grid gap-1">{t.secret}<input type="password" className={field} autoComplete="off" value={secret} onChange={e=>setSecret(e.target.value)}/></label></>}
  <p>{t.boundary}</p>{uncertain?<p role="alert">{t.uncertainStage}</p>:null}{error?<p role="alert">{error}</p>:null}<Button className="max-sm:min-h-11" disabled={busy||uncertain||(reconnecting?!reconnect:(!context.mode.data||context.reviewNeeded||(ownership==='workspace'&&!context.ready)))||!shop||(manual?!token:!clientId||!secret)} onClick={()=>void start()}>{t.stage}</Button>
 </section>;
}
function ReviewEvidence({value}:{value:ProtectedProjection<SetupReview>}){
 const t=useT().shopifySetup,a=useT().workspaceAccess;const review=value.review;if(!review)return null;const intent=review.setup.intent;
 return <div className="max-h-[40dvh] space-y-2 overflow-y-auto break-words text-sm"><p>{t.account}: {review.account.subject}</p><p>{t.account}: {review.account.tenant??a.reviewNone}</p><p>{t.roots}: {review.account.roots.join(', ')||a.reviewNone}</p><p>{t.permissions}: {review.account.permissions.join(', ')||a.reviewNone}</p><p>{t.ownership}: {intent.ownership==='personal'?t.personal:t.workspace}</p><p>{a.departments}: {intent.binding.departments.join(', ')||a.generalOnly}</p><p>{a.reviewProjects}: {intent.binding.projects.join(', ')||a.reviewNone}</p><p>{a.clearance}: {intent.binding.sensitivityFloor==='confidential'?a.confidential:intent.binding.sensitivityFloor==='public'?a.public:a.internal}</p><p>{a.expires}: {new Date(value.projectionDeadline).toISOString()}</p><p>{t.boundary}</p><p className="break-all">{t.digest}: {value.digest}</p></div>;
}
function SetupProgress({id}:{id:string}){
 const {workspaceId,me}=useWorkspaceContext(),t=useT().shopifySetup,a=useT().workspaceAccess;
 const key=connectorSetupCacheKey(workspaceId,me.id,id),resource=useCachedResource(key,()=>getSetup(workspaceId,id));
 const controller=useRef<AbortController|null>(null),pending=useRef<string|null>(null),live=useRef(true);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(false);
 const data=useProtectedProjection(key,resource.data,()=>controller.current?.abort(),resource.refresh);
 useEffect(()=>{live.current=true;const purge=(event:Event)=>{const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;if(isCatchUpRefresh(event)){markSurfaceCacheStale(key);return;}controller.current?.abort();invalidateSurfaceCache(key);};window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);return()=>{live.current=false;controller.current?.abort();window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};},[key,workspaceId]);
 async function apply(){
  if(busy||!data)return;setBusy(true);setError('');const abort=new AbortController();controller.current=abort;let timer:ReturnType<typeof setTimeout>|undefined;let reviewed:ProtectedProjection<SetupReview>|undefined;let consentAttempted=false;
  try{
   if(!pending.current){const value=await reviewSetup(workspaceId,id,me.id);if(abort.signal.aborted||!live.current)return;
    if(projectionRemainingMs(value)<=0||!value.review||!value.digest||value.review.setup.id!==id||value.review.setup.workspaceId!==workspaceId||value.review.setup.provider!=='shopify')throw new Error('review');
    reviewed=value;timer=setTimeout(()=>abort.abort(),Math.max(0,projectionRemainingMs(value)));
    if(!await confirmDialog({signal:abort.signal,title:t.approve,description:t.boundary,content:<ReviewEvidence value={value}/>,confirmLabel:t.approve,cancelLabel:a.cancel})||abort.signal.aborted||projectionRemainingMs(value)<=0)return;
    pending.current=value.digest;
   }
   const status=await getSetup(workspaceId,id);if(!live.current)return;
   if(abort.signal.aborted||(reviewed&&projectionRemainingMs(reviewed)<=0)){pending.current=null;throw new Error('review_expired');}
   if(status.status==='active'&&status.result){pending.current=null;setRetry(false);await resource.refresh();return;}
   if(!['pending_review','ready'].includes(status.status))throw new Error('terminal');
   consentAttempted=true;const consent=await mutateSetup(workspaceId,id,'consent',pending.current!);if(consent.status!=='ready')throw new Error('terminal');
   const result=await mutateSetup(workspaceId,id,'activate',pending.current!);if(!live.current)return;
   if(result.status!=='active'||!result.result){pending.current=null;throw new Error('terminal');}
   pending.current=null;setRetry(false);await resource.refresh();
  }catch{if(reviewed&&!consentAttempted)pending.current=null;if(live.current){setError(t.error);setRetry(Boolean(pending.current));void resource.refresh();}}finally{clearTimeout(timer);if(live.current)setBusy(false);}
 }
 async function cancel(){if(busy)return;controller.current?.abort();setBusy(true);try{await mutateSetup(workspaceId,id,'cancel');pending.current=null;setRetry(false);await resource.refresh();}catch{setError(t.error);}finally{if(live.current)setBusy(false);}}
 if(!data)return <section>{resource.error?<p role="alert">{t.error}</p>:<SurfaceSkeletonFor surface="studio" chrome={false}/>}<Button className="max-sm:min-h-11" onClick={()=>void resource.refresh()}>{a.reload}</Button></section>;
 const expired=Date.parse(data.expiresAt)<=Date.now(),active=data.status==='active'&&Boolean(data.result);
 return <section className="space-y-3 rounded-lg border border-border p-3 text-sm"><h3 className="font-semibold">{t.title}</h3><p className="break-all">{id}</p><p role="status">{active?t.active:expired&&['pending_auth','pending_review','ready'].includes(data.status)?t.expired:t[data.status]}</p><p>{t.pendingHint}</p><p>{t.boundary}</p>{error?<p role="alert">{error}</p>:null}<div className="flex flex-wrap gap-2"><Button className="max-sm:min-h-11" disabled={busy} onClick={()=>void resource.refresh()}>{a.reload}</Button>{!expired&&['pending_review','ready'].includes(data.status)?<Button className="max-sm:min-h-11" disabled={busy} onClick={()=>void apply()}>{retry?t.retry:t.review}</Button>:null}{['pending_auth','pending_review','ready'].includes(data.status)?<Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>void cancel()}>{a.cancel}</Button>:null}</div></section>;
}
