"use client";

import { ProjectContent } from "@/components/projects/project-content";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Project home with canonical records and a fresh contextual chat. [COMP:app-web/project-detail]
 *
 * Paints from the surface cache (instant-navigation contract N1): the
 * project row + the workspace member roster load in parallel under
 * `project:<wid>:<viewer>:<projectId>`, and the assistant list rides the
 * shared `assistants:<wid>` slot Studio reads (N7: two hooks, no waterfall).
 * A revisit renders the last-known page on its first frame; a cold entry
 * paints a geometry-matched skeleton, never a sentence (N4). No spine
 * primitive names a project, so mount / visibility revalidation and the
 * `refresh()` each mutation awaits keep it current. The edit drafts seed once
 * per project id and are never clobbered by a revalidation (editable-draft
 * rule).
 */
import { use, useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { markSurfaceCacheStale, mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { assistantsCacheKey, projectDetailCacheKey } from "@/lib/surface-prefetch";
import { listAssistants } from "@/lib/api/studio";
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
type ProjectBundle = { project: ContextProject; members: Member[] };

/** The project row and the member roster it is checked against, in parallel. */
async function fetchProjectBundle(workspaceId: string, projectId: string): Promise<ProjectBundle> {
  const [project, workspace] = await Promise.all([
    getContextProject(workspaceId, projectId),
    authFetch(`${API_URL}/api/workspaces/${workspaceId}`).then((response) => response.ok ? response.json() : {}),
  ]);
  return { project, members: (workspace as { members?: Member[] }).members ?? [] };
}

const NO_ASSISTANTS: Assistant[] = [];

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = use(params);
  const t = useT().contextScope;
  const { role } = useWorkspaceContext();
  const canManage = role === "owner" || role === "admin";
  const bundleKey = projectDetailCacheKey(workspaceId, projectId);
  const bundle = useCachedResource<ProjectBundle>(bundleKey, () => fetchProjectBundle(workspaceId, projectId));
  const assistantList = useCachedResource(assistantsCacheKey(workspaceId), () => listAssistants(workspaceId));
  const { refresh: refreshBundle } = bundle;
  const project = bundle.data?.project ?? null;
  const members = bundle.data?.members ?? [];
  const assistants: Assistant[] = assistantList.data ?? NO_ASSISTANTS;
  const [error, setError] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editIcon, setEditIcon] = useState("");
  // Which project the drafts were seeded from: a revalidated row never
  // overwrites what the user is typing; a different project reseeds.
  const [draftFor, setDraftFor] = useState<string | null>(null);

  useEffect(() => {
    if (!project || draftFor === project.id) return;
    setDraftFor(project.id);
    setEditName(project.name);
    setEditDescription(project.description ?? "");
    setEditIcon(project.icon ?? "");
  }, [project, draftFor]);

  async function toggleMember(userId: string, enabled: boolean) {
    if (!project) return;
    setError(null);
    try {
      await setContextProjectMember(workspaceId, project.id, userId, enabled);
      await refreshBundle();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  async function toggleAssistant(assistantId: string, enabled: boolean) {
    if (!project) return;
    setError(null);
    try {
      await setContextProjectAssistant(workspaceId, project.id, assistantId, enabled);
      await refreshBundle();
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
      markSurfaceCacheStale(`projects:${workspaceId}`);
      // The user's own write: patch the cached row so the next visit paints
      // the post-edit name, never the pre-edit one.
      mutateSurfaceCache<ProjectBundle>(bundleKey, (previous) => ({
        ...previous,
        project: { ...previous.project, ...updated },
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.updateFailed); }
  }

  if (!project) {
    if (bundle.loading) {
      // Cold entry only: the page's own geometry (header + aggregate cards).
      return (
        <div aria-busy="true" data-testid="project-skeleton" className="h-full w-full overflow-y-auto px-4 py-6 md:px-6">
          <div className="mx-auto max-w-5xl space-y-6">
            <BackButton href={`/w/${workspaceId}/projects`} label={t.projectDetailBack} />
            <div className="space-y-2">
              <Skeleton className="h-7 w-56 max-w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border p-4">
                  <Skeleton className="h-7 w-12" />
                  <Skeleton className="mt-2 h-3 w-20" />
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }
    return <div className="p-6"><BackButton href={`/w/${workspaceId}/projects`} label={t.projectDetailBack} />
      <p role={bundle.error ? "alert" : undefined} className="mt-8 text-sm text-muted-foreground">{bundle.error ? t.loadFailed : t.projectDetailNotFound}</p>
      {bundle.error ? <Button className="mt-3" variant="outline" onClick={() => void refreshBundle()}>{t.retryProjects}</Button> : null}
    </div>;
  }

  return (
    <div className="h-full w-full overflow-y-auto px-4 py-6 md:px-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <BackButton href={`/w/${workspaceId}/projects`} label={t.projectDetailBack} />
        <header>
          <div className="flex flex-wrap items-center gap-3">
            {project.icon ? <span className="text-2xl">{project.icon}</span> : null}
            <h1 className="min-w-0 break-words text-2xl font-semibold">{project.name}</h1>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {project.status === "active" ? t.active : t.archived}
            </span>
          </div>
          <div className="mt-4 rounded-xl border border-border p-4">
            <h2 className="text-sm font-medium">{t.projectHome.brief}</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{project.description || t.projectHome.noBrief}</p>
          </div>
        </header>


        <ProjectContent key={project.id} project={project} assistants={assistants} />

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
        {canManage && project.status === "active" ? (
          <details className="rounded-xl border border-border p-4">
            <summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-2 text-sm font-medium">{t.projectSettings}</summary>
            <div className="grid gap-3 pt-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.projectNameLabel}
              <input value={editName} onChange={(event) => setEditName(event.target.value)}
                className="h-9 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.projectIconLabel}
              <input value={editIcon} onChange={(event) => setEditIcon(event.target.value)} placeholder={t.projectIconPlaceholder}
                className="h-9 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm" />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
              {t.projectDescriptionLabel}
              <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)}
                className="h-9 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm" />
            </label>
            <Button size="sm" className="self-start" onClick={() => void saveDetails()} disabled={!editName.trim()}>
              {t.saveProjectDetails}
            </Button>
          </div>
          </details>
        ) : null}

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
