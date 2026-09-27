"use client";

/** Explicit permissions, separate from the organization directory. [COMP:app-web/workspace-access] */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { DepartmentAccessCommand, DepartmentAccessTeam, WorkspaceAccessOverview, WorkspaceAccessHistory, DepartmentReadGrant } from '@use-brian/shared';
import { useProtectedProjection } from '@/lib/use-protected-projection';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { workspaceAccessCacheKey, workspaceAccessHistoryCacheKey } from '@/lib/surface-prefetch';
import { fetchWorkspaceAccess, fetchWorkspaceAccessHistory, ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useDepartmentChange } from './use-department-change';
import { SurfaceSkeletonFor } from '@/components/chrome/surface-skeleton';
import Link from 'next/link';
import { organizationHref } from '@/lib/organization-navigation';
import { ScopeReviewPanel } from './scope-review';
import {AccessExplanationPanel,AccessEventsPanel} from './access-inspection';

const fieldClass='min-h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] md:text-sm';
type Save=(command:DepartmentAccessCommand,description:string)=>Promise<boolean>;
function Picker({label,value,onChange,items,disabled=false}:{label:string;value:string;onChange:(v:string)=>void;items:Array<{value:string;label:string}>;disabled?:boolean}) {
  const t=useT().workspaceAccess;
  return <label className="grid gap-1 text-sm"><span>{label}</span><SearchableSelect aria-label={label} value={value} onValueChange={onChange} items={items} disabled={disabled} className="min-h-11" searchPlaceholder={t.search} emptyMessage={t.noResults}/></label>;
}
type AccessSelection = {kind:'person';id:string}|{kind:'department';id:string}|{kind:'requests'};
export function WorkspaceAccessView({selection}:{selection?:AccessSelection}={}) {
  const {workspaceId,me}=useWorkspaceContext();
  return <WorkspaceAccessPanel key={`${workspaceId}:${me.id}:${selection?.kind??'all'}:${selection&&'id' in selection?selection.id:''}`} selection={selection}/>;
}
function WorkspaceAccessPanel({selection}:{selection?:AccessSelection}) {
  const peopleVisible=!selection||selection.kind==='person';
  const departmentsVisible=!selection||selection.kind!=='person';
  const historyVisible=!selection||selection.kind==='requests';
  const {workspaceId,me}=useWorkspaceContext(),t=useT().workspaceAccess;
  const key=workspaceAccessCacheKey(workspaceId,me.id);
  const resource=useCachedResource(key,()=>fetchWorkspaceAccess(workspaceId));
  const [requestTeam,setRequestTeam]=useState<string|null>(null),[editTeam,setEditTeam]=useState<string|null>(null),[editPerson,setEditPerson]=useState<string|null>(null);
  const change=useDepartmentChange(workspaceId);
  const {busy,error,retryAvailable}=change;
  const [reviewOpen,setReviewOpen]=useState(false);
  const [inspection,setInspection]=useState<{memberId:string}|'events'|null>(null);
  const data=useProtectedProjection(key,resource.data,()=>{change.cancelReview();setRequestTeam(null);setEditTeam(null);setEditPerson(null);setInspection(null);},resource.refresh);
  useEffect(()=>{
    const purge=(event:Event)=>{
      const detail=(event as CustomEvent<{workspaceId?:string}>).detail;
      if(detail?.workspaceId&&detail.workspaceId!==workspaceId)return;
      change.cancelReview();setRequestTeam(null);setEditTeam(null);setEditPerson(null);setInspection(null);invalidateSurfaceCache(`workspace-access:${workspaceId}:`);
    };
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};
  },[workspaceId]);
  const save:Save=async(command,description)=>data?Boolean(await change.save(command,description,data.policyRevision)):false;
  const header=<header className="space-y-2"><h2 className="text-lg font-semibold">{selection&&selection.kind!=='requests'?t.accessSettings:t.title}</h2>{historyVisible?<p className="text-sm text-muted-foreground">{t.description}</p>:null}<p className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{t.boundaryHint}{data?.canAdminister?` ${t.adminHint}`:''}</p></header>;
  // Review owns its independently expiring administrator projection. A refresh
  // of the parent must not discard an in-progress saved-review selection.
  if(reviewOpen)return <ScopeReviewPanel teams={data?.canAdminister?data.teams:[]} close={()=>setReviewOpen(false)}/>;
  if(!data) return resource.error?<main className="space-y-4 p-4">{header}<p role="alert">{t.loadError}</p><Button className="min-h-11" onClick={()=>void resource.refresh()}>{t.reload}</Button></main>:<SurfaceSkeletonFor surface="organization"/>;
  return <main className={historyVisible?'min-w-0 space-y-6 p-4 md:p-6':'min-w-0 space-y-4 pt-6'}>{header}
    {data.readiness?.ready!==true?<p role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{t.notReady}</p>:null}
    {data.canAdminister&&selection?.kind!=='person'?<Button variant="outline" className="min-h-11" onClick={()=>setReviewOpen(true)}>{t.reviewData}</Button>:null}
    <nav className="flex flex-wrap gap-2">{data.canAdminister&&historyVisible?<Link className="flex min-h-11 items-center rounded-lg border border-border px-3 text-sm" href={organizationHref(workspaceId,'departments')}>{t.configureTeams}</Link>:null}<Button variant="ghost" className="min-h-11" onClick={()=>{change.clearError();invalidateSurfaceCache(key);}}>{t.reload}</Button></nav>
    {historyVisible?<Button variant="outline" className="min-h-11" onClick={()=>setInspection('events')}>{t.accessAudit}</Button>:<nav className="flex flex-wrap gap-3"><Link className="flex min-h-11 items-center text-sm underline" href={organizationHref(workspaceId,'access')}>{t.requests} / {t.grants}</Link><Link className="flex min-h-11 items-center text-sm underline" href={organizationHref(workspaceId)}>{t.organization}</Link></nav>}
    {selection?.kind==='department'?<Button variant="outline" className="min-h-11" onClick={()=>setInspection({memberId:me.id})}>{t.explainAccess}</Button>:null}
    {inspection==='events'?<AccessEventsPanel key={data.policyRevision} data={data} close={()=>setInspection(null)}/>:inspection?<AccessExplanationPanel key={`${inspection.memberId}:${data.policyRevision}`} data={data} memberId={inspection.memberId} close={()=>setInspection(null)}/>:null}
    {error||resource.error?<p role="alert" className="text-sm text-destructive">{error||t.loadError}</p>:null}
    {retryAvailable?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void change.retry()}>{t.retryChange}</Button>:null}
    {peopleVisible?<section className="space-y-3">{!selection?<><h2 className="font-semibold">{t.people}</h2><p className="text-sm text-muted-foreground">{t.peopleHint}</p></>:null}
      {data.people.filter(person=>person.access&&(selection?.kind!=='person'||person.id===selection.id)).map(person=><article key={person.id} className="min-w-0 space-y-3 rounded-xl border border-border p-4">
        <h3 className="break-words font-medium">{person.name||t.unnamed}</h3>
        <p className="text-sm">{t.workspaceRole}: {person.role==='member'?t.memberRole:t[person.role]}</p>
        <p className="text-sm">{t.clearance}: {t[person.access!.effectiveClearance]}</p>
        <p className="text-sm">{t.scopeMode}: {person.access!.teamScopeMode==='legacy'?t.legacyMode:t.assignedMode}</p>
        <p className="text-sm">{t.memberships}: {data.teams.filter(team=>team.memberIds.includes(person.id)).map(team=>team.name).join(', ')||t.noMemberships}</p>
        <p className="text-sm">{t.readReach}: {reachLabel(person.access!.readTeamIds,person.access!.hasUnlistedReadScope,data,t)}</p>
        <p className="text-sm">{t.membershipReach}: {reachLabel(person.access!.membershipTeamIds,person.access!.hasUnlistedMembershipScope,data,t)}</p>
        {person.role!=='member'?<p className="text-sm text-muted-foreground">{t.adminHint}</p>:person.access!.teamScopeMode==='legacy'?<p className="text-sm text-muted-foreground">{t.legacyHint}</p>:null}
        <Button variant="outline" className="min-h-11" onClick={()=>setInspection({memberId:person.id})}>{t.explainAccess}</Button>
        {data.canAdminister&&person.role==='member'?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>setEditPerson(person.id)}>{t.editPerson}</Button>:null}
        {data.canAdminister&&editPerson===person.id?<PersonAccessEditor key={`${person.id}:${data.policyRevision}`} data={data} person={person} busy={busy} save={save} close={()=>setEditPerson(null)}/>:null}
      </article>)}
    </section>:null}
    {departmentsVisible?<section className="space-y-3">{historyVisible?<h2 className="font-semibold">{t.departments}</h2>:null}
      {!data.teams.length?<p className="text-sm text-muted-foreground">{t.emptyTeams}</p>:null}
      {data.teams.filter(team=>selection?.kind!=='department'||team.id===selection.id).map(team=><article key={team.id} className="min-w-0 space-y-3 rounded-xl border border-border p-4"><h3 className="break-words font-medium">{team.name}</h3>
        {team.expandedPackage?<p className="text-sm text-muted-foreground">{t.expanded}</p>:null}
        <div className="flex flex-wrap gap-2">{historyVisible&&(team.requestable||data.canAdminister)?<Button className="min-h-11" disabled={busy||data.readiness?.ready!==true} onClick={()=>{setRequestTeam(team.id);setEditTeam(null);}}>{t.requestAccess}</Button>:null}{selection?.kind!=='requests'&&(data.canAdminister||team.canManageMembers)?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>{setEditTeam(team.id);setRequestTeam(null);}}>{t.edit}</Button>:null}</div>
        {requestTeam===team.id&&data.readiness?.ready===true?<AccessRequestForm data={data} team={team} viewerId={me.id} busy={busy} save={save} close={()=>setRequestTeam(null)}/>:null}
        {editTeam===team.id?<DepartmentEditor key={`${team.id}:${data.policyRevision}`} data={data} team={team} busy={busy} save={save} close={()=>setEditTeam(null)}/>:null}
      </article>)}
    </section>:null}
    {historyVisible?(['requests','grants'] as const).map(kind=><AccessHistorySection key={`${kind}:${data.policyRevision}`} kind={kind} data={data} busy={busy} save={save}/>):null}
  </main>;
}
function Interval({starts,expires}:{starts:string;expires:string|null}) {
  const t=useT().workspaceAccess;
  return <p className="text-sm text-muted-foreground">{t.starts}: <time dateTime={starts}>{new Date(starts).toLocaleString()}</time> · {t.expires}: {expires?<time dateTime={expires}>{new Date(expires).toLocaleString()}</time>:t.ongoing}</p>;
}
function AccessRequestForm({data,team,viewerId,busy,save,close,renewal}:{renewal?:DepartmentReadGrant;data:WorkspaceAccessOverview;team:DepartmentAccessTeam;viewerId:string;busy:boolean;save:Save;close:()=>void}) {
  const t=useT().workspaceAccess;
  const [kind,setKind]=useState<'member'|'team'>(renewal?.beneficiaryKind??'member'),[beneficiary,setBeneficiary]=useState(renewal?.beneficiaryId??viewerId),[duration,setDuration]=useState('30'),[days,setDays]=useState('30'),[reason,setReason]=useState('');
  async function submit(event:FormEvent){event.preventDefault();if(await save({type:'access.request.create',targetTeamId:team.id,beneficiaryKind:kind,beneficiaryId:beneficiary,reason,days:duration==='custom'?Number(days):duration==='ongoing'?30:Number(duration),ongoing:duration==='ongoing'},`${t.requestAccess}: ${team.name}. ${(kind==='member'?data.people:data.teams).find(p=>p.id===beneficiary)?.name??t.unnamed}. ${reason}. ${t.duration}: ${duration==='ongoing'?t.ongoing:duration==='custom'?days:duration}. ${t.readOnly} ${kind==='team'?t.futureMembers:''}`))close();}
  return <form onSubmit={submit} className="grid gap-3 border-t border-border pt-3">
    {renewal?<p role="status" className="text-sm">{t.renewalHint}</p>:null}
    {data.canAdminister?<><Picker label={t.requestFor} value={kind} onChange={value=>{setKind(value as 'member'|'team');setBeneficiary(value==='member'?viewerId:data.teams[0]?.id??'');}} items={[{value:'member',label:t.individual},{value:'team',label:t.team}]} disabled={busy}/><Picker label={kind==='member'?t.member:t.team} value={beneficiary} onChange={setBeneficiary} items={kind==='member'?data.people.map(p=>({value:p.id,label:p.name||t.unnamed})):data.teams.map(p=>({value:p.id,label:p.name}))} disabled={busy}/></>:null}
    <Picker label={t.duration} value={duration} onChange={setDuration} items={[{value:'7',label:t.days7},{value:'30',label:t.days30},{value:'custom',label:t.custom},...(data.canAdminister?[{value:'ongoing',label:t.ongoing}]:[])]} disabled={busy}/>
    {duration==='custom'?<label className="grid gap-1 text-sm">{t.days}<input className={fieldClass} type="number" min="1" max="90" step="1" required value={days} disabled={busy} onChange={e=>setDays(e.target.value)}/></label>:null}
    <label className="grid gap-1 text-sm">{t.reason}<textarea className={`${fieldClass} min-h-24 py-2`} maxLength={1000} required value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
    <p className="text-sm text-muted-foreground">{t.readOnly}{kind==='team'?` ${t.futureMembers}`:''}</p>
    <div className="flex flex-wrap gap-2"><Button className="min-h-11" type="submit" disabled={busy||!reason.trim()||!beneficiary}>{t.submit}</Button><Button type="button" className="min-h-11" variant="ghost" onClick={close}>{t.close}</Button></div>
  </form>;
}
function DepartmentEditor({data,team,busy,save,close}:{data:WorkspaceAccessOverview;team:DepartmentAccessTeam;busy:boolean;save:Save;close:()=>void}) {
  const t=useT().workspaceAccess;
  const [published,setPublished]=useState(team.directoryVisibility==='workspace'),[requestable,setRequestable]=useState(team.requestable),[person,setPerson]=useState(''),[manager,setManager]=useState(''),[manage,setManage]=useState(false),[approve,setApprove]=useState(false);
  const people=data.people.map(p=>({value:p.id,label:p.name||t.unnamed}));
  return <div className="grid gap-3 border-t border-border pt-3">
    {data.canAdminister?<><label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={published} disabled={busy} onCheckedChange={v=>setPublished(Boolean(v))}/>{t.published}</label><label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={requestable} disabled={busy} onCheckedChange={v=>setRequestable(Boolean(v))}/>{t.requestable}</label><Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void save({type:'department.configure',teamId:team.id,directoryVisibility:published?'workspace':'members',requestable},`${team.name}: ${t.published} (${published?t.enabled:t.disabled}), ${t.requestable} (${requestable?t.enabled:t.disabled})`)}>{t.save}</Button>
      <Picker label={t.manager} value={manager} onChange={id=>{setManager(id);const caps=team.managers.find(m=>m.userId===id)?.capabilities??[];setManage(caps.includes('manage_members'));setApprove(caps.includes('approve_read_requests'));}} items={people} disabled={busy}/>
      <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={manage} disabled={busy||(data.readiness?.ready!==true&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('manage_members'))} onCheckedChange={v=>setManage(Boolean(v))}/>{t.manageMembers}</label><label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={approve} disabled={busy||(data.readiness?.ready!==true&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('approve_read_requests'))} onCheckedChange={v=>setApprove(Boolean(v))}/>{t.approveRequests}</label>
      <Button variant="outline" className="min-h-11" disabled={busy||!manager||(data.readiness?.ready!==true&&((manage&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('manage_members'))||(approve&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('approve_read_requests'))))} onClick={()=>void save({type:'department.manager.set',teamId:team.id,userId:manager,capabilities:[...(manage?['manage_members' as const]:[]),...(approve?['approve_read_requests' as const]:[])]},`${team.name}: ${people.find(p=>p.value===manager)?.label}. ${t.manageMembers} (${manage?t.enabled:t.disabled}), ${t.approveRequests} (${approve?t.enabled:t.disabled})`)}>{t.managerSave}</Button></>:null}
    <p className="text-sm text-muted-foreground">{t.membershipHint}{!data.canAdminister?` ${t.memberRestriction}`:''}</p>
    {team.canManageMembers?<><Picker label={t.member} value={person} onChange={setPerson} items={people} disabled={busy}/><div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={busy||!person||team.memberIds.includes(person)||(!data.canAdminister&&data.readiness?.ready!==true)} onClick={()=>void save({type:'department.member.set',teamId:team.id,userId:person,enabled:true},`${t.add}: ${people.find(p=>p.value===person)?.label}. ${team.name}. ${t.membershipHint}`)}>{t.add}</Button><Button variant="outline" className="min-h-11" disabled={busy||!person||!team.memberIds.includes(person)} onClick={()=>void save({type:'department.member.set',teamId:team.id,userId:person,enabled:false},`${t.remove}: ${people.find(p=>p.value===person)?.label}. ${team.name}`)}>{t.remove}</Button></div></>:null}
    <Button variant="ghost" className="min-h-11" onClick={close}>{t.close}</Button>
  </div>;
}

