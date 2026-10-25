"use client";

/** Shared immutable Team/Project selection surface. [COMP:app-web/context-scope] */
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
import { Building2, FolderKanban } from "lucide-react";
import type { ContextProject, ContextTeam } from "@/lib/api/context-scopes";

const GENERAL = "__general__";

export function ContextScopePicker({
  teams,
  projects,
  teamId,
  projectId,
  onTeamChange,
  onProjectChange,
  disabled,
  teamDisabled,
  hideTeam=false,
  projectDisabled,
  showProjectHint=true,
  inline=false,
}: {
  teams: ContextTeam[];
  projects: ContextProject[];
  teamId: string | null;
  projectId: string | null;
  onTeamChange: (id: string | null) => void;
  onProjectChange: (id: string | null) => void;
  disabled?: boolean;
  teamDisabled?: boolean;
  hideTeam?: boolean;
  projectDisabled?: boolean;
  showProjectHint?: boolean;
  inline?: boolean;
}) {
  const t = useT().contextScope;
  return (
    <div className={inline ? "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" : "grid gap-3 sm:grid-cols-2"}>
      {!hideTeam?<label className={inline ? "flex w-[calc(50%-0.375rem)] min-w-0 max-w-52 items-center gap-1.5 text-xs text-muted-foreground" : "grid content-start gap-1.5 text-xs font-medium text-muted-foreground"}>
        {inline ? <><Building2 className="size-4 shrink-0" aria-hidden /><span className="sr-only">{t.team}</span></> : t.team}
        <SearchableSelect
          className={inline ? "min-w-0 gap-1 border-transparent bg-transparent px-1.5 shadow-none hover:bg-background/70 max-sm:min-h-11" : "max-sm:min-h-11"}
          value={teamId ?? GENERAL}
          onValueChange={(value) => onTeamChange(value === GENERAL ? null : value)}
          items={[
            { value: GENERAL, label: t.general },
            ...teams.filter((team) => team.status === "active").map((team) => ({ value: team.id, label: team.name })),
          ]}
          searchPlaceholder={t.searchTeams}
          emptyMessage={t.noTeams}
          aria-label={t.team}
          disabled={disabled || teamDisabled}
        />
      </label>:null}
      <label className={inline ? "flex w-[calc(50%-0.375rem)] min-w-0 max-w-52 items-center gap-1.5 text-xs text-muted-foreground" : "grid content-start gap-1.5 text-xs font-medium text-muted-foreground"}>
        {inline ? <><FolderKanban className="size-4 shrink-0" aria-hidden /><span className="sr-only">{t.project}</span></> : t.project}
        <SearchableSelect
          className={inline ? "min-w-0 gap-1 border-transparent bg-transparent px-1.5 shadow-none hover:bg-background/70 max-sm:min-h-11" : "max-sm:min-h-11"}
          value={projectId ?? GENERAL}
          onValueChange={(value) => onProjectChange(value === GENERAL ? null : value)}
          items={[
            { value: GENERAL, label: inline ? t.addProject : t.noProject },
            ...projects.filter((project) => project.status === "active").map((project) => ({ value: project.id, label: project.name })),
          ]}
          searchPlaceholder={t.searchProjects}
          emptyMessage={t.noProjects}
          aria-label={t.project}
          disabled={disabled || projectDisabled}
        />
        {showProjectHint?<span className="text-xs font-normal">{t.projectAccessHint}</span>:null}
      </label>
    </div>
  );
}
