"use client";

/** Shared display for stable context IDs. [COMP:app-web/context-scope] */
import { Users, FolderKanban } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { ContextProject, ContextTeam } from "@/lib/api/context-scopes";

export function ContextScopeChips({
  teamId,
  projectId,
  teamIds,
  projectIds,
  hasRestrictedContext,
  teams,
  projects,
}: {
  teamId?: string | null;
  projectId?: string | null;
  teamIds?: string[];
  projectIds?: string[];
  hasRestrictedContext?: boolean;
  teams: ContextTeam[];
  projects: ContextProject[];
}) {
  const t = useT().contextScope;
  const selectedTeams = teams.filter((item) => (teamIds ?? (teamId ? [teamId] : [])).includes(item.id));
  const selectedProjects = projects.filter((item) => (projectIds ?? (projectId ? [projectId] : [])).includes(item.id));
  if (selectedTeams.length === 0 && selectedProjects.length === 0 && !hasRestrictedContext) {
    return <span className="text-xs text-muted-foreground">{t.general}</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {hasRestrictedContext ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs">
          <Users className="size-3" aria-hidden />{t.restricted}
        </span>
      ) : null}
      {selectedTeams.map((team) => (
        <span key={team.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs">
          <Users className="size-3" aria-hidden />{team.name}
        </span>
      ))}
      {selectedProjects.map((project) => (
        <span key={project.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs">
          <FolderKanban className="size-3" aria-hidden />{project.name}
        </span>
      ))}
    </div>
  );
}
