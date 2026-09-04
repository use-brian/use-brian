"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
// [COMP:app-web/settings-privacy-section] — see docs/architecture/features/privacy-controls.md
// Ported from apps/web/src/app/(app)/settings/privacy/page.tsx (PrivacyPage → PrivacySection).

import { useEffect, useState } from "react";
import { getUserInfo, getCachedUserInfo, type UserInfo } from "@/lib/user";
import { authFetch } from "@/lib/auth-fetch";
import { desktopSignOut } from "@/lib/desktop-auth-source";
import { clearLocalDocCaches } from "@/lib/offline/idb";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { isOssEdition } from "@/lib/edition";
import { useWorkspaceContext } from "@/lib/workspace-context";
import {
  downloadSupportDiagnosticCapsule,
  getSupportDiagnosticStatus,
  previewSupportDiagnosticCapsule,
  startSupportDiagnosticCapture,
  stopSupportDiagnosticCapture,
  type SupportDiagnosticPreview,
  type SupportDiagnosticStatus,
} from "@/lib/support-diagnostics";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type ConflictAssistant = { id: string; name: string; memberCount: number };
type ConflictTeam = { id: string; name: string; memberCount?: number };

export function PrivacySection() {
  const t = useT();
  const [analyticsOptOut, setAnalyticsOptOut] = useState(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(getCachedUserInfo);

  useEffect(() => {
    const info = getUserInfo();
    if (info) setUserInfo(info);
  }, []);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.settings.nav.privacy}</h2>

      <div className="border-t border-border pt-6 space-y-5">
        <Toggle
          label={t.settings.privacy.analyticsTitle}
          description={t.settings.privacy.analyticsDesc}
          value={!analyticsOptOut}
          onChange={(v) => setAnalyticsOptOut(!v)}
          disabled
          hint={t.chat.modelComingSoon}
        />
      </div>

      {isOssEdition() && <SupportDiagnosticsCard />}

      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t.settings.privacy.dataTitle}</h3>
        <DeleteMemoriesRow />
        <DeleteAccountRow userEmail={userInfo?.email ?? ""} />
      </div>
    </div>
  );
}

// ── OSS Support Mode ────────────────────────────────────────

