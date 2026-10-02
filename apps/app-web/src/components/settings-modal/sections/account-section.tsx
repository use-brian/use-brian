"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
// Ported from apps/web/src/app/(app)/settings/account/page.tsx
// (AccountPage → AccountSection). The earlier app-web port was a thinner
// stub (initials bubble, no name-save, no avatar upload); this gap-fills it
// to parity with apps/web — see docs/architecture/features/doc.md §5a.

import { useState, useEffect, useRef } from "react";
import {
  getUserInfo,
  getCachedUserInfo,
  setUserInfoCache,
  subscribeUserInfo,
  type UserInfo,
} from "@/lib/user";
import { authFetch } from "@/lib/auth-fetch";
import { signOutActiveAccount } from "@/lib/account-logout";
import { useT } from "@/lib/i18n/client";
import { isPhoneViewport } from "@/lib/viewport";
import { UserAvatar } from "@/components/ui/user-avatar";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  updateDisplayName,
  uploadAvatar,
  removeAvatar,
  listAccountSessions,
  revokeAccountSession,
  revokeAllAccountSessions,
  MAX_AVATAR_BYTES,
  planProfileRefresh,
  type AccountSession,
} from "@/lib/api/account";
import { CHANNEL_IDENTITY_KINDS } from "@use-brian/shared";
import { ConnectedAccountsList } from "@/components/channel-identity/channel-identity";
import { format } from "@/lib/i18n/format";
import { isOssEdition, isHostedEdition } from "@/lib/edition";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { primaryAuthUrl } from "@/lib/primary-auth";
import { desktopAuthSource, isDesktopAuth } from "@/lib/desktop-auth-source";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** A transient status banner: success or error feedback after an action. */
type Status = { kind: "success" | "error"; text: string } | null;

