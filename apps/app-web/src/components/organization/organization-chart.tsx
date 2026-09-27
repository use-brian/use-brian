"use client";

/** Directory-only hierarchy. Permissions are changed explicitly in Departments. [COMP:app-web/organization-chart] */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Bot, UserRound, Network, Plus, Search, Settings2 } from 'lucide-react';
import type { OrganizationChart, OrganizationCommand, OrganizationPlacement, OrganizationSubject, OrganizationUnit } from '@use-brian/shared';
import { useProtectedProjection } from '@/lib/use-protected-projection';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { organizationCacheKey } from '@/lib/surface-prefetch';
import { fetchOrganizationChart, ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { ASSISTANT_REFRESH_EVENT } from '@/lib/assistant-events';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Checkbox } from '@/components/ui/checkbox';
import { DepartmentChangeFeedback } from '@/components/workspace-access/use-department-change';
import { useOrganizationChange } from './use-organization-change';
import { SurfaceSkeletonFor } from '@/components/chrome/surface-skeleton';
import { openWorkspaceSettings } from '@/lib/workspace-settings-events';
import { OrganizationInitialization } from './organization-initialization';

type Editor = {kind:'unit';unit?:OrganizationUnit} | {kind:'subject';subject:OrganizationSubject;placement?:OrganizationPlacement};
const inputClass = 'min-h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] md:text-sm';

export function OrganizationChartView() {
  const {workspaceId,me} = useWorkspaceContext();
  return <OrganizationWorkspace key={`${workspaceId}:${me.id}`} />;
}

