"use client";

/**
 * Profile-Management (computer-use.md §7, plan R2-4): browser profiles are
 * clearance-carrying browsing identities - one cookie jar each, logged into
 * many sites, enabled per assistant, defaulted to a backend. The top
 * clearance rung is owner-only; sharing is an explicit downgrade. Revoking a
 * site's session deletes the saved bundle only; the user's real account on
 * the site is untouched.
 *
 * [COMP:app-web/profile-management]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  createBrowserProfile,
  deleteBrowserProfile,
  listBrowserProfiles,
  revokeProfileGrant,
  revokeProfileSession,
  updateBrowserProfile,
  type BrowserBackend,
  type BrowserProfile,
  type BrowserProfileClearance,
} from "@/lib/api/computer";

const CLEARANCES: BrowserProfileClearance[] = ["confidential", "internal", "public"];
const BACKENDS: BrowserBackend[] = ["cloud", "local"];

export function BrowserProfilesSection() {
  const t = useT();
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params?.workspaceId ?? "";

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unconfigured" }
    | { kind: "ready"; profiles: BrowserProfile[] }
    | { kind: "error" }
  >({ kind: "loading" });
  const [assistants, setAssistants] = useState<StudioAssistantSummary[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setState({ kind: "unconfigured" });
      return;
    }
    try {
      const res = await listBrowserProfiles(workspaceId);
      setState(res.configured ? { kind: "ready", profiles: res.profiles } : { kind: "unconfigured" });
    } catch {
      setState({ kind: "error" });
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!workspaceId) return;
    void listAssistants(workspaceId).then(setAssistants).catch(() => setAssistants([]));
  }, [workspaceId]);

  const onCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setActionError(null);
    const created = await createBrowserProfile({ workspaceId, name }).catch(() => null);
    setBusy(false);
    if (!created) {
      setActionError(t.computer.profiles.createFailed);
      return;
    }
    setNewName("");
    void reload();
  }, [busy, newName, reload, t, workspaceId]);

  const mutate = useCallback(
    async (profileId: string, patch: Parameters<typeof updateBrowserProfile>[1]) => {
      setActionError(null);
      const ok = await updateBrowserProfile(profileId, patch).catch(() => false);
      if (!ok) setActionError(t.computer.profiles.updateFailed);
      void reload();
    },
    [reload, t],
  );

  const onDelete = useCallback(
    async (profile: BrowserProfile) => {
      const confirmed = await confirmDialog({
        title: t.computer.profiles.deleteConfirmTitle,
        description: t.computer.profiles.deleteConfirmBody.replace("{name}", profile.name),
        confirmLabel: t.computer.profiles.deleteConfirmAction,
        variant: "destructive",
      });
      if (!confirmed) return;
      setActionError(null);
      const ok = await deleteBrowserProfile(profile.id).catch(() => false);
      if (!ok) setActionError(t.computer.profiles.updateFailed);
      void reload();
    },
    [reload, t],
  );

  const onRevoke = useCallback(
    async (profileId: string, site: string) => {
      const confirmed = await confirmDialog({
        title: t.computer.profiles.revokeConfirmTitle,
        description: t.computer.profiles.revokeConfirmBody.replace("{site}", site),
        confirmLabel: t.computer.profiles.revokeConfirmAction,
      });
      if (!confirmed) return;
      await revokeProfileSession(profileId, site).catch(() => {});
      void reload();
    },
    [reload, t],
  );

  const onRevokeGrant = useCallback(
    async (profileId: string, grantId: string, skillName: string) => {
      const confirmed = await confirmDialog({
        title: t.computer.profiles.grantRevokeConfirmTitle,
        description: t.computer.profiles.grantRevokeConfirmBody.replace("{skill}", skillName),
        confirmLabel: t.computer.profiles.grantRevokeConfirmAction,
      });
      if (!confirmed) return;
      await revokeProfileGrant(profileId, grantId).catch(() => {});
      void reload();
    },
    [reload, t],
  );

  const clearanceLabel = (clearance: BrowserProfileClearance): string =>
    clearance === "confidential"
      ? t.computer.profiles.clearanceConfidential
      : clearance === "internal"
        ? t.computer.profiles.clearanceInternal
        : t.computer.profiles.clearancePublic;

  const backendLabel = (backend: BrowserBackend): string =>
    backend === "cloud" ? t.computer.profiles.backendCloud : t.computer.profiles.backendLocal;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t.computer.profiles.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t.computer.profiles.description}</p>
      </div>

      {state.kind === "loading" ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : state.kind === "unconfigured" ? (
        <p className="text-xs text-muted-foreground">{t.computer.profiles.notConfigured}</p>
      ) : state.kind === "error" ? (
        <p className="text-xs text-destructive">{t.computer.profiles.loadFailed}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onCreate();
              }}
              placeholder={t.computer.profiles.createPlaceholder}
              className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              disabled={busy || newName.trim().length === 0}
              onClick={() => void onCreate()}
              className="h-8 shrink-0 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              {t.computer.profiles.createAction}
            </button>
          </div>

          {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}

          {state.profiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.computer.profiles.empty}</p>
          ) : (
            <ul className="space-y-3">
              {state.profiles.map((profile) => (
                <li key={profile.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{profile.name}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {clearanceLabel(profile.clearance)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void onDelete(profile)}
                      className="shrink-0 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      {t.computer.profiles.deleteProfile}
                    </button>
                  </div>

                  {/* Clearance rung (top rung = owner-only; lower = shared) */}
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.clearanceLabel}
                    </p>
                    <div className="mt-1 flex gap-1">
                      {CLEARANCES.map((clearance) => (
                        <button
                          key={clearance}
                          type="button"
                          onClick={() => void mutate(profile.id, { clearance })}
                          className={
                            profile.clearance === clearance
                              ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                              : "rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                          }
                        >
                          {clearanceLabel(clearance)}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t.computer.profiles.clearanceHint}
                    </p>
                  </div>

                  {/* Default backend (R2-3): seeds the toggle; authoritative unattended */}
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.backendLabel}
                    </p>
                    <div className="mt-1 flex gap-1">
                      {BACKENDS.map((backend) => (
                        <button
                          key={backend}
                          type="button"
                          onClick={() => void mutate(profile.id, { defaultBackend: backend })}
                          className={
                            profile.defaultBackend === backend
                              ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                              : "rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                          }
                        >
                          {backendLabel(backend)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Enabled assistants (R2-4: explicit enablement) */}
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.assistantsLabel}
                    </p>
                    {assistants.length === 0 ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t.computer.profiles.assistantsEmpty}
                      </p>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {assistants.map((assistant) => {
                          const enabled = profile.enabledAssistantIds.includes(assistant.id);
                          return (
                            <button
                              key={assistant.id}
                              type="button"
                              onClick={() =>
                                void mutate(profile.id, {
                                  enabledAssistantIds: enabled
                                    ? profile.enabledAssistantIds.filter((id) => id !== assistant.id)
                                    : [...profile.enabledAssistantIds, assistant.id],
                                })
                              }
                              className={
                                enabled
                                  ? "rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary"
                                  : "rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                              }
                            >
                              {assistant.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Standing skill grants on this identity (R2-2) */}
                  {profile.grants.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t.computer.profiles.grantsLabel}
                      </p>
                      <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                        {profile.grants.map((grant) => (
                          <li
                            key={grant.id}
                            className="flex items-center justify-between gap-3 px-2.5 py-2"
                          >
                            <div className="min-w-0">
                              <span className="truncate text-xs font-medium">{grant.skillName}</span>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {t.computer.profiles.grantHint}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                void onRevokeGrant(profile.id, grant.id, grant.skillName)
                              }
                              className="shrink-0 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                            >
                              {t.computer.profiles.revoke}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Per-site sessions inside the cookie jar */}
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.sessionsLabel}
                    </p>
                    {profile.sessions.length === 0 ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t.computer.profiles.sessionsEmpty}
                      </p>
                    ) : (
                      <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                        {profile.sessions.map((session) => (
                          <li
                            key={session.site}
                            className="flex items-center justify-between gap-3 px-2.5 py-2"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-medium">{session.site}</span>
                                <span
                                  className={
                                    session.status === "active"
                                      ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                                      : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                                  }
                                >
                                  {session.status === "active"
                                    ? t.computer.profiles.statusActive
                                    : t.computer.profiles.statusDead}
                                </span>
                              </div>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {t.computer.profiles.lastUsed}:{" "}
                                {session.lastUsedAt
                                  ? new Date(session.lastUsedAt).toLocaleDateString()
                                  : t.computer.profiles.never}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void onRevoke(profile.id, session.site)}
                              className="shrink-0 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                            >
                              {t.computer.profiles.revoke}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
