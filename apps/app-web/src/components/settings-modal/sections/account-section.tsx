"use client";

// Ported from apps/web/src/app/(app)/settings/account/page.tsx
// (AccountPage → AccountSection). The earlier app-web port was a thinner
// stub (initials bubble, no name-save, no avatar upload); this gap-fills it
// to parity with apps/web — see docs/architecture/features/doc.md §5a.

import { useState, useEffect, useRef } from "react";
import {
  getUserInfo,
  getCachedUserInfo,
  setUserInfoCache,
  type UserInfo,
} from "@/lib/user";
import { authFetch } from "@/lib/auth-fetch";
import { signOutActiveAccount } from "@/lib/account-logout";
import { useT } from "@/lib/i18n/client";
import { UserAvatar } from "@/components/ui/user-avatar";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  updateDisplayName,
  uploadAvatar,
  removeAvatar,
  listLinkedAccounts,
  unlinkAccount,
  createTelegramLinkCode,
  MAX_AVATAR_BYTES,
  type LinkedAccount,
  type TelegramLinkCode,
} from "@/lib/api/account";
import {
  buildTelegramDeepLink,
  linkCodeSecondsLeft,
  formatCountdown,
} from "@/lib/telegram-link";
import { format } from "@/lib/i18n/format";
import { isOssEdition } from "@/lib/edition";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** A transient status banner: success or error feedback after an action. */
type Status = { kind: "success" | "error"; text: string } | null;

export function AccountSection() {
  const t = useT();
  const [userInfo, setUserInfo] = useState<UserInfo | null>(getCachedUserInfo);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const info = getUserInfo();
    if (info) {
      setUserInfo(info);
      setName(info.name ?? "");
    }
  }, []);

  const displayLabel = userInfo?.name || userInfo?.email || "";

  /**
   * Re-pull the `user` cookie via the refresh bridge (which now carries
   * `avatarUrl`) so the sidebar + switcher update without a full reload, then
   * sync the module cache + local state. Returns the fresh info, if any.
   */
  async function refreshUserInfo(): Promise<UserInfo | null> {
    await fetch("/api/auth/refresh", { method: "POST" });
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
      const ok = await uploadAvatar(file);
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
      await refreshUserInfo();
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
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || removing}
              className="text-[12px] text-primary hover:underline disabled:opacity-50"
            >
              {uploading ? t.settings.common.save + "…" : t.settings.account.changePhoto}
            </button>
            {hasAvatar && (
              <button
                type="button"
                onClick={onRemovePhoto}
                disabled={uploading || removing}
                className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {t.settings.account.removePhoto}
              </button>
            )}
          </div>
        </div>
      </div>

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
                className="flex-1 text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 disabled:opacity-60"
              />
              {!isOssEdition() && (
                <button
                  type="button"
                  onClick={onSaveName}
                  disabled={!nameDirty || savingName}
                  className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
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
                defaultValue={userInfo?.email ?? ""}
                disabled
                className="w-full text-sm bg-muted border border-border rounded-lg px-3 py-2 text-muted-foreground"
              />
            </div>
          )}
        </div>
      </div>

      <HandleSection />

      <ConnectedAccountsSection />

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

/**
 * Connected accounts — the personal Telegram link to the official bot.
 *
 * Connect mints a 6-char code (`POST /api/account/telegram/link-code`,
 * bound server-side to the first-owned assistant) and renders a t.me deep
 * link; the section then polls the linked-accounts list until the bot
 * redeems the code. Connecting a Telegram that is linked to another
 * account MOVES it here (upsert on provider identity). Disconnect calls
 * `DELETE /api/account/linked-accounts/:id` behind a confirmDialog.
 * See docs/architecture/platform/auth.md → "Linked accounts".
 * Component tag: [COMP:app-web/telegram-link].
 */
type TelegramLinkState =
  | { kind: "loading" }
  | { kind: "unlinked" }
  | { kind: "linked"; account: LinkedAccount }
  | { kind: "connecting"; code: TelegramLinkCode };

