"use client";

/** Explicit permissions, separate from the organization directory. [COMP:app-web/workspace-access] */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { DepartmentAccessCommand, DepartmentAccessTeam, WorkspaceAccessOverview, WorkspaceAccessHistory, DepartmentReadGrant } from '@use-brian/shared';
import { useProtectedProjection } from '@/lib/use-protected-projection';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache, markSurfaceCacheStale } from '@/lib/surface-cache';
import { workspaceAccessCacheKey, workspaceAccessHistoryCacheKey } from '@/lib/surface-prefetch';
import { fetchWorkspaceAccess, fetchWorkspaceAccessHistory, ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { WORKSPACE_IDENTITY_REFRESH_EVENT, isCatchUpRefresh } from '@/lib/workspace-identity-events';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useDepartmentChange } from './use-department-change';
import { SurfaceSkeletonFor } from '@/components/chrome/surface-skeleton';
import { Bot, Building2, CheckCircle2, Clock, Eye, History, Inbox, KeyRound, Layers, RefreshCw, ScanSearch, ShieldAlert, ShieldCheck, UserRound, XCircle } from 'lucide-react';
import { Chip, ClearancePill, EmptyState, HowItWorks, InfoNote, OrgAvatar, StatStrip, StatTile, toneFill, toneFor, type OrgTone } from '@/components/organization/org-visuals';
import { format } from '@/lib/i18n/format';
import { OrganizationTopbarActions, organizationTopbarActionCls } from '@/components/organization/organization-chrome';
import { ScopeReviewPanel } from './scope-review';
import {MigrationProgressPanel} from './migration-progress';
import {AccessExplanationPanel,AccessEventsPanel} from './access-inspection';

