"use client";


import type { DepartmentAccessCommand } from "@use-brian/shared";
/** Workspace department registry UI. [COMP:app-web/context-scope] */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isPhoneViewport } from "@/lib/viewport";
import Link from "next/link";
import { Archive, Building2, Check, Crown, Lock, Network, Plus, ShieldCheck, SlidersHorizontal, UsersRound } from "lucide-react";
import { AvatarStack, Chip, ClearanceBar, ClearancePill, InfoNote, ORG_TONES, SegmentedTabs, departmentTone, tabPanelProps, toneFill, toneSolid, type OrgTone } from "@/components/organization/org-visuals";
import { clearanceCounts, useDepartmentReaders } from "@/components/organization/department-access-panel";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DepartmentChangeFeedback, useDepartmentChange } from "@/components/workspace-access/use-department-change";
import type { ReviewCopy } from "@/components/workspace-access/use-reviewed-command";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT } from "@/lib/i18n/client";
import { fetchWorkspaceDepartmentRegistry, ORGANIZATION_CHANGED_EVENT } from "@/lib/api/workspace-access";
import { useCachedResource, invalidateSurfaceCache, markSurfaceCacheStale } from "@/lib/surface-cache";
import { useProtectedProjection } from "@/lib/use-protected-projection";
import { workspaceDepartmentRegistryCacheKey } from "@/lib/surface-prefetch";
import { isCatchUpRefresh, WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { organizationHref } from "@/lib/organization-navigation";
import { format } from "@/lib/i18n";


function stableKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 39);
}