function SupportDiagnosticsCard() {
  const t = useT().settings.privacy;
  const { workspaceId, role } = useWorkspaceContext();
  const [status, setStatus] = useState<SupportDiagnosticStatus | null>(null);
  const [durationHours, setDurationHours] = useState<1 | 24 | 168>(24);
  const [includeContent, setIncludeContent] = useState(false);
  const [preview, setPreview] = useState<SupportDiagnosticPreview | null>(null);
  const [working, setWorking] = useState<
    "start" | "stop" | "preview" | "download" | null
  >(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (role === "member") return;
    void getSupportDiagnosticStatus(workspaceId)
      .then(setStatus)
      .catch(() => setError(true));
  }, [role, workspaceId]);

  if (role === "member") return null;

  async function startCapture() {
    setWorking("start");
    setError(false);
    setPreview(null);
    try {
      setStatus(
        await startSupportDiagnosticCapture({
          workspaceId,
          durationHours,
          includeContent,
        }),
      );
    } catch {
      setError(true);
    } finally {
      setWorking(null);
    }
  }

  async function stopCapture() {
    setWorking("stop");
    setError(false);
    try {
      await stopSupportDiagnosticCapture(workspaceId);
      setStatus({ active: false, capture: null });
      setPreview(null);
    } catch {
      setError(true);
    } finally {
      setWorking(null);
    }
  }

  async function loadPreview() {
    setWorking("preview");
    setError(false);
    try {
      setPreview(await previewSupportDiagnosticCapsule(workspaceId));
    } catch {
      setError(true);
    } finally {
      setWorking(null);
    }
  }

  async function downloadCapsule() {
    setWorking("download");
    setError(false);
    try {
      await downloadSupportDiagnosticCapsule(workspaceId);
      setStatus({ active: false, capture: null });
      setPreview(null);
    } catch {
      setError(true);
    } finally {
      setWorking(null);
    }
  }

  const active = status?.active && status.capture ? status.capture : null;

  return (
    <div className="border-t border-border pt-6 space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t.supportTitle}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t.supportDesc}
        </p>
      </div>

      {!active && (
        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium">{t.supportDuration}</span>
            <select
              value={durationHours}
              onChange={(event) =>
                setDurationHours(Number(event.target.value) as 1 | 24 | 168)
              }
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value={1}>{t.supportDurationOneHour}</option>
              <option value={24}>{t.supportDurationOneDay}</option>
              <option value={168}>{t.supportDurationOneWeek}</option>
            </select>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={includeContent}
              onChange={(event) => setIncludeContent(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              <span className="block text-xs font-medium">
                {t.supportIncludeContent}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {t.supportIncludeContentDesc}
              </span>
            </span>
          </label>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {t.supportLocalOnly}
          </p>
          <button
            type="button"
            onClick={startCapture}
            disabled={working !== null}
            className="rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {working === "start" ? t.supportStarting : t.supportStart}
          </button>
        </div>
      )}

      {active && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                {t.supportActive}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {format(t.supportActiveUntil, {
                  time: new Date(active.expiresAt).toLocaleString(),
                })}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {format(t.supportEvents, { count: active.eventCount })}
              </div>
            </div>
            <button
              type="button"
              onClick={stopCapture}
              disabled={working !== null}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {working === "stop" ? t.supportStopping : t.supportStop}
            </button>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {t.supportReproduce}
          </p>

          {!preview && (
            <button
              type="button"
              onClick={loadPreview}
              disabled={working !== null}
              className="rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {working === "preview" ? t.supportPreparing : t.supportPreview}
            </button>
          )}

          {preview && (
            <div className="rounded-lg border border-border bg-background p-3 space-y-3">
              <div className="text-xs font-medium">{t.supportPreviewTitle}</div>
              <ul className="space-y-1">
                {preview.categories.map((category) => (
                  <li
                    key={category.name}
                    className="flex justify-between gap-4 text-xs text-muted-foreground"
                  >
                    <span>{supportCategoryLabel(category.name, t)}</span>
                    <span>{category.count}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {preview.includeContent
                  ? t.supportPreviewWithContent
                  : t.supportPreviewWithoutContent}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t.supportDownloadDeletes}
              </p>
              <button
                type="button"
                onClick={downloadCapsule}
                disabled={working !== null}
                className="rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {working === "download"
                  ? t.supportDownloading
                  : t.supportDownload}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{t.supportError}</p>}
    </div>
  );
}

function supportCategoryLabel(
  category: string,
  t: ReturnType<typeof useT>["settings"]["privacy"],
): string {
  const labels: Record<string, string> = {
    captureEvents: t.supportCategoryLogs,
    analyticsEvents: t.supportCategoryAnalytics,
    sessionMessages: t.supportCategoryMessages,
    workflowRuns: t.supportCategoryWorkflows,
    scheduledJobs: t.supportCategorySchedules,
    migrations: t.supportCategoryMigrations,
  };
  return labels[category] ?? category;
}

// ── Delete memories ─────────────────────────────────────────

function DeleteMemoriesRow() {
  const t = useT();
  type State =
    | { kind: "idle" }
    | { kind: "confirming"; input: string }
    | { kind: "working" }
    | { kind: "done"; count: number }
    | { kind: "error"; message: string };

  const [state, setState] = useState<State>({ kind: "idle" });
  const REQUIRED = "delete memories";

  async function runDelete() {
    setState({ kind: "working" });
    try {
      const res = await authFetch(`${API_URL}/api/account/memories`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({
          kind: "error",
          message: body?.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as { memoriesDeleted: number; soulsDeleted: number };
      setState({ kind: "done", count: data.memoriesDeleted + data.soulsDeleted });
    } catch {
      setState({ kind: "error", message: "Network error" });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-sm font-medium">{t.settings.privacy.deleteMemoriesTitle}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t.settings.privacy.deleteMemoriesDesc}
          </div>
        </div>
        {state.kind === "idle" && (
          <button
            onClick={() => setState({ kind: "confirming", input: "" })}
            className="text-sm font-medium border border-destructive/30 text-destructive px-3 py-1.5 rounded-lg hover:bg-destructive/10 transition-colors shrink-0"
          >
            {t.settings.common.delete}
          </button>
        )}
        {state.kind === "done" && (
          <span className="text-xs text-muted-foreground shrink-0">
            {format(
              state.count === 1
                ? t.settings.privacy.clearedItemsOne
                : t.settings.privacy.clearedItems,
              { count: state.count },
            )}
          </span>
        )}
      </div>

      {state.kind === "confirming" && (
        <ConfirmBlock
          title={t.settings.privacy.confirmMemoriesTitle}
          input={state.input}
          onChange={(v) => setState({ kind: "confirming", input: v })}
          disabled={state.input.trim().toLowerCase() !== REQUIRED}
          confirmLabel={t.settings.privacy.confirmMemoriesLabel}
          onCancel={() => setState({ kind: "idle" })}
          onConfirm={runDelete}
        />
      )}

      {state.kind === "working" && (
        <div className="text-xs text-muted-foreground">{t.settings.privacy.deleting}</div>
      )}

      {state.kind === "error" && (
        <div className="text-xs text-destructive">
          {state.message}{" "}
          <button
            onClick={() => setState({ kind: "idle" })}
            className="underline"
          >
            {t.settings.privacy.dismiss}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Delete account ──────────────────────────────────────────

function DeleteAccountRow({ userEmail }: { userEmail: string }) {
  const t = useT();
  type State =
    | { kind: "idle" }
    | { kind: "confirming"; input: string }
    | { kind: "working" }
    | { kind: "conflict"; assistants: ConflictAssistant[] }
    | { kind: "teamConflict"; teams: ConflictTeam[] }
    | { kind: "error"; message: string };

  const [state, setState] = useState<State>({ kind: "idle" });

  async function runDelete() {
    setState({ kind: "working" });
    try {
      const res = await authFetch(`${API_URL}/api/account`, {
        method: "DELETE",
      });

      if (res.status === 204) {
        // Account deleted on the backend; scrub the locally cached doc pages
        // (offline editing stores) so deleted-account content doesn't linger
        // in the browser, then clear the session. In the Electron shell,
        // clear the shell's own cookie jar via the bridge (the sub-app
        // `/api/auth/logout` is a no-op in prod, so it would otherwise leave
        // orphaned cookies in the jar) — it reloads into the sign-in landing
        // itself. See `desktopSignOut`.
        await clearLocalDocCaches();
        if (desktopSignOut()) return;
        // Web: clear the session server-side so `Domain=.usebrian.ai` cookies go
        // too (JS-only clears can't reach them). Use hard navigation after so
        // every in-memory app state resets along with the cookies.
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
        }).catch(() => {
          // Logout failure is non-fatal — the next page load still
          // bounces to /login because the account row is gone.
        });
        window.location.href = "/login";
        return;
      }

      if (res.status === 409) {
        // Two conflict shapes: `transfer_ownership_required` lists shared
        // assistants; `transfer_team_ownership_required` lists shared
        // workspaces. Both need the user to act elsewhere first — the panel
        // copy has to name the right object or the panel is a dead end.
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          assistants?: ConflictAssistant[];
          teams?: ConflictTeam[];
        };
        if (body.error === "transfer_team_ownership_required") {
          setState({ kind: "teamConflict", teams: body.teams ?? [] });
        } else {
          setState({ kind: "conflict", assistants: body.assistants ?? [] });
        }
        return;
      }

      const body = await res.json().catch(() => ({}));
      setState({
        kind: "error",
        message: body?.error ?? `Request failed (${res.status})`,
      });
    } catch {
      setState({ kind: "error", message: "Network error" });
    }
  }

  const canConfirm =
    state.kind === "confirming" &&
    userEmail.length > 0 &&
    state.input.trim().toLowerCase() === userEmail.trim().toLowerCase();

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-sm font-medium">{t.settings.privacy.deleteAccountTitle}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t.settings.privacy.deleteAccountDesc}
          </div>
        </div>
        {state.kind === "idle" && (
          <button
            onClick={() => setState({ kind: "confirming", input: "" })}
            disabled={!userEmail}
            className="text-sm font-medium border border-destructive/30 text-destructive px-3 py-1.5 rounded-lg hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {t.settings.privacy.deleteAccountTitle}
          </button>
        )}
      </div>

      {state.kind === "confirming" && (
        <ConfirmBlock
          title={
            userEmail
              ? format(t.settings.privacy.confirmAccountTitle, { email: userEmail })
              : t.settings.privacy.confirmAccountTitleNoEmail
          }
          input={state.input}
          onChange={(v) => setState({ kind: "confirming", input: v })}
          disabled={!canConfirm}
          confirmLabel={t.settings.privacy.confirmAccountLabel}
          onCancel={() => setState({ kind: "idle" })}
          onConfirm={runDelete}
        />
      )}

      {state.kind === "working" && (
        <div className="text-xs text-muted-foreground">{t.settings.privacy.deletingAccount}</div>
      )}

      {state.kind === "teamConflict" && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <div className="font-medium text-foreground">
            {t.settings.privacy.teamConflictTitle}
          </div>
          <div className="text-muted-foreground">
            {format(
              state.teams.length === 1
                ? t.settings.privacy.teamConflictDescOne
                : t.settings.privacy.teamConflictDescMany,
              { count: state.teams.length },
            )}
          </div>
          <ul className="space-y-1">
            {state.teams.map((w) => (
              <li key={w.id} className="text-foreground">
                {w.name}{" "}
                {typeof w.memberCount === "number" && (
                  <span className="text-muted-foreground">
                    {format(t.settings.privacy.conflictMemberCount, { count: w.memberCount })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button
            onClick={() => setState({ kind: "idle" })}
            className="text-muted-foreground hover:text-foreground underline"
          >
            {t.settings.privacy.dismiss}
          </button>
        </div>
      )}

      {state.kind === "conflict" && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <div className="font-medium text-foreground">
            {t.settings.privacy.conflictTitle}
          </div>
          <div className="text-muted-foreground">
            {format(
              state.assistants.length === 1
                ? t.settings.privacy.conflictDescOne
                : t.settings.privacy.conflictDescMany,
              { count: state.assistants.length },
            )}
          </div>
          <ul className="space-y-1">
            {state.assistants.map((a) => (
              <li key={a.id} className="text-foreground">
                {a.name}{" "}
                <span className="text-muted-foreground">
                  {format(t.settings.privacy.conflictMemberCount, { count: a.memberCount })}
                </span>
              </li>
            ))}
          </ul>
          <button
            onClick={() => setState({ kind: "idle" })}
            className="text-muted-foreground hover:text-foreground underline"
          >
            {t.settings.privacy.dismiss}
          </button>
        </div>
      )}

      {state.kind === "error" && (
        <div className="text-xs text-destructive">
          {state.message}{" "}
          <button
            onClick={() => setState({ kind: "idle" })}
            className="underline"
          >
            {t.settings.privacy.dismiss}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Shared UI bits ──────────────────────────────────────────

function ConfirmBlock({
  title,
  input,
  onChange,
  disabled,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  input: string;
  onChange: (v: string) => void;
  disabled: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
      <div className="text-xs text-foreground">{title}</div>
      <input
        type="text"
        value={input}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
        className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-destructive/30"
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="text-xs font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
        >
          {t.settings.privacy.confirmCancel}
        </button>
        <button
          onClick={onConfirm}
          disabled={disabled}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  description,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="text-sm font-medium flex items-center gap-2">
          {label}
          {hint && (
            <span className="text-[10px] uppercase tracking-wider font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
              {hint}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <button
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
          value ? "bg-primary" : "bg-muted"
        }`}
      >
        <div
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            value ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
