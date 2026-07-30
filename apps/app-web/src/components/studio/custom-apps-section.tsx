"use client";

/**
 * Studio → Mini apps → Custom — the consent surface for workspace-built apps.
 *
 * This is where "the grant is the review" actually happens. Everything else in
 * the custom-app stack is machinery; this is the one screen where a human is
 * asked to approve someone else's code reaching workspace data, so it is built
 * around making that decision legible:
 *
 *   - **Requested scopes are spelled out in prose**, not JSON. "Read your
 *     workspace brain" and "Read and write your workspace brain" are different
 *     decisions, and an admin should not have to parse `{"data":"read_write"}`
 *     to tell them apart.
 *   - **Re-consent is visually distinct from first consent.** An app that
 *     widened its scopes after a sync is a different situation from a new
 *     install — the admin already approved something, and what changed is the
 *     thing they need to see.
 *   - **Every consequential action confirms.** Granting is the moment access
 *     starts; revoking is the moment it stops and the app leaves Home.
 *
 * Spec: docs/architecture/features/home-apps.md → "The grant is the review".
 * [COMP:app-web/studio-custom-apps]
 */

import { useCallback, useEffect, useState } from "react";
import type { AppScopes } from "@use-brian/brian-app";
import { AlertTriangle, Check, GitBranch, Puzzle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  deleteCustomHomeApp,
  grantCustomHomeApp,
  listCustomHomeApps,
  setCustomHomeAppStatus,
  type CustomHomeApp,
} from "@/lib/api/home-apps";

/**
 * Requested scopes as sentences an admin can act on. Deliberately verbose:
 * this is the text someone reads before handing workspace data to third-party
 * code, and terseness here buys nothing.
 */
export function describeScopes(
  scopes: AppScopes | null,
  copy: {
    scopeRead: string;
    scopeReadWrite: string;
    scopeIdentity: string;
    scopeNet: string;
    scopeNone: string;
  },
): string[] {
  if (!scopes) return [copy.scopeNone];
  const lines = [scopes.data === "read_write" ? copy.scopeReadWrite : copy.scopeRead];
  if (scopes.identity) lines.push(copy.scopeIdentity);
  for (const origin of scopes.net ?? []) {
    lines.push(format(copy.scopeNet, { origin }));
  }
  return lines;
}

/** What changed between a granted scope set and a newly requested one. */
export function scopeDelta(requested: AppScopes | null, granted: AppScopes | null): string[] {
  if (!requested || !granted) return [];
  const added: string[] = [];
  if (requested.data === "read_write" && granted.data !== "read_write") added.push("data");
  if (requested.identity && !granted.identity) added.push("identity");
  const known = new Set(granted.net ?? []);
  for (const origin of requested.net ?? []) if (!known.has(origin)) added.push(origin);
  return added;
}

