"use client";

/** Assistant Team/Project grants and defaults. [COMP:app-web/context-scope] */
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ContextScopePicker } from "./context-scope-picker";
import { useT } from "@/lib/i18n/client";
import {
  getAssistantContext,
  listContextProjects,
  listContextTeams,
  updateAssistantContext,
  type AssistantContextConfig,
  type ContextProject,
  type ContextTeam,
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
  const [teams, setTeams] = useState<ContextTeam[]>([]);
  const [projects, setProjects] = useState<ContextProject[]>([]);
  const [config, setConfig] = useState<AssistantContextConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listContextTeams(workspaceId),
      listContextProjects(workspaceId),
      getAssistantContext(workspaceId, assistantId),
    ]).then(([nextTeams, nextProjects, nextConfig]) => {
      if (cancelled) return;
      setTeams(nextTeams);
      setProjects(nextProjects);
      setConfig(nextConfig);
    }).catch(() => { if (!cancelled) setFeedback(t.loadFailed); });
    return () => { cancelled = true; };
  }, [assistantId, t.loadFailed, workspaceId]);

  if (!config) return <p className="px-5 py-4 text-sm text-muted-foreground">{feedback ?? t.loading}</p>;
  const teamMode = config.teamMode === "assigned" ? "assigned" : "all";

  function toggle(list: string[], id: string, enabled: boolean): string[] {
    return enabled ? [...new Set([...list, id])] : list.filter((item) => item !== id);
  }

  async function save() {
    if (!config) return;
    setBusy(true);
    setFeedback(null);
    try {
      await updateAssistantContext(workspaceId, assistantId, {
        teamMode,
        teamIds: config.teamIds,
        defaultGroupId: config.defaultGroupId,
        projectMode: config.projectMode,
        projectIds: config.projectIds,
        defaultProjectId: config.defaultProjectId,
      });
      setFeedback(t.saved);
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : t.updateFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-5 py-4 space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          {t.teamAccessMode}
          <SearchableSelect value={teamMode} disabled={!canManage}
            onValueChange={(value) => setConfig({ ...config, teamMode: value as "all" | "assigned" })}
            items={[{ value: "all", label: t.allTeams }, { value: "assigned", label: t.assignedTeams }]}
            aria-label={t.teamAccessMode} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          {t.projectAccessMode}
          <SearchableSelect value={config.projectMode} disabled={!canManage}
            onValueChange={(value) => setConfig({ ...config, projectMode: value as "all" | "assigned" })}
            items={[{ value: "all", label: t.allProjects }, { value: "assigned", label: t.assignedProjects }]}
            aria-label={t.projectAccessMode} />
        </label>
      </div>
      {teamMode === "assigned" ? <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t.teamGrants}</p>
        <div className="grid gap-2 sm:grid-cols-2">{teams.map((team) => <label key={team.id} className="flex items-center gap-2 text-sm">
          <Checkbox checked={config.teamIds.includes(team.id)} disabled={!canManage}
            onCheckedChange={(value) => setConfig({ ...config, teamIds: toggle(config.teamIds, team.id, Boolean(value)) })} />{team.name}
        </label>)}</div>
      </div> : null}
      {config.projectMode === "assigned" ? <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t.projectGrants}</p>
        <div className="grid gap-2 sm:grid-cols-2">{projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm">
          <Checkbox checked={config.projectIds.includes(project.id)} disabled={!canManage}
            onCheckedChange={(value) => setConfig({ ...config, projectIds: toggle(config.projectIds, project.id, Boolean(value)) })} />{project.name}
        </label>)}</div>
      </div> : null}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t.defaults}</p>
        <ContextScopePicker teams={teams} projects={projects}
          teamId={config.defaultGroupId} projectId={config.defaultProjectId} disabled={!canManage}
          onTeamChange={(id) => setConfig({ ...config, defaultGroupId: id, teamIds: id ? toggle(config.teamIds, id, true) : config.teamIds })}
          onProjectChange={(id) => setConfig({ ...config, defaultProjectId: id, projectIds: id ? toggle(config.projectIds, id, true) : config.projectIds })} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{feedback}</p>
        {canManage ? <Button size="sm" disabled={busy} onClick={() => void save()}><Check className="size-4" />{busy ? t.saving : t.saveContext}</Button> : null}
      </div>
    </div>
  );
}
