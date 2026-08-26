"use client";

/** Audited Team/Project scope editor shared by detail surfaces. [COMP:app-web/context-scope] */
import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextScopeChips } from "@/components/context/context-scope-chips";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import {
  getReclassifiableContext,
  listContextProjects,
  listContextTeams,
  reclassifyContext,
  type ContextProject,
  type ContextTeam,
} from "@/lib/api/context-scopes";

export type ReclassifiablePrimitive = "memory" | "task" | "file" | "entity" | "knowledge" | "recording" | "office";

export function ReclassifyContextButton({
  workspaceId,
  primitive,
  rowId,
  onSaved,
}: {
  workspaceId: string;
  primitive: ReclassifiablePrimitive;
  rowId: string;
  onSaved?: () => void;
}) {
  const t = useT().contextScope;
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<ContextTeam[]>([]);
  const [projects, setProjects] = useState<ContextProject[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [initialTeams, setInitialTeams] = useState<string[]>([]);
  const [initialProjects, setInitialProjects] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayTeams, setDisplayTeams] = useState<ContextTeam[]>([]);
  const [displayProjects, setDisplayProjects] = useState<ContextProject[]>([]);
  const [displayTeamIds, setDisplayTeamIds] = useState<string[]>([]);
  const [displayProjectIds, setDisplayProjectIds] = useState<string[]>([]);
  const [displayLoaded, setDisplayLoaded] = useState(false);
  const [hasRestrictedContext, setHasRestrictedContext] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDisplayLoaded(false);
    void Promise.all([
      listContextTeams(workspaceId),
      listContextProjects(workspaceId, true),
      getReclassifiableContext({ workspaceId, primitive, rowId }),
    ]).then(([nextTeams, nextProjects, context]) => {
      if (cancelled) return;
      setDisplayTeams(nextTeams);
      setDisplayProjects(nextProjects);
      setDisplayTeamIds(context.teamIds);
      setDisplayProjectIds(context.projectIds);
      setHasRestrictedContext(context.hasOtherCompartments);
      setDisplayLoaded(true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [workspaceId, primitive, rowId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      listContextTeams(workspaceId),
      listContextProjects(workspaceId),
      getReclassifiableContext({ workspaceId, primitive, rowId }),
    ]).then(([nextTeams, nextProjects, context]) => {
      if (cancelled) return;
      setTeams(nextTeams);
      setProjects(nextProjects);
      setTeamIds(context.teamIds);
      setProjectIds(context.projectIds);
      setInitialTeams(context.teamIds);
      setInitialProjects(context.projectIds);
      setReason("");
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t.loadFailed);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, workspaceId, primitive, rowId, t.loadFailed]);

  function toggleTeam(id: string, enabled: boolean) {
    setTeamIds((current) => enabled ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  }

  function toggleProject(id: string, enabled: boolean) {
    setProjectIds((current) => {
      if (primitive === "task") return enabled ? [id] : [];
      return enabled ? [...new Set([...current, id])] : current.filter((value) => value !== id);
    });
  }

  async function save() {
    if (!reason.trim() || saving) return;
    const widening = initialTeams.some((id) => !teamIds.includes(id))
      || (initialProjects.length > 0 && projectIds.length === 0);
    let confirmed = false;
    if (widening) {
      confirmed = await confirmDialog({
        title: t.reclassifyWidenTitle,
        description: t.reclassifyWidenDescription,
        confirmLabel: t.reclassifyWidenConfirm,
        cancelLabel: t.cancel,
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    setSaving(true);
    setError(null);
    try {
      await reclassifyContext({
        workspaceId,
        primitive,
        rowId,
        teamIds,
        projectIds,
        reason: reason.trim(),
        confirmed,
      });
      setDisplayTeamIds(teamIds);
      setDisplayProjectIds(projectIds);
      setOpen(false);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {displayLoaded ? (
          <ContextScopeChips
            teamIds={displayTeamIds}
            projectIds={displayProjectIds}
            teams={displayTeams}
            projects={displayProjects}
            hasRestrictedContext={hasRestrictedContext}
          />
        ) : null}
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t.reclassifyAction}</Button>
      </div>
      <Dialog.Root open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl">
            <Dialog.Title className="text-base font-semibold">{t.reclassifyTitle}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.reclassifyDescription}</Dialog.Description>
            {loading ? <p className="mt-4 text-sm text-muted-foreground">{t.loading}</p> : (
              <div className="mt-5 space-y-5">
                <fieldset>
                  <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamGrants}</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {teams.filter((team) => team.status === "active").map((team) => (
                      <label key={team.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Checkbox checked={teamIds.includes(team.id)} onCheckedChange={(value) => toggleTeam(team.id, Boolean(value))} />{team.name}</label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.projectGrants}</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {projects.filter((project) => project.status === "active").map((project) => (
                      <label key={project.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Checkbox checked={projectIds.includes(project.id)} onCheckedChange={(value) => toggleProject(project.id, Boolean(value))} />{project.name}</label>
                    ))}
                  </div>
                </fieldset>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  {t.reclassifyReason}
                  <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none" />
                </label>
              </div>
            )}
            {error ? <p role="alert" className="mt-3 text-xs text-destructive">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>{t.cancel}</Button><Button onClick={() => void save()} disabled={loading || saving || !reason.trim()}>{saving ? t.saving : t.saveContext}</Button></div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
