"use client";

/**
 * Studio → Mini apps — which operator apps show on Home.
 *
 * This tab existed once (deleted 2026-07-23) as a card gallery over the
 * dormant `MINI_APPS` shared registry. It returns doing a **different job**:
 * it is a configurator over the operator-app registry, writing
 * `workspaces.home_apps` (migration 385). The old registry is not reused and
 * not touched.
 *
 * Config is workspace-wide (D1): one strip, set by an owner/admin, seen by
 * every member. Per-user overrides are deferred.
 *
 * Three behaviours worth stating, because each is a decision rather than a
 * default:
 *
 *   - **Save on change**, no Save button (the workspace-sections precedent).
 *     A toggle that needs confirming reads as a form; this is a preference.
 *     The optimistic flip reverts if the write fails.
 *   - **Disabling is not removing** (T11). Routes stay reachable, so a
 *     bookmark, a notification deep link, or a home-dock card into a hidden
 *     app all keep working. The note under the grid says so, because "hidden"
 *     otherwise reads as "gone".
 *   - **Hiding the app you are standing in** asks first, via `confirmDialog` —
 *     the strip entry disappearing under the user is exactly the moment a
 *     silent save feels like a bug.
 *
 * Spec: docs/architecture/features/home-apps.md.
 * [COMP:app-web/studio-mini-apps]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { APP_ICON } from "@/components/doc/operator-app-bar";
import { CustomAppsSection } from "@/components/studio/custom-apps-section";
import {
  HOME_APPS_MAX,
  isBuiltinHomeAppKey,
  OPERATOR_APP_KEYS,
  homeAppFromPathname,
  type HomeAppEntry,
  type OperatorAppKey,
} from "@/lib/operator-apps";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import {
  getWorkspaceHomeApps,
  getWorkspaceRole,
  setWorkspaceHomeApps,
} from "@/lib/api/workspaces";

export default function StudioMiniAppsPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const pathname = usePathname();
  const t = useT();
  const copy = t.studioPage.miniAppsPage;
  const appLabels = t.operatorBar;

  const [homeApps, setHomeApps] = useState<HomeAppEntry[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void getWorkspaceHomeApps(workspaceId).then((apps) => {
      if (!cancelled) setHomeApps(apps);
    });
    void getWorkspaceRole(workspaceId).then((role) => {
      // A failed probe resolves to `null` → read-only. Never grant an
      // affordance the server would refuse.
      if (!cancelled) setCanEdit(role === "owner" || role === "admin");
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const enabled = useMemo(
    () => new Set((homeApps ?? []).filter(isBuiltinHomeAppKey)),
    [homeApps],
  );

  /** The app the user is standing in right now, if any. */
  const activeApp = homeAppFromPathname(surfaceFromPathname(pathname), pathname);

  const persist = useCallback(
    async (next: HomeAppEntry[], previous: HomeAppEntry[]) => {
      setSaving(true);
      setError(null);
      setHomeApps(next); // optimistic — a preference should feel instant
      try {
        setHomeApps(await setWorkspaceHomeApps(workspaceId, next));
      } catch {
        setHomeApps(previous); // the strip must never claim a state the server refused
        setError(copy.saveFailed);
      } finally {
        setSaving(false);
      }
    },
    [copy.saveFailed, workspaceId],
  );

  const toggle = useCallback(
    async (key: OperatorAppKey) => {
      if (!homeApps || !canEdit || saving) return;
      const on = enabled.has(key);

      if (on) {
        if (enabled.size <= 1) {
          setError(copy.atLeastOne);
          return;
        }
        if (key === activeApp) {
          const ok = await confirmDialog({
            title: copy.leavingTitle,
            description: format(copy.leavingBody, { name: appLabels[key] }),
            confirmLabel: copy.leavingConfirm,
            variant: "destructive",
          });
          if (!ok) return;
        }
        await persist(
          homeApps.filter((entry) => entry !== key),
          homeApps,
        );
        return;
      }

      if (homeApps.length >= HOME_APPS_MAX) {
        setError(format(copy.atMost, { max: HOME_APPS_MAX }));
        return;
      }
      // Insert in REGISTRY order, not append order: the strip renders built-ins
      // in registry order (T15), so appending would make the config array
      // disagree with what the user sees.
      const next = [
        ...OPERATOR_APP_KEYS.filter((k) => enabled.has(k) || k === key),
        ...homeApps.filter((entry) => !isBuiltinHomeAppKey(entry)),
      ];
      await persist(next, homeApps);
    },
    [activeApp, appLabels, canEdit, copy, enabled, homeApps, persist, saving],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm text-muted-foreground">{copy.intro}</p>

      <p className="mt-4 text-xs font-medium text-muted-foreground tabular-nums">
        {format(copy.counter, {
          count: homeApps?.length ?? 0,
          max: HOME_APPS_MAX,
        })}
      </p>

      {!canEdit && (
        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {copy.readOnlyNote}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {OPERATOR_APP_KEYS.map((key) => {
          const Icon = APP_ICON[key];
          const on = enabled.has(key);
          return (
            <button
              key={key}
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={format(copy.toggleAria, { name: appLabels[key] })}
              disabled={!canEdit || homeApps === null || saving}
              onClick={() => void toggle(key)}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                on
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-background hover:bg-accent/50",
                (!canEdit || saving) && "cursor-not-allowed opacity-60",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  on ? "text-primary" : "text-muted-foreground",
                )}
                strokeWidth={1.8}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {appLabels[key]}
              </span>
              <span
                aria-hidden
                className={cn(
                  "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                  on ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3 rounded-full bg-background transition-all",
                    on ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{copy.routesStayNote}</p>

      <CustomAppsSection workspaceId={workspaceId} canEdit={canEdit} />
    </div>
  );
}
