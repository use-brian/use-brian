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
import { Cloud, Laptop } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ConnectBrowserPanel } from "./connect-browser-panel";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  createBrowserProfile,
  deleteBrowserProfile,
  listBrowserProfiles,
  revokeProfileGrant,
  revokeBrowserCredential,
  revokeProfileSession,
  saveBrowserCredential,
  startProfileLogin,
  testBrowserCredential,
  updateBrowserProfile,
  type BrowserBackend,
  type BrowserProfile,
  type BrowserProfileClearance,
  type LocalBrowserControlMode,
} from "@/lib/api/computer";

/** "instagram.com" and "https://instagram.com/x" both work in the sign-in box. */
function normalizeLoginUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A proxy URL must be an absolute URL with a real host - `new URL` alone is
 *  not enough, since a bare "host:port" typo (the common one, e.g.
 *  "proxy.example:8080") parses as a valid OPAQUE url whose "scheme" is the
 *  host and whose hostname is empty, not as an error. Requiring a hostname
 *  is what actually catches it (story 12: a typo must not silently produce
 *  an unproxied browse). */
export function isValidProxyUrl(raw: string): boolean {
  try {
    return new URL(raw).hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Which surfaces a profile card shows, by backend.
 *
 * A profile is "ONE cookie jar" only on the CLOUD backend, where the session
 * vault holds its logins. A `local` ("My Browser") profile rides the logins
 * already in the user's real Chrome — nothing is captured and the vault is
 * never read — so the sign-in box and the signed-in-sites list would both
 * mislead: they imply the user must sign in through us, and that a profile
 * with working logins has none. Tested as a decision table.
 */
export function profileSurfaces(profile: BrowserProfile): {
  signIn: boolean;
  vaultSessions: boolean;
  pairBrowser: boolean;
  localControl: boolean;
  ownBrowserNote: boolean;
} {
  const local = profile.defaultBackend === "local";
  return {
    signIn: !local,
    vaultSessions: !local,
    pairBrowser: local,
    localControl: local,
    ownBrowserNote: local,
  };
}

const CLEARANCES: BrowserProfileClearance[] = ["confidential", "internal", "public"];
const BACKENDS: BrowserBackend[] = ["cloud", "local"];
const LOCAL_CONTROL_MODES: LocalBrowserControlMode[] = ["task_tabs", "full_browser"];

export function BrowserProfilesSection() {
  const t = useT();
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params?.workspaceId ?? "";

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unconfigured" }
    | { kind: "ready"; profiles: BrowserProfile[]; credentialAuthConfigured: boolean }
    | { kind: "error" }
  >({ kind: "loading" });
  const [assistants, setAssistants] = useState<StudioAssistantSummary[]>([]);
  const [newName, setNewName] = useState("");
  const [newBackend, setNewBackend] = useState<BrowserBackend>("cloud");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // "Sign in to a site" drafts + in-flight flag, keyed by profile id.
  const [loginDrafts, setLoginDrafts] = useState<Record<string, string>>({});
  const [loginBusyId, setLoginBusyId] = useState<string | null>(null);
  // Proxy URL drafts (D7) - undefined until the user edits, so the input
  // falls back to the saved value.
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, string>>({});
  const [credentialDrafts, setCredentialDrafts] = useState<
    Record<
      string,
      { loginUrl: string; accountLabel: string; username: string; password: string }
    >
  >({});
  const [credentialBusyId, setCredentialBusyId] = useState<string | null>(null);

  const setCredentialField = useCallback(
    (
      profileId: string,
      field: "loginUrl" | "accountLabel" | "username" | "password",
      value: string,
    ) => {
      setCredentialDrafts((current) => ({
        ...current,
        [profileId]: {
          loginUrl: current[profileId]?.loginUrl ?? "",
          accountLabel: current[profileId]?.accountLabel ?? "",
          username: current[profileId]?.username ?? "",
          password: current[profileId]?.password ?? "",
          [field]: value,
        },
      }));
    },
    [],
  );

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setState({ kind: "unconfigured" });
      return;
    }
    try {
      const res = await listBrowserProfiles(workspaceId);
      setState(
        res.configured
          ? {
              kind: "ready",
              profiles: res.profiles,
              credentialAuthConfigured: res.credentialAuthConfigured,
            }
          : { kind: "unconfigured" },
      );
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
    const created = await createBrowserProfile({
      workspaceId,
      name,
      defaultBackend: newBackend,
    }).catch(() => null);
    setBusy(false);
    if (!created) {
      setActionError(t.computer.profiles.createFailed);
      return;
    }
    setNewName("");
    void reload();
  }, [busy, newBackend, newName, reload, t, workspaceId]);

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

  // "Sign in to a site" (§7): open a cloud browser on the login page as this
  // profile and jump to the Take-Over live view in a new tab (the settings
  // modal stays put). Signing in there + "I signed in" captures the cookies
  // into the profile; the ?flow=login view offers Done when saved.
  const onLogin = useCallback(
    async (profile: BrowserProfile) => {
      const url = normalizeLoginUrl(loginDrafts[profile.id] ?? "");
      if (!url || loginBusyId) return;
      setActionError(null);
      setLoginBusyId(profile.id);
      const started = await startProfileLogin(profile.id, url).catch(() => null);
      setLoginBusyId(null);
      if (!started) {
        setActionError(t.computer.profiles.loginFailed);
        return;
      }
      const query = started.site ? `&site=${encodeURIComponent(started.site)}` : "";
      window.open(
        `/w/${workspaceId}/computer/${encodeURIComponent(started.sessionId)}?flow=login${query}`,
        "_blank",
        "noopener",
      );
    },
    [loginBusyId, loginDrafts, t, workspaceId],
  );

  // Proxy URL (D7): free-text, validated client-side as a URL, saved through
  // the same `mutate` PATCH path as every other profile field.
  const onSaveProxy = useCallback(
    async (profile: BrowserProfile) => {
      const raw = (proxyDrafts[profile.id] ?? profile.proxyUrl ?? "").trim();
      if (raw && !isValidProxyUrl(raw)) {
        setActionError(t.computer.profiles.proxyInvalid);
        return;
      }
      await mutate(profile.id, { proxyUrl: raw || null });
    },
    [mutate, proxyDrafts, t],
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

  const onSaveCredential = useCallback(
    async (profile: BrowserProfile) => {
      const draft = credentialDrafts[profile.id];
      const loginUrl = normalizeLoginUrl(draft?.loginUrl ?? "");
      if (
        !loginUrl?.startsWith("https://") ||
        !draft?.username.trim() ||
        !draft.password ||
        credentialBusyId
      ) {
        return;
      }
      setActionError(null);
      setCredentialBusyId(profile.id);
      const saved = await saveBrowserCredential(profile.id, {
        loginUrl,
        accountLabel: draft.accountLabel.trim() || null,
        username: draft.username,
        password: draft.password,
      }).catch(() => null);
      setCredentialBusyId(null);
      if (!saved) {
        setActionError(t.computer.profiles.credentialSaveFailed);
        return;
      }
      setCredentialDrafts((current) => ({
        ...current,
        [profile.id]: { loginUrl: "", accountLabel: "", username: "", password: "" },
      }));
      void reload();
    },
    [credentialBusyId, credentialDrafts, reload, t],
  );

  const onTestCredential = useCallback(
    async (profileId: string, credentialId: string) => {
      if (credentialBusyId) return;
      setActionError(null);
      setCredentialBusyId(credentialId);
      const result = await testBrowserCredential(profileId, credentialId).catch(() => null);
      setCredentialBusyId(null);
      if (!result?.ok) {
        setActionError(
          result?.status === "needs_user"
            ? t.computer.profiles.credentialNeedsUser
            : t.computer.profiles.credentialTestFailed,
        );
      }
      void reload();
    },
    [credentialBusyId, reload, t],
  );

  const onRevokeCredential = useCallback(
    async (profileId: string, credentialId: string, site: string) => {
      const confirmed = await confirmDialog({
        title: t.computer.profiles.credentialRevokeTitle,
        description: t.computer.profiles.credentialRevokeBody.replace("{site}", site),
        confirmLabel: t.computer.profiles.revoke,
        variant: "destructive",
      });
      if (!confirmed) return;
      await revokeBrowserCredential(profileId, credentialId).catch(() => false);
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

  const backendTitle = (backend: BrowserBackend): string =>
    backend === "cloud" ? t.computer.profiles.remoteTitle : t.computer.profiles.localTitle;

  const backendDescription = (backend: BrowserBackend): string =>
    backend === "cloud"
      ? t.computer.profiles.remoteDescription
      : t.computer.profiles.localDescription;

  const localControlModeLabel = (mode: LocalBrowserControlMode): string =>
    mode === "task_tabs"
      ? t.computer.profiles.localControlTaskTabs
      : t.computer.profiles.localControlFullBrowser;

  const onLocalControlMode = useCallback(
    async (profile: BrowserProfile, mode: LocalBrowserControlMode) => {
      if (mode === profile.localControlMode) return;
      if (mode === "full_browser") {
        const confirmed = await confirmDialog({
          title: t.computer.profiles.localControlFullConfirmTitle,
          description: t.computer.profiles.localControlFullConfirmBody,
          confirmLabel: t.computer.profiles.localControlFullConfirmAction,
        });
        if (!confirmed) return;
      }
      await mutate(profile.id, { localControlMode: mode });
    },
    [mutate, t],
  );

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
          <div className="rounded-lg border border-border bg-muted/15 p-4">
            <h4 className="text-sm font-medium">{t.computer.profiles.createTitle}</h4>
            <p className="mt-3 text-[11px] font-medium text-muted-foreground">
              {t.computer.profiles.typeLabel}
            </p>
            <div
              role="radiogroup"
              aria-label={t.computer.profiles.typeLabel}
              className="mt-1.5 grid gap-2 sm:grid-cols-2"
            >
              {BACKENDS.map((backend) => {
                const selected = newBackend === backend;
                const Icon = backend === "cloud" ? Cloud : Laptop;
                return (
                  <button
                    key={backend}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setNewBackend(backend)}
                    className={
                      selected
                        ? "flex min-h-20 items-start gap-3 rounded-lg border border-primary bg-primary/5 p-3 text-left ring-1 ring-primary/20"
                        : "flex min-h-20 items-start gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-accent/50"
                    }
                  >
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-muted">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">
                        {backendTitle(backend)}
                      </span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                        {backendDescription(backend)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onCreate();
                }}
                placeholder={t.computer.profiles.createPlaceholder}
                className="h-9 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                disabled={busy || newName.trim().length === 0}
                onClick={() => void onCreate()}
                className="h-9 shrink-0 rounded-md bg-action px-3 text-xs font-medium text-action-foreground hover:bg-action/90 disabled:opacity-50"
              >
                {t.computer.profiles.createAction}
              </button>
            </div>
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
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        {backendTitle(profile.defaultBackend)}
                      </span>
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

                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.typeLabel}
                    </p>
                    <div
                      role="radiogroup"
                      aria-label={t.computer.profiles.typeLabel}
                      className="mt-1.5 grid gap-2 sm:grid-cols-2"
                    >
                      {BACKENDS.map((backend) => {
                        const selected = profile.defaultBackend === backend;
                        const Icon = backend === "cloud" ? Cloud : Laptop;
                        return (
                          <button
                            key={backend}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => void mutate(profile.id, { defaultBackend: backend })}
                            className={
                              selected
                                ? "flex items-start gap-2 rounded-md border border-primary bg-primary/5 p-2.5 text-left"
                                : "flex items-start gap-2 rounded-md border border-border p-2.5 text-left transition-colors hover:bg-accent/50"
                            }
                          >
                            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0">
                              <span className="block text-xs font-medium">
                                {backendTitle(backend)}
                              </span>
                              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                                {backendDescription(backend)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Pairing is profile-scoped. A distinct real Chrome profile
                      can keep this connection live while another Use Brian
                      profile uses another extension instance concurrently. */}
                  {profileSurfaces(profile).pairBrowser ? (
                    <div className="mt-3">
                      <ConnectBrowserPanel profileId={profile.id} profileName={profile.name} />
                    </div>
                  ) : null}

                  {/* Standing local-browser scope. The extension still asks
                      for per-task consent; this setting only bounds which
                      eligible tabs that task may select afterward. */}
                  {profileSurfaces(profile).localControl ? (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.localControlLabel}
                    </p>
                    <div className="mt-1 flex gap-1">
                      {LOCAL_CONTROL_MODES.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => void onLocalControlMode(profile, mode)}
                          className={
                            profile.localControlMode === mode
                              ? "rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                              : "rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                          }
                        >
                          {localControlModeLabel(mode)}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {profile.localControlMode === "full_browser"
                        ? t.computer.profiles.localControlFullHint
                        : t.computer.profiles.localControlTaskHint}
                    </p>
                  </div>
                  ) : null}

                  {/* A My Browser profile has no vault to fill — it rides the
                      logins already in the user's real Chrome. */}
                  {profileSurfaces(profile).ownBrowserNote ? (
                    <div className="mt-3">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t.computer.profiles.ownBrowserLabel}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t.computer.profiles.ownBrowserHint}
                      </p>
                    </div>
                  ) : null}

                  {/* The secret goes from this authenticated app form to the
                      host-owned broker store. It never enters chat or a
                      model-facing browser tool. Cloud profiles only. */}
                  {profileSurfaces(profile).signIn ? (
                    <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
                      <p className="text-[11px] font-medium text-foreground">
                        {t.computer.profiles.credentialLabel}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {state.credentialAuthConfigured
                          ? t.computer.profiles.credentialHint
                          : t.computer.profiles.credentialNotConfigured}
                      </p>
                      {state.credentialAuthConfigured ? (
                        <>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <input
                              type="text"
                              autoComplete="off"
                              value={credentialDrafts[profile.id]?.loginUrl ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "loginUrl", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialUrlPlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring sm:col-span-2"
                            />
                            <input
                              type="text"
                              autoComplete="off"
                              value={credentialDrafts[profile.id]?.accountLabel ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "accountLabel", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialAccountPlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring sm:col-span-2"
                            />
                            <input
                              type="text"
                              autoComplete="username"
                              value={credentialDrafts[profile.id]?.username ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "username", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialUsernamePlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                            />
                            <input
                              type="password"
                              autoComplete="current-password"
                              value={credentialDrafts[profile.id]?.password ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "password", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialPasswordPlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                            />
                          </div>
                          <button
                            type="button"
                            disabled={
                              credentialBusyId !== null ||
                              !normalizeLoginUrl(
                                credentialDrafts[profile.id]?.loginUrl ?? "",
                              )?.startsWith("https://") ||
                              !(credentialDrafts[profile.id]?.username ?? "").trim() ||
                              !(credentialDrafts[profile.id]?.password ?? "")
                            }
                            onClick={() => void onSaveCredential(profile)}
                            className="mt-2 h-8 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50"
                          >
                            {credentialBusyId === profile.id
                              ? t.computer.profiles.credentialSaving
                              : t.computer.profiles.credentialSaveAction}
                          </button>
                        </>
                      ) : null}

                      {profile.credentials.length > 0 ? (
                        <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-background">
                          {profile.credentials.map((credential) => (
                            <li
                              key={credential.id}
                              className="flex items-center justify-between gap-3 px-2.5 py-2"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-xs font-medium">
                                    {credential.accountLabel || credential.site}
                                  </span>
                                  <span
                                    className={
                                      credential.status === "active"
                                        ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                                        : "rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                                    }
                                  >
                                    {credential.status === "active"
                                      ? t.computer.profiles.credentialReady
                                      : t.computer.profiles.credentialNeedsAttention}
                                  </span>
                                </div>
                                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                  {credential.site}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  disabled={credentialBusyId !== null}
                                  onClick={() =>
                                    void onTestCredential(profile.id, credential.id)
                                  }
                                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                                >
                                  {credentialBusyId === credential.id
                                    ? t.computer.profiles.credentialTesting
                                    : t.computer.profiles.credentialTestAction}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void onRevokeCredential(
                                      profile.id,
                                      credential.id,
                                      credential.site,
                                    )
                                  }
                                  className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                                >
                                  {t.computer.profiles.revoke}
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {/* "Sign in to a site" (§7): user-initiated login capture —
                      opens the Take-Over live view on the site's login page.
                      Cloud only: capture exists only in the cloud sandbox. */}
                  {profileSurfaces(profile).signIn ? (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.loginLabel}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="text"
                        value={loginDrafts[profile.id] ?? ""}
                        onChange={(e) =>
                          setLoginDrafts((d) => ({ ...d, [profile.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void onLogin(profile);
                        }}
                        placeholder={t.computer.profiles.loginPlaceholder}
                        className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                      />
                      <button
                        type="button"
                        disabled={
                          loginBusyId !== null ||
                          normalizeLoginUrl(loginDrafts[profile.id] ?? "") === null
                        }
                        onClick={() => void onLogin(profile)}
                        className="h-8 shrink-0 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50"
                      >
                        {loginBusyId === profile.id
                          ? t.computer.profiles.loginOpening
                          : t.computer.profiles.loginAction}
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t.computer.profiles.loginHint}
                    </p>
                  </div>
                  ) : null}

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

                  {/* Proxy URL (D7): routes the CLOUD browser's traffic
                      through the user's own proxy, so its egress resembles
                      where a captured session's cookies were minted. */}
                  {profileSurfaces(profile).signIn ? (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.proxyLabel}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="text"
                        value={proxyDrafts[profile.id] ?? profile.proxyUrl ?? ""}
                        onChange={(e) =>
                          setProxyDrafts((d) => ({ ...d, [profile.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void onSaveProxy(profile);
                        }}
                        placeholder={t.computer.profiles.proxyPlaceholder}
                        className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                      />
                      <button
                        type="button"
                        onClick={() => void onSaveProxy(profile)}
                        className="h-8 shrink-0 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
                      >
                        {t.computer.profiles.proxySave}
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t.computer.profiles.proxyHint}
                    </p>
                  </div>
                  ) : null}

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

                  {/* Per-site sessions inside the cookie jar. Cloud only: a My
                      Browser profile never captures into the vault, so an
                      empty list here would read as "no logins" when the real
                      Chrome is signed in. */}
                  {profileSurfaces(profile).vaultSessions ? (
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
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
