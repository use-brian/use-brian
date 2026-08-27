"use client";

/** Workspace Team/Project registry and readiness UI. [COMP:app-web/context-scope] */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, Check, Info, Plus, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import {
  archiveContextProject,
  archiveContextTeam,
  createContextProject,
  createContextTeam,
  getContextTeam,
  getContextExplanation,
  getContextReadiness,
  listContextProjects,
  listContextTeams,
  setTeamReadGrants,
  setContextTeamAssistant,
  setContextTeamMember,
  updateContextTeam,
  updateContextProject,
  type ContextExplanation,
  type ContextProject,
  type ContextReadiness,
  type ContextTeam,
} from "@/lib/api/context-scopes";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type RosterMember = { userId: string; userName?: string | null; email?: string | null };
type RosterAssistant = { id: string; name: string };

function stableKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 39);
}

export function TeamsContextSection() {
  const { workspaceId, role } = useWorkspaceContext();
  const t = useT().contextScope;
  const [teams, setTeams] = useState<ContextTeam[]>([]);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [grantIds, setGrantIds] = useState<string[]>([]);
  const [readAll, setReadAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextTeam | null>(null);
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [assistants, setAssistants] = useState<RosterAssistant[]>([]);
  const [explanation, setExplanation] = useState<ContextExplanation | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editColor, setEditColor] = useState("");
  const canManage = role === "owner" || role === "admin";

  async function reload() {
    const next = await listContextTeams(workspaceId);
    setTeams(next);
    if (!selectedId && next[0]) setSelectedId(next[0].id);
  }
  useEffect(() => { void reload().catch(() => setError(t.loadFailed)); }, [workspaceId]);
  const selected = teams.find((team) => team.id === selectedId) ?? null;
  useEffect(() => {
    setGrantIds((selected?.readGrantGroupIds ?? []).filter((id) => id !== selected?.id));
    setReadAll(selected?.readAll ?? false);
    setEditName(selected?.name ?? "");
    setEditDescription(selected?.description ?? "");
    setEditColor(selected?.color ?? "");
  }, [
    selectedId,
    selected?.name,
    selected?.description,
    selected?.color,
    selected?.readAll,
    selected?.readGrantGroupIds,
  ]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      selectedId ? getContextTeam(workspaceId, selectedId) : Promise.resolve(null),
      authFetch(`${API_URL}/api/workspaces/${workspaceId}`).then((response) => response.ok ? response.json() : {}),
      authFetch(`${API_URL}/api/assistants?workspaceId=${encodeURIComponent(workspaceId)}`).then((response) => response.ok ? response.json() : {}),
      selectedId
        ? getContextExplanation(workspaceId, { groupId: selectedId }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([nextDetail, workspace, assistantBody, nextExplanation]) => {
      if (cancelled) return;
      setDetail(nextDetail);
      setMembers((workspace as { members?: RosterMember[] }).members ?? []);
      setAssistants((assistantBody as { assistants?: RosterAssistant[] }).assistants ?? []);
      setExplanation(nextExplanation);
    }).catch(() => { if (!cancelled) setError(t.loadFailed); });
    return () => { cancelled = true; };
  }, [workspaceId, selectedId, t.loadFailed]);

  async function create() {
    const trimmed = name.trim();
    const key = stableKey(trimmed);
    if (!trimmed || !key) return;
    setError(null);
    try {
      const created = await createContextTeam(workspaceId, { name: trimmed, key });
      setName("");
      await reload();
      setSelectedId(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    }
  }

  async function saveGrants() {
    if (!selected) return;
    setError(null);
    try {
      await setTeamReadGrants(workspaceId, selected.id, { readAll, groupIds: grantIds });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    }
  }

  async function saveTeamDetails() {
    if (!selected || !editName.trim()) return;
    setError(null);
    try {
      await updateContextTeam(workspaceId, selected.id, {
        name: editName.trim(),
        description: editDescription.trim() || null,
        color: editColor.trim() || null,
      });
      await reload();
      setDetail(await getContextTeam(workspaceId, selected.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function setMember(userId: string, enabled: boolean) {
    if (!selected) return;
    setError(null);
    try {
      await setContextTeamMember(workspaceId, selected.id, userId, enabled);
      setDetail(await getContextTeam(workspaceId, selected.id));
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function setAssistant(assistantId: string, enabled: boolean) {
    if (!selected) return;
    setError(null);
    try {
      await setContextTeamAssistant(workspaceId, selected.id, assistantId, enabled);
      setDetail(await getContextTeam(workspaceId, selected.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function archive() {
    if (!selected) return;
    const confirmed = await confirmDialog({
      title: t.archiveTeamTitle,
      description: t.archiveTeamDescription,
      confirmLabel: t.archiveTeam,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return;
    try { await archiveContextTeam(workspaceId, selected.id); setSelectedId(""); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t.teamsTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.teamsDescription}</p>
      </div>
      {canManage ? (
        <div className="flex gap-2">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t.teamNamePlaceholder}
            className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring" />
          <Button onClick={() => void create()} disabled={!name.trim()}><Plus className="size-4" />{t.createTeam}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {teams.length === 0 ? <p className="text-sm text-muted-foreground">{t.noTeams}</p> : (
        <div className="space-y-4">
          <SearchableSelect value={selectedId} onValueChange={setSelectedId}
            items={teams.map((team) => ({ value: team.id, label: team.name, hint: `${team.memberCount} ${t.members}` }))}
            searchPlaceholder={t.searchTeams} emptyMessage={t.noTeams} />
          {selected ? (
            <div className="rounded-xl border border-border p-4 space-y-4">
              <div><h3 className="font-medium">{selected.name}</h3><p className="text-xs text-muted-foreground">{t.flatGrantHint}</p></div>
              {canManage ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {t.teamNameLabel}
                    <input value={editName} onChange={(event) => setEditName(event.target.value)}
                      className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring" />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {t.teamColorLabel}
                    <input value={editColor} onChange={(event) => setEditColor(event.target.value)} placeholder={t.teamColorPlaceholder}
                      className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring" />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
                    {t.teamDescriptionLabel}
                    <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)}
                      className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring" />
                  </label>
                  <Button size="sm" variant="outline" className="self-start" onClick={() => void saveTeamDetails()} disabled={!editName.trim()}>
                    <Check className="size-4" />{t.saveTeamDetails}
                  </Button>
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={readAll} onCheckedChange={(value) => setReadAll(Boolean(value))} disabled={!canManage} />
                {t.readAllTeams}
              </label>
              {!readAll ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {teams.filter((team) => team.id !== selected.id && team.status === "active").map((team) => (
                    <label key={team.id} className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm">
                      <Checkbox checked={grantIds.includes(team.id)} disabled={!canManage}
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
              <div className="rounded-lg border border-border/70 px-3 py-3 text-xs">
                <h4 className="flex items-center gap-1.5 font-medium text-foreground"><Info className="size-3.5" />{t.whyCanAccessTitle}</h4>
                {explanation ? (
                  <div className="mt-2 space-y-1 text-muted-foreground">
                    <p>{explanation.memberTeams.length > 0
                      ? `${t.directMembershipsPrefix} ${explanation.memberTeams.map((team) => team.name).join(", ")}`
                      : t.directMembershipsNone}</p>
                    <p>{explanation.effective.teamUniverse
                      ? t.effectiveTeamsAll
                      : `${t.effectiveTeamsPrefix} ${teams.filter((team) => explanation.effective.teamIds.includes(team.id)).map((team) => team.name).join(", ") || t.none}`}</p>
                    <p>{t.intersectionRule}</p>
                  </div>
                ) : <p className="mt-2 text-muted-foreground">{t.explanationUnavailable}</p>}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamMembersTitle}</h4>
                  <div className="space-y-2">
                    {members.map((member) => (
                      <label key={member.userId} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={Boolean(detail?.members?.some((row) => row.userId === member.userId))}
                          disabled={!canManage}
                          onCheckedChange={(value) => void setMember(member.userId, Boolean(value))}
                        />
                        {member.userName ?? member.email ?? member.userId}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamAssistantsTitle}</h4>
                  <div className="space-y-2">
                    {assistants.map((assistant) => (
                      <label key={assistant.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={Boolean(detail?.assistantIds?.includes(assistant.id))}
                          disabled={!canManage}
                          onCheckedChange={(value) => void setAssistant(assistant.id, Boolean(value))}
                        />
                        {assistant.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {canManage ? <Button size="sm" onClick={() => void saveGrants()}><Check className="size-4" />{t.saveAccess}</Button> : null}
              {canManage && selected.status === "active" ? <Button variant="ghost" size="sm" onClick={() => void archive()}><Archive className="size-4" />{t.archiveTeam}</Button> : null}
            </div>
          ) : null}
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
          className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring" />
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
