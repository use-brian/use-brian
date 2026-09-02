"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/** First-class Project aggregation page. [COMP:app-web/project-detail] */
import { use, useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import { useWorkspaceContext } from "@/lib/workspace-context";
import {
  getContextProject,
  setContextProjectAssistant,
  setContextProjectMember,
  updateContextProject,
  type ContextProject,
} from "@/lib/api/context-scopes";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
type Member = { userId: string; userName?: string | null; email?: string | null };
type Assistant = { id: string; name: string };

const AGGREGATE_LABELS = {
  memories: "projectAggregateMemories",
  tasks: "projectAggregateTasks",
  files: "projectAggregateFiles",
  entities: "projectAggregateEntities",
  knowledge: "projectAggregateKnowledge",
  recordings: "projectAggregateRecordings",
  office: "projectAggregateOffice",
  pages: "projectAggregatePages",
  workflows: "projectAggregateWorkflows",
  goals: "projectAggregateGoals",
  episodes: "projectAggregateEpisodes",
} as const;

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = use(params);
  const t = useT().contextScope;
  const { role } = useWorkspaceContext();
  const canManage = role === "owner" || role === "admin";
  const [project, setProject] = useState<ContextProject | null | undefined>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editIcon, setEditIcon] = useState("");

  useEffect(() => {
    let cancelled = false;
    setProject(undefined);
    void Promise.all([
      getContextProject(workspaceId, projectId),
      authFetch(`${API_URL}/api/workspaces/${workspaceId}`).then((response) => response.ok ? response.json() : {}),
      authFetch(`${API_URL}/api/assistants?workspaceId=${encodeURIComponent(workspaceId)}`).then((response) => response.ok ? response.json() : {}),
    ])
      .then(([row, workspace, assistantBody]) => {
        if (cancelled) return;
        setProject(row);
        setEditName(row.name);
        setEditDescription(row.description ?? "");
        setEditIcon(row.icon ?? "");
        setMembers((workspace as { members?: Member[] }).members ?? []);
        setAssistants((assistantBody as { assistants?: Assistant[] }).assistants ?? []);
      })
      .catch(() => { if (!cancelled) setProject(null); });
    return () => { cancelled = true; };
  }, [workspaceId, projectId]);

  async function toggleMember(userId: string, enabled: boolean) {
    if (!project) return;
    setError(null);
    try {
      await setContextProjectMember(workspaceId, project.id, userId, enabled);
      setProject(await getContextProject(workspaceId, project.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function toggleAssistant(assistantId: string, enabled: boolean) {
    if (!project) return;
    setError(null);
    try {
      await setContextProjectAssistant(workspaceId, project.id, assistantId, enabled);
      setProject(await getContextProject(workspaceId, project.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function saveDetails() {
    if (!project || !editName.trim()) return;
    setError(null);
    try {
      const updated = await updateContextProject(workspaceId, project.id, {
        name: editName.trim(),
        description: editDescription.trim() || null,
        icon: editIcon.trim() || null,
      });
      setProject({ ...project, ...updated });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  if (project === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">{t.loading}</div>;
  }
  if (project === null) {
    return <div className="p-6"><BackButton href={`/w/${workspaceId}`} label={t.projectDetailBack} /><p className="mt-8 text-sm text-muted-foreground">{t.projectDetailNotFound}</p></div>;
  }

  return (
    <div className="h-full w-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <BackButton href={`/w/${workspaceId}`} label={t.projectDetailBack} />
        <header>
          <div className="flex items-center gap-3">
            {project.icon ? <span className="text-2xl">{project.icon}</span> : null}
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {project.status === "active" ? t.active : t.archived}
            </span>
          </div>
          {project.description ? <p className="mt-2 text-sm text-muted-foreground">{project.description}</p> : null}
        </header>

        {canManage && project.status === "active" ? (
          <section className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.projectNameLabel}
              <input value={editName} onChange={(event) => setEditName(event.target.value)}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.projectIconLabel}
              <input value={editIcon} onChange={(event) => setEditIcon(event.target.value)} placeholder={t.projectIconPlaceholder}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
              {t.projectDescriptionLabel}
              <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring" />
            </label>
            <Button size="sm" className="self-start" onClick={() => void saveDetails()} disabled={!editName.trim()}>
              {t.saveProjectDetails}
            </Button>
          </section>
        ) : null}

        <section>
          <h2 className="mb-3 text-sm font-medium">{t.projectDetailOverview}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(AGGREGATE_LABELS).map(([key, label]) => (
              <div key={key} className="rounded-xl border border-border p-4">
                <p className="text-2xl font-semibold">{project.aggregates?.[key] ?? 0}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t[label]}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-border p-4">
            <h2 className="text-sm font-medium">{t.projectDetailPeople}</h2>
            <div className="mt-3 space-y-2">
              {canManage ? members.map((member) => {
                const assigned = project.members?.find((row) => row.userId === member.userId);
                return <label key={member.userId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2"><Checkbox checked={Boolean(assigned)} onCheckedChange={(value) => void toggleMember(member.userId, Boolean(value))} />{member.userName ?? member.email ?? member.userId}</span>
                  {assigned ? <span className="text-xs capitalize text-muted-foreground">{assigned.role}</span> : null}
                </label>;
              }) : project.members?.length ? project.members.map((member) => (
                <div key={member.userId} className="flex items-center justify-between text-sm"><span>{member.name ?? member.email ?? member.userId}</span><span className="text-xs capitalize text-muted-foreground">{member.role}</span></div>
              )) : <p className="text-sm text-muted-foreground">{t.projectDetailEmptyPeople}</p>}
            </div>
          </section>
          <section className="rounded-xl border border-border p-4">
            <h2 className="text-sm font-medium">{t.projectDetailAssistants}</h2>
            <div className="mt-3 space-y-2">
              {canManage ? assistants.map((assistant) => (
                <label key={assistant.id} className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(project.assistantIds?.includes(assistant.id))} onCheckedChange={(value) => void toggleAssistant(assistant.id, Boolean(value))} />{assistant.name}</label>
              )) : project.assistantIds?.length ? project.assistantIds.map((assistantId) => (
                <p key={assistantId} className="break-all font-mono text-xs">{assistantId}</p>
              )) : <p className="text-sm text-muted-foreground">{t.projectDetailEmptyAssistants}</p>}
            </div>
          </section>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
