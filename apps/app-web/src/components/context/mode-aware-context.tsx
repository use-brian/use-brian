"use client";
/** Explicit creation intent, never a rebinder. [COMP:app-web/mode-aware-context] */
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {useT} from '@/lib/i18n/client';
import {useCachedResource,invalidateSurfaceCache} from '@/lib/surface-cache';
import {useProtectedProjection,projectionRemainingMs} from '@/lib/use-protected-projection';
import {workspaceAccessModeCacheKey,workspaceCreationContextCacheKey} from '@/lib/surface-prefetch';
import {fetchWorkspaceAccessMode,fetchWorkspaceCreationContext,ORGANIZATION_CHANGED_EVENT} from '@/lib/api/workspace-access';
import {WORKSPACE_IDENTITY_REFRESH_EVENT,isCatchUpRefresh} from '@/lib/workspace-identity-events';
import {ContextScopePicker} from './context-scope-picker';
import {SurfaceSkeletonFor} from '@/components/chrome/surface-skeleton';
import {Button} from '@/components/ui/button';
import {organizationHref} from '@/lib/organization-navigation';
export type CreationIntent='new-shared'|'private'|'existing';
export function useWorkspaceAccessMode(){
 const {workspaceId,me}=useWorkspaceContext();
 const key=workspaceAccessModeCacheKey(workspaceId,me.id),resource=useCachedResource(key,()=>fetchWorkspaceAccessMode(workspaceId));
 const data=useProtectedProjection(key,resource.error?undefined:resource.data,()=>{},resource.refresh);
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
 // Only a dropped explicit selection needs review: with nothing picked, the
 // fresh projection's defaults are already current, so there is nothing to confirm.
 const purge=()=>{if(choiceRef.current===null)return;choiceRef.current=null;setReviewNeeded(true);setChoice(null);};
 const choices=useProtectedProjection(creates?key:null,resource.error?undefined:resource.data,purge,resource.refresh);
 const stamp=mode.data?`${identity}:${mode.data.policyRevision}:${mode.data.mode}:${mode.data.setupState}:${mode.data.defaultDepartmentId}:${mode.data.canAdminister}`:null;
 const liveStamp=useRef(stamp);liveStamp.current=stamp;
 const changed=previous.current!==null&&previous.current!==stamp;
 useEffect(()=>{if(stamp&&previous.current===null)previous.current=stamp;else if(changed){purge();previous.current=stamp;}},[stamp,changed]);
 useEffect(()=>{
  const invalidate=(event:Event)=>{if(isCatchUpRefresh(event))return;const w=(event as CustomEvent<{workspaceId?:string}>).detail?.workspaceId;if(w&&w!==workspaceId)return;purge();invalidateSurfaceCache(`workspace-access:${workspaceId}:`);};
  window.addEventListener(ORGANIZATION_CHANGED_EVENT,invalidate);window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,invalidate);
  return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,invalidate);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,invalidate);};
 },[workspaceId,me.id,intent]);
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
 const ready=!creates||Boolean(mode.data&&choices&&mode.data.policyRevision===choices.policyRevision&&!reviewNeeded&&!changed&&validTeam&&validProject&&(!simple||teamId)&&(intent==='private'||legacy||simple||selected));
 // An explicit pick made against the current projection is itself the review.
 const pick=(team:string|null,project:string|null)=>{setChoice({identity,teamId:team,projectId:project});if(mode.data&&choices&&mode.data.policyRevision===choices.policyRevision){previous.current=stamp;setReviewNeeded(false);}};
 const fail=()=>{purge();invalidateSurfaceCache(`workspace-access:${workspaceId}:`);};
 return {intent,mode,choices,error:mode.error||resource.error,ready,isCurrent:()=>liveStamp.current===stamp,reviewNeeded:reviewNeeded||changed,teamId,projectId,legacy,hasSelection:Boolean(selected),
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
 if(!context.mode.data||!context.choices)return <div>{context.error?<p role="alert">{t.stale}</p>:<SurfaceSkeletonFor surface="organization" chrome={false}/>}<Button type="button" className="max-sm:min-h-11" onClick={()=>void context.refresh()}>{a.reload}</Button></div>;
 return <section className="space-y-3 text-sm"><p>{context.intent==='private'?t.private:context.mode.readySimple?t.shared:t.destination}</p>
  <ContextScopePicker teams={context.choices.teams} projects={context.choices.projects} teamId={context.teamId} projectId={context.projectId} onTeamChange={context.selectTeam} onProjectChange={context.selectProject} disabled={disabled} hideTeam={context.intent==='new-shared'&&context.mode.readySimple} showProjectHint={!compact}/>
  {compact?null:<p>{t.boundaries}</p>}{!compact&&!context.mode.readySimple&&!context.legacy&&!context.ready&&!context.reviewNeeded?<p>{t.choose}</p>:null}
  {context.reviewNeeded?<div role="alert"><p>{t.stale}</p><Button type="button" className="max-sm:min-h-11" onClick={context.review}>{t.review}</Button></div>:null}
 </section>;
}
export function WorkspaceModeSummary(){
 const {workspaceId}=useWorkspaceContext(),mode=useWorkspaceAccessMode(),t=useT().accessMigration,m=useT().modeContext;
 if(!mode.data)return mode.error?<div role="alert"><p>{m.stale}</p><Button className="max-sm:min-h-11" onClick={()=>void mode.refresh()}>{m.review}</Button></div>:<SurfaceSkeletonFor surface="organization" chrome={false}/>;
 return <section className="space-y-2 rounded-lg border border-border p-3 text-sm"><h3 className="font-semibold">{t.title}</h3><p>{t.current}: {t[mode.data.mode]} · {t.setup}: {t[mode.data.setupState]}</p><p>{mode.readySimple?m.shared:m.setup}</p><p>{m.boundaries}</p>{mode.data.canAdminister?<><p>{m.migration}</p><Link className="inline-flex min-h-8 max-sm:min-h-11 items-center underline" href={organizationHref(workspaceId,'access')}>{t.plans}</Link></>:null}</section>;
}
