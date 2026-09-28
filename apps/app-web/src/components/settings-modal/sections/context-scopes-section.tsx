"use client";


import type { DepartmentAccessCommand } from "@use-brian/shared";
/** Workspace Team/Project registry and readiness UI. [COMP:app-web/context-scope] */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Archive, Check, Plus, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DepartmentChangeFeedback, useDepartmentChange } from "@/components/workspace-access/use-department-change";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT } from "@/lib/i18n/client";
import { fetchWorkspaceDepartmentRegistry, ORGANIZATION_CHANGED_EVENT } from "@/lib/api/workspace-access";
import { useCachedResource, invalidateSurfaceCache } from "@/lib/surface-cache";
import { useProtectedProjection } from "@/lib/use-protected-projection";
import { workspaceDepartmentRegistryCacheKey } from "@/lib/surface-prefetch";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { organizationHref } from "@/lib/organization-navigation";
import { format } from "@/lib/i18n";
import {
  archiveContextProject,
  createContextProject,
  getContextReadiness,
  listContextProjects,
  updateContextProject,
  type ContextProject,
  type ContextReadiness,
} from "@/lib/api/context-scopes";

function stableKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 39);
}

export function TeamsContextSection({renderAccessSettings}:{renderAccessSettings?:(teamId:string)=>ReactNode}={}) {
  const { workspaceId, me } = useWorkspaceContext();
  const dictionary = useT(), t = dictionary.contextScope, accessCopy = dictionary.workspaceAccess;
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [grantIds, setGrantIds] = useState<string[]>([]);
  const [readAll, setReadAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editColor, setEditColor] = useState("");
  const key=workspaceDepartmentRegistryCacheKey(workspaceId,me.id);
  const resource=useCachedResource(key,()=>fetchWorkspaceDepartmentRegistry(workspaceId));
  const change=useDepartmentChange(workspaceId,async(_result,isCurrent)=>{if(isCurrent())await resource.refresh();},selectedId);
  const data=useProtectedProjection(key,resource.data,()=>{
    change.cancelReview();setName("");setEditName("");setEditDescription("");setEditColor("");setGrantIds([]);setReadAll(false);
  },resource.refresh);
  const teams=data?.teams??[];
  const selected=teams.find(team=>team.id===selectedId)??null;
  const members=(data?.people??[]).map(person=>({userId:person.id,userName:person.name}));
  const assistants=data?.assistants??[];
  const canManage=data?.canAdminister===true;
  const save=(command:DepartmentAccessCommand,description:string)=>data?change.save(command,description,data.policyRevision):Promise.resolve(null);
  useEffect(()=>{
    const purge=(event:Event)=>{
      const detail=(event as CustomEvent<{workspaceId?:string}>).detail;
      if(detail?.workspaceId&&detail.workspaceId!==workspaceId)return;
      change.cancelReview();invalidateSurfaceCache(key);
    };
    window.addEventListener(ORGANIZATION_CHANGED_EVENT,purge);
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);
    return()=>{window.removeEventListener(ORGANIZATION_CHANGED_EVENT,purge);window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT,purge);};
  },[workspaceId,key]);
  useEffect(()=>{if(data&&!selectedId&&data.teams[0])setSelectedId(data.teams[0].id);},[data,selectedId]);
  // Equal metadata renewals preserve unfinished drafts; object identity does not.
  const selectedBundle=selected?.readGrantGroupIds.join(',');
  useEffect(()=>{
    setGrantIds((selected?.readGrantGroupIds??[]).filter(id=>id!==selected?.id));
    setReadAll(selected?.readAll??false);setEditName(selected?.name??"");
    setEditDescription(selected?.description??"");setEditColor(selected?.color??"");
  },[selectedId,selected?.name,selected?.description,selected?.color,selected?.readAll,selectedBundle]);

  async function create() {
    const trimmed = name.trim();
    const key = stableKey(trimmed);
    if (!trimmed || !key) return;
    setError(null);
    try {
      const result = await save({ type: "department.create", name: trimmed, key }, `${t.createTeam}: ${trimmed}`);
      if (!result) return;
      setName("");
      if (result.appliedCommand?.subjectId) setSelectedId(result.appliedCommand.subjectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    }
  }

  async function saveGrants() {
    if (!selected) return;
    setError(null);
    try {
      if (!await save({ type: "department.read_bundle.set", teamId: selected.id, readAll, groupIds: grantIds }, `${t.saveAccess}: ${selected.name}`)) return;
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

  async function setMember(userId: string, enabled: boolean) {
    if (!selected) return;
    setError(null);
    try {
      if (!await save({ type: "department.member.set", teamId: selected.id, userId, enabled, activateAssigned: false }, `${t.teamMembersTitle}: ${selected.name}. ${members.find(member => member.userId === userId)?.userName ?? t.members}. ${t.membershipModeHint}`)) return;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function setAssistant(assistantId: string, enabled: boolean) {
    if (!selected) return;
    setError(null);
    try {
      if (!await save({ type: "department.assistant.set", teamId: selected.id, assistantId, enabled }, `${t.teamAssistantsTitle}: ${selected.name}. ${assistants.find(assistant => assistant.id === assistantId)?.name ?? t.teamAssistantsTitle}`)) return;
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

  if(!data)return resource.error?<div className="space-y-3"><p role="alert">{t.loadFailed}</p><Button className="min-h-11" onClick={()=>void resource.refresh()}>{accessCopy.reload}</Button></div>:<SurfaceSkeletonFor surface="organization"/>;
  const createDepartment=canManage?<section className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
    <h3 className="font-medium">{t.createTeamTitle}</h3>
    <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t.teamNamePlaceholder}
      aria-label={t.teamNameLabel} className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] outline-none focus-visible:border-ring md:text-sm" />
    <Button className="min-h-11 w-full" onClick={() => void create()} disabled={change.busy || !name.trim()}><Plus className="size-4" />{t.createTeam}</Button>
  </section>:null;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t.teamsTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.teamsDescription}</p>
      </div>
      <DepartmentChangeFeedback change={change}/>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {teams.length === 0 ? <div className="grid gap-4 lg:max-w-sm">{createDepartment}<p className="text-sm text-muted-foreground">{t.noTeams}</p></div> : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
          <aside className="space-y-4 lg:sticky lg:top-4">
            <section className="space-y-3 rounded-xl border border-border bg-background p-4">
              <h3 className="font-medium">{t.departmentPickerLabel}</h3>
              <SearchableSelect aria-label={t.departmentPickerLabel} value={selectedId} disabled={change.busy} onValueChange={setSelectedId}
                items={teams.map((team) => ({ value: team.id, label: team.name }))}
                searchPlaceholder={t.searchTeams} emptyMessage={t.noTeams} />
            </section>
            {createDepartment}
          </aside>
          {selected ? <div className="min-w-0 space-y-4">
            <section className="space-y-4 rounded-xl border border-border bg-background p-4 md:p-5">
              <div><h3 className="font-semibold">{t.departmentDetailsTitle}</h3><p className="mt-1 text-sm text-muted-foreground">{selected.name}</p></div>
              {canManage ? <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {t.teamNameLabel}
                    <input value={editName} onChange={(event) => setEditName(event.target.value)}
                      className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm" />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {t.teamColorLabel}
                    <input value={editColor} onChange={(event) => setEditColor(event.target.value)} placeholder={t.teamColorPlaceholder}
                      className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm" />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
                    {t.teamDescriptionLabel}
                    <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)}
                      className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm" />
                  </label>
                  <Button size="sm" variant="outline" className="min-h-11 self-start" onClick={() => void saveTeamDetails()} disabled={change.busy || !editName.trim()}>
                    <Check className="size-4" />{t.saveTeamDetails}
                  </Button>
                </div> : <p className="text-sm text-muted-foreground">{selected.description || t.flatGrantHint}</p>}
              <p className="text-xs text-muted-foreground">{t.flatGrantHint}</p>
            </section>
            <section className="space-y-4 rounded-xl border border-border bg-background p-4 md:p-5">
              <h3 className="font-semibold">{t.membershipTitle}</h3>
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamMembersTitle}</h4>
                  <p className="mb-3 text-xs text-muted-foreground">{t.membershipModeHint}</p>
                  <div className="space-y-2">
                    {members.map((member) => (
                      <label key={member.userId} className="flex min-h-11 items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm">
                        <Checkbox checked={selected.memberIds.includes(member.userId)} disabled={!canManage || change.busy}
                          onCheckedChange={(value) => void setMember(member.userId, Boolean(value))} />
                        {member.userName || dictionary.workspaceAccess.unnamed}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamAssistantsTitle}</h4>
                  <div className="space-y-2">
                    {assistants.map((assistant) => (
                      <label key={assistant.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm">
                        <Checkbox checked={selected.assistantIds.includes(assistant.id)} disabled={!canManage || change.busy}
                          onCheckedChange={(value) => void setAssistant(assistant.id, Boolean(value))} />
                        {assistant.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <section className="space-y-4 rounded-xl border border-border bg-background p-4 md:p-5">
              <h3 className="font-semibold">{t.readAccessTitle}</h3>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={readAll} onCheckedChange={(value) => setReadAll(Boolean(value))} disabled={!canManage || change.busy} />
                {t.readAllTeams}
              </label>
              {!readAll ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {teams.filter((team) => team.id !== selected.id && team.status === "active").map((team) => (
                    <label key={team.id} className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm">
                      <Checkbox checked={grantIds.includes(team.id)} disabled={!canManage || change.busy}
                        onCheckedChange={(value) => setGrantIds((current) => value ? [...new Set([...current, team.id])] : current.filter((id) => id !== team.id))} />
                      {team.name}
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {readAll
                  ? t.accessPreviewAll
                  : `${t.accessPreviewPrefix} ${[selected.name, ...teams.filter((team) => grantIds.includes(team.id)).map((team) => team.name)].join(", ")}`}
              </div>
              <div className="space-y-2 text-sm">
                <h4 className="font-medium">{accessCopy.relatedOrgUnits}</h4>
                {selected.orgUnits.length?<ul>{selected.orgUnits.map(unit=><li key={unit.id}><Link className="flex min-h-11 items-center underline" href={organizationHref(workspaceId)}>{unit.name}</Link></li>)}</ul>:<p className="text-muted-foreground">{accessCopy.noVisibleOrgUnits}</p>}
                <p className="text-muted-foreground">{format(accessCopy.requestPolicyHint,{defaultDays:data.requestPolicy.defaultDays,maxDays:data.requestPolicy.maxDays})}</p>
              </div>
              {canManage ? <Button size="sm" className="min-h-11" disabled={change.busy} onClick={() => void saveGrants()}><Check className="size-4" />{t.saveAccess}</Button> : null}
            </section>
            {renderAccessSettings?<section className="rounded-xl border border-border bg-background p-4 md:p-5">{renderAccessSettings(selected.id)}</section>:null}
            {canManage && selected.status === "active" ? <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4"><h3 className="font-medium">{t.departmentLifecycleTitle}</h3><Button variant="ghost" size="sm" className="min-h-11 text-destructive hover:text-destructive" disabled={change.busy} onClick={() => void archive()}><Archive className="size-4" />{t.archiveTeam}</Button></section> : null}
          </div> : null}
        </div>
      )}
    </div>
  );
}

export function ProjectsContextSection() {
  const { workspaceId, role } = useWorkspaceContext();
  const t = useT().contextScope;
  const [projects, setProjects] = useState<ContextProject[]>([]);
  const [readiness, setReadiness] = useState<ContextReadiness | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canManage = role === "owner" || role === "admin";
  const active = useMemo(() => projects.filter((project) => project.status === "active"), [projects]);

  async function reload() {
    const [nextProjects, nextReadiness] = await Promise.all([
      listContextProjects(workspaceId, true),
      canManage ? getContextReadiness(workspaceId) : Promise.resolve(null),
    ]);
    setProjects(nextProjects);
    setReadiness(nextReadiness);
  }
  useEffect(() => { void reload().catch(() => setError(t.loadFailed)); }, [workspaceId, canManage]);

  async function create() {
    if (!name.trim()) return;
    try {
      await createContextProject(workspaceId, { name: name.trim() });
      setName("");
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function archive(project: ContextProject) {
    const confirmed = await confirmDialog({
      title: t.archiveProjectTitle,
      description: t.archiveProjectDescription,
      confirmLabel: t.archiveProject,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return;
    try { await archiveContextProject(workspaceId, project.id); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function restore(project: ContextProject) {
    try {
      await updateContextProject(workspaceId, project.id, { status: "active" });
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  return (
    <div className="space-y-6">
      <div><h2 className="text-lg font-semibold">{t.projectsTitle}</h2><p className="mt-1 text-sm text-muted-foreground">{t.projectsDescription}</p></div>
      {canManage ? <div className="flex gap-2">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t.projectNamePlaceholder}
          className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-[16px] outline-none focus-visible:border-ring md:text-sm" />
        <Button onClick={() => void create()} disabled={!name.trim()}><Plus className="size-4" />{t.createProject}</Button>
      </div> : null}
      {readiness ? (
        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 font-medium">
            {readiness.readyForActivation ? <ShieldCheck className="size-4 text-emerald-500" /> : <ShieldAlert className="size-4 text-amber-500" />}
            {readiness.readyForActivation ? t.ready : t.notReady}
          </div>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {readiness.checks.filter((check) => check.blocking).map((check) => <li key={check.id}>{check.ready ? "✓" : "○"} {check.detail}</li>)}
          </ul>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="divide-y divide-border rounded-xl border border-border">
        {projects.map((project) => <div key={project.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1"><Link href={`/w/${workspaceId}/projects/${project.id}`} className="truncate text-sm font-medium hover:underline">{project.name}</Link><p className="text-xs text-muted-foreground">{project.status === "active" ? t.active : t.archived}</p></div>
          {canManage && project.status === "active" ? <Button variant="ghost" size="sm" onClick={() => void archive(project)}><Archive className="size-4" />{t.archiveProject}</Button> : null}
          {canManage && project.status === "archived" ? <Button variant="ghost" size="sm" onClick={() => void restore(project)}>{t.restoreProject}</Button> : null}
        </div>)}
        {active.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">{t.noProjects}</p> : null}
      </div>
    </div>
  );
}
