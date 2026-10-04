"use client";

import { useEffect, useMemo, useState } from "react";
import { DesktopAccounts } from "@/components/desktop-accounts";
import {
  DesktopAddAccountProvider,
  onDesktopAccountConnected,
  openDesktopAddAccount,
} from "@/components/desktop-add-account";
import { Button } from "@/components/ui/button";
import {
  desktopBridge,
  type DesktopLinkNavigationState,
} from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";

/** Shared authenticated-overlay and local recovery host. [COMP:app-web/desktop-link-recovery] */
export function DesktopLinkRecovery() {
  const t = useT().internalLinks;
  const [state, setState] = useState<DesktopLinkNavigationState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const bridge = desktopBridge();
    let live = true;
    void bridge?.getLinkNavigation?.().then((value) => { if (live) setState(value); });
    const stopState = bridge?.onLinkNavigation?.((value) => setState(value));
    const stopDelivery = bridge?.onLinkNavigationDelivery?.((requestId) => {
      void bridge.linkNavigationAction?.(requestId, "acknowledge");
    });
    const stopConnected = onDesktopAccountConnected(() => {
      setState((current) => {
        if (current) void bridge?.linkNavigationAction?.(current.requestId, "retry");
        return current;
      });
    });
    return () => {
      live = false;
      stopState?.();
      stopDelivery?.();
      stopConnected();
    };
  }, []);

  const message = useMemo(() => {
    if (!state) return "";
    const messages: Record<DesktopLinkNavigationState["phase"], string> = {
      received: t.received,
      "choose-deployment": t.chooseDeployment,
      "choose-account": t.chooseAccount,
      connect: t.connect,
      authorizing: t.authorizing,
      reauthenticate: t.reauthenticate,
      denied: t.denied,
      unreachable: t.unreachable,
      blocked: t.blocked,
      delivering: t.delivering,
      expired: t.expired,
    };
    return messages[state.phase];
  }, [state, t]);

  if (!state) return <DesktopAddAccountProvider />;

  const act = async (
    action: "choose" | "retry" | "browser" | "cancel",
    key?: string,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await desktopBridge()?.linkNavigationAction?.(state.requestId, action, key);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (state.appOrigin === "https://app.usebrian.ai") {
      setBusy(true);
      try { await desktopBridge()?.selectCloud?.(); }
      finally { setBusy(false); }
      return;
    }
    openDesktopAddAccount(state.appOrigin);
  };

  return (
    <>
      <div className="fixed inset-0 z-[90] grid min-h-dvh place-items-center bg-background/90 p-4 backdrop-blur-sm">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-link-recovery-title"
          aria-busy={busy || ["received", "authorizing", "delivering"].includes(state.phase)}
          className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl sm:p-6"
        >
          <h1 id="desktop-link-recovery-title" className="text-lg font-semibold">{t.recoveryTitle}</h1>
          <p className="mt-2 break-all text-xs text-muted-foreground">{state.appOrigin}</p>
          <p role="status" className="mt-4 text-sm leading-relaxed">{message}</p>

          {state.phase === "choose-account" && (
            <div className="-mx-2 mt-4">
              <DesktopAccounts
                allowedKeys={state.choices.map((choice) => choice.key)}
                onSelect={(account) => act("choose", account.key)}
              />
            </div>
          )}
          {state.phase === "choose-deployment" && (
            <div className="mt-4 grid gap-2">
              {state.choices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  disabled={busy}
                  onClick={() => void act("choose", choice.key)}
                  className="max-sm:min-h-11 rounded-xl border border-border px-3 py-2 text-left hover:bg-muted disabled:opacity-60"
                >
                  <span className="block text-sm font-medium">{choice.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{choice.detail}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-6 flex flex-wrap justify-end gap-2">
            {state.canCancel && <Button variant="ghost" disabled={busy} onClick={() => void act("cancel")}>{t.cancel}</Button>}
            {state.canOpenBrowser && <Button variant="outline" disabled={busy} onClick={() => void act("browser")}>{t.openBrowser}</Button>}
            {(state.phase === "connect" || state.phase === "reauthenticate") && (
              <Button disabled={busy} onClick={() => void connect()}>{t.connectAction}</Button>
            )}
            {state.canRetry && state.phase !== "reauthenticate" && (
              <Button disabled={busy} onClick={() => void act("retry")}>{t.retry}</Button>
            )}
          </div>
        </section>
      </div>
      <DesktopAddAccountProvider />
    </>
  );
}
