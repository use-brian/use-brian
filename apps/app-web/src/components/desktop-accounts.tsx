"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, SmilePlus, Trash2, Upload } from "lucide-react";
import { desktopBridge, type DesktopAccount } from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { UserAvatar } from "@/components/ui/user-avatar";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { confirmDialog } from "@/components/ui/confirm-dialog";

/** One identity list across desktop deployments. [COMP:app-web/desktop-accounts] */
export function DesktopAccounts(props: {
  allowedKeys?: readonly string[];
  onSelect?: (account: DesktopAccount) => Promise<void> | void;
} = {}) {
  const t = useT().workspaceSwitcher;
  const canRemoveConnections = typeof desktopBridge()?.removeAccount === "function";
  const canCustomize = !props.allowedKeys && typeof desktopBridge()?.updateAccountPresentation === "function" &&
    typeof desktopBridge()?.moveAccount === "function";
  const [customizing, setCustomizing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [icon, setIcon] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [accounts, setAccounts] = useState<DesktopAccount[]>([]);
  const [canSwitch, setCanSwitch] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void desktopBridge()?.listAccounts?.().then((result) => {
      if (!live) return;
      setAccounts(result.accounts);
      setCanSwitch(result.canSwitch);
    }).catch(() => { if (live) setError(t.switchError); });
    return () => { live = false; };
  }, [t.switchError]);

  async function select(account?: DesktopAccount) {
    if (pending || !canSwitch || account?.active) return;
    setPending(account?.key ?? "cloud");
    setError(null);
    try {
      if (account && props.onSelect) {
        await props.onSelect(account);
        return;
      }
      const bridge = desktopBridge();
      const result = account ? await bridge?.selectAccount?.(account.key) : await bridge?.selectCloud?.();
      if (!result?.ok) {
        const expired = result && "error" in result && result.error === "reauth";
        setError(expired ? t.accountSessionExpired : t.switchError);
        if (expired && account) setAccounts((rows) => rows.filter((row) => row.key !== account.key));
      }
    } catch { setError(t.switchError); }
    finally { setPending(null); }
  }

  async function remove(account: DesktopAccount) {
    if (pending || !canSwitch || account.active || account.deployment === "cloud") return;
    const confirmed = await confirmDialog({
      title: t.removeConnectionTitle,
      description: format(t.removeConnectionDescription, { url: account.appUrl }),
      confirmLabel: t.removeConnectionConfirm,
      cancelLabel: t.addAccountDialog.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    setPending(`remove:${account.key}`);
    setError(null);
    try {
      const result = await desktopBridge()?.removeAccount?.(account.key);
      if (!result?.ok) {
        setError(t.removeConnectionError);
        return;
      }
      setAccounts((current) => current.filter((row) => row.key !== account.key));
    } catch {
      setError(t.removeConnectionError);
    } finally {
      setPending(null);
    }
  }

  async function uploadIcon(file: File) {
    if (pending || !editing) return;
    setError(null);
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError(t.accountImageError);
      return;
    }
    setPending(`image:${editing}`);
    let url: string | undefined;
    try {
      url = URL.createObjectURL(file);
      const image = new Image();
      image.src = url;
      await image.decode();
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      if (!side) throw new Error("Empty image");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
      const data = canvas.toDataURL("image/png");
      if (!data.startsWith("data:image/png;base64,") || data.length > 128 * 1024) throw new Error("Invalid image");
      setIcon(data);
    } catch { setError(t.accountImageError); }
    finally { if (url) URL.revokeObjectURL(url); setPending(null); }
  }

  async function customize(account: DesktopAccount, direction?: "up" | "down") {
    if (pending) return;
    setPending(`customize:${account.key}`);
    setError(null);
    try {
      const bridge = desktopBridge();
      const result = direction
        ? await bridge?.moveAccount?.(account.key, direction)
        : await bridge?.updateAccountPresentation?.(account.key, { displayName, icon });
      if (!result?.ok) { setError(t.customizeError); return; }
      setAccounts(result.accounts);
      if (!direction) setEditing(null);
    } catch { setError(t.customizeError); }
    finally { setPending(null); }
  }

  return (
    <div className="flex flex-col gap-0.5" aria-busy={pending !== null}>
      {accounts.filter((account) => !props.allowedKeys || props.allowedKeys.includes(account.key)).map((account, index) => {
        const label = account.deployment === "cloud" ? t.deploymentCloud
          : account.deployment === "local" ? t.deploymentLocal : t.deploymentSelfHosted;
        const source = format(t.deploymentSource, { url: account.appUrl });
        const removing = pending === `remove:${account.key}`;
        const selecting = pending === account.key;
        const canRemove = canRemoveConnections && !props.allowedKeys && canSwitch && !account.active && account.deployment !== "cloud";
        return (
          <div key={account.key} className="min-w-0">
            <div className={`flex min-w-0 rounded ${customizing ? "flex-col items-stretch" : "items-center"} ${account.active ? "bg-muted/60" : ""}`}>
              <button
                type="button" role="menuitem"
                disabled={pending !== null || !canSwitch || customizing}
                aria-current={account.active ? "true" : undefined}
                aria-label={`${account.displayName || account.email || account.name} (${label}, ${account.appUrl})`}
                onClick={() => void select(account)}
                className="flex min-h-8 max-sm:min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
              >
                {account.icon?.startsWith("data:image/png;base64,") ? <UserAvatar key={account.icon} size={24} name={account.name} avatarUrl={account.icon} /> : account.icon ? <span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-xl">{account.icon}</span> : <UserAvatar
                  size={24}
                  name={account.name}
                  email={account.email}
                  avatarUrl={account.avatarUrl}
                />}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs">{account.displayName || account.email || account.name || label}</span>
                    <span title={source} className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${account.deployment === "cloud" ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300" : "border-border bg-muted text-muted-foreground"}`}>{label}</span>
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground" title={source}>{account.appUrl}</span>
                </span>
                {selecting ? <span aria-hidden className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                  : account.active ? <span aria-hidden className="text-primary">✓</span> : null}
              </button>
              {customizing && canCustomize ? (
                <div className="flex shrink-0 items-center justify-end px-1">
                  <button type="button" disabled={pending !== null} aria-label={format(t.editAccount, { name: account.displayName || account.email || account.name || label })}
                    onClick={() => { setEditing(account.key); setDisplayName(account.displayName ?? ""); setIcon(account.icon ?? ""); setError(null); }}
                    className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50 sm:size-7">
                    <Pencil aria-hidden className="size-3.5" />
                  </button>
                  <button type="button" disabled={pending !== null || index === 0} aria-label={format(t.moveAccountUp, { name: account.displayName || account.email || account.name || label })}
                    onClick={() => void customize(account, "up")}
                    className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50 sm:size-7">
                    <ArrowUp aria-hidden className="size-3.5" />
                  </button>
                  <button type="button" disabled={pending !== null || index === accounts.length - 1} aria-label={format(t.moveAccountDown, { name: account.displayName || account.email || account.name || label })}
                    onClick={() => void customize(account, "down")}
                    className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50 sm:size-7">
                    <ArrowDown aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {canRemove && !customizing ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={pending !== null}
                  aria-label={format(t.removeConnectionAria, { url: account.appUrl })}
                  title={t.removeConnection}
                  onClick={() => void remove(account)}
                  className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:size-8"
                >
                  {removing
                    ? <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                    : <Trash2 aria-hidden className="size-3.5" />}
                </button>
              ) : null}
            </div>
            {customizing && editing === account.key && (
              <form onSubmit={(event) => { event.preventDefault(); void customize(account); }} className="mx-1 mb-1 space-y-2 rounded-lg border border-border bg-background p-2">
                <label htmlFor={`account-name-${account.key}`} className="block text-xs font-medium text-muted-foreground">{t.accountDisplayName}</label>
                <div className="flex items-center gap-1.5">
                  <EmojiPicker onPick={(value) => { if (!pending) setIcon(value ?? ""); }} trigger={
                    <Button type="button" variant="outline" size="icon" disabled={pending !== null}
                      aria-label={t.accountIcon} title={t.accountIcon} className="max-sm:size-11">
                      {icon.startsWith("data:image/png;base64,") ? <UserAvatar key={icon} size={24} name={account.name} avatarUrl={icon} /> : icon ? <span aria-hidden className="text-base leading-none">{icon}</span> : <SmilePlus aria-hidden className="text-muted-foreground" />}
                    </Button>
                  } />
                  <input id={`account-name-${account.key}`} autoFocus value={displayName} maxLength={80} disabled={pending !== null}
                    placeholder={account.email || account.name || label} onChange={(event) => setDisplayName(event.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-[16px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:min-h-11 md:text-xs" />
                </div>
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label={t.uploadAccountImage} disabled={pending !== null}
                  onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadIcon(file); }} />
                <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => fileInput.current?.click()} className="max-sm:min-h-11">
                  <Upload aria-hidden className="size-3.5" />{t.uploadAccountImage}
                </Button>
                <p className="text-[11px] leading-snug text-muted-foreground">{t.accountImageHint}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">{t.customizeHint}</p>
                <div className="flex items-center justify-end gap-1">
                  {icon && <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={() => setIcon("")} className="mr-auto text-muted-foreground">{t.resetAccountIcon}</Button>}
                  <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={() => setEditing(null)}>{t.addAccountDialog.cancel}</Button>
                  <Button type="submit" size="sm" disabled={pending !== null}>{t.saveAccount}</Button>
                </div>
              </form>
            )}
          </div>
        );
      })}
      {!props.allowedKeys && !accounts.some((account) => account.deployment === "cloud") && canSwitch && (
        <button type="button" role="menuitem" disabled={pending !== null} onClick={() => void select()}
          className="min-h-8 max-sm:min-h-11 rounded px-2 py-1.5 text-left text-sm hover:bg-muted">
          {t.openCloudAccount}
        </button>
      )}
      {canCustomize && accounts.length > 0 && (
        <button type="button" disabled={pending !== null} aria-pressed={customizing}
          onClick={() => { setCustomizing(!customizing); setEditing(null); setError(null); }}
          className="min-h-8 max-sm:min-h-11 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted">
          {customizing ? t.customizeDone : t.customizeAccounts}
        </button>
      )}
      {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
