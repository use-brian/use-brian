"use client";

/** Workspace project browser. [COMP:app-web/projects-browser] */
import { useState } from "react";
import Link from "next/link";
import { Archive, FolderKanban, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { markSurfaceCacheStale, useCachedResource } from "@/lib/surface-cache";
import { surfaceDataKey, useIntentPrefetch } from "@/lib/surface-prefetch";
import { archiveContextProject, createContextProject, listContextProjects, updateContextProject, type ContextProject } from "@/lib/api/context-scopes";

export function ProjectsBrowser() {
  const { workspaceId, role } = useWorkspaceContext();
  // Reset local input when the workspace changes, including an in-flight mutation.
  return <WorkspaceProjects key={workspaceId} workspaceId={workspaceId} canManage={role === "owner" || role === "admin"} />;
}

function WorkspaceProjects({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const t = useT().contextScope;
  const cacheKey = surfaceDataKey("projects", workspaceId)!;
  const { data, loading, error: loadError, refresh } = useCachedResource(cacheKey, () => listContextProjects(workspaceId, true));
  const prefetch = useIntentPrefetch();
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = (data ?? []).filter(project =>
    (project.status === "archived") === archived &&
    `${project.name} ${project.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  async function mutate(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      markSurfaceCacheStale(`project:${workspaceId}:`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    } finally { setBusy(false); }
  }

  async function archive(project: ContextProject) {
    if (!await confirmDialog({ title: t.archiveProjectTitle, description: t.archiveProjectDescription, confirmLabel: t.archiveProject, cancelLabel: t.cancel })) return;
    await mutate(() => archiveContextProject(workspaceId, project.id));
  }

  return <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 md:px-6">
    <header>
      <h1 className="text-2xl font-semibold">{t.projectsTitle}</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t.projectsDescription}</p>
    </header>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <label className="relative min-w-0 flex-1">
        <Search aria-hidden className="absolute left-3 top-3.5 size-4 text-muted-foreground" />
        <input aria-label={t.searchProjects} placeholder={t.searchProjects} value={query} onChange={event => setQuery(event.target.value)}
          className="h-11 md:h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
      </label>
      <div className="flex gap-1" role="group" aria-label={t.projectStatus}>
        <Button variant={archived ? "ghost" : "secondary"} className="max-sm:min-h-11" aria-pressed={!archived} onClick={() => setArchived(false)}>{t.active}</Button>
        <Button variant={archived ? "secondary" : "ghost"} className="max-sm:min-h-11" aria-pressed={archived} onClick={() => setArchived(true)}>{t.archived}</Button>
      </div>
    </div>
    {canManage && !archived ? <form className="flex flex-col gap-2 sm:flex-row" onSubmit={event => {
      event.preventDefault();
      if (name.trim()) void mutate(async () => { await createContextProject(workspaceId, { name: name.trim() }); setName(""); });
    }}>
      <input aria-label={t.projectNameLabel} placeholder={t.projectNamePlaceholder} value={name} onChange={event => setName(event.target.value)} disabled={busy}
        className="h-11 md:h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
      <Button type="submit" className="max-sm:min-h-11" disabled={busy || !name.trim()}><Plus aria-hidden className="size-4" />{t.createProject}</Button>
    </form> : null}
    {error || loadError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><p>{error ?? t.loadFailed}</p><Button variant="ghost" onClick={() => void refresh()}>{t.retryProjects}</Button></div> : null}
    {loading && !data ? <div aria-busy="true" className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-36 rounded-xl" />)}</div>
      : projects.length ? <ul className="grid gap-3 sm:grid-cols-2">{projects.map(project => <li key={project.id} className="flex min-w-0 flex-col rounded-xl border border-border bg-card">
        <Link href={`/w/${workspaceId}/projects/${project.id}`} {...prefetch(`/w/${workspaceId}/projects/${project.id}`)} className="flex min-h-24 flex-1 gap-3 rounded-xl p-4 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-xl">{project.icon || <FolderKanban className="size-5 text-muted-foreground" />}</span>
          <div className="min-w-0"><h2 className="break-words font-medium">{project.name}</h2><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{project.description || t.projectOpenOverview}</p></div>
        </Link>
        {canManage ? <div className="flex justify-end border-t border-border/60 px-2 py-1"><Button variant="ghost" className="max-sm:min-h-11" disabled={busy} onClick={() => archived ? void mutate(() => updateContextProject(workspaceId, project.id, { status: "active" })) : void archive(project)}>
          <Archive aria-hidden className="size-4" />{archived ? t.restoreProject : t.archiveProject}
        </Button></div> : null}
      </li>)}</ul>
      : !loadError ? <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{query.trim() ? t.noMatchingProjects : archived ? t.noArchivedProjects : t.noProjects}</p> : null}
  </div>;
}
