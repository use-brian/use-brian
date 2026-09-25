"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { desktopBridge, type DesktopAccount } from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { UserAvatar } from "@/components/ui/user-avatar";
import { confirmDialog } from "@/components/ui/confirm-dialog";

/** One identity list across desktop deployments. [COMP:app-web/desktop-accounts] */
export function DesktopAccounts(props: {
  allowedKeys?: readonly string[];
  onSelect?: (account: DesktopAccount) => Promise<void> | void;
} = {}) {
  const t = useT().workspaceSwitcher;
  const canRemoveConnections = typeof desktopBridge()?.removeAccount === "function";
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

  return (
    <div className="flex flex-col gap-0.5" aria-busy={pending !== null}>
      {accounts.filter((account) => !props.allowedKeys || props.allowedKeys.includes(account.key)).map((account) => {
        const label = account.deployment === "cloud" ? t.deploymentCloud
          : account.deployment === "local" ? t.deploymentLocal : t.deploymentSelfHosted;
        const source = format(t.deploymentSource, { url: account.appUrl });
        const removing = pending === `remove:${account.key}`;
        const selecting = pending === account.key;
        const canRemove = canRemoveConnections && !props.allowedKeys && canSwitch && !account.active && account.deployment !== "cloud";
        return (
          <div key={account.key} className={`flex min-w-0 items-center rounded ${account.active ? "bg-muted/60" : ""}`}>
            <button
              type="button" role="menuitem"
              disabled={pending !== null || !canSwitch}
              aria-current={account.active ? "true" : undefined}
              aria-label={`${account.email || account.name} (${label}, ${account.appUrl})`}
              onClick={() => void select(account)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              <UserAvatar
                size={24}
                name={account.name}
                email={account.email}
                avatarUrl={account.avatarUrl}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-xs">{account.email || account.name || label}</span>
                  <span title={source} className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{label}</span>
                </span>
                <span className="block truncate text-[11px] text-muted-foreground" title={source}>{account.appUrl}</span>
              </span>
              {selecting ? <span aria-hidden className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                : account.active ? <span aria-hidden className="text-primary">✓</span> : null}
            </button>
            {canRemove ? (
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
        );
      })}
      {!props.allowedKeys && !accounts.some((account) => account.deployment === "cloud") && canSwitch && (
        <button type="button" role="menuitem" disabled={pending !== null} onClick={() => void select()}
          className="min-h-11 rounded px-2 py-1.5 text-left text-sm hover:bg-muted">
          {t.openCloudAccount}
        </button>
      )}
      {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