function OrganizationWorkspace() {
  const {workspaceId,me} = useWorkspaceContext();
  const t=useT().organization;
  const key=organizationCacheKey(workspaceId,me.id);
  const resource=useCachedResource(key,()=>fetchOrganizationChart(workspaceId));
  const [query,setQuery]=useState('');
  const [editor,setEditor]=useState<Editor|{kind:'initialize'}|null>(null);
  const change=useOrganizationChange(workspaceId,()=>{setEditor(null);invalidateSurfaceCache(key);});
  const selectEditor=(next:typeof editor)=>{change.cancelReview();setEditor(next);};
  // The viewer-keyed cache never reuses another account's directory. Security
  // signals PURGE instead of stale-while-revalidate so revoked rows disappear.
  useEffect(()=>{
    const refresh=(event:Event)=>{
      const detail=(event as CustomEvent<{workspaceId?:string}>).detail;
      if(detail?.workspaceId && detail.workspaceId!==workspaceId) return;
      change.cancelReview();setEditor(null);
      invalidateSurfaceCache(`organization:${workspaceId}:`);
    };
    const events=[ORGANIZATION_CHANGED_EVENT,WORKSPACE_IDENTITY_REFRESH_EVENT,ASSISTANT_REFRESH_EVENT];
    for(const event of events) window.addEventListener(event,refresh);
    return()=>{for(const event of events)window.removeEventListener(event,refresh);};
  },[workspaceId]);
  const chart=useProtectedProjection(key,resource.data,()=>{change.cancelReview();setEditor(null);setQuery('');},resource.refresh);
  // Selection stores only viewer-scoped data and is never reused after a scope switch.
  useEffect(()=>{setEditor(null);setQuery('');},[key]);
  const title=<div className="flex flex-wrap items-center justify-between gap-3">
    <div><h1 className="flex items-center gap-2 text-xl font-semibold"><Network className="size-5"/>{t.title}</h1><p className="mt-1 text-sm text-muted-foreground">{t.description}</p></div>
    <Button variant="outline" className="min-h-11" onClick={()=>openWorkspaceSettings('ws-access')}><Settings2 className="size-4"/>{t.departments}</Button>
  </div>;
  if(resource.error && !chart) return <main className="space-y-4 p-4 md:p-6">{title}<p role="alert">{t.loadError}</p><Button className="min-h-11" onClick={()=>void resource.refresh()}>{t.retry}</Button></main>;
  if(!chart) return <SurfaceSkeletonFor surface="organization"/>;
  const term=query.trim().toLocaleLowerCase();
  const subjectName=(subject:OrganizationSubject)=>subject.name || (subject.kind==='assistant'?t.unnamedAssistant:t.unnamedPerson);
  const subjectFor=(placement:OrganizationPlacement)=>chart.subjects.find(s=>s.id===(placement.userId??placement.assistantId)&&s.kind===(placement.userId?'member':'assistant'));
  const personName=(id:string|null)=>chart.subjects.find(s=>s.id===id&&s.kind==='member')?.name;
  const nameMatches=(subject:OrganizationSubject)=>subjectName(subject).toLocaleLowerCase().includes(term);
  const placementRow=(placement:OrganizationPlacement):ReactNode=>{
    const subject=subjectFor(placement); if(!subject)return null;
    const relation=placement.reportsToUserId?personName(placement.reportsToUserId):personName(placement.accountableUserId);
    return <li key={placement.id} className="min-w-0"><button type="button" onClick={()=>selectEditor({kind:'subject',subject,placement})} className="flex min-h-11 w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-ring">
      {subject.kind==='assistant'?<Bot aria-hidden className="mt-1 size-4 shrink-0"/>:<UserRound aria-hidden className="mt-1 size-4 shrink-0"/>}
      <span className="min-w-0"><span className="block break-words font-medium">{subjectName(subject)}</span><span className="block text-xs text-muted-foreground">{subject.kind==='assistant'?t.assistant:t.person}{!placement.isPrimary?` · ${t.secondary}`:''}</span>
        {relation?<span className="block break-words text-xs text-muted-foreground">{subject.kind==='assistant'?t.accountable:t.reportsTo}: {relation}</span>:null}</span>
    </button>{!term&&placement.userId?<ul className="ml-4 border-l border-border pl-2">{chart.placements.filter(p=>p.unitId===placement.unitId&&(p.userId?p.reportsToUserId:p.accountableUserId)===placement.userId).map(placementRow)}</ul>:null}</li>;
  };
  function unitTree(unit:OrganizationUnit,depth=0):ReactNode {
    const placements=chart!.placements.filter(p=>p.unitId===unit.id);
    const children=chart!.units.filter(u=>u.parentId===unit.id);
    return <li key={unit.id} className="min-w-0">
      <details open className="rounded-xl border border-border bg-card">
        <summary className="min-h-11 cursor-pointer break-words px-4 py-3 font-medium">{unit.name}</summary>
        <div className="space-y-2 px-2 pb-3">
          {unit.teamName?<p className="break-words px-2 text-xs text-muted-foreground">{t.linkedDepartment}: {unit.teamName}</p>:null}
          {chart!.canManage?<Button variant="ghost" className="min-h-11" onClick={()=>selectEditor({kind:'unit',unit})}>{t.editUnit}</Button>:null}
          <ul className="space-y-1">{placements.filter(p=>{if(term)return nameMatches(subjectFor(p)!);const parent=p.userId?p.reportsToUserId:p.accountableUserId;return !parent||!placements.some(person=>person.userId===parent);}).map(placementRow)}</ul>
          {!term&&children.length?<ul className={depth<4?'ml-2 space-y-3 border-l border-border pl-3':'space-y-3'}>{children.map(child=>unitTree(child,depth+1))}</ul>:null}
        </div>
      </details>
    </li>;
  }
  const units=term?chart.units.filter(u=>u.name.toLocaleLowerCase().includes(term)||chart.placements.some(p=>p.unitId===u.id&&subjectFor(p)&&nameMatches(subjectFor(p)!))):chart.units.filter(u=>!u.parentId);
  const unassigned=chart.subjects.filter(s=>!chart.placements.some(p=>p.isPrimary&&(s.kind==='member'?p.userId:p.assistantId)===s.id)&&(!term||nameMatches(s)));
  return <main className="h-full min-w-0 overflow-y-auto p-4 md:p-6">
    <div className="mx-auto max-w-6xl space-y-5">{title}<DepartmentChangeFeedback change={change}/>
      <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{t.permissionHint}{chart.canManage?` ${t.adminHint}`:''}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-full md:basis-0"><Search aria-hidden className="absolute left-3 top-3 size-5 text-muted-foreground"/><input aria-label={t.search} placeholder={t.search} value={query} onChange={e=>setQuery(e.target.value)} className={`${inputClass} pl-10`}/></label>
        {chart.canManage?<Button className="min-h-11" onClick={()=>selectEditor({kind:'unit'})}><Plus className="size-4"/>{t.addUnit}</Button>:null}
        {chart.canManage&&chart.initialization?.candidates.length?<Button variant="outline" className="min-h-11" onClick={()=>selectEditor({kind:'initialize'})}>{t.initialize}</Button>:null}
      </div>
      {resource.error?<p role="alert" className="text-sm text-destructive">{t.loadError}</p>:null}
      <div className={editor?'grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]':'min-w-0'}>
        <div className="min-w-0 space-y-5">
          {units.length?<ul aria-label={t.chart} className="grid min-w-0 gap-4">{units.map(unit=>unitTree(unit))}</ul>:<p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">{term?t.noResults:t.empty}</p>}
          {unassigned.length?<section className="rounded-xl border border-border p-3"><h2 className="px-2 py-2 font-semibold">{t.unassigned}</h2><ul>{unassigned.map(subject=><li key={`${subject.kind}:${subject.id}`}><button type="button" onClick={()=>selectEditor({kind:'subject',subject})} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-muted">{subject.kind==='assistant'?<Bot className="size-4"/>:<UserRound className="size-4"/>}<span className="min-w-0 break-words">{subjectName(subject)} <span className="text-xs text-muted-foreground">{subject.kind==='assistant'?t.assistant:t.person}</span></span></button></li>)}</ul></section>:null}
        </div>
        {editor?.kind==='initialize'?<OrganizationInitialization chart={chart} close={()=>selectEditor(null)} change={change}/>:editor?<OrganizationEditor key={editor.kind==='unit'?editor.unit?.id??'new':`${editor.subject.id}:${editor.placement?.id??'new'}`} chart={chart} editor={editor} close={()=>selectEditor(null)} change={change}/>:null}
      </div>
    </div>
  </main>;
}

function OrganizationEditor({chart,editor,close,change}:{chart:OrganizationChart;editor:Editor;close:()=>void;change:ReturnType<typeof useOrganizationChange>}) {
  const t=useT().organization;
  const unit=editor.kind==='unit'?editor.unit:undefined;
  const placement=editor.kind==='subject'?editor.placement:undefined;
  const subject=editor.kind==='subject'?editor.subject:undefined;
  const [name,setName]=useState(unit?.name??'');
  const [parent,setParent]=useState(unit?.parentId??'none');
  const [team,setTeam]=useState(unit?.teamId??'none');
  const [visibility,setVisibility]=useState(unit?.directoryVisibility??'members');
  const [unitId,setUnitId]=useState(placement?.unitId??'');
  const [primary,setPrimary]=useState(placement?.isPrimary??true);
  const [human,setHuman]=useState(placement?.reportsToUserId??placement?.accountableUserId??'none');
  const [destination,setDestination]=useState('none');
  const busy=change.busy;
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus();heading.current?.scrollIntoView?.({block:'nearest'});},[]);
  const pick=(label:string,value:string,onValueChange:(value:string)=>void,items:Array<{value:string;label:string}>)=><label className="grid gap-1 text-sm"><span>{label}</span><SearchableSelect aria-label={label} className="min-h-11" value={value} onValueChange={onValueChange} items={items} searchPlaceholder={t.search} emptyMessage={t.noResults} disabled={busy||!chart.canManage}/></label>;
  const units=chart.units.filter(u=>u.id!==unit?.id).map(u=>({value:u.id,label:u.name}));
  async function execute(command:OrganizationCommand,archive=false) {
    if(!chart.canManage||busy)return;
    await change.save(command,archive?t.archiveHint:t.confirmHint);
  }
  function submit(event:FormEvent) {
    event.preventDefault();
    if(editor.kind==='unit')void execute({type:'org.unit.save',...(unit?{id:unit.id,expectedVersion:unit.version}:{}),name,parentId:parent==='none'?null:parent,teamId:team==='none'?null:team,directoryVisibility:visibility,position:unit?.position??0});
    else void execute({type:'org.placement.save',...(placement?{id:placement.id,expectedVersion:placement.version}:{}),unitId,userId:subject!.kind==='member'?subject!.id:null,assistantId:subject!.kind==='assistant'?subject!.id:null,isPrimary:primary,reportsToUserId:primary&&subject!.kind==='member'&&human!=='none'?human:null,accountableUserId:primary&&subject!.kind==='assistant'&&human!=='none'?human:null});
  }
  return <aside aria-label={t.details} className="min-w-0 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-4">
    <div className="mb-3 flex items-center justify-between gap-2"><h2 ref={heading} tabIndex={-1} className="break-words font-semibold">{subject?.name||(editor.kind==='unit'?(unit?t.editUnit:t.addUnit):t.details)}</h2><Button variant="ghost" className="min-h-11" onClick={close}>{t.close}</Button></div>
    {subject?<div className="mb-4 flex flex-wrap gap-2">{subject.kind==='assistant'?<Link className="flex min-h-11 items-center text-sm text-primary underline" href={`/w/${chart.workspaceId}/studio/assistants?assistant=${subject.id}`}>{t.openAssistant}</Link>:<Button variant="outline" className="min-h-11" onClick={()=>openWorkspaceSettings('ws-members',{workspaceId:chart.workspaceId,memberId:subject.id})}>{t.openMember}</Button>}</div>:null}
    <form onSubmit={submit} className="space-y-4">
      {editor.kind==='unit'?<>
        <label className="grid gap-1 text-sm">{t.unitName}<input required maxLength={120} value={name} onChange={e=>setName(e.target.value)} className={inputClass} disabled={busy||!chart.canManage}/></label>
        {pick(t.parent,parent,setParent,[{value:'none',label:t.root},...units])}
        {pick(t.linkedDepartment,team,setTeam,[{value:'none',label:t.none},...chart.teams.filter(g=>!chart.units.some(u=>u.teamId===g.id&&u.id!==unit?.id)).map(g=>({value:g.id,label:g.name}))])}
        {pick(t.directory,visibility,value=>setVisibility(value as 'members'|'workspace'),[{value:'members',label:t.restricted},{value:'workspace',label:t.published}])}
        <p className="text-xs text-muted-foreground">{t.directoryHint}</p>
      </>:<>
        {pick(t.unit,unitId,setUnitId,units)}
        <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={primary} onCheckedChange={value=>setPrimary(Boolean(value))} disabled={busy||!chart.canManage}/>{t.primary}</label>
        {primary?pick(subject!.kind==='assistant'?t.accountable:t.reportsTo,human,setHuman,[{value:'none',label:t.none},...chart.subjects.filter(s=>s.kind==='member'&&s.id!==subject!.id).map(s=>({value:s.id,label:s.name||t.unnamedPerson}))]):null}
        {chart.canManage&&placement?<Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={()=>void execute({type:'org.placement.remove',id:placement.id,expectedVersion:placement.version})}>{t.unplace}</Button>:null}
        {chart.canManage&&placement?<Button type="button" variant="ghost" className="min-h-11" disabled={busy||!unitId} onClick={()=>void execute({type:'org.placement.save',unitId,userId:subject!.kind==='member'?subject!.id:null,assistantId:subject!.kind==='assistant'?subject!.id:null,isPrimary:false,reportsToUserId:null,accountableUserId:null})}>{t.addSecondary}</Button>:null}
      </>}
      <p className="text-xs text-muted-foreground">{t.permissionHint}</p>
      {chart.canManage?<Button type="submit" className="min-h-11 w-full" disabled={busy||(editor.kind==='unit'?!name.trim():!unitId)}>{busy?t.saving:t.save}</Button>:null}
    </form>
    {unit&&chart.canManage?<div className="mt-5 space-y-3 border-t border-border pt-4">
      {pick(t.archiveDestination,destination,setDestination,[{value:'none',label:t.unassigned},...units])}
      <p className="text-xs text-muted-foreground">{t.archiveHint}</p>
      <Button variant="outline" className="min-h-11 w-full" disabled={busy} onClick={()=>void execute({type:'org.unit.archive',id:unit.id,expectedVersion:unit.version,destinationId:destination==='none'?null:destination},true)}>{t.archiveUnit}</Button>
    </div>:null}
  </aside>;
}
