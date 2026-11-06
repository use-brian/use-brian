"use client";
/** Explicit creation intent, never a rebinder. [COMP:app-web/mode-aware-context] */
import {useEffect,useRef,useState} from 'react';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {useT} from '@/lib/i18n/client';
import {useCachedResource,invalidateSurfaceCache} from '@/lib/surface-cache';
import {useProtectedProjection,projectionRemainingMs} from '@/lib/use-protected-projection';
import {workspaceAccessModeCacheKey,workspaceCreationContextCacheKey} from '@/lib/surface-prefetch';
import {fetchWorkspaceAccessMode,fetchWorkspaceCreationContext,ORGANIZATION_CHANGED_EVENT} from '@/lib/api/workspace-access';
import {WORKSPACE_IDENTITY_REFRESH_EVENT,isCatchUpRefresh} from '@/lib/workspace-identity-events';
import {ContextScopePicker} from './context-scope-picker';
import {Button} from '@/components/ui/button';
export type CreationIntent='new-shared'|'private'|'existing';
export function useWorkspaceAccessMode(){
 const {workspaceId,me}=useWorkspaceContext();
 const key=workspaceAccessModeCacheKey(workspaceId,me.id),resource=useCachedResource(key,()=>fetchWorkspaceAccessMode(workspaceId));
 // Ordinary refresh failures do not revoke a still-live projection. Denials
 // evict it in the cache; useProtectedProjection still enforces its deadline.
 const data=useProtectedProjection(key,resource.data,()=>{},resource.refresh);
 return {data,error:resource.error,refresh:resource.refresh,readySimple:data?.mode==='simple'&&data.setupState==='ready'};
}
/**
 * `held`: a private (personal chat) pane whose host already owns its Team and
 * Project choice (handoffs and restored drafts seed it), so the one hero
 * picker reads and writes that choice instead of its own (chat-parity T5).
 */