const fieldClass='min-h-8 max-sm:min-h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] md:text-sm';
type Save=(command:DepartmentAccessCommand,description:string)=>Promise<boolean>;
function Picker({label,value,onChange,items,disabled=false}:{label:string;value:string;onChange:(v:string)=>void;items:Array<{value:string;label:string}>;disabled?:boolean}) {
  const t=useT().workspaceAccess;
  return <label className="grid gap-1 text-sm"><span>{label}</span><SearchableSelect aria-label={label} value={value} onValueChange={onChange} items={items} disabled={disabled} className="max-sm:min-h-11" searchPlaceholder={t.search} emptyMessage={t.noResults}/></label>;
}
type AccessSelection = {kind:'person';id:string}|{kind:'department';id:string}|{kind:'requests'};
export function WorkspaceAccessView({selection,embedded=false}:{selection?:AccessSelection;embedded?:boolean}={}) {
  const {workspaceId,me}=useWorkspaceContext();
  return <WorkspaceAccessPanel key={`${workspaceId}:${me.id}:${selection?.kind??'all'}:${selection&&'id' in selection?selection.id:''}`} selection={selection} embedded={embedded}/>;
}
function WorkspaceAccessPanel({selection,embedded}:{selection?:AccessSelection;embedded:boolean}) {
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
      // Reconnect catch-up: revalidate behind the paint, keep open editors.
      if(isCatchUpRefresh(event)){markSurfaceCacheStale(`workspace-access:${workspaceId}:`);return;}
      change.cancelReview();setRequestTeam(null);setEditTeam(null);setEditPerson(null);setInspection(null);invalidateSurfaceCache(`workspace-access:${workspaceId}:`);
    };
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};
  },[workspaceId]);
  const save:Save=async(command,description)=>data?Boolean(await change.save(command,description,data.policyRevision)):false;
  const pageTitle=selection?.kind==='person'?t.personAccessTitle:selection?.kind==='department'?t.departmentPolicyTitle:t.title;
  const pageDescription=selection?.kind==='person'?t.personAccessDescription:selection?.kind==='department'?t.departmentPolicyDescription:t.description;
  const header=<header><h2 className="text-lg font-semibold">{pageTitle}</h2><p className="mt-1 text-sm text-muted-foreground">{pageDescription}</p></header>;
  // Review owns its independently expiring administrator projection. A refresh
  // of the parent must not discard an in-progress saved-review selection.
  if(reviewOpen)return <ScopeReviewPanel teams={data?.canAdminister?data.teams:[]} close={()=>setReviewOpen(false)}/>;
  if(!data) return resource.error?<main className="space-y-4">{header}<p role="alert">{t.loadError}</p><Button className="max-sm:min-h-11" onClick={()=>void resource.refresh()}>{t.reload}</Button></main>:<SurfaceSkeletonFor surface="organization" chrome={false}/>;
  const reload=()=>{change.clearError();invalidateSurfaceCache(key);};
  // The Access section's own actions ride the Organization top bar; embedded
  // person/department panels keep their Refresh beside the data it reloads.
  const notReady=data.readiness?.ready!==true;
  const memberLabel=(role:string)=>role==='member'?t.memberRole:t[role as 'owner'|'admin'];
  const fact=(label:string,value:ReactNode)=><div className="min-w-0 space-y-1"><dt className="text-xs text-muted-foreground">{label}<span className="sr-only">: </span></dt><dd className="flex min-w-0 flex-wrap gap-1">{value}</dd></div>;
  const chips=(labels:string[])=>labels.map((label,index)=><Chip key={`${label}:${index}`}>{index?<span className="sr-only">, </span>:null}{label}</Chip>);
  return <main className={historyVisible?'min-w-0 space-y-5':embedded?'min-w-0 space-y-4':'min-w-0 space-y-4 pt-6'}>
    <header><h2 className={embedded?'font-semibold':'text-lg font-semibold'}>{pageTitle}</h2><p className="mt-1 text-sm text-muted-foreground">{pageDescription}</p></header>
    {historyVisible?<StatStrip label={t.overviewLabel}>
      <StatTile icon={Building2} tone="purple" label={t.statDepartments} value={data.teams.length}/>
      <StatTile icon={Inbox} tone={data.requests.some(r=>r.status==='pending')?'orange':'gray'} label={t.statPendingRequests} value={data.requests.filter(r=>r.status==='pending').length}/>
      <StatTile icon={KeyRound} tone="blue" label={t.statActiveGrants} value={data.grants.filter(g=>g.status==='active').length}/>
      <StatTile icon={notReady?ShieldAlert:ShieldCheck} tone={notReady?'orange':'green'} label={t.statIsolation} value={notReady?t.isolationIncomplete:t.isolationPassed}/>
    </StatStrip>:null}
    {notReady?<p role="status" style={toneFill('orange')} className="flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] leading-relaxed"><ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0"/>{t.notReady}</p>:null}
    <HowItWorks summary={t.notesSummary}><p>{t.boundaryHint}{data.canAdminister?` ${t.adminHint}`:''}</p>{peopleVisible&&!selection?<p>{t.peopleHint}</p>:null}</HowItWorks>
    {historyVisible&&data.canAdminister?<MigrationProgressPanel/>:null}
    {historyVisible?<OrganizationTopbarActions>
      {data.canAdminister?<button type="button" aria-label={t.reviewData} title={t.reviewData} onClick={()=>setReviewOpen(true)} className={organizationTopbarActionCls}><ScanSearch aria-hidden className="size-3.5 shrink-0"/><span className="max-lg:hidden">{t.reviewData}</span></button>:null}
      <button type="button" aria-label={t.accessAudit} title={t.accessAudit} aria-pressed={inspection==='events'} onClick={()=>setInspection('events')} className={organizationTopbarActionCls}><History aria-hidden className="size-3.5 shrink-0"/><span className="max-lg:hidden">{t.accessAudit}</span></button>
      <button type="button" aria-label={t.reload} title={t.reload} onClick={reload} className={organizationTopbarActionCls}><RefreshCw aria-hidden className="size-3.5 shrink-0"/><span className="max-lg:hidden">{t.reload}</span></button>
    </OrganizationTopbarActions>:<div className="flex flex-wrap items-center gap-2">
      {selection?.kind==='department'?<Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={()=>setInspection({memberId:me.id})}><ScanSearch aria-hidden className="size-3.5"/>{t.explainAccess}</Button>:null}
      <Button variant="ghost" size="sm" className="max-sm:min-h-11" onClick={reload}><RefreshCw aria-hidden className="size-3.5"/>{t.reload}</Button>
    </div>}
    {inspection==='events'?<AccessEventsPanel key={data.policyRevision} data={data} close={()=>setInspection(null)}/>:inspection?<AccessExplanationPanel key={`${inspection.memberId}:${data.policyRevision}`} data={data} memberId={inspection.memberId} close={()=>setInspection(null)}/>:null}
    {error||resource.error?<p role="alert" className="text-sm text-destructive">{error||t.loadError}</p>:null}
    {retryAvailable?<Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>void change.retry()}>{t.retryChange}</Button>:null}
    {peopleVisible?<section className="space-y-3">{!selection?<h2 className="font-semibold">{t.people}</h2>:null}
      {data.people.filter(person=>person.access&&(selection?.kind!=='person'||person.id===selection.id)).map(person=>{
        const access=person.access!;
        return <article key={person.id} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <div className="flex min-w-0 items-center gap-3">
            <OrgAvatar name={person.name||t.unnamed} seed={person.id} size={36}/>
            <div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{person.name||t.unnamed}</h3><p className="text-xs text-muted-foreground">{memberLabel(person.role)}</p></div>
          </div>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {fact(t.workspaceRole,<Chip>{memberLabel(person.role)}</Chip>)}
            {fact(t.clearance,<ClearancePill clearance={access.effectiveClearance} label={t[access.effectiveClearance]}/>)}
            {fact(t.scopeMode,<Chip>{access.teamScopeMode==='legacy'?t.legacyMode:t.assignedMode}</Chip>)}
            {fact(t.memberships,(()=>{const names=data.teams.filter(team=>team.memberIds.includes(person.id)).map(team=>team.name);return names.length?chips(names):<span className="text-sm text-muted-foreground">{t.noMemberships}</span>;})())}
            {fact(t.readReach,chips(reachLabels(access.readTeamIds,access.hasUnlistedReadScope,data,t)))}
            {fact(t.membershipReach,chips(reachLabels(access.membershipTeamIds,access.hasUnlistedMembershipScope,data,t)))}
          </dl>
          {person.role!=='member'?<InfoNote>{t.adminHint}</InfoNote>:access.teamScopeMode==='legacy'?<InfoNote>{t.legacyHint}</InfoNote>:null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={()=>setInspection({memberId:person.id})}>{t.explainAccess}</Button>
            {data.canAdminister&&person.role==='member'?<Button variant="outline" size="sm" className="max-sm:min-h-11" disabled={busy} onClick={()=>setEditPerson(person.id)}>{t.editPerson}</Button>:null}
          </div>
          {data.canAdminister&&editPerson===person.id?<PersonAccessEditor key={`${person.id}:${data.policyRevision}`} data={data} person={person} busy={busy} save={save} close={()=>setEditPerson(null)}/>:null}
        </article>;
      })}
    </section>:null}
    {departmentsVisible?<section className="space-y-3">{historyVisible?<h2 className="font-semibold">{t.availableDepartments}</h2>:null}
      {!data.teams.length?<EmptyState icon={Building2}>{t.emptyTeams}</EmptyState>:null}
      <ul className={historyVisible?'grid gap-3 sm:grid-cols-2 xl:grid-cols-3':'space-y-3'}>{data.teams.filter(team=>selection?.kind!=='department'||team.id===selection.id).map(team=>{
        const inline=embedded&&selection?.kind==='department';
        return <li key={team.id} className="min-w-0"><article className={`flex h-full min-w-0 flex-col gap-3 ${inline?'':'rounded-xl border border-border bg-card p-3.5'}`}>
          <div className="flex min-w-0 items-start gap-2.5">
            <span aria-hidden style={toneFill(toneFor(team.id))} className="grid size-8 shrink-0 place-items-center rounded-lg"><Building2 className="size-4"/></span>
            <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{team.name}</h3>
              <p title={format(t.memberCount,{people:team.memberIds.length,assistants:team.assistantIds.length})} className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
                <span className="sr-only">{format(t.memberCount,{people:team.memberIds.length,assistants:team.assistantIds.length})}</span>
                <span aria-hidden className="inline-flex items-center gap-0.5"><UserRound className="size-3"/>{team.memberIds.length}</span>
                <span aria-hidden className="inline-flex items-center gap-0.5"><Bot className="size-3"/>{team.assistantIds.length}</span></p></div>
          </div>
          {team.directoryVisibility==='workspace'||team.requestable||team.expandedPackage?<div className="flex flex-wrap gap-1">
            {team.directoryVisibility==='workspace'?<Chip icon={Eye} title={t.published}>{t.chipListed}</Chip>:null}
            {team.requestable?<Chip icon={Inbox} title={t.requestable}>{t.chipRequestable}</Chip>:null}
            {team.expandedPackage?<Chip icon={Layers} tone="orange" title={t.expanded}>{t.chipExtraAccess}</Chip>:null}
          </div>:null}
          {team.expandedPackage?<p className="sr-only">{t.expanded}</p>:null}
          <div className="mt-auto flex flex-wrap gap-2">{historyVisible&&(team.requestable||data.canAdminister)?<Button variant="outline" size="sm" className="max-sm:min-h-11" disabled={busy||notReady} onClick={()=>{setRequestTeam(team.id);setEditTeam(null);}}>{t.requestAccess}</Button>:null}{selection?.kind!=='requests'&&(data.canAdminister||team.canManageMembers)?<Button variant="outline" size="sm" className="max-sm:min-h-11" disabled={busy} onClick={()=>{setEditTeam(team.id);setRequestTeam(null);}}>{t.edit}</Button>:null}</div>
          {requestTeam===team.id&&!notReady?<AccessRequestForm data={data} team={team} viewerId={me.id} busy={busy} save={save} close={()=>setRequestTeam(null)}/>:null}
          {editTeam===team.id?<DepartmentEditor key={`${team.id}:${data.policyRevision}`} data={data} team={team} busy={busy} save={save} close={()=>setEditTeam(null)}/>:null}
        </article></li>;
      })}</ul>
    </section>:null}
    {historyVisible?<div className="grid items-start gap-4 xl:grid-cols-2">{(['requests','grants'] as const).map(kind=><AccessHistorySection key={`${kind}:${data.policyRevision}`} kind={kind} data={data} busy={busy} save={save}/>)}</div>:null}
  </main>;
}
function Interval({starts,expires}:{starts:string;expires:string|null}) {
  const t=useT().workspaceAccess;
  return <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"><Clock aria-hidden className="size-3"/>{t.starts}: <time dateTime={starts}>{new Date(starts).toLocaleString()}</time> · {t.expires}: {expires?<time dateTime={expires}>{new Date(expires).toLocaleString()}</time>:t.ongoing}</p>;
}
const STATUS_TONE:Record<string,OrgTone>={pending:'orange',approved:'green',active:'green',scheduled:'blue',rejected:'red',revoked:'red',cancelled:'gray',expired:'gray',superseded:'gray'};
/** Department name and a status pill; the hidden separator keeps "Name · Status" as one phrase. */
function HistoryTitle({name,status,label}:{name:string;status:string;label:string}) {
  const Icon=status==='pending'||status==='scheduled'?Clock:status==='approved'||status==='active'?CheckCircle2:XCircle;
  return <h3 className="flex min-w-0 flex-wrap items-center gap-2 font-medium"><span className="break-words">{name}</span><span className="sr-only"> · </span><Chip icon={Icon} tone={STATUS_TONE[status]??'gray'}>{label}</Chip></h3>;
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
    <div className="flex flex-wrap gap-2"><Button className="max-sm:min-h-11" type="submit" disabled={busy||!reason.trim()||!beneficiary}>{t.submit}</Button><Button type="button" className="max-sm:min-h-11" variant="ghost" onClick={close}>{t.close}</Button></div>
  </form>;
}
function DepartmentEditor({data,team,busy,save,close}:{data:WorkspaceAccessOverview;team:DepartmentAccessTeam;busy:boolean;save:Save;close:()=>void}) {
  const t=useT().workspaceAccess;
  const [published,setPublished]=useState(team.directoryVisibility==='workspace'),[requestable,setRequestable]=useState(team.requestable),[person,setPerson]=useState(''),[manager,setManager]=useState(''),[manage,setManage]=useState(false),[approve,setApprove]=useState(false);
  const people=data.people.map(p=>({value:p.id,label:p.name||t.unnamed}));
  return <div className="grid gap-3 border-t border-border pt-3">
    {data.canAdminister?<><label className="flex min-h-8 max-sm:min-h-11 items-center gap-2 text-sm"><Checkbox checked={published} disabled={busy} onCheckedChange={v=>setPublished(Boolean(v))}/>{t.published}</label><label className="flex min-h-8 max-sm:min-h-11 items-center gap-2 text-sm"><Checkbox checked={requestable} disabled={busy} onCheckedChange={v=>setRequestable(Boolean(v))}/>{t.requestable}</label><Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>void save({type:'department.configure',teamId:team.id,directoryVisibility:published?'workspace':'members',requestable},`${team.name}: ${t.published} (${published?t.enabled:t.disabled}), ${t.requestable} (${requestable?t.enabled:t.disabled})`)}>{t.save}</Button>
      <Picker label={t.manager} value={manager} onChange={id=>{setManager(id);const caps=team.managers.find(m=>m.userId===id)?.capabilities??[];setManage(caps.includes('manage_members'));setApprove(caps.includes('approve_read_requests'));}} items={people} disabled={busy}/>
      <label className="flex min-h-8 max-sm:min-h-11 items-center gap-2 text-sm"><Checkbox checked={manage} disabled={busy||(data.readiness?.ready!==true&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('manage_members'))} onCheckedChange={v=>setManage(Boolean(v))}/>{t.manageMembers}</label><label className="flex min-h-8 max-sm:min-h-11 items-center gap-2 text-sm"><Checkbox checked={approve} disabled={busy||(data.readiness?.ready!==true&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('approve_read_requests'))} onCheckedChange={v=>setApprove(Boolean(v))}/>{t.approveRequests}</label>
      <Button variant="outline" className="max-sm:min-h-11" disabled={busy||!manager||(data.readiness?.ready!==true&&((manage&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('manage_members'))||(approve&&!team.managers.find(m=>m.userId===manager)?.capabilities.includes('approve_read_requests'))))} onClick={()=>void save({type:'department.manager.set',teamId:team.id,userId:manager,capabilities:[...(manage?['manage_members' as const]:[]),...(approve?['approve_read_requests' as const]:[])]},`${team.name}: ${people.find(p=>p.value===manager)?.label}. ${t.manageMembers} (${manage?t.enabled:t.disabled}), ${t.approveRequests} (${approve?t.enabled:t.disabled})`)}>{t.managerSave}</Button></>:null}
    <p className="text-sm text-muted-foreground">{t.membershipHint}{!data.canAdminister?` ${t.memberRestriction}`:''}</p>
    {team.canManageMembers?<><Picker label={t.member} value={person} onChange={setPerson} items={people} disabled={busy}/><div className="flex flex-wrap gap-2"><Button variant="outline" className="max-sm:min-h-11" disabled={busy||!person||team.memberIds.includes(person)||(!data.canAdminister&&data.readiness?.ready!==true)} onClick={()=>void save({type:'department.member.set',teamId:team.id,userId:person,enabled:true},`${t.add}: ${people.find(p=>p.value===person)?.label}. ${team.name}. ${t.membershipHint}`)}>{t.add}</Button><Button variant="outline" className="max-sm:min-h-11" disabled={busy||!person||!team.memberIds.includes(person)} onClick={()=>void save({type:'department.member.set',teamId:team.id,userId:person,enabled:false},`${t.remove}: ${people.find(p=>p.value===person)?.label}. ${team.name}`)}>{t.remove}</Button></div></>:null}
    <Button variant="ghost" className="max-sm:min-h-11" onClick={close}>{t.close}</Button>
  </div>;
}