/** `panel` names the department panel being filled; a caller without panels may ignore it. */
export function TeamsContextSection({renderAccessSettings}:{renderAccessSettings?:(teamId:string,panel?:'readers'|'policy')=>ReactNode}={}) {
  const { workspaceId, me } = useWorkspaceContext();
  const dictionary = useT(), t = dictionary.contextScope, accessCopy = dictionary.workspaceAccess;
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editColor, setEditColor] = useState("");
  const key=workspaceDepartmentRegistryCacheKey(workspaceId,me.id);
  const resource=useCachedResource(key,()=>fetchWorkspaceDepartmentRegistry(workspaceId));
  const change=useDepartmentChange(workspaceId,async(_result,isCurrent)=>{if(isCurrent())await resource.refresh();},selectedId);
  const data=useProtectedProjection(key,resource.data,()=>{
    change.cancelReview();setName("");setEditName("");setEditDescription("");setEditColor("");
  },resource.refresh);
  const teams=data?.teams??[];
  const selected=teams.find(team=>team.id===selectedId)??null;
  const canManage=data?.canAdminister===true;
  const [panel,setPanel]=useState<'readers'|'policy'|'details'>('readers');
  const detailRef=useRef<HTMLElement>(null);
  // On a phone the detail sits below every card; bring the chosen one into view.
  const choose=(id:string)=>{setSelectedId(id);if(isPhoneViewport())requestAnimationFrame(()=>detailRef.current?.scrollIntoView({block:'start',behavior:'smooth'}));};
  const {edges:readerEdges,directory}=useDepartmentReaders(teams.map(team=>team.id));
  const save=(command:DepartmentAccessCommand,description:ReviewCopy)=>data?change.save(command,description,data.policyRevision):Promise.resolve(null);
  useEffect(()=>{
    const purge=(event:Event)=>{
      const detail=(event as CustomEvent<{workspaceId?:string}>).detail;
      if(detail?.workspaceId&&detail.workspaceId!==workspaceId)return;
      // Reconnect catch-up: revalidate behind the paint (a changed projection
      // still purges drafts through useProtectedProjection's identity check).
      if(isCatchUpRefresh(event)){markSurfaceCacheStale(key);return;}
      change.cancelReview();invalidateSurfaceCache(key);
    };
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};
  },[workspaceId,key]);
  useEffect(()=>{if(data&&!selectedId&&data.teams[0])setSelectedId(data.teams[0].id);},[data,selectedId]);
  // Equal metadata renewals preserve unfinished drafts; object identity does not.
  useEffect(()=>{
    setEditName(selected?.name??"");
    setEditDescription(selected?.description??"");setEditColor(selected?.color??"");
  },[selectedId,selected?.name,selected?.description,selected?.color]);

  async function create() {
    const trimmed = name.trim();
    const key = stableKey(trimmed);
    if (!trimmed || !key) return;
    setError(null);
    try {
      const result = await save({ type: "department.create", name: trimmed, key },
        { title: format(t.createTeamReviewTitle, { name: trimmed }), description: t.createTeamReviewDescription, confirmLabel: t.createTeam });
      if (!result) return;
      setName("");setAdding(false);
      if (result.appliedCommand?.subjectId) {
        setPanel("readers");
        choose(result.appliedCommand.subjectId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    }
  }

  async function saveTeamDetails() {
    if (!selected || !editName.trim()) return;
    setError(null);
    try {
      if (!await save({ type: "department.update", teamId: selected.id,
        name: editName.trim(),
        description: editDescription.trim() || null,
        color: editColor.trim() || null,
      }, `${t.saveTeamDetails}: ${selected.name}`)) return;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function archive() {
    if (!selected) return;
    try {
      if (!await save({ type: "department.archive", teamId: selected.id }, `${selected.name}. ${t.archiveTeamDescription}`)) return;
      setSelectedId("");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  if(!data)return resource.error?<div className="space-y-3"><p role="alert">{t.loadFailed}</p><Button className="max-sm:min-h-11" onClick={()=>void resource.refresh()}>{accessCopy.reload}</Button></div>:<SurfaceSkeletonFor surface="organization" chrome={false}/>;
  const d=dictionary.departmentAccess,colors=dictionary.docPage.blockActions;
  const clearanceLabels={public:d.clearancePublic,internal:d.clearanceInternal,confidential:d.clearanceConfidential};
  const nameOf=(principal:{kind:'user'|'assistant';id:string})=>(principal.kind==='user'?data.people:data.assistants).find(row=>row.id===principal.id)?.name||(principal.kind==='user'?d.person:d.assistant);
  const fieldClass="h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring max-sm:h-11 md:text-sm";
  const toneNames:Record<OrgTone,string>={blue:colors.colorBlue,green:colors.colorGreen,purple:colors.colorPurple,orange:colors.colorOrange,pink:colors.colorPink,brown:colors.colorBrown,yellow:colors.colorYellow,red:colors.colorRed,gray:colors.colorGray};
  const departmentCard=(team:(typeof teams)[number])=>{
    const tone=departmentTone(team.color,team.id);
    const entry=directory?.find(row=>row.departmentId===team.id);
    const readers=readerEdges?.get(team.id);
    // People lead the stack; assistants follow.
    const stack=(readers??[]).map(edge=>({id:edge.principal.id,kind:edge.principal.kind==='user'?'member' as const:'assistant' as const,name:nameOf(edge.principal)})).sort((a,b)=>a.kind===b.kind?0:a.kind==='member'?-1:1);
    const linked=team.orgUnits.filter(unit=>unit.name.trim().toLocaleLowerCase()!==team.name.trim().toLocaleLowerCase()).map(unit=>unit.name).join(', ');
    const count=format(t.readerCount,{count:stack.length});
    return <li key={team.id} className="min-w-0"><button type="button" aria-pressed={team.id===selectedId} onClick={()=>choose(team.id)}
      className="flex h-full w-full min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:border-foreground/25 focus-visible:outline focus-visible:outline-ring aria-pressed:border-foreground/50 aria-pressed:bg-muted/40 aria-pressed:shadow-sm">
      <span className="flex w-full min-w-0 items-start gap-2.5">
        <span aria-hidden style={toneFill(tone)} className="grid size-8 shrink-0 place-items-center rounded-lg"><Building2 className="size-4"/></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{team.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{team.description||linked||'\u00a0'}</span></span>
        {entry?.isOwner?<Chip icon={Crown}>{d.owner}</Chip>:entry?.myClearance?<ClearancePill clearance={entry.myClearance} label={clearanceLabels[entry.myClearance]}/>:entry?<Chip icon={Lock}>{t.notAMember}</Chip>:null}
      </span>
      {readers?<span className="block w-full space-y-2">
        <span className="flex items-center justify-between gap-2">{stack.length?<AvatarStack items={stack} label={count} size={22}/>:<span className="text-xs text-muted-foreground">{t.noReaders}</span>}
          {stack.length?<span aria-hidden className="text-xs tabular-nums text-muted-foreground">{count}</span>:null}</span>
        <ClearanceBar counts={clearanceCounts(readers)} labels={clearanceLabels} legend={false}/>
      </span>:<span aria-hidden className={`block h-[38px] w-full rounded-md ${readerEdges?'':'animate-pulse bg-muted/50'}`}/>}
    </button></li>;
  };
  // Collapsed, the whole card is the "add" target; expanded, it is a
  // labelled form with the name field on its own row.
  const createDepartment=canManage?<li className="min-w-0">{adding
    ?<form onSubmit={event=>{event.preventDefault();void create();}} className="flex h-full flex-col gap-2.5 rounded-xl border border-foreground/30 bg-card p-3.5 shadow-sm">
      <label className="grid gap-1.5 text-sm font-medium">{t.teamNameLabel}
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setAdding(false);setName("");}}}
          placeholder={t.teamNameExample} className={`${fieldClass} w-full font-normal`} />
      </label>
      <div className="mt-auto flex justify-end gap-2">
        <Button type="button" variant="ghost" className="max-sm:min-h-11" onClick={()=>{setAdding(false);setName("");}}>{t.cancel}</Button>
        <Button type="submit" className="max-sm:min-h-11" disabled={change.busy || !name.trim()}>{t.createTeam}</Button>
      </div>
    </form>
    :<button type="button" onClick={()=>setAdding(true)}
      className="flex h-full min-h-[104px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-3.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted/40 hover:text-foreground focus-visible:outline focus-visible:outline-ring">
      <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-muted"><Plus className="size-4"/></span>{t.createTeamTitle}
    </button>}</li>:null;
  const selectedTone=selected?departmentTone(selected.color,selected.id):'gray';
  const prefix=`department-${selected?.id??'none'}`;
  const readers=selected?readerEdges?.get(selected.id):undefined;
  const swatch=(value:string,label:string,tone:OrgTone|null)=><button key={value||'none'} type="button" role="radio" aria-checked={editColor.trim().toLowerCase()===value} aria-label={label} title={label} disabled={change.busy}
    onClick={()=>setEditColor(value)} style={tone?toneSolid(tone):undefined}
    className={`grid size-6 place-items-center rounded-full border border-border ring-offset-2 ring-offset-background aria-checked:ring-2 aria-checked:ring-foreground/60 max-sm:size-11 ${tone?'':'bg-background text-muted-foreground'}`}>{tone?null:<span aria-hidden className="block h-px w-3.5 rotate-45 bg-current"/>}</button>;
  const details=<div className="space-y-5">
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-3">
        <h4 className="text-sm font-semibold">{t.departmentDetailsTitle}</h4>
        {canManage ? <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs text-muted-foreground">{t.teamNameLabel}
            <input value={editName} onChange={(event) => setEditName(event.target.value)} className={fieldClass} /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">{t.teamDescriptionLabel}
            <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} className={fieldClass} /></label>
          <div className="grid gap-1.5 text-xs text-muted-foreground sm:col-span-2"><span id={`${prefix}-color`}>{t.teamColorLabel}</span>
            <div role="radiogroup" aria-labelledby={`${prefix}-color`} className="flex flex-wrap items-center gap-2">
              {swatch('',colors.colorDefault,null)}
              {ORG_TONES.map(tone=>swatch(tone,toneNames[tone],tone))}
              {editColor.trim()&&!(ORG_TONES as readonly string[]).includes(editColor.trim().toLowerCase())?<span className="rounded-full bg-muted px-2 py-0.5 text-foreground">{editColor}</span>:null}
            </div></div>
          <Button size="sm" variant="outline" className="self-start justify-self-start max-sm:min-h-11" onClick={() => void saveTeamDetails()} disabled={change.busy || !editName.trim()}>
            <Check className="size-4" />{t.saveTeamDetails}
          </Button>
        </div> : selected?.description ? <p className="text-sm text-muted-foreground">{selected.description}</p> : null}
      </div>
      <aside className="min-w-0 space-y-3 text-sm lg:border-l lg:border-border/70 lg:pl-5">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{accessCopy.relatedOrgUnits}</h4>
        {selected?.orgUnits.length?<ul className="flex flex-wrap gap-1.5">{selected.orgUnits.map(unit=><li key={unit.id}><Link className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-muted max-sm:min-h-11" href={organizationHref(workspaceId)}><Network aria-hidden className="size-3"/>{unit.name}</Link></li>)}</ul>:<p className="text-xs text-muted-foreground">{accessCopy.noVisibleOrgUnits}</p>}
        <InfoNote>{format(accessCopy.requestPolicyHint,{defaultDays:data.requestPolicy.defaultDays,maxDays:data.requestPolicy.maxDays})}</InfoNote>
      </aside>
    </div>
    {canManage && selected?.status === "active" ? <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 px-3 py-2.5">
      <div className="min-w-0"><h4 className="text-sm font-medium">{t.departmentLifecycleTitle}</h4><p className="text-xs text-muted-foreground">{t.archiveTeamDescription}</p></div>
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive max-sm:min-h-11" disabled={change.busy} onClick={() => void archive()}><Archive className="size-4" />{t.archiveTeam}</Button>
    </section> : null}
  </div>;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">{t.teamsTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.teamsDescription}</p>
      </div>
      <DepartmentChangeFeedback change={change}/>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <ul aria-label={t.departmentPickerLabel} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{teams.map(departmentCard)}{createDepartment}</ul>
      {teams.length === 0 ? <p className="text-sm text-muted-foreground">{t.noTeams}</p> : null}
      {selected ? <section ref={detailRef} aria-label={selected.name} className="min-w-0 scroll-mt-4 rounded-xl border border-border bg-background">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden style={toneFill(selectedTone)} className="grid size-9 shrink-0 place-items-center rounded-lg"><Building2 className="size-4"/></span>
            <div className="min-w-0"><h3 className="truncate text-base font-semibold">{selected.name}</h3>
              {selected.description?<p className="truncate text-sm text-muted-foreground">{selected.description}</p>:null}</div>
          </div>
          {renderAccessSettings?<SegmentedTabs value={panel} onChange={setPanel} label={t.panelsLabel} idPrefix={prefix} items={[
            {value:'readers',label:t.readersTab,icon:UsersRound,count:readers?.length},
            {value:'policy',label:t.policyTab,icon:ShieldCheck},
            {value:'details',label:t.detailsTab,icon:SlidersHorizontal},
          ]}/>:null}
        </header>
        <div className="p-4 md:p-5">
          {renderAccessSettings?<>
            <div {...tabPanelProps(prefix,'readers')} hidden={panel!=='readers'}>{renderAccessSettings(selected.id,'readers')}</div>
            <div {...tabPanelProps(prefix,'policy')} hidden={panel!=='policy'}>{renderAccessSettings(selected.id,'policy')}</div>
            <div {...tabPanelProps(prefix,'details')} hidden={panel!=='details'}>{details}</div>
          </>:details}
        </div>
      </section> : null}
    </div>
  );
}
