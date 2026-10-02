"use client";

/**
 * Assistant Project grants and defaults, plus where its departments are set.
 * Since the v2 cutover an assistant reads a department only through its edge
 * there (Organization -> Departments), so the legacy Team mode, Team grants and
 * default Team are no longer edited here; the home department replaces the
 * default Team. [COMP:app-web/context-scope]
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DepartmentChangeFeedback, useDepartmentChange } from "@/components/workspace-access/use-department-change";
import {AssistantAccessExplanation} from "@/components/workspace-access/access-inspection";
import { ContextScopePicker } from "./context-scope-picker";
import { AssistantHomeDepartment } from "@/components/organization/department-access-panel";
import { organizationHref } from "@/lib/organization-navigation";
import { useT } from "@/lib/i18n/client";
import {
  getAssistantContext,
  listContextProjects,
  type AssistantContextConfig,
  type ContextProject,
} from "@/lib/api/context-scopes";

export function AssistantContextSettings({
  workspaceId,
  assistantId,
  canManage,
}: {
  workspaceId: string;
  assistantId: string;
  canManage: boolean;
}) {
  const t = useT().contextScope;
  const [projects, setProjects] = useState<ContextProject[]>([]);
  const [config, setConfig] = useState<AssistantContextConfig | null>(null);
  const change = useDepartmentChange(workspaceId, async (_result, isCurrent) => {
    const next = await getAssistantContext(workspaceId, assistantId);
    if (!isCurrent()) return;
    setConfig(next);
    setFeedback(t.saved);
  }, assistantId);
  const busy = change.busy;
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listContextProjects(workspaceId),
      getAssistantContext(workspaceId, assistantId),
    ]).then(([nextProjects, nextConfig]) => {
      if (cancelled) return;
      setProjects(nextProjects);
      setConfig(nextConfig);
    }).catch(() => { if (!cancelled) setFeedback(t.loadFailed); });
    return () => { cancelled = true; };
  }, [assistantId, t.loadFailed, workspaceId]);

  if (!config) return <p className="px-5 py-4 text-sm text-muted-foreground">{feedback ?? t.loading}</p>;
  // The legacy Team fields are carried through unchanged; v2 reads ignore them.
  const teamMode = config.teamMode === "assigned" ? "assigned" : "all";

  function toggle(list: string[], id: string, enabled: boolean): string[] {
    return enabled ? [...new Set([...list, id])] : list.filter((item) => item !== id);
  }

  async function save() {
    if (!config) return;
    setFeedback(null);
    try {
      await change.save({
        type: "assistant.audience.set", assistantId,
        teamMode,
        teamIds: config.teamIds,
        defaultGroupId: config.defaultGroupId,
        projectMode: config.projectMode,
        projectIds: config.projectIds,
        defaultProjectId: config.defaultProjectId,
      }, t.saveContext);
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : t.updateFailed);
    }
  }

  return (
    <div className="px-5 py-4 space-y-5">
      <DepartmentChangeFeedback change={change}/>
      <AssistantAccessExplanation assistantId={assistantId}/>
      <section className="space-y-3 rounded-lg border border-border p-3">
        <div>
          <h4 className="text-sm font-medium">{t.assistantDepartmentsTitle}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t.assistantDepartmentsNote}</p>
          <Link href={organizationHref(workspaceId, "departments")} className="inline-flex min-h-11 items-center text-sm underline">{t.openDepartments}</Link>
        </div>
        <AssistantHomeDepartment assistantId={assistantId} />
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          {t.projectAccessMode}
          <SearchableSelect value={config.projectMode} disabled={!canManage || busy}
            onValueChange={(value) => setConfig({ ...config, projectMode: value as "all" | "assigned" })}
            items={[{ value: "all", label: t.allProjects }, { value: "assigned", label: t.assignedProjects }]}
            aria-label={t.projectAccessMode} />
        </label>
      </div>
      {config.projectMode === "assigned" ? <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t.projectGrants}</p>
        <div className="grid gap-2 sm:grid-cols-2">{projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm">
          <Checkbox checked={config.projectIds.includes(project.id)} disabled={!canManage || busy}
            onCheckedChange={(value) => setConfig({ ...config, projectIds: toggle(config.projectIds, project.id, Boolean(value)) })} />{project.name}
        </label>)}</div>
      </div> : null}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t.defaults}</p>
        <ContextScopePicker teams={[]} projects={projects} hideTeam
          teamId={config.defaultGroupId} projectId={config.defaultProjectId} disabled={!canManage || busy}
          onTeamChange={() => {}}
          onProjectChange={(id) => setConfig({ ...config, defaultProjectId: id, projectIds: id ? toggle(config.projectIds, id, true) : config.projectIds })} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{feedback}</p>
        {canManage ? <Button size="sm" disabled={busy} onClick={() => void save()}><Check className="size-4" />{busy ? t.saving : t.saveContext}</Button> : null}
      </div>
    </div>
  );
}
