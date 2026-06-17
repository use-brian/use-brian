"use client";

// [COMP:app-web/settings-privacy-section] — see docs/architecture/features/privacy-controls.md
// Ported from apps/web/src/app/(app)/settings/privacy/page.tsx (PrivacyPage → PrivacySection).

import { useEffect, useState } from "react";
import { getUserInfo, getCachedUserInfo, type UserInfo } from "@/lib/user";
import { authFetch } from "@/lib/auth-fetch";
import { desktopSignOut } from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type ConflictAssistant = { id: string; name: string; memberCount: number };

type DeleteAccountError =
  | { kind: "conflict"; assistants: ConflictAssistant[] }
  | { kind: "unauthorized" }
  | { kind: "server"; message: string };

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

      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t.settings.privacy.dataTitle}</h3>
        <DeleteMemoriesRow />
        <DeleteAccountRow userEmail={userInfo?.email ?? ""} />
      </div>
    </div>
  );
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
    | { kind: "error"; message: string };

  const [state, setState] = useState<State>({ kind: "idle" });

  async function runDelete() {
    setState({ kind: "working" });
    try {
      const res = await authFetch(`${API_URL}/api/account`, {
        method: "DELETE",
      });

      if (res.status === 204) {
        // Account deleted on the backend; now clear the session. In the
        // Electron shell, clear the shell's own cookie jar via the bridge
        // (the sub-app `/api/auth/logout` is a no-op in prod, so it would
        // otherwise leave orphaned cookies in the jar) — it reloads into the
        // sign-in landing itself. See `desktopSignOut`.
        if (desktopSignOut()) return;
        // Web: clear the session server-side so `Domain=.sidan.ai` cookies go
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
        const body = (await res.json()) as DeleteAccountError & { kind: "conflict" };
        setState({ kind: "conflict", assistants: body.assistants ?? [] });
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