/** Reach as chip labels: every department, or General plus the listed ones. */
function reachLabels(ids:string[]|null,unlisted:boolean,data:WorkspaceAccessOverview,t:ReturnType<typeof useT>['workspaceAccess']):string[] {
  if(ids===null)return [t.allDepartments];
  const names=data.teams.filter(team=>ids.includes(team.id)).map(team=>team.name);
  if(unlisted)names.push(t.unlistedScope);
  return [t.generalOnly,...names];
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
    <div className="flex flex-wrap gap-2"><Button type="submit" className="max-sm:min-h-11" disabled={busy||blocked||(clearance===access.clearance&&mode===access.teamScopeMode)}>{t.savePerson}</Button><Button type="button" variant="ghost" className="max-sm:min-h-11" onClick={close}>{t.close}</Button></div>
  </form>;
}


function AccessHistorySection({kind,data,busy,save}:{kind:'requests'|'grants';data:WorkspaceAccessOverview;busy:boolean;save:Save}) {
  const [after,setAfter]=useState<string|null>(null),t=useT().workspaceAccess;
  const controls=(next:string|null)=><nav aria-label={kind==='requests'?t.requests:t.grants} className="flex flex-wrap gap-2">
    {after?<Button className="max-sm:min-h-11" variant="outline" onClick={()=>setAfter(null)}>{t.newestHistory}</Button>:null}
    {next?<Button className="max-sm:min-h-11" variant="outline" onClick={()=>setAfter(next)}>{kind==='requests'?t.olderRequests:t.olderGrants}</Button>:null}
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
    {resource.error?<><p role="alert">{t.historyChanged}</p><Button className="max-sm:min-h-11" variant="outline" onClick={()=>void resource.refresh()}>{t.reload}</Button></>:<SurfaceSkeletonFor surface="organization" chrome={false}/>}
    <Button className="max-sm:min-h-11" variant="outline" onClick={reset}>{t.newestHistory}</Button>
  </section>;
}
function AccessHistoryContent({kind,history,data,busy,save,controls}:{kind:'requests'|'grants';history:Pick<WorkspaceAccessHistory,'requests'|'grants'>;data:WorkspaceAccessOverview;busy:boolean;save:Save;controls:ReactNode}) {
  const t=useT().workspaceAccess,{me}=useWorkspaceContext();
  const [renewal,setRenewal]=useState<string|null>(null);
  const count=kind==='requests'?history.requests.length:history.grants.length;
  return <section className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"><h2 className="flex items-center gap-2 font-semibold">{kind==='requests'?<Inbox aria-hidden className="size-4 text-muted-foreground"/>:<KeyRound aria-hidden className="size-4 text-muted-foreground"/>}{kind==='requests'?t.requests:t.grants}<span className="rounded-full bg-muted px-2 text-xs font-medium tabular-nums text-muted-foreground">{count}</span></h2>
    {kind==='requests'?<>{!history.requests.length?<EmptyState bare icon={Inbox}>{t.emptyRequests}</EmptyState>:null}
      <div className="divide-y divide-border">{history.requests.map(request=><article key={request.id} className="space-y-2 py-3 first:pt-0 last:pb-0"><HistoryTitle name={request.targetTeamName} status={request.status} label={t[request.status]}/>
        <p className="flex min-w-0 items-start gap-2 text-sm"><OrgAvatar name={request.beneficiaryName??t.unnamed} seed={request.beneficiaryId} size={20} kind={request.beneficiaryKind==='team'?'assistant':'member'}/><span className="min-w-0 break-words"><span className="font-medium">{request.beneficiaryName??t.unnamed}</span> · {request.reason}</span></p>
        <Interval starts={request.startsAt} expires={request.expiresAt}/><InfoNote>{t.readOnly}{request.beneficiaryKind==='team'?` ${t.futureMembers}`:''}</InfoNote>
        {request.status==='pending'&&!request.approvalId?<p className="text-sm">{t.waiting}</p>:null}
        <div className="flex flex-wrap gap-2">
          {request.canDecide&&request.approvalId?(['approved','rejected'] as const).map(decision=><Button key={decision} variant={decision==='approved'?'default':'outline'} className="max-sm:min-h-11" disabled={busy||(decision==='approved'&&data.readiness?.ready!==true)} onClick={()=>void save({type:'access.request.decide',requestId:request.id,expectedVersion:request.version,payloadHash:request.payloadHash,policyRevision:data.policyRevision,decision},`${decision==='approved'?t.approve:t.reject}: ${request.targetTeamName}. ${request.beneficiaryName??t.unnamed}. ${request.reason}. ${t.starts}: ${new Date(request.startsAt).toLocaleString()}. ${t.expires}: ${request.expiresAt?new Date(request.expiresAt).toLocaleString():t.ongoing}. ${t.readOnly} ${request.beneficiaryKind==='team'?t.futureMembers:''}`)}>{decision==='approved'?t.approve:t.reject}</Button>):null}
          {request.canCancel?<Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>void save({type:'access.request.cancel',requestId:request.id,expectedVersion:request.version},`${t.cancel}: ${request.targetTeamName}`)}>{t.cancel}</Button>:null}
          {data.canAdminister&&request.status==='pending'?<Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>void save({type:'access.request.assign',requestId:request.id},`${t.assign}: ${request.targetTeamName}`)}>{t.assign}</Button>:null}
        </div></article>)}</div>
    </>:<>{!history.grants.length?<EmptyState bare icon={KeyRound}>{t.emptyGrants}</EmptyState>:null}
      <div className="divide-y divide-border">{history.grants.map(grant=><article key={grant.id} className="space-y-2 py-3 first:pt-0 last:pb-0"><HistoryTitle name={grant.targetTeamName} status={grant.status} label={t[grant.status]}/>
        <p className="flex items-center gap-2 text-sm"><OrgAvatar name={grant.beneficiaryName??t.unnamed} seed={grant.beneficiaryId} size={20} kind={grant.beneficiaryKind==='team'?'assistant':'member'}/><span className="font-medium">{grant.beneficiaryName??t.unnamed}</span></p>
        <Interval starts={grant.startsAt} expires={grant.expiresAt}/><InfoNote>{t.readOnly}</InfoNote>{grant.canRevoke?<Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>void save({type:'access.grant.revoke',grantId:grant.id,reason:t.revoke},`${t.revoke}: ${grant.targetTeamName}`)}>{t.revoke}</Button>:null}{data.readiness?.ready===true&&(data.canAdminister||(grant.beneficiaryKind==='member'&&grant.beneficiaryId===me.id))&&data.teams.some(team=>team.id===grant.targetTeamId&&(team.requestable||data.canAdminister))?<Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={()=>setRenewal(grant.id)}>{t.requestRenewal}</Button>:null}
        {renewal===grant.id&&data.readiness?.ready===true?<AccessRequestForm key={grant.id} renewal={grant} data={data} team={data.teams.find(team=>team.id===grant.targetTeamId)!} viewerId={me.id} busy={busy} save={save} close={()=>setRenewal(null)}/>:null}</article>)}</div>
    </>}
    {controls}
  </section>;
}
