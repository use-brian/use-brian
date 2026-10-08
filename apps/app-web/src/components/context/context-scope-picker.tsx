"use client";

/** Shared immutable Team/Project selection surface. [COMP:app-web/context-scope] */
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
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
}) {
  const t = useT().contextScope;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {!hideTeam?<label className="grid content-start gap-1.5 text-xs font-medium text-muted-foreground">
        {t.team}
        <SearchableSelect
          className="max-sm:min-h-11"
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
      <label className="grid content-start gap-1.5 text-xs font-medium text-muted-foreground">
        {t.project}
        <SearchableSelect
          className="max-sm:min-h-11"
          value={projectId ?? GENERAL}
          onValueChange={(value) => onProjectChange(value === GENERAL ? null : value)}
          items={[
            { value: GENERAL, label: t.noProject },
            ...projects.filter((project) => project.status === "active").map((project) => ({ value: project.id, label: project.name })),
          ]}
          searchPlaceholder={t.searchProjects}
          emptyMessage={t.noProjects}
          aria-label={t.project}
          disabled={disabled || projectDisabled}
        />
        <span className="text-xs font-normal">{t.projectAccessHint}</span>
      </label>
    </div>
  );
}