export function AccountSection() {
  const t = useT();
  const { workspaceId } = useWorkspaceContext();
  const [userInfo, setUserInfo] = useState<UserInfo | null>(getCachedUserInfo);
  const [name, setName] = useState(() => getCachedUserInfo()?.name ?? "");
  const profileName = useRef(getCachedUserInfo()?.name ?? "");
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const syncProfile = (info: UserInfo | null) => {
      const previousName = profileName.current;
      profileName.current = info?.name ?? "";
      setUserInfo(info);
      setName((draft) => draft === previousName ? (info?.name ?? "") : draft);
      if (info) setProfileLoadFailed(false);
    };
    const unsubscribe = subscribeUserInfo(syncProfile);
    const info = getUserInfo();
    syncProfile(info);
    // Existing packaged sessions predate the native avatar field. One
    // background refresh upgrades that encrypted record and repaints this
    // section without requiring a sign-out/reinstall. `null` means the account
    // intentionally has no photo; `undefined` means the old record never knew.
    if (isDesktopAuth() && (!info || info.avatarUrl === undefined)) {
      void refreshProfile();
    }
    return unsubscribe;
  }, []);

  async function refreshProfile() {
    setProfileLoadFailed(false);
    try {
      await refreshUserInfo();
    } catch {
      setProfileLoadFailed(true);
    }
  }

  const displayLabel = userInfo?.name || userInfo?.email || "";

  /**
   * Re-pull the `user` cookie through the route allowed to write it. Hosted
   * app-web navigates through the primary site's refresh-and-return bridge;
   * dev/OSS refresh in place, then sync the module cache + local state.
   */
  async function refreshUserInfo(): Promise<UserInfo | null> {
    if (isDesktopAuth()) {
      const outcome = await desktopAuthSource.refresh();
      if (outcome.kind !== "ok") throw new Error("profile_refresh_failed");
      // Older native shells return the identity with refresh but have no
      // getCurrentUser getter. Preserve that response instead of reading cookies.
      const info = outcome.user ?? getUserInfo();
      if (!info) throw new Error("profile_refresh_failed");
      setUserInfoCache(info);
      setUserInfo(info);
      return info;
    }

    if (typeof window !== "undefined") {
      const plan = planProfileRefresh(primaryAuthUrl(), window.location.href);
      if (plan.kind === "redirect") {
        window.location.assign(plan.url);
        return null;
      }
    }

    const refreshed = await fetch("/api/auth/refresh", { method: "POST" });
    if (!refreshed.ok) throw new Error("profile_refresh_failed");
    const info = getUserInfo();
    if (info) {
      setUserInfoCache(info);
      setUserInfo(info);
      setName(info.name ?? "");
    }
    return info;
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so re-picking the same file fires `onChange` again.
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      setStatus({ kind: "error", text: t.settings.account.photoTooLarge });
      return;
    }
    setUploading(true);
    setStatus(null);
    try {
      if (!workspaceId) throw new Error("missing_workspace");
      const ok = await uploadAvatar(file, workspaceId);
      if (!ok) throw new Error("upload_failed");
      await refreshUserInfo();
      setStatus({ kind: "success", text: t.settings.account.photoUpdated });
    } catch {
      setStatus({ kind: "error", text: t.settings.account.photoError });
    } finally {
      setUploading(false);
    }
  }

  async function onRemovePhoto() {
    const ok = await confirmDialog({
      title: t.settings.account.removePhotoTitle,
      description: t.settings.account.removePhotoConfirm,
      confirmLabel: t.settings.account.removePhoto,
      cancelLabel: t.settings.common.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setRemoving(true);
    setStatus(null);
    try {
      const removed = await removeAvatar();
      if (!removed) throw new Error("remove_failed");
      await refreshUserInfo();
      setStatus({ kind: "success", text: t.settings.account.photoRemoved });
    } catch {
      setStatus({ kind: "error", text: t.settings.account.photoError });
    } finally {
      setRemoving(false);
    }
  }

  async function onSaveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === (userInfo?.name ?? "")) return;
    setSavingName(true);
    setStatus(null);
    try {
      const ok = await updateDisplayName(trimmed);
      if (!ok) throw new Error("name_failed");
      const info = await refreshUserInfo();
      if (info) setName(info.name ?? "");
      setStatus({ kind: "success", text: t.settings.account.nameUpdated });
    } catch {
      setStatus({ kind: "error", text: t.settings.account.nameError });
    } finally {
      setSavingName(false);
    }
  }

  const nameDirty = name.trim() !== "" && name.trim() !== (userInfo?.name ?? "");
  const hasAvatar = Boolean(userInfo?.avatarUrl);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.settings.nav.account}</h2>

      <div className="border-t border-border pt-6 flex items-center gap-4">
        <UserAvatar
          size={56}
          name={userInfo?.name}
          email={userInfo?.email}
          avatarUrl={userInfo?.avatarUrl}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium">{displayLabel}</div>
          {/* The oss single-player owner has no real email — the local-owner
              session uses a synthetic `@local` address that must never surface. */}
          {!isOssEdition() && (
            <div className="text-xs text-muted-foreground truncate">{userInfo?.email ?? ""}</div>
          )}
          <div className="mt-2 flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickPhoto}
            />
            {/* `Button size="sm"` carries the phone floor (44px below `sm`);
                the 12px text links were ~16px-tall targets (report A row 18). */}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || removing}
              className="px-0 text-[12px]"
            >
              {uploading ? t.settings.common.save + "…" : t.settings.account.changePhoto}
            </Button>
            {hasAvatar && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={onRemovePhoto}
                disabled={uploading || removing}
                className="px-0 text-[12px] text-muted-foreground hover:text-foreground"
              >
                {t.settings.account.removePhoto}
              </Button>
            )}
          </div>
        </div>
      </div>

      {profileLoadFailed && (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-xs text-red-400">{t.settings.account.profileLoadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refreshProfile()}>
            {t.settings.account.retry}
          </Button>
        </div>
      )}

      {status && (
        <p
          className={
            status.kind === "success"
              ? "text-[12px] text-primary"
              : "text-[12px] text-red-400"
          }
        >
          {status.text}
        </p>
      )}

      <div className="border-t border-border pt-6 space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t.settings.account.profile}</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t.settings.account.displayName}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && nameDirty && onSaveName()}
                // In the oss edition the owner name is local config (set via the
                // launcher prompt / ~/.usebrian/config.json), so it is read-only
                // here — an in-app edit would be re-clobbered on the next boot.
                disabled={savingName || isOssEdition()}
                className="flex-1 min-w-0 text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 disabled:opacity-60"
              />
              {!isOssEdition() && (
                <button
                  type="button"
                  onClick={onSaveName}
                  disabled={!nameDirty || savingName}
                  className="text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50"
                >
                  {savingName ? "…" : t.settings.account.saveName}
                </button>
              )}
            </div>
          </div>
          {!isOssEdition() && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t.settings.account.email}</label>
              <input
                type="email"
                value={userInfo?.email ?? ""}
                disabled
                className="w-full text-[16px] md:text-sm bg-muted border border-border rounded-lg px-3 py-2 text-muted-foreground"
              />
            </div>
          )}
        </div>
      </div>

      <HandleSection />

      <ConnectedAccountsSection />

      <DevicesSection />

      <div className="border-t border-border pt-6 space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t.settings.account.signOut}</h3>
        <button
          onClick={() => signOutActiveAccount()}
          className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors"
        >
          {t.settings.account.logOut}
        </button>
      </div>
    </div>
  );
}