export function CustomAppsSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const t = useT().studioPage.customApps;
  const [apps, setApps] = useState<CustomHomeApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setApps(await listCustomHomeApps(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (appId: string, fn: () => Promise<void>) => {
      setBusy(appId);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const onGrant = useCallback(
    async (app: CustomHomeApp) => {
      const lines = describeScopes(app.requestedScopes, t);
      const reconsent = app.grantedScopes !== null;
      const ok = await confirmDialog({
        title: reconsent
          ? format(t.reconsentTitle, { name: app.name })
          : format(t.grantTitle, { name: app.name }),
        description:
          (reconsent ? t.reconsentBody : t.grantBody) + "\n\n" + lines.map((l) => `• ${l}`).join("\n"),
        confirmLabel: t.grantConfirm,
      });
      if (!ok) return;
      await run(app.id, () => grantCustomHomeApp(app.id));
    },
    [run, t],
  );

  const onRevoke = useCallback(
    async (app: CustomHomeApp) => {
      const ok = await confirmDialog({
        title: format(t.revokeTitle, { name: app.name }),
        description: t.revokeBody,
        confirmLabel: t.revokeConfirm,
        variant: "destructive",
      });
      if (!ok) return;
      await run(app.id, () => setCustomHomeAppStatus(app.id, "needs_consent"));
    },
    [run, t],
  );

  const onRemove = useCallback(
    async (app: CustomHomeApp) => {
      const ok = await confirmDialog({
        title: format(t.removeTitle, { name: app.name }),
        description: t.removeBody,
        confirmLabel: t.removeConfirm,
        variant: "destructive",
      });
      if (!ok) return;
      await run(app.id, () => deleteCustomHomeApp(app.id));
    },
    [run, t],
  );

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">{t.heading}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t.intro}</p>

      {error && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {apps !== null && apps.length === 0 && (
        <p className="mt-3 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t.empty}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {(apps ?? []).map((app) => {
          const delta = scopeDelta(app.requestedScopes, app.grantedScopes);
          const needsFirstConsent = app.status === "needs_consent" && !app.grantedScopes;
          const needsReconsent = app.status === "needs_consent" && Boolean(app.grantedScopes);
          return (
            <div
              key={app.id}
              className={cn(
                "rounded-lg border px-3 py-2.5",
                needsReconsent
                  ? "border-amber-500/40 bg-amber-500/5"
                  : needsFirstConsent
                    ? "border-primary/40 bg-primary/5"
                    : "border-border",
              )}
            >
              <div className="flex items-center gap-2">
                {app.kind === "github" ? (
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{app.name}</span>
                <StatusChip app={app} t={t} />
              </div>

              {app.description && (
                <p className="mt-1 text-xs text-muted-foreground">{app.description}</p>
              )}
              {app.repo && (
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {app.repo}@{app.branch}
                </p>
              )}
              {app.syncError && (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] text-destructive">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {app.syncError}
                </p>
              )}

              <ul className="mt-2 flex flex-col gap-0.5">
                {describeScopes(app.requestedScopes, t).map((line) => (
                  <li key={line} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <Check className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>

              {needsReconsent && delta.length > 0 && (
                <p className="mt-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  {format(t.widened, { what: delta.join(", ") })}
                </p>
              )}

              {canEdit && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {app.status !== "active" && (
                    <button
                      type="button"
                      disabled={busy === app.id}
                      onClick={() => void onGrant(app)}
                      className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {needsReconsent ? t.reconsentAction : t.grantAction}
                    </button>
                  )}
                  {app.status === "active" && (
                    <>
                      <button
                        type="button"
                        disabled={busy === app.id}
                        onClick={() => void run(app.id, () => setCustomHomeAppStatus(app.id, "disabled"))}
                        className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
                      >
                        {t.disableAction}
                      </button>
                      <button
                        type="button"
                        disabled={busy === app.id}
                        onClick={() => void onRevoke(app)}
                        className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
                      >
                        {t.revokeAction}
                      </button>
                    </>
                  )}
                  {app.status === "disabled" && (
                    <button
                      type="button"
                      disabled={busy === app.id}
                      onClick={() => void run(app.id, () => setCustomHomeAppStatus(app.id, "active"))}
                      className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"
                    >
                      {t.enableAction}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy === app.id}
                    onClick={() => void onRemove(app)}
                    className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-destructive hover:bg-accent disabled:opacity-50"
                  >
                    <Trash2 className="size-3" aria-hidden />
                    {t.removeAction}
                  </button>
                </div>
              )}

              {app.status === "active" && (
                <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
                  {format(t.budget, {
                    used: app.dailyUsed,
                    limit: app.dailyCallLimit === 0 ? "∞" : app.dailyCallLimit,
                  })}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!canEdit && apps !== null && apps.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">{t.readOnlyNote}</p>
      )}
    </section>
  );
}

function StatusChip({
  app,
  t,
}: {
  app: CustomHomeApp;
  t: { statusLive: string; statusNeedsConsent: string; statusNeedsReconsent: string; statusOff: string };
}) {
  const label =
    app.status === "active"
      ? t.statusLive
      : app.status === "disabled"
        ? t.statusOff
        : app.grantedScopes
          ? t.statusNeedsReconsent
          : t.statusNeedsConsent;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
        app.status === "active"
          ? "bg-primary/10 text-primary"
          : app.status === "disabled"
            ? "bg-muted text-muted-foreground"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      )}
    >
      {label}
    </span>
  );
}