function reachLabel(ids:string[]|null,unlisted:boolean,data:WorkspaceAccessOverview,t:ReturnType<typeof useT>['workspaceAccess']) {
  if(ids===null)return t.allDepartments;
  const names=data.teams.filter(team=>ids.includes(team.id)).map(team=>team.name);
  if(unlisted)names.push(t.unlistedScope);
  return names.length?`${t.generalOnly}; ${names.join(', ')}`:t.generalOnly;
}
function PersonAccessEditor({data,person,busy,save,close}:{data:WorkspaceAccessOverview;person:WorkspaceAccessOverview['people'][number];busy:boolean;save:Save;close:()=>void}) {
  const t=useT().workspaceAccess,access=person.access!;
  const [clearance,setClearance]=useState(access.clearance),[mode,setMode]=useState(access.teamScopeMode);
  const blocked=mode==='assigned'&&access.teamScopeMode!=='assigned'&&data.readiness?.ready!==true;
  const modeLabel=(value:string)=>value==='legacy'?t.legacyMode:t.assignedMode;
  async function submit(event:FormEvent){event.preventDefault();if(blocked||busy)return;
    if(await save({type:'member.access.set',userId:person.id,clearance,teamScopeMode:mode,expectedPolicyRevision:data.policyRevision},`${person.name||t.unnamed}. ${t.clearance}: ${t[access.clearance]} → ${t[clearance]}. ${t.scopeMode}: ${modeLabel(access.teamScopeMode)} → ${modeLabel(mode)}. ${t.personChangeHint}`))close();
  }
  return <form onSubmit={submit} className="grid gap-3 border-t border-border pt-3">
    <Picker label={t.clearance} value={clearance} onChange={value=>setClearance(value as typeof clearance)} items={(['public','internal','confidential'] as const).map(value=>({value,label:t[value]}))} disabled={busy}/>
    <Picker label={t.scopeMode} value={mode} onChange={value=>setMode(value as typeof mode)} items={[...(access.teamScopeMode==='legacy'?[{value:'legacy',label:t.legacyMode}]:[]),{value:'assigned',label:t.assignedMode}]} disabled={busy}/>
    <p className="text-sm text-muted-foreground">{t.personChangeHint}</p>
    {blocked?<p role="status" className="text-sm">{t.notReady}</p>:null}
    <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11" disabled={busy||blocked||(clearance===access.clearance&&mode===access.teamScopeMode)}>{t.savePerson}</Button><Button type="button" variant="ghost" className="min-h-11" onClick={close}>{t.close}</Button></div>
  </form>;
}


