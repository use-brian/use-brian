"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
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
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
              >
                {account.icon ? <span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-xl">{account.icon}</span> : <UserAvatar
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
                    className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50">
                    <Pencil aria-hidden className="size-3.5" />
                  </button>
                  <button type="button" disabled={pending !== null || index === 0} aria-label={format(t.moveAccountUp, { name: account.displayName || account.email || account.name || label })}
                    onClick={() => void customize(account, "up")}
                    className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50">
                    <ArrowUp aria-hidden className="size-3.5" />
                  </button>
                  <button type="button" disabled={pending !== null || index === accounts.length - 1} aria-label={format(t.moveAccountDown, { name: account.displayName || account.email || account.name || label })}
                    onClick={() => void customize(account, "down")}
                    className="flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50">
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
              <form onSubmit={(event) => { event.preventDefault(); void customize(account); }} className="space-y-2 rounded border border-border p-2">
                <p className="text-xs text-muted-foreground">{t.customizeHint}</p>
                <label className="block text-xs">
                  {t.accountDisplayName}
                  <input autoFocus value={displayName} maxLength={80} disabled={pending !== null}
                    placeholder={account.email || account.name || label} onChange={(event) => setDisplayName(event.target.value)}
                    className="mt-1 min-h-11 w-full rounded border border-border bg-background px-2 text-base" />
                </label>
                <div className="flex items-center gap-2">
                  <EmojiPicker onPick={(value) => setIcon(value ?? "")} trigger={
                    <button type="button" disabled={pending !== null} className="flex min-h-11 items-center gap-2 rounded border border-border px-3 text-sm">
                      {icon && <span aria-hidden>{icon}</span>}{t.accountIcon}
                    </button>
                  } />
                  {icon && <button type="button" disabled={pending !== null} onClick={() => setIcon("")} className="min-h-11 rounded px-2 text-sm hover:bg-muted">{t.resetAccountIcon}</button>}
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={pending !== null} onClick={() => setEditing(null)} className="min-h-11 rounded px-3 text-sm hover:bg-muted">{t.addAccountDialog.cancel}</button>
                  <Button type="submit" disabled={pending !== null} className="min-h-11">{t.saveAccount}</Button>
                </div>
              </form>
            )}
          </div>
        );
      })}
      {!props.allowedKeys && !accounts.some((account) => account.deployment === "cloud") && canSwitch && (
        <button type="button" role="menuitem" disabled={pending !== null} onClick={() => void select()}
          className="min-h-11 rounded px-2 py-1.5 text-left text-sm hover:bg-muted">
          {t.openCloudAccount}
        </button>
      )}
      {canCustomize && accounts.length > 0 && (
        <button type="button" disabled={pending !== null} aria-pressed={customizing}
          onClick={() => { setCustomizing(!customizing); setEditing(null); setError(null); }}
          className="min-h-11 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted">
          {customizing ? t.customizeDone : t.customizeAccounts}
        </button>
      )}
      {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
