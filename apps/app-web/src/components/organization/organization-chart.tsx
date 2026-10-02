"use client";

/** Directory-only hierarchy. Permissions are changed explicitly in Departments. [COMP:app-web/organization-chart] */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Bot, Building2, ChevronDown, ListChecks, Network, Pencil, Plus, Search, UserRound, UserX } from 'lucide-react';
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
import { organizationHref } from '@/lib/organization-navigation';
import { OrganizationInitialization } from './organization-initialization';
import { OrganizationTopbarActions, organizationTopbarActionCls, organizationTopbarPrimaryCls } from './organization-chrome';
import { EmptyState, HowItWorks, OrgAvatar, StatStrip, StatTile, toneFor, toneSolid } from './org-visuals';
import { format } from '@/lib/i18n/format';

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
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
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
  useEffect(()=>{setEditor(null);setQuery('');setCollapsed(new Set());},[key]);
  const title=<div><h2 className="text-lg font-semibold">{t.structureTab}</h2><p className="mt-1 text-sm text-muted-foreground">{t.description}</p></div>;
  if(resource.error && !chart) return <main className="space-y-4">{title}<p role="alert">{t.loadError}</p><Button className="max-sm:min-h-11" onClick={()=>void resource.refresh()}>{t.retry}</Button></main>;
  if(!chart) return <SurfaceSkeletonFor surface="organization" chrome={false}/>;
  const term=query.trim().toLocaleLowerCase();
  const subjectName=(subject:OrganizationSubject)=>subject.name || (subject.kind==='assistant'?t.unnamedAssistant:t.unnamedPerson);
  const subjectFor=(placement:OrganizationPlacement)=>chart.subjects.find(s=>s.id===(placement.userId??placement.assistantId)&&s.kind===(placement.userId?'member':'assistant'));
  const personName=(id:string|null)=>chart.subjects.find(s=>s.id===id&&s.kind==='member')?.name;
  const nameMatches=(subject:OrganizationSubject)=>subjectName(subject).toLocaleLowerCase().includes(term);
  const isPlaced=(subject:OrganizationSubject)=>chart.placements.some(p=>p.isPrimary&&(subject.kind==='member'?p.userId:p.assistantId)===subject.id);
  const placementRow=(placement:OrganizationPlacement):ReactNode=>{
    const subject=subjectFor(placement); if(!subject)return null;
    const parentId=placement.userId?placement.reportsToUserId:placement.accountableUserId;
    const relation=personName(parentId);
    // Nesting already shows a manager in the same unit; label only cross-unit or searched rows.
    const nestedHere=!term&&chart.placements.some(p=>p.unitId===placement.unitId&&p.userId===parentId);
    const relationLabel=relation&&!nestedHere?`${subject.kind==='assistant'?t.accountable:t.reportsTo}: ${relation}`:null;
    const reports=!term&&placement.userId?chart.placements.filter(p=>p.unitId===placement.unitId&&(p.userId?p.reportsToUserId:p.accountableUserId)===placement.userId):[];
    return <li key={placement.id} className="min-w-0"><button type="button" onClick={()=>selectEditor({kind:'subject',subject,placement})} title={relation?`${subject.kind==='assistant'?t.accountable:t.reportsTo}: ${relation}`:undefined}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted focus-visible:outline focus-visible:outline-ring max-sm:min-h-11">
      <OrgAvatar name={subjectName(subject)} kind={subject.kind} seed={subject.id} size={22}/>
      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{subjectName(subject)}</span>
        <span className="sr-only"> {subject.kind==='assistant'?t.assistant:t.person}</span>
        {!placement.isPrimary||relationLabel?<span className="block truncate text-[11px] text-muted-foreground">{[!placement.isPrimary?t.secondary:null,relationLabel].filter(Boolean).join(' · ')}</span>:null}</span>
    </button>{reports.length?<ul className="ml-[18px] border-l border-border pl-1.5">{reports.map(placementRow)}</ul>:null}</li>;
  };
  const toggleUnit=(id:string)=>setCollapsed(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});
  function unitCard(unit:OrganizationUnit):ReactNode {
    const placements=chart!.placements.filter(p=>p.unitId===unit.id);
    const children=chart!.units.filter(u=>u.parentId===unit.id).sort((a,b)=>a.position-b.position);
    const shown=placements.filter(p=>{if(term)return nameMatches(subjectFor(p)!);const parent=p.userId?p.reportsToUserId:p.accountableUserId;return !parent||!placements.some(person=>person.userId===parent);});
    const people=placements.filter(p=>p.userId).length,assistants=placements.filter(p=>p.assistantId).length;
    const folded=collapsed.has(unit.id);
    const sameName=Boolean(unit.teamName)&&unit.teamName!.trim().toLocaleLowerCase()===unit.name.trim().toLocaleLowerCase();
    return <li key={unit.id} className="org-node min-w-0">
      <article aria-label={unit.name} className={`w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm ${term?'':'md:w-60'}`}>
        <div aria-hidden style={toneSolid(unit.teamId?toneFor(unit.teamId):'gray')} className="h-1"/>
        <header className="flex items-start gap-2 px-3 pb-1.5 pt-2.5">
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-sm font-semibold leading-5">{unit.name}{sameName?<span title={`${t.linkedDepartment}: ${unit.teamName}`} className="ml-1 inline-flex align-[-1px] text-muted-foreground"><Building2 aria-hidden className="size-3"/><span className="sr-only">{t.linkedDepartment}: {unit.teamName}</span></span>:null}</h3>
            {unit.teamName&&!sameName?<p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"><Building2 aria-hidden className="size-3 shrink-0"/><span className="sr-only">{t.linkedDepartment}: </span><span className="truncate">{unit.teamName}</span></p>:null}
          </div>
          <span title={format(t.unitCounts,{people,assistants})} className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-0.5"><UserRound aria-hidden className="size-3"/>{people}</span>
            {assistants?<span className="inline-flex items-center gap-0.5"><Bot aria-hidden className="size-3"/>{assistants}</span>:null}
          </span>
          {chart!.canManage?<button type="button" aria-label={format(t.editUnitNamed,{unit:unit.name})} title={t.editUnit} onClick={()=>selectEditor({kind:'unit',unit})}
            className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring max-sm:size-11"><Pencil aria-hidden className="size-3.5"/></button>:null}
        </header>
        {shown.length?<ul className="space-y-0.5 px-1.5 pb-2">{shown.map(placementRow)}</ul>:<p className="px-3 pb-3 text-xs text-muted-foreground">{t.emptyUnit}</p>}
        {!term&&children.length?<button type="button" aria-expanded={!folded} onClick={()=>toggleUnit(unit.id)}
          className="flex w-full items-center justify-center gap-1 border-t border-border py-1.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground max-sm:min-h-11">
          <ChevronDown aria-hidden className={`size-3 transition-transform ${folded?'-rotate-90':''}`}/>{folded?format(t.showSubunits,{count:children.length}):t.hideSubunits}</button>:null}
      </article>
      {!term&&children.length&&!folded?<ul className="org-children">{children.map(child=>unitCard(child))}</ul>:null}
    </li>;
  }
  const units=term?chart.units.filter(u=>u.name.toLocaleLowerCase().includes(term)||chart.placements.some(p=>p.unitId===u.id&&subjectFor(p)&&nameMatches(subjectFor(p)!))):chart.units.filter(u=>!u.parentId).sort((a,b)=>a.position-b.position);
  const unassignedAll=chart.subjects.filter(s=>!isPlaced(s));
  const unassigned=unassignedAll.filter(s=>!term||nameMatches(s));
  const total=(kind:'member'|'assistant')=>chart.subjects.filter(s=>s.kind===kind).length;
  const placed=(kind:'member'|'assistant')=>chart.subjects.filter(s=>s.kind===kind&&isPlaced(s)).length;
  const canInitialize=chart.canManage&&Boolean(chart.initialization?.candidates.length);
  return <main className="min-w-0 space-y-5">
    {chart.canManage?<OrganizationTopbarActions>
      {canInitialize?<button type="button" aria-label={t.initialize} title={t.initialize} aria-pressed={editor?.kind==='initialize'} onClick={()=>selectEditor({kind:'initialize'})} className={organizationTopbarActionCls}><ListChecks aria-hidden className="size-3.5 shrink-0"/><span className="max-lg:hidden">{t.initialize}</span></button>:null}
      <button type="button" aria-label={t.addUnit} title={t.addUnit} onClick={()=>selectEditor({kind:'unit'})} className={organizationTopbarPrimaryCls}><Plus aria-hidden className="size-4 shrink-0"/><span className="max-sm:hidden">{t.addUnit}</span></button>
    </OrganizationTopbarActions>:null}
    {title}<DepartmentChangeFeedback change={change}/>
    <StatStrip label={t.overview}>
      <StatTile icon={Network} tone="purple" label={t.statUnits} value={chart.units.length}/>
      <StatTile icon={UserRound} tone="blue" label={t.statPeoplePlaced} value={placed('member')} hint={format(t.statOfTotal,{total:total('member')})}/>
      <StatTile icon={Bot} tone="green" label={t.statAssistantsPlaced} value={placed('assistant')} hint={format(t.statOfTotal,{total:total('assistant')})}/>
      <StatTile icon={UserX} tone={unassignedAll.length?'orange':'gray'} label={t.unassigned} value={unassignedAll.length}/>
    </StatStrip>
    <HowItWorks summary={t.noteSummary}><p>{t.permissionHint}{chart.canManage?` ${t.adminHint}`:''}</p></HowItWorks>
    <label className="relative block min-w-0"><Search aria-hidden className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><input aria-label={t.search} placeholder={t.search} value={query} onChange={e=>setQuery(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-[16px] outline-none focus-visible:border-ring max-sm:h-11 md:text-sm"/></label>
    {resource.error?<p role="alert" className="text-sm text-destructive">{t.loadError}</p>:null}
    <div className={editor?'grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]':'min-w-0'}>
      <div className="min-w-0 space-y-4">
        {units.length?(term?<ul aria-label={t.chart} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">{units.map(unit=>unitCard(unit))}</ul>
          :<div className="-mx-1 overflow-x-auto px-1 pb-2"><ul aria-label={t.chart} className="org-tree md:mx-auto md:w-max">{units.map(unit=>unitCard(unit))}</ul></div>)
          :<EmptyState icon={Network} action={!term&&chart.canManage?<Button variant="outline" className="max-sm:min-h-11" onClick={()=>selectEditor({kind:'unit'})}><Plus className="size-4"/>{t.addUnit}</Button>:null}>{term?t.noResults:t.empty}</EmptyState>}
        {unassigned.length?<section aria-label={t.unassigned} className="rounded-xl border border-border bg-card p-3">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">{t.unassigned}<span className="rounded-full bg-muted px-2 text-xs font-medium tabular-nums text-muted-foreground">{unassigned.length}</span></h2>
          <ul className="flex flex-wrap gap-1.5">{unassigned.map(subject=><li key={`${subject.kind}:${subject.id}`} className="min-w-0"><button type="button" onClick={()=>selectEditor({kind:'subject',subject})}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pl-0.5 pr-2.5 text-[13px] hover:bg-muted focus-visible:outline focus-visible:outline-ring max-sm:min-h-11">
            <OrgAvatar name={subjectName(subject)} kind={subject.kind} seed={subject.id} size={22}/>
            <span className="truncate">{subjectName(subject)}</span><span className="sr-only"> {subject.kind==='assistant'?t.assistant:t.person}</span>
          </button></li>)}</ul>
        </section>:null}
      </div>
      {editor?.kind==='initialize'?<OrganizationInitialization chart={chart} close={()=>selectEditor(null)} change={change}/>:editor?<OrganizationEditor key={editor.kind==='unit'?editor.unit?.id??'new':`${editor.subject.id}:${editor.placement?.id??'new'}`} chart={chart} editor={editor} close={()=>selectEditor(null)} change={change}/>:null}
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
    {subject?<div className="mb-4 flex flex-wrap gap-2">{subject.kind==='assistant'?<Link className="flex min-h-11 items-center text-sm text-primary underline" href={`/w/${chart.workspaceId}/studio/assistants?assistant=${subject.id}`}>{t.openAssistant}</Link>:<Link className="flex min-h-11 items-center text-sm text-primary underline" href={organizationHref(chart.workspaceId,'people',subject.id)}>{t.openMember}</Link>}</div>:null}
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