function AccessHistorySection({kind,data,busy,save}:{kind:'requests'|'grants';data:WorkspaceAccessOverview;busy:boolean;save:Save}) {
  const [after,setAfter]=useState<string|null>(null),t=useT().workspaceAccess;
  const controls=(next:string|null)=><nav aria-label={kind==='requests'?t.requests:t.grants} className="flex flex-wrap gap-2">
    {after?<Button className="min-h-11" variant="outline" onClick={()=>setAfter(null)}>{t.newestHistory}</Button>:null}
    {next?<Button className="min-h-11" variant="outline" onClick={()=>setAfter(next)}>{kind==='requests'?t.olderRequests:t.olderGrants}</Button>:null}
  </nav>;
  const render=(history:Pick<WorkspaceAccessHistory,'requests'|'grants'|'nextCursor'>)=><AccessHistoryContent kind={kind} history={history} data={data} busy={busy} save={save} controls={controls(history.nextCursor)}/>;
  return after?<AccessHistoryPage key={after} kind={kind} after={after} revision={data.policyRevision} reset={()=>setAfter(null)} render={render}/>:render({requests:data.requests,grants:data.grants,nextCursor:(kind==='requests'?data.nextRequestCursor:data.nextGrantCursor)??null});
}
function AccessHistoryPage({kind,after,revision,reset,render}:{kind:'requests'|'grants';after:string;revision:string;reset:()=>void;render:(history:WorkspaceAccessHistory)=>ReactNode}) {
  const {workspaceId,me}=useWorkspaceContext(),t=useT().workspaceAccess;
  const key=workspaceAccessHistoryCacheKey(workspaceId,me.id,kind,revision,after);
  const resource=useCachedResource(key,()=>fetchWorkspaceAccessHistory(workspaceId,kind,after,revision));
  const history=useProtectedProjection(key,resource.data,()=>{},resource.refresh);
  if(history)return render(history);
  return <section className="space-y-3"><h2 className="font-semibold">{kind==='requests'?t.requests:t.grants}</h2>
    {resource.error?<><p role="alert">{t.historyChanged}</p><Button className="min-h-11" variant="outline" onClick={()=>void resource.refresh()}>{t.reload}</Button></>:<SurfaceSkeletonFor surface="organization"/>}
    <Button className="min-h-11" variant="outline" onClick={reset}>{t.newestHistory}</Button>
  </section>;
}
function AccessHistoryContent({kind,history,data,busy,save,controls}:{kind:'requests'|'grants';history:Pick<WorkspaceAccessHistory,'requests'|'grants'>;data:WorkspaceAccessOverview;busy:boolean;save:Save;controls:ReactNode}) {
  const t=useT().workspaceAccess,{me}=useWorkspaceContext();
  const [renewal,setRenewal]=useState<string|null>(null);
  return <section className="space-y-3"><h2 className="font-semibold">{kind==='requests'?t.requests:t.grants}</h2>
    {kind==='requests'?<>{!history.requests.length?<p className="text-sm text-muted-foreground">{t.emptyRequests}</p>:null}
      {history.requests.map(request=><article key={request.id} className="space-y-2 rounded-xl border border-border p-4"><h3 className="font-medium">{request.targetTeamName} · {t[request.status]}</h3><p className="break-words text-sm">{request.beneficiaryName??t.unnamed} · {request.reason}</p><Interval starts={request.startsAt} expires={request.expiresAt}/><p className="text-sm text-muted-foreground">{t.readOnly}</p>{request.beneficiaryKind==='team'?<p className="text-sm">{t.futureMembers}</p>:null}
        {request.status==='pending'&&!request.approvalId?<p className="text-sm">{t.waiting}</p>:null}
        <div className="flex flex-wrap gap-2">
          {request.canDecide&&request.approvalId?(['approved','rejected'] as const).map(decision=><Button key={decision} variant={decision==='approved'?'default':'outline'} className="min-h-11" disabled={busy||(decision==='approved'&&data.readiness?.ready!==true)} onClick={()=>void save({type:'access.request.decide',requestId:request.id,expectedVersion:request.version,payloadHash:request.payloadHash,policyRevision:data.policyRevision,decision},`${decision==='approved'?t.approve:t.reject}: ${request.targetTeamName}. ${request.beneficiaryName??t.unnamed}. ${request.reason}. ${t.starts}: ${new Date(request.startsAt).toLocaleString()}. ${t.expires}: ${request.expiresAt?new Date(request.expiresAt).toLocaleString():t.ongoing}. ${t.readOnly} ${request.beneficiaryKind==='team'?t.futureMembers:''}`)}>{decision==='approved'?t.approve:t.reject}</Button>):null}
          {request.canCancel?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void save({type:'access.request.cancel',requestId:request.id,expectedVersion:request.version},`${t.cancel}: ${request.targetTeamName}`)}>{t.cancel}</Button>:null}
          {data.canAdminister&&request.status==='pending'?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void save({type:'access.request.assign',requestId:request.id},`${t.assign}: ${request.targetTeamName}`)}>{t.assign}</Button>:null}
        </div></article>)}
    </>:<>{!history.grants.length?<p className="text-sm text-muted-foreground">{t.emptyGrants}</p>:null}
      {history.grants.map(grant=><article key={grant.id} className="space-y-2 rounded-xl border border-border p-4"><h3 className="font-medium">{grant.targetTeamName} · {t[grant.status]}</h3><p className="text-sm">{grant.beneficiaryName??t.unnamed}</p><Interval starts={grant.startsAt} expires={grant.expiresAt}/><p className="text-sm text-muted-foreground">{t.readOnly}</p>{grant.canRevoke?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void save({type:'access.grant.revoke',grantId:grant.id,reason:t.revoke},`${t.revoke}: ${grant.targetTeamName}`)}>{t.revoke}</Button>:null}{data.readiness?.ready===true&&(data.canAdminister||(grant.beneficiaryKind==='member'&&grant.beneficiaryId===me.id))&&data.teams.some(team=>team.id===grant.targetTeamId&&(team.requestable||data.canAdminister))?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>setRenewal(grant.id)}>{t.requestRenewal}</Button>:null}
        {renewal===grant.id&&data.readiness?.ready===true?<AccessRequestForm key={grant.id} renewal={grant} data={data} team={data.teams.find(team=>team.id===grant.targetTeamId)!} viewerId={me.id} busy={busy} save={save} close={()=>setRenewal(null)}/>:null}</article>)}
    </>}
    {controls}
  </section>;
}