function ConnectedAccountsSection() {
  const t = useT();
  const [state, setState] = useState<TelegramLinkState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Status>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void listLinkedAccounts().then((accounts) => {
      if (cancelled) return;
      const tg = accounts.find((a) => a.provider === "telegram");
      setState(tg ? { kind: "linked", account: tg } : { kind: "unlinked" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // While a code is pending: 1s countdown tick + 3s poll for the bot-side
  // redemption. Both stop when the section leaves the connecting state;
  // the poll also stops firing once the code expires.
  useEffect(() => {
    if (state.kind !== "connecting") return;
    const expiresAt = state.code.expiresAt;
    setSecondsLeft(linkCodeSecondsLeft(expiresAt));
    const tick = setInterval(() => {
      setSecondsLeft(linkCodeSecondsLeft(expiresAt));
    }, 1000);
    const poll = setInterval(() => {
      if (linkCodeSecondsLeft(expiresAt) <= 0) return;
      void listLinkedAccounts().then((accounts) => {
        const tg = accounts.find((a) => a.provider === "telegram");
        if (tg) {
          setState({ kind: "linked", account: tg });
          setNotice({ kind: "success", text: t.settings.account.telegramLinked });
        }
      });
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [state, t]);

  async function onConnect() {
    setBusy(true);
    setNotice(null);
    try {
      const code = await createTelegramLinkCode();
      if (!code) {
        setNotice({ kind: "error", text: t.settings.account.connectError });
        return;
      }
      setState({ kind: "connecting", code });
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (state.kind !== "linked") return;
    const ok = await confirmDialog({
      title: t.settings.account.disconnectTelegramTitle,
      description: t.settings.account.disconnectTelegramConfirm,
      confirmLabel: t.settings.account.disconnect,
      cancelLabel: t.settings.common.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      const removed = await unlinkAccount(state.account.id);
      if (!removed) {
        setNotice({ kind: "error", text: t.settings.account.connectError });
        return;
      }
      setState({ kind: "unlinked" });
      setNotice({ kind: "success", text: t.settings.account.telegramUnlinked });
    } finally {
      setBusy(false);
    }
  }

  const linkedName =
    state.kind === "linked" &&
    typeof state.account.providerMetadata?.firstName === "string"
      ? (state.account.providerMetadata.firstName as string)
      : null;

  const deepLink =
    state.kind === "connecting"
      ? buildTelegramDeepLink(state.code.botUsername, state.code.code)
      : null;
  const expired = state.kind === "connecting" && secondsLeft <= 0;

  return (
    <div className="border-t border-border pt-6 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
        {t.settings.account.connectedAccounts}
      </h3>
      <p className="text-[12px] text-muted-foreground">
        {t.settings.account.connectedAccountsDesc}
      </p>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t.settings.account.telegram}</div>
          <div className="text-xs text-muted-foreground truncate">
            {state.kind === "loading" && t.settings.common.loading}
            {state.kind === "unlinked" && t.settings.account.notConnected}
            {state.kind === "connecting" && t.settings.account.notConnected}
            {state.kind === "linked" &&
              (linkedName
                ? format(t.settings.account.telegramConnectedAs, { name: linkedName })
                : t.settings.account.telegramConnected)}
          </div>
        </div>
        {state.kind === "unlinked" && (
          <button
            type="button"
            onClick={() => void onConnect()}
            disabled={busy}
            className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "…" : t.settings.account.connect}
          </button>
        )}
        {state.kind === "linked" && (
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={busy}
            className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          >
            {busy ? "…" : t.settings.account.disconnect}
          </button>
        )}
      </div>

      {state.kind === "connecting" && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <div className="text-2xl font-mono tracking-[0.3em] text-center select-all">
            {state.code.code}
          </div>
          <p className="text-[12px] text-muted-foreground">
            {t.settings.account.connectTelegramHint}
          </p>
          <div className="flex items-center gap-3">
            {deepLink && !expired && (
              <a
                href={deepLink}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t.settings.account.openTelegram}
              </a>
            )}
            {expired && (
              <button
                type="button"
                onClick={() => void onConnect()}
                disabled={busy}
                className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? "…" : t.settings.account.generateNewCode}
              </button>
            )}
            <button
              type="button"
              onClick={() => setState({ kind: "unlinked" })}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t.settings.common.cancel}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {expired
              ? t.settings.account.codeExpired
              : format(t.settings.account.codeExpiresIn, {
                  time: formatCountdown(secondsLeft),
                })}
          </p>
        </div>
      )}

      {notice && (
        <p
          className={
            notice.kind === "success"
              ? "text-[12px] text-primary"
              : "text-[12px] text-red-400"
          }
        >
          {notice.text}
        </p>
      )}
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
          <div className="flex gap-2">
            <div className="flex items-center bg-muted/50 border border-border rounded-lg px-3">
              <span className="text-sm text-muted-foreground">@</span>
              <input
                type="text"
                value={input}
                onChange={(e) => { setInput(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && saveHandle()}
                className="text-sm bg-transparent py-2 pl-1 focus:outline-none w-48"
                autoFocus
              />
            </div>
            <button
              onClick={saveHandle}
              disabled={saving}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
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
          <button
            onClick={() => setEditing(true)}
            className="text-[12px] text-primary hover:underline"
          >
            {t.settings.account.change}
          </button>
        </div>
      )}
    </div>
  );
}