export type HeldCreationChoice={teamId:string|null;projectId:string|null;select:(team:string|null,project:string|null)=>void};
export function useCreationContext(intent:CreationIntent,held?:HeldCreationChoice){
 const {workspaceId,me}=useWorkspaceContext(),identity=`${workspaceId}:${me.id}:${intent}`;
 const mode=useWorkspaceAccessMode();
 const key=workspaceCreationContextCacheKey(workspaceId,me.id);
 // Every NEW conversation (a room or a personal chat) binds its context from
 // the same creation projection; an existing one never rebinds (T5).
 const creates=intent!=='existing';
 const resource=useCachedResource(creates?key:null,()=>fetchWorkspaceCreationContext(workspaceId));
 const [reviewNeeded,setReviewNeeded]=useState(false);
 const [choice,setChoice]=useState<{identity:string;teamId:string|null;projectId:string|null}|null>(null);
 const previous=useRef<string|null>(null);
 const choiceRef=useRef(choice);choiceRef.current=choice;
 const keepV2Choice=useRef(false);
 if(mode.data)keepV2Choice.current=mode.data.departmentReadV2===true&&mode.data.mode==='departments';
 // Only a dropped explicit selection needs review: with nothing picked, the
 // fresh projection's defaults are already current, so there is nothing to confirm.
 const purge=()=>{if(keepV2Choice.current||choiceRef.current===null)return;choiceRef.current=null;setReviewNeeded(true);setChoice(null);};
 const choices=useProtectedProjection(creates?key:null,resource.data,()=>{},resource.refresh);
 const stamp=mode.data?`${identity}:${mode.data.policyRevision}:${mode.data.mode}:${mode.data.setupState}:${mode.data.defaultDepartmentId}:${mode.data.canAdminister}`:null;
 const liveStamp=useRef(stamp);liveStamp.current=stamp;
 // A v2 setup/revision refresh does not change an explicit destination. Keep
 // the draft and selection; submission still waits for fresh matching policy
 // and choice projections and refuses a destination that is no longer allowed.
 const changed=stamp!==null&&previous.current!==null&&previous.current!==stamp&&!keepV2Choice.current;
 useEffect(()=>{if(stamp&&previous.current===null)previous.current=stamp;else if(changed){purge();previous.current=stamp;}},[stamp,changed]);
 useEffect(()=>{
  const invalidate=(event:Event)=>{if(isCatchUpRefresh(event))return;const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;purge();invalidateSurfaceCache(`workspace-access:${workspaceId}:`);};
  window.addEventListener(ORGANIZATION_CHANGED_EVENT,invalidate);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,invalidate);
  return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,invalidate);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,invalidate);};
 },[workspaceId,me.id,intent]);
 // Choice is user intent, not permission. Expiry hides the projection but
 // preserves intent until a fresh policy can validate it again.
 const error=mode.error||resource.error;
 const denied=Boolean(error&&[401,403,404].includes((error as {status?:number}).status??0));
 const [offline,setOffline]=useState(()=>typeof navigator!=="undefined"&&!navigator.onLine);
 const refreshRef=useRef(()=>Promise.all([mode.refresh(),resource.refresh()]));
 refreshRef.current=()=>Promise.all([mode.refresh(),resource.refresh()]);
 const needsRecovery=creates&&!denied&&Boolean(error||!mode.data||!choices);
 useEffect(()=>{
  const update=()=>setOffline(!navigator.onLine);
  window.addEventListener('online',update);window.addEventListener('offline',update);
  return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};
 },[]);
 useEffect(()=>{
  if(!needsRecovery)return;
  let stopped=false,running=false,delay=5000,timer:ReturnType<typeof setTimeout>|undefined;
  const schedule=()=>{if(!stopped)timer=setTimeout(()=>void retry(),delay);};
  const retry=async()=>{
   if(stopped||running)return;
   clearTimeout(timer);
   if(!navigator.onLine||document.visibilityState==='hidden'){schedule();return;}
   running=true;
   try{await refreshRef.current();}catch{/* The cache owns the visible error. */}
   finally{running=false;delay=Math.min(delay*2,60000);schedule();}
  };
  const wake=()=>{if(document.visibilityState!=='hidden')void retry();};
  schedule();window.addEventListener('online',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('online',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
 },[identity,needsRecovery]);
 const selected=choice?.identity===identity?choice:null;
 const simple=intent==='new-shared'&&mode.readySimple;
 const holds=intent==='private'&&held!==undefined;
 const teamId=simple?mode.data?.defaultDepartmentId??null:holds?held!.teamId:selected?.teamId??null;
 const projectId=holds?held!.projectId:selected?.projectId??null;
 const legacy=mode.data?.setupState==='legacy';
 const validTeam=teamId===null||Boolean(choices?.teams.some(team=>team.id===teamId&&team.status==='active'));
 const validProject=projectId===null||Boolean(choices?.projects.some(project=>project.id===projectId&&project.status==='active'));
 // A personal chat needs no explicit choice (company-wide is a valid one), but
 // still waits for the projection and a valid selection, like a room.
 const ready=!creates||Boolean(mode.data&&choices&&mode.data.policyRevision===choices.policyRevision&&!reviewNeeded&&!changed&&validTeam&&validProject&&(!simple||teamId)&&(intent==='private'||legacy||mode.data.departmentReadV2||simple||selected));
 // An explicit pick made against the current projection is itself the review.
 const pick=(team:string|null,project:string|null)=>{setChoice({identity,teamId:team,projectId:project});if(mode.data&&choices&&mode.data.policyRevision===choices.policyRevision){previous.current=stamp;setReviewNeeded(false);}};
 const fail=()=>{purge();invalidateSurfaceCache(`workspace-access:${workspaceId}:`);};
 return {intent,mode,choices,error,denied,offline,ready,isCurrent:()=>liveStamp.current===stamp,reviewNeeded:reviewNeeded||changed,teamId,projectId,legacy,hasSelection:Boolean(selected),
  selectTeam:(id:string|null)=>holds?held!.select(id,projectId):pick(id,projectId),selectProject:(id:string|null)=>holds?held!.select(teamId,id):pick(teamId,id),
  review:()=>{if(mode.data&&choices&&mode.data.policyRevision===choices.policyRevision){previous.current=stamp;setReviewNeeded(false);}},
  refresh:async()=>{await Promise.all([mode.refresh(),resource.refresh()]);},fail,
  snapshot:()=>creates&&ready&&mode.data&&choices&&projectionRemainingMs(mode.data)>0&&projectionRemainingMs(choices)>0?{contextGroupId:teamId,contextProjectId:projectId,expectedPolicyRevision:mode.data.policyRevision}:null,
 };
}
export type CreationContext=ReturnType<typeof useCreationContext>;
/** `compact` is the chat composer host: pickers only, no explanatory copy. */
/** `disabled` freezes the picks while the host is mid-upload (an upload mints the conversation with them). */
export function ModeAwareCreationContext({disabled=false,context,compact=false}:{disabled?:boolean;context:CreationContext;compact?:boolean}){
 const t=useT().modeContext,a=useT().workspaceAccess;
 if(context.intent==='existing')return <p className="text-sm">{t.existing}</p>;
 // Creation choices are small controls, not an Organization list. Keep the
 // composer quiet while authority loads; a retry belongs only to a failure.
 if(!context.mode.data||!context.choices)return <div aria-busy={!context.denied||undefined} className="flex min-h-9 max-sm:min-h-11 items-center gap-2 text-xs text-muted-foreground">
  {context.denied?<><span role="alert">{t.unavailable}</span><Button type="button" variant="ghost" size="sm" className="max-sm:min-h-11" onClick={()=>void context.refresh()}>{a.reload}</Button></>:context.error||context.offline?<span role="status">{context.offline?t.offlineDraft:t.reconnecting}</span>:null}
 </div>;
 return <section className={compact?"space-y-1 text-sm":"space-y-3 text-sm"}>{compact?null:<p>{context.intent==='private'?t.private:context.mode.readySimple?t.shared:t.destination}</p>}
  <ContextScopePicker teams={context.choices.teams} projects={context.choices.projects} teamId={context.teamId} projectId={context.projectId} onTeamChange={context.selectTeam} onProjectChange={context.selectProject} disabled={disabled} hideTeam={context.intent==='new-shared'&&context.mode.readySimple} showProjectHint={!compact} inline={compact}/>
  {compact?null:<p>{t.boundaries}</p>}{!compact&&!context.mode.readySimple&&!context.legacy&&!context.ready&&!context.reviewNeeded?<p>{t.choose}</p>:null}
  {context.reviewNeeded?<div role="alert"><p>{t.stale}</p><Button type="button" className="max-sm:min-h-11" onClick={context.review}>{t.review}</Button></div>:null}
 </section>;
}
