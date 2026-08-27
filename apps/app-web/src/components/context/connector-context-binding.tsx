"use client";

/** Stable Team/Project exposure binding for one connector. [COMP:app-web/context-scope] */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import {
  getConnectorContext,
  listContextProjects,
  listContextTeams,
  updateConnectorContext,
  type ContextProject,
  type ContextTeam,
} from "@/lib/api/context-scopes";
import { ContextScopePicker } from "./context-scope-picker";

export function ConnectorContextBinding({
  workspaceId,
  instanceId,
}: {
  workspaceId: string;
  instanceId: string;
}) {
  const t = useT().contextScope;
  const [teams, setTeams] = useState<ContextTeam[]>([]);
  const [projects, setProjects] = useState<ContextProject[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      listContextTeams(workspaceId),
      listContextProjects(workspaceId),
      getConnectorContext(workspaceId, instanceId),
    ])
      .then(([nextTeams, nextProjects, context]) => {
        if (cancelled) return;
        setTeams(nextTeams);
        setProjects(nextProjects);
        setTeamId(context.contextGroupId);
        setProjectId(context.contextProjectId);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t.loadFailed);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, instanceId, t.loadFailed]);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateConnectorContext(workspaceId, instanceId, {
        contextGroupId: teamId,
        contextProjectId: projectId,
      });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div>
        <h3 className="text-[13px] font-medium">{t.connectorContextTitle}</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t.connectorContextDescription}</p>
      </div>
      {loading ? <p className="text-xs text-muted-foreground">{t.loading}</p> : (
        <ContextScopePicker
          teams={teams}
          projects={projects}
          teamId={teamId}
          projectId={projectId}
          onTeamChange={(value) => { setTeamId(value); setSaved(false); }}
          onProjectChange={(value) => { setProjectId(value); setSaved(false); }}
          disabled={saving}
        />
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        {saved ? <span className="text-xs text-muted-foreground">{t.saved}</span> : null}
        <Button size="sm" onClick={() => void save()} disabled={loading || saving}>
          {saving ? t.saving : t.saveContext}
        </Button>
      </div>
    </section>
  );
}
