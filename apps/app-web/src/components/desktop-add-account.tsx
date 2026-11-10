"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Cloud, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";
import { requestSidebarClose } from "@/lib/sidebar-close";

const OPEN_EVENT = "brian:desktop-add-account";
const CONNECTED_EVENT = "brian:desktop-account-connected";
const DEFAULT_URL = "http://localhost:3003";

/** Shared in-app account entry. [COMP:app-web/desktop-add-account] */
export function openDesktopAddAccount(url?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: url }));
}

export function onDesktopAccountConnected(callback: () => void): () => void {
  window.addEventListener(CONNECTED_EVENT, callback);
  return () => window.removeEventListener(CONNECTED_EVENT, callback);
}

/** Mounted at both app roots so native menu actions also work on /teams. */
export function DesktopAddAccountProvider() {
  const t = useT().workspaceSwitcher.addAccountDialog;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choose" | "self-hosted">("choose");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<"checking" | "browser" | "approved">("checking");
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const edited = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.runLocal) return;
    const show = (address?: string) => {
      if (busyRef.current) return;
      const attempt = ++generation.current;
      edited.current = false;
      setUrl(address ?? "");
      setStep(address ? "self-hosted" : "choose");
      setError(null);
      setOpen(true);
      requestSidebarClose();
      if (!address) void bridge.listAccounts?.().then((result) => {
        if (generation.current === attempt && !edited.current) setUrl(result.localAppUrl ?? "");
      }).catch(() => { /* An optional remembered address must not block entry. */ });
    };
    const onOpen = (event: Event) => show(
      event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : undefined,
    );
    window.addEventListener(OPEN_EVENT, onOpen);
    const unsubscribe = bridge.onChooseDeployment?.((address) => show(address));
    const stopProgress = bridge.onAccessAuthState?.((state) => {
      if (busyRef.current) setProgress(state);
    });
    return () => {
      generation.current++;
      window.removeEventListener(OPEN_EVENT, onOpen);
      unsubscribe?.();
      stopProgress?.();
    };
  }, []);

  useEffect(() => {
    if (open && step === "self-hosted") inputRef.current?.focus();
  }, [open, step]);

  function close() {
    if (busyRef.current) return;
    generation.current++;
    setOpen(false);
  }

  async function connect() {
    if (busyRef.current) return;
    const address = url.trim() || DEFAULT_URL;
    try {
      const parsed = new URL(address);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch { setError(t.invalidUrl); return; }
    const runLocal = desktopBridge()?.runLocal;
    if (!runLocal) { setError(t.connectionError); return; }
    const attempt = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress("checking");
    try {
      const result = await runLocal(address);
      if (generation.current !== attempt) return;
      if (result.ok) {
        setOpen(false);
        window.dispatchEvent(new Event(CONNECTED_EVENT));
        return;
      }
      const errors: Record<string, string> = {
        "invalid-url": t.invalidUrl,
        "env-override": t.envOverride,
        "unreachable": t.unreachable,
        "auth": t.authError,
        "gateway-auth": t.approvalError,
        "access-auth-failed": t.approvalError,
        "access-oauth-unavailable": t.gatewaySetupError,
        "access-oauth-misconfigured": t.gatewaySetupError,
        "secure-storage-unavailable": t.secureStorageError,
        "switch": t.switchError,
      };
      setError(errors[result.error] ?? t.connectionError);
    } catch { if (generation.current === attempt) setError(t.connectionError); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-6 text-foreground shadow-xl">
          <Dialog.Title className="text-lg font-semibold">{t.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {step === "choose" ? t.description : t.selfHostedDescription}
          </Dialog.Description>
          {step === "choose" ? (
            <div className="mt-5 grid gap-3">
              <button type="button" onClick={() => { desktopBridge()?.addAccount?.(); close(); }}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                <Cloud aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span><span className="block text-sm font-medium">{t.cloud}</span><span className="mt-1 block text-xs text-muted-foreground">{t.cloudDescription}</span></span>
              </button>
              <button type="button" onClick={() => setStep("self-hosted")}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                <Server aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span><span className="block text-sm font-medium">{t.selfHosted}</span><span className="mt-1 block text-xs text-muted-foreground">{t.selfHostedDescription}</span></span>
              </button>
              <Button variant="ghost" onClick={close}>{t.cancel}</Button>
            </div>
          ) : (
            <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void connect(); }} aria-busy={busy}>
              <label className="block space-y-2 text-sm font-medium">
                <span>{t.serverAddress}</span>
                <input ref={inputRef} type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={url} onChange={(event) => { edited.current = true; setUrl(event.target.value); setError(null); }}
                  placeholder={DEFAULT_URL} disabled={busy} aria-invalid={!!error} aria-describedby={error ? "desktop-account-error" : undefined}
                  className="h-11 w-full rounded-lg border border-border bg-background px-3 text-[16px] font-normal outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-60 md:text-sm" />
              </label>
              {busy && <p role="status" className="text-sm text-muted-foreground">{progress === "browser" ? t.browserApproval : progress === "approved" ? t.finishing : t.connecting}</p>}
              {error && <p id="desktop-account-error" role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-between gap-3">
                <Button type="button" variant="ghost" disabled={busy} onClick={() => { setStep("choose"); setError(null); }}>{t.back}</Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" disabled={busy} onClick={close}>{t.cancel}</Button>
                  <Button type="submit" disabled={busy}>{busy ? t.connecting : t.connect}</Button>
                </div>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
