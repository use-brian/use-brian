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
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Cloud, Laptop, Settings2, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/skeleton";
import { normalizeCaptureSite } from "@/lib/computer-takeover";
import { useCachedResource } from "@/lib/surface-cache";
import { browserProfilesCacheKey, browserProfileDestinationsCacheKey } from "@/lib/surface-prefetch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ConnectBrowserPanel } from "./connect-browser-panel";
import {
  captureProfileSession,
  classifyBrowserProfileDepartment,
  createBrowserProfile,
  fetchBrowserProfileDestinations,
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
  type BrowserProfileScope,
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
 * Which surfaces a profile card shows, by backend and ownership.
 *
 * A profile is "ONE cookie jar" only on the CLOUD backend, where the session
 * vault holds its logins. A `local` ("My Browser") profile rides the logins
 * already in the user's real Chrome — the local profile itself owns no vault
 * never read — so the sign-in box and the signed-in-sites list would both
 * mislead: they imply the user must sign in through us, and that a profile
 * with working logins has none. Owners may still pair any profile so a cloud
 * identity can switch live to My Browser or explicitly copy one site's session
 * into its cloud vault. Tested as a decision table.
 */
export function profileSurfaces(profile: BrowserProfile): {
  signIn: boolean;
  vaultSessions: boolean;
  pairBrowser: boolean;
  captureFromBrowser: boolean;
  localControl: boolean;
  ownBrowserNote: boolean;
} {
  const local = profile.defaultBackend === "local";
  return {
    signIn: !local && profile.canManage === true,
    vaultSessions: !local,
    pairBrowser: profile.canManage === true,
    captureFromBrowser: !local && profile.canManage === true,
    localControl: profile.canManage === true,
    ownBrowserNote: local,
  };
}

/** Query selection for the master-detail profile surface. */
export function selectedBrowserProfile(
  profiles: BrowserProfile[],
  selectedProfileId: string | undefined,
  creating: boolean,
): BrowserProfile | null {
  if (creating) return null;
  return profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null;
}

const CLEARANCES: BrowserProfileClearance[] = ["confidential", "internal", "public"];
const SCOPES: BrowserProfileScope[] = ["owner", "workspace"];
const BACKENDS: BrowserBackend[] = ["cloud", "local"];
const LOCAL_CONTROL_MODES: LocalBrowserControlMode[] = ["task_tabs", "full_browser"];

export function BrowserProfilesSection({
  selectedProfileId,
  creating = false,
}: {
  selectedProfileId?: string;
  creating?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params?.workspaceId ?? "";

  // The roster paints from the surface cache (instant-navigation contract
  // N1): a revisit renders the last-known profiles on its first frame and
  // revalidates behind them; only a cold entry shows the skeleton. The
  // Browsers sidebar panel reads the SAME key in profiles mode, so the two
  // never issue a second copy of one request. No spine primitive names a
  // browser profile, so revalidation is mount / visibility plus the
  // `refresh()` every mutation below awaits.
  const roster = useCachedResource(
    workspaceId ? browserProfilesCacheKey(workspaceId) : null,
    () => listBrowserProfiles(workspaceId),
  );
  const { refresh: refreshRoster } = roster;
  const state:
    | { kind: "loading" }
    | { kind: "unconfigured" }
    | { kind: "ready"; profiles: BrowserProfile[]; credentialAuthConfigured: boolean }
    | { kind: "error" } = !workspaceId
    ? { kind: "unconfigured" }
    : roster.data
      ? roster.data.configured
        ? {
            kind: "ready",
            profiles: roster.data.profiles,
            credentialAuthConfigured: roster.data.credentialAuthConfigured,
          }
        : { kind: "unconfigured" }
      : roster.error !== undefined
        ? { kind: "error" }
        : { kind: "loading" };
  const [newName, setNewName] = useState("");
  const destinations = useCachedResource(
    workspaceId ? browserProfileDestinationsCacheKey(workspaceId) : null,
    () => fetchBrowserProfileDestinations(workspaceId),
    { expiresInMs: () => 30_000 },
  );
  const { refresh: refreshDestinations } = destinations;
  useEffect(() => {
    if (!workspaceId) return;
    const renew = () => {
      if (document.visibilityState === "visible") void refreshDestinations();
    };
    const timer = window.setInterval(renew, 15_000);
    window.addEventListener("focus", renew);
    document.addEventListener("visibilitychange", renew);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", renew);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [workspaceId, refreshDestinations]);
  const [newDepartment, setNewDepartment] = useState<string | null>(null);
  const [newScope, setNewScope] = useState<BrowserProfileScope>("owner");
  const [newClearance, setNewClearance] = useState<BrowserProfileClearance>("confidential");
  const chosenDepartment = destinations.data?.departments.find(row => row.id === newDepartment);
  const destinationReady = Boolean(destinations.data && (!newDepartment || chosenDepartment)
    && (newScope === "owner" || chosenDepartment)
    && (!chosenDepartment || ["public", "internal", "confidential"].indexOf(newClearance)
      <= ["public", "internal", "confidential"].indexOf(chosenDepartment.clearance)));
  const [newBackend, setNewBackend] = useState<BrowserBackend>("cloud");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [classificationDraft, setClassificationDraft] = useState<{ profileId: string; departmentId: string; reason: string } | null>(null);
  useEffect(() => {
    setClassificationDraft(null);
  }, [workspaceId, selectedProfileId, destinations.error, roster.error]);
  // "Sign in to a site" drafts + in-flight flag, keyed by profile id.
  const [loginDrafts, setLoginDrafts] = useState<Record<string, string>>({});
  const [loginBusyId, setLoginBusyId] = useState<string | null>(null);
  const [captureDrafts, setCaptureDrafts] = useState<Record<string, string>>({});
  const [captureBusyId, setCaptureBusyId] = useState<string | null>(null);
  const [captureResults, setCaptureResults] = useState<
    Record<string, { kind: "saved" | "failed"; site?: string; capturedAt?: string | null }>
  >({});
  const [connectedProfiles, setConnectedProfiles] = useState<Record<string, boolean>>({});
  const onBrowserConnectionChange = useCallback((profileId: string, connected: boolean) => {
    setConnectedProfiles((current) =>
      current[profileId] === connected ? current : { ...current, [profileId]: connected },
    );
  }, []);
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

  // Authoritative reload after the user's own mutation: `refresh()` loads
  // into the same key, so the rows on screen stay up until the new roster
  // lands (no blank frame) and the next visit paints the post-edit list.
  const reload = useCallback(async () => {
    if (!workspaceId) return;
    await refreshRoster();
  }, [refreshRoster, workspaceId]);

  const onCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || busy || !destinationReady) return;
    setBusy(true);
    setActionError(null);
    const created = await createBrowserProfile({
      workspaceId,
      name,
      defaultBackend: newBackend,
      departmentId: newDepartment,
      scope: newScope,
      clearance: newClearance,
    }).catch(() => null);
    setBusy(false);
    if (!created) {
      setActionError(t.computer.profiles.createFailed);
      return;
    }
    setNewName("");
    await reload();
    router.replace(
      `/w/${workspaceId}/computer/profiles?profile=${encodeURIComponent(created.id)}`,
    );
  }, [busy, newBackend, newName, newDepartment, newScope, newClearance, destinationReady, reload, router, t, workspaceId]);

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
      if (!ok) {
        setActionError(t.computer.profiles.updateFailed);
        return;
      }
      await reload();
      router.replace(`/w/${workspaceId}/computer/profiles`);
    },
    [reload, router, t, workspaceId],
  );

  const onClassify = async (profile: BrowserProfile) => {
    const draft = classificationDraft;
    if (busy || !destinations.data || draft?.profileId !== profile.id || !draft.reason.trim()) return;
    const departmentId = draft.departmentId || null;
    if (departmentId === (profile.departmentId ?? null)) return;
    setBusy(true);
    setActionError(null);
    try {
      const confirmed = await confirmDialog({
        title: t.computer.profiles.changeDepartment,
        description: t.computer.profiles.classificationConfirm,
        confirmLabel: t.computer.profiles.changeDepartment,
      });
      if (!confirmed) return;
      const result = await classifyBrowserProfileDepartment(profile.id, workspaceId, {
        departmentId, expectedDepartmentId: profile.departmentId ?? null,
        reason: draft.reason.trim(), confirmed: true,
      });
      setClassificationDraft(null);
      if (result !== "saved") setActionError(result === "changed"
        ? t.computer.profiles.classificationChanged
        : result === "admin_required" ? t.computer.profiles.classificationAdminRequired
          : t.computer.profiles.classificationUnavailable);
      await Promise.all([reload(), refreshDestinations()]);
    } finally { setBusy(false); }
  };

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

  const onCaptureFromBrowser = useCallback(
    async (profile: BrowserProfile) => {
      const site = normalizeCaptureSite(captureDrafts[profile.id] ?? "");
      if (!site || captureBusyId) return;
      setCaptureBusyId(profile.id);
      setCaptureResults((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      const result = await captureProfileSession(profile.id, site).catch(() => ({
        ok: false,
        site: undefined,
        capturedAt: undefined,
      }));
      setCaptureBusyId(null);
      setCaptureResults((current) => ({
        ...current,
        [profile.id]: result.ok
          ? {
              kind: "saved",
              site: result.site ?? site,
              capturedAt: result.capturedAt ?? null,
            }
          : { kind: "failed" },
      }));
      if (result.ok) void reload();
    },
    [captureBusyId, captureDrafts, reload],
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

  const scopeLabel = (scope: BrowserProfileScope, departmentId?: string | null): string =>
    scope === "owner"
      ? t.computer.profiles.scopeOwner
      : departmentId ? t.computer.profiles.departmentMembers : t.computer.profiles.scopeWorkspace;

  const clearanceLabel = (clearance: BrowserProfileClearance): string =>
    clearance === "confidential"
      ? t.computer.profiles.clearanceConfidential
      : clearance === "internal"
        ? t.computer.profiles.clearanceInternal
        : t.computer.profiles.clearancePublic;

  const backendTitle = (backend: BrowserBackend): string =>
    backend === "cloud" ? t.computer.profiles.remoteTitle : t.computer.profiles.localTitle;

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

  const readyProfiles = state.kind === "ready" ? state.profiles : [];
  const selectedProfile = selectedBrowserProfile(
    readyProfiles,
    selectedProfileId,
    creating,
  );
  const showCreate = state.kind === "ready" && (creating || readyProfiles.length === 0);

  return (
    <div className="space-y-4">
      {state.kind === "loading" ? (
        // Cold entry only (nothing cached yet): the selected-profile card's
        // geometry, so the swap to real rows is quiet (N4).
        <div
          aria-busy="true"
          data-testid="browser-profiles-skeleton"
          className="rounded-xl border border-border bg-background p-4 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="size-8 rounded-md" />
          </div>
          <div className="mt-3 space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        </div>
      ) : state.kind === "unconfigured" ? (
        <p className="text-xs text-muted-foreground">{t.computer.profiles.notConfigured}</p>
      ) : state.kind === "error" ? (
        <p className="text-xs text-destructive">{t.computer.profiles.loadFailed}</p>
      ) : (
        <>
          {showCreate ? (
          <div className="rounded-xl border border-border bg-background p-4 shadow-sm">
            <h4 className="text-sm font-medium">{t.computer.profiles.createTitle}</h4>
            <div
              role="radiogroup"
              aria-label={t.computer.profiles.typeLabel}
              className="mt-3 flex flex-wrap gap-2"
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
                        ? "inline-flex h-9 items-center gap-2 rounded-md border border-primary bg-primary/5 px-3 text-xs font-medium text-primary ring-1 ring-primary/20"
                        : "inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
                    }
                  >
                    <Icon className="size-4" aria-hidden />
                    {backendTitle(backend)}
                  </button>
                );
              })}
            </div>
            {destinations.data ? <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1 text-xs">{t.contextScope.team}
                <SearchableSelect className="max-sm:min-h-11" value={newDepartment ?? "__personal__"}
                  items={[{ value: "__personal__", label: t.computer.profiles.personalDepartment },
                    ...destinations.data.departments.map(row => ({ value: row.id, label: row.name }))]}
                  onValueChange={value => {
                    const row = destinations.data?.departments.find(item => item.id === value);
                    setNewDepartment(row?.id ?? null);
                    setNewClearance(row?.clearance ?? "confidential");
                    if (!row) setNewScope("owner");
                  }} />
              </label>
              <label className="grid gap-1 text-xs">{t.computer.profiles.scopeLabel}
                <SearchableSelect className="max-sm:min-h-11" value={newScope}
                  items={[{ value: "owner", label: t.computer.profiles.scopeOwner },
                    ...(chosenDepartment ? [{ value: "workspace", label: t.computer.profiles.departmentMembers }] : [])]}
                  onValueChange={value => setNewScope(value as BrowserProfileScope)} />
              </label>
              <label className="grid gap-1 text-xs">{t.computer.profiles.clearanceLabel}
                <SearchableSelect className="max-sm:min-h-11" value={newClearance}
                  items={CLEARANCES.filter(value => !chosenDepartment ||
                    ["public", "internal", "confidential"].indexOf(value) <= ["public", "internal", "confidential"].indexOf(chosenDepartment.clearance))
                    .map(value => ({ value, label: clearanceLabel(value) }))}
                  onValueChange={value => setNewClearance(value as BrowserProfileClearance)} />
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-3">{t.computer.profiles.departmentCreationHint}</p>
            </div> : destinations.error ? <div className="mt-3 text-sm" role="alert">
              <p>{t.computer.profiles.loadFailed}</p>
              <button type="button" className="min-h-8 max-sm:min-h-11 px-3 underline" onClick={() => void destinations.refresh()}>{t.computer.profiles.retryDestinations}</button>
            </div> : <Skeleton className="mt-3 h-20 w-full" />}
            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onCreate();
                }}
                placeholder={t.computer.profiles.createPlaceholder}
                className="h-9 flex-1 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:text-sm"
              />
              <button
                type="button"
                disabled={busy || !destinationReady || newName.trim().length === 0}
                onClick={() => void onCreate()}
                className="h-9 shrink-0 rounded-md bg-action px-3 text-xs font-medium text-action-foreground hover:bg-action/90 disabled:opacity-50"
              >
                {t.computer.profiles.createAction}
              </button>
            </div>
          </div>
          ) : null}

          {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}

          {selectedProfile ? (
            <ul className="space-y-3">
              {[selectedProfile].map((profile) => (
                <li key={profile.id} className="rounded-xl border border-border bg-background p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-base font-medium">{profile.name}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {backendTitle(profile.defaultBackend)}
                      </span>
                    </div>
                    {profile.canManage === true ? (<button
                      type="button"
                      onClick={() => void onDelete(profile)}
                      aria-label={t.computer.profiles.deleteProfile}
                      title={t.computer.profiles.deleteProfile}
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>) : null}
                  </div>

                  <dl className="mt-3 grid gap-1 text-xs">
                    <dt className="font-medium text-muted-foreground">{t.contextScope.team}</dt>
                    <dd className="break-words">{profile.departmentId
                      ? destinations.data?.departments.find(row => row.id === profile.departmentId)?.name ?? t.computer.profiles.departmentUnavailable
                      : profile.scope === "owner" ? t.computer.profiles.personalDepartment : t.computer.profiles.unassignedDepartment}</dd>
                  </dl>

                  {profile.canManage === true && destinations.data ? (
                    <form className="mt-3 grid gap-3 py-3" onSubmit={(event) => { event.preventDefault(); void onClassify(profile); }}>
                      <label className="grid gap-1 text-xs">
                        {t.computer.profiles.changeDepartment}
                        <SearchableSelect
                          aria-label={t.computer.profiles.changeDepartment}
                          className="min-h-8 max-sm:min-h-11 text-base sm:text-sm"
                          disabled={busy}
                          value={classificationDraft?.profileId === profile.id ? classificationDraft.departmentId : profile.departmentId ?? ""}
                          placeholder={t.computer.profiles.unassignedDepartment}
                          items={[
                            ...(profile.scope === "owner" ? [{ value: "", label: t.computer.profiles.personalDepartment }] : []),
                            ...destinations.data.departments.filter(row => CLEARANCES.indexOf(row.clearance) <= CLEARANCES.indexOf(profile.clearance))
                              .map(row => ({ value: row.id, label: row.name })),
                          ]}
                          onValueChange={departmentId => setClassificationDraft(current => ({profileId: profile.id, departmentId, reason: current?.profileId === profile.id ? current.reason : ""}))}
                        />
                      </label>
                      <label className="grid gap-1 text-xs">
                        {t.computer.profiles.classificationReason}
                        <input className="min-h-8 max-sm:min-h-11 min-w-0 rounded-md border border-border bg-background px-3 text-base" maxLength={1000} required disabled={busy}
                          value={classificationDraft?.profileId === profile.id ? classificationDraft.reason : ""}
                          onChange={event => setClassificationDraft(current => ({profileId: profile.id, departmentId: current?.profileId === profile.id ? current.departmentId : profile.departmentId ?? "", reason: event.target.value}))} />
                      </label>
                      <p className="text-xs text-muted-foreground">{t.computer.profiles.classificationConfirm}</p>
                      <button type="submit" className="min-h-8 max-sm:min-h-11 rounded-md border border-border px-3 text-sm disabled:opacity-50"
                        disabled={busy || classificationDraft?.profileId !== profile.id || !classificationDraft.reason.trim()
                          || classificationDraft.departmentId === (profile.departmentId ?? "")
                          || (!classificationDraft.departmentId && profile.scope !== "owner")
                          || Boolean(classificationDraft.departmentId && !destinations.data.departments.some(row => row.id === classificationDraft.departmentId && CLEARANCES.indexOf(row.clearance) <= CLEARANCES.indexOf(profile.clearance)))}>
                        {t.computer.profiles.changeDepartment}
                      </button>
                    </form>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.typeLabel}
                    </span>
                    {profile.canManage === true ? (<div
                      role="radiogroup"
                      aria-label={t.computer.profiles.typeLabel}
                      className="flex gap-1"
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
                                ? "inline-flex h-8 items-center gap-1.5 rounded-md bg-primary/10 px-2.5 text-xs font-medium text-primary"
                                : "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                            }
                          >
                            <Icon className="size-3.5" aria-hidden />
                            {backendTitle(backend)}
                          </button>
                        );
                      })}
                    </div>) : <p className="text-xs">{backendTitle(profile.defaultBackend)}</p>}
                  </div>

                  {/* Pairing is profile-scoped. A distinct real Chrome profile
                      can keep this connection live while another Use Brian
                      profile uses another extension instance concurrently. */}
                  {profileSurfaces(profile).pairBrowser ? (
                    <div className="mt-3">
                      <ConnectBrowserPanel
                        profileId={profile.id}
                        profileName={profile.name}
                        onConnectionChange={onBrowserConnectionChange}
                      />
                    </div>
                  ) : null}

                  {profileSurfaces(profile).captureFromBrowser ? (
                    <div className="mt-4 border-t border-border pt-3">
                      <p className="text-[11px] font-medium text-foreground">
                        {t.computer.profiles.captureLabel}
                      </p>
                      {connectedProfiles[profile.id] ? (
                        <>
                          <div className="mt-2 flex items-center gap-2">
                            <input
                              type="text"
                              value={captureDrafts[profile.id] ?? ""}
                              onChange={(event) =>
                                setCaptureDrafts((current) => ({
                                  ...current,
                                  [profile.id]: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void onCaptureFromBrowser(profile);
                              }}
                              placeholder={t.computer.profiles.capturePlaceholder}
                              className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:text-sm"
                            />
                            <button
                              type="button"
                              disabled={
                                captureBusyId !== null ||
                                normalizeCaptureSite(captureDrafts[profile.id] ?? "") === null
                              }
                              onClick={() => void onCaptureFromBrowser(profile)}
                              className="h-8 shrink-0 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50"
                            >
                              {captureBusyId === profile.id
                                ? t.computer.profiles.captureSaving
                                : t.computer.profiles.captureAction}
                            </button>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {t.computer.profiles.captureHint}
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t.computer.profiles.captureNoSession}
                        </p>
                      )}
                      {captureResults[profile.id]?.kind === "saved" ? (
                        <p role="status" className="mt-1 text-[11px] text-primary">
                          {captureResults[profile.id].capturedAt
                            ? t.computer.profiles.captureSuccess
                                .replace("{site}", captureResults[profile.id].site ?? "")
                                .replace(
                                  "{date}",
                                  new Date(
                                    captureResults[profile.id].capturedAt as string,
                                  ).toLocaleDateString(),
                                )
                            : t.computer.profiles.captureSuccessNoDate.replace(
                                "{site}",
                                captureResults[profile.id].site ?? "",
                              )}
                        </p>
                      ) : captureResults[profile.id]?.kind === "failed" ? (
                        <p role="status" className="mt-1 text-[11px] text-destructive">
                          {t.computer.profiles.captureFailed}
                        </p>
                      ) : null}
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
                              ? "rounded-md bg-primary/10 px-2 py-2 text-[11px] font-medium text-primary sm:py-1"
                              : "rounded-md border border-border px-2 py-2 text-[11px] text-muted-foreground hover:bg-accent sm:py-1"
                          }
                        >
                          {localControlModeLabel(mode)}
                        </button>
                      ))}
                    </div>
                  </div>
                  ) : null}

                  {/* The secret goes from this authenticated app form to the
                      host-owned broker store. It never enters chat or a
                      model-facing browser tool. Cloud profiles only. */}
                  {profileSurfaces(profile).signIn ? (
                    <div className="mt-4 border-t border-border pt-3">
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
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring sm:col-span-2 md:text-sm"
                            />
                            <input
                              type="text"
                              autoComplete="off"
                              value={credentialDrafts[profile.id]?.accountLabel ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "accountLabel", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialAccountPlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring sm:col-span-2 md:text-sm"
                            />
                            <input
                              type="text"
                              autoComplete="username"
                              value={credentialDrafts[profile.id]?.username ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "username", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialUsernamePlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:text-sm"
                            />
                            <input
                              type="password"
                              autoComplete="current-password"
                              value={credentialDrafts[profile.id]?.password ?? ""}
                              onChange={(event) =>
                                setCredentialField(profile.id, "password", event.target.value)
                              }
                              placeholder={t.computer.profiles.credentialPasswordPlaceholder}
                              className="h-8 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:text-sm"
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
                        <ul className="mt-2 divide-y divide-border">
                          {profile.credentials.map((credential) => (
                            <li
                              key={credential.id}
                              className="flex items-center justify-between gap-3 py-2"
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
                                  className="rounded-md border border-border px-2.5 py-2 text-xs font-medium sm:py-1 hover:bg-accent disabled:opacity-50"
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
                                  className="rounded-md border border-destructive/40 px-2.5 py-2 text-xs font-medium sm:py-1 text-destructive hover:bg-destructive/10"
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
                        className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:text-sm"
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

                  <details className="group mt-4 border-t border-border pt-3 [&_summary::-webkit-details-marker]:hidden">
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                      <Settings2 className="size-3.5" aria-hidden />
                      {t.computer.profiles.advancedTitle}
                    </summary>
                    <div className="pb-1 pl-1">
                  {/* Two independent axes (migration 451): WHOSE turns may use
                      it, and - only when shared - WHAT clearance they need.
                      One control used to carry both, so "only me" silently
                      demanded a top-cleared assistant. */}
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.scopeLabel}
                    </p>
                    {profile.canManage === true ? (<div className="mt-1 flex gap-1">
                      {SCOPES.map((scope) => (
                        <button
                          key={scope}
                          type="button"
                          onClick={() => void mutate(profile.id, { scope })}
                          className={
                            profile.scope === scope
                              ? "rounded-md bg-primary/10 px-2 py-2 text-[11px] font-medium text-primary sm:py-1"
                              : "rounded-md border border-border px-2 py-2 text-[11px] text-muted-foreground hover:bg-accent sm:py-1"
                          }
                        >
                          {scopeLabel(scope, profile.departmentId)}
                        </button>
                      ))}
                    </div>) : <p className="text-xs">{scopeLabel(profile.scope, profile.departmentId)}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {profile.scope === "owner"
                        ? t.computer.profiles.scopeHintOwner
                        : t.computer.profiles.scopeHintWorkspace}
                    </p>
                  </div>

                  {/* A private profile has no rung to satisfy, so offering one
                      would be a control that does nothing. */}
                  {profile.scope === "workspace" ? (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.computer.profiles.clearanceLabel}
                    </p>
                    {profile.canManage === true ? (<div className="mt-1 flex gap-1">
                      {CLEARANCES.map((clearance) => (
                        <button
                          key={clearance}
                          type="button"
                          onClick={() => void mutate(profile.id, { clearance })}
                          className={
                            profile.clearance === clearance
                              ? "rounded-md bg-primary/10 px-2 py-2 text-[11px] font-medium text-primary sm:py-1"
                              : "rounded-md border border-border px-2 py-2 text-[11px] text-muted-foreground hover:bg-accent sm:py-1"
                          }
                        >
                          {clearanceLabel(clearance)}
                        </button>
                      ))}
                    </div>) : <p className="text-xs">{clearanceLabel(profile.clearance)}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t.computer.profiles.clearanceHint}
                    </p>
                  </div>
                  ) : null}

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
                        className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-[16px] outline-none focus:ring-1 focus:ring-ring md:text-sm"
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

                  {/* Assistant access is configured from the assistant, where
                      users can reason about all of its available identities
                      together and leave per-profile routing guidance. */}
                  <div className="mt-3">
                    <Link
                      href={`/w/${workspaceId}/studio/assistants?tab=tools`}
                      className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {t.computer.profiles.manageAssistantAccess}
                    </Link>
                  </div>

                  {/* Standing skill grants on this identity (R2-2) */}
                  {profile.grants.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t.computer.profiles.grantsLabel}
                      </p>
                      <ul className="mt-1 divide-y divide-border">
                        {profile.grants.map((grant) => (
                          <li
                            key={grant.id}
                            className="flex items-center justify-between gap-3 py-2"
                          >
                            <div className="min-w-0">
                              <span className="truncate text-xs font-medium">{grant.skillName}</span>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {t.computer.profiles.grantHint}
                              </p>
                            </div>
                            {profile.canManage === true ? (<button
                              type="button"
                              onClick={() =>
                                void onRevokeGrant(profile.id, grant.id, grant.skillName)
                              }
                              className="shrink-0 rounded-md border border-destructive/40 px-2.5 py-2 text-xs font-medium sm:py-1 text-destructive hover:bg-destructive/10"
                            >
                              {t.computer.profiles.revoke}
                            </button>) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                    </div>
                  </details>

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
                      <ul className="mt-1 divide-y divide-border">
                        {profile.sessions.map((session) => (
                          <li
                            key={session.site}
                            className="flex items-center justify-between gap-3 py-2"
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
                            {profile.canManage === true ? (<button
                              type="button"
                              onClick={() => void onRevoke(profile.id, session.site)}
                              className="shrink-0 rounded-md border border-destructive/40 px-2.5 py-2 text-xs font-medium sm:py-1 text-destructive hover:bg-destructive/10"
                            >
                              {t.computer.profiles.revoke}
                            </button>) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