export function DevicesSection() {
  const t = useT();
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const rows = await listAccountSessions();
    if (rows === null) {
      setLoadFailed(true);
      setSessions([]);
      return;
    }
    setLoadFailed(false);
    setSessions(rows);
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(session: AccountSession) {
    const confirmed = await confirmDialog({
      title: t.settings.account.logOutDeviceTitle,
      description: format(t.settings.account.logOutDeviceConfirm, {
        device: session.deviceLabel,
      }),
      confirmLabel: t.settings.account.logOutDevice,
      cancelLabel: t.settings.common.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusyId(session.id);
    const ok = await revokeAccountSession(session.id);
    if (!ok) {
      setBusyId(null);
      setLoadFailed(true);
      return;
    }
    if (session.current) {
      signOutActiveAccount({ revokeCurrent: false });
      return;
    }
    setSessions((current) => current?.filter((row) => row.id !== session.id) ?? []);
    setBusyId(null);
  }

  async function revokeAll() {
    const confirmed = await confirmDialog({
      title: t.settings.account.logOutAllDevicesTitle,
      description: t.settings.account.logOutAllDevicesConfirm,
      confirmLabel: t.settings.account.logOutAllDevices,
      cancelLabel: t.settings.common.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusyId("all");
    const ok = await revokeAllAccountSessions();
    if (!ok) {
      setBusyId(null);
      setLoadFailed(true);
      return;
    }
    signOutActiveAccount({ revokeCurrent: false });
  }

  return (
    <div className="border-t border-border pt-6 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          {t.settings.account.devices}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t.settings.account.devicesDesc}
        </p>
      </div>

      {sessions === null && (
        <p className="text-xs text-muted-foreground">{t.settings.common.loading}</p>
      )}
      {loadFailed && (
        <div className="flex items-center gap-3">
          <p className="text-xs text-red-400">{t.settings.account.devicesLoadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t.settings.account.retry}
          </Button>
        </div>
      )}
      {!loadFailed && sessions?.length === 0 && (
        <p className="text-xs text-muted-foreground">{t.settings.account.noDevices}</p>
      )}

      {!loadFailed && sessions && sessions.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {sessions.map((session) => (
            <div key={session.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{session.deviceLabel}</span>
                  {session.current && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {t.settings.account.currentDevice}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {format(t.settings.account.lastActive, {
                    time: new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(session.lastSeenAt)),
                  })}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busyId !== null}
                onClick={() => void revoke(session)}
              >
                {busyId === session.id ? "…" : t.settings.account.logOutDevice}
              </Button>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busyId !== null}
        onClick={() => void revokeAll()}
        className="text-red-500 hover:text-red-500"
      >
        {busyId === "all" ? "…" : t.settings.account.logOutAllDevices}
      </Button>
    </div>
  );
}

/**
 * Connected accounts - one row per chat channel from the shared channel
 * identity registry (`ConnectedAccountsList`), the same row the Studio
 * channel footer uses. The WhatsApp row links to the hosted official number,
 * so self-host omits it.
 * Spec: docs/plans/channel-identity-binding.md §4.1.
 */
function ConnectedAccountsSection() {
  const t = useT();
  const kinds = isHostedEdition()
    ? CHANNEL_IDENTITY_KINDS
    : CHANNEL_IDENTITY_KINDS.filter((kind) => kind !== "whatsapp");
  return (
    <div className="border-t border-border pt-6 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
        {t.settings.account.connectedAccounts}
      </h3>
      <p className="text-[12px] text-muted-foreground">
        {t.settings.account.connectedAccountsDesc}
      </p>
      <ConnectedAccountsList kinds={kinds} />
    </div>
  );
}

function HandleSection() {
  const t = useT();
  const [handle, setHandle] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    authFetch(`${API_URL}/api/handles/me`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { handle?: string } | null) => {
        if (data?.handle) {
          setHandle(data.handle);
          setInput(data.handle);
        }
      })
      .catch(() => {});
  }, []);

  async function saveHandle() {
    if (!input.trim() || input.trim() === handle) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await authFetch(`${API_URL}/api/handles/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: input.trim().toLowerCase() }),
      });
      if (res.ok) {
        const data = await res.json();
        setHandle(data.handle);
        setInput(data.handle);
        setEditing(false);
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setError(err.error ?? "Failed to update handle");
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border pt-6 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t.settings.account.handle}</h3>
      <p className="text-[12px] text-muted-foreground">
        {t.settings.account.handleDesc}
      </p>
      {editing ? (
        <div className="space-y-2">
          {/* Wraps at 360px instead of crowding Save / Cancel onto a second
              line beside a fixed 192px box (report A row 18). */}
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-0 flex-1 items-center bg-muted/50 border border-border rounded-lg px-3">
              <span className="text-sm text-muted-foreground">@</span>
              <input
                type="text"
                value={input}
                onChange={(e) => { setInput(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && saveHandle()}
                className="min-w-0 flex-1 text-[16px] md:text-sm bg-transparent py-2 pl-1 focus:outline-none"
                autoFocus={!isPhoneViewport()}
              />
            </div>
            <button
              onClick={saveHandle}
              disabled={saving}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50"
            >
              {saving ? "..." : t.settings.common.save}
            </button>
            <button
              onClick={() => { setEditing(false); setInput(handle ?? ""); setError(""); }}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t.settings.common.cancel}
            </button>
          </div>
          {error && <p className="text-[12px] text-red-400">{error}</p>}
          <p className="text-[11px] text-muted-foreground">
            {t.settings.account.handleHint}
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono bg-muted/50 px-3 py-2 rounded-lg">
            @{handle ?? t.settings.account.handleLoading}
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => setEditing(true)}
            className="px-0 text-[12px]"
          >
            {t.settings.account.change}
          </Button>
        </div>
      )}
    </div>
  );
}
