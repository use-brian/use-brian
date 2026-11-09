"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getAccountsDir } from "@/lib/accounts";
import { desktopBridge, type DesktopSignInState } from "@/lib/desktop-auth-source";
import { useAppSession } from "./app-session";
import { safeAccountReturn } from "@/lib/app-session";
import { primaryAuthUrl, buildDelegatedLoginUrl } from "@/lib/primary-auth";
import { ossSignedOutRedirect } from "@/lib/oss-entry";
import { getUserInfo } from "@/lib/user";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useLocale, useT } from "@/lib/i18n/client";
import { Button } from "./ui/button";
import { DesktopAccounts } from "./desktop-accounts";
import { openDesktopAddAccount } from "./desktop-add-account";
import { Dialog } from "@base-ui/react/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n/config";
import { setLocaleAction } from "@/lib/i18n/set-locale";

function useSignInState() {
  const [state, setState] = useState<DesktopSignInState>({ phase: "idle" });
  useEffect(() => {
    const bridge = desktopBridge(); let live = true;
    void bridge?.getSignInState?.().then(value => { if (live) setState(value); });
    const stop = bridge?.onSignInState?.(setState);
    return () => { live = false; stop?.(); };
  }, []);
  return state;
}
function BrowserSignInProgress({ state }: { state: DesktopSignInState }) {
  const t = useT().desktopSession;
  const busy = state.phase === "exchanging";
  return <div className="space-y-4" aria-busy={busy}>
    <p role={state.phase === "error" ? "alert" : "status"} className="text-sm text-muted-foreground">
      {state.phase === "error" ? t.signInError : busy ? t.finishing : t.browserWaiting}
    </p>
    {state.appUrl && <p className="break-all text-xs text-muted-foreground">{state.appUrl}</p>}
    <div className="flex flex-wrap gap-3">
      <Button className="max-md:min-h-11" variant="outline" disabled={busy} onClick={() => desktopBridge()?.reopenSignIn?.()}>{t.reopenBrowser}</Button>
      <Button className="max-md:min-h-11" variant="ghost" onClick={() => desktopBridge()?.cancelSignIn?.()}>{t.cancel}</Button>
    </div>
  </div>;
}

/** One public account surface across browser and desktop. [COMP:app-web/account-entry] */
export function AccountEntry({ mode = "signed-out", recovery, retry }: {
  mode?: string; recovery?: string; retry?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { state, controller } = useAppSession();
  const auth = useSignInState();
  const native = desktopBridge();
  const selectedOutpost = !!native && publicRuntimeConfig().edition === "outpost";
  const router = useRouter();
  const [browserAccounts] = useState(() => typeof document !== "undefined" ? getAccountsDir() : []);
  const [failed, setFailed] = useState(false);
  const checking = mode === "checking" && state.connection === "online";
  const unavailable = recovery === "unreachable" || mode === "unavailable" || (mode === "checking" && state.connection !== "online");
  const denied = mode === "forbidden" || mode === "missing";
  const reconnect = mode === "reauthenticate";
  const ownerFailure = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("error") === "local_session_failed";
  const message = ownerFailure ? t.workspaceSwitcher.addAccountDialog.authError : recovery ? recovery === "auth" ? t.workspaceSwitcher.addAccountDialog.authError
    : recovery === "access" || recovery === "gateway-auth" ? t.workspaceSwitcher.addAccountDialog.approvalError
      : recovery === "signed-out" ? t.desktopSession.description : t.workspaceSwitcher.addAccountDialog.unreachable
    : denied ? mode === "missing" ? t.desktopSession.missing : t.desktopSession.denied
      : unavailable ? state.connection === "offline" ? t.desktopSession.offline : t.desktopSession.unavailable
        : reconnect ? t.desktopSession.reconnectDescription : t.desktopSession.description;
  const signIn = (cloud = false, addAccount = false) => {
    if (native) {
      let userId = getUserInfo()?.id;
      try { userId ??= state.identity ? JSON.parse(state.identity)[2] : undefined; } catch {}
      if (cloud && native.addAccount) native.addAccount();
      else native.signIn({ userId });
      return;
    }
    const path = window.location.pathname === "/accounts"
      ? new URLSearchParams(window.location.search).get("next")
      : window.location.pathname + window.location.search + window.location.hash;
    const next = safeAccountReturn(path, window.location.origin);
    const owner = ossSignedOutRedirect(next);
    const primary = primaryAuthUrl();
    if (owner) window.location.assign(owner);
    else if (primary) window.location.assign(buildDelegatedLoginUrl(primary, new URL(next, window.location.origin).href, { addAccount }));
    else setFailed(true);
  };
  const connectServer = async () => {
    let address: string | undefined;
    try { address = (await native?.listAccounts?.())?.localAppUrl; } catch {}
    openDesktopAddAccount(address || "http://localhost:3003");
  };
  const retryEntry = () => {
    if (recovery && native?.retry) native.retry(); else if (retry) retry(); else void controller.check();
  };
  return <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <header className="flex h-14 shrink-0 items-center justify-end px-4" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <div data-no-drag style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <Select value={locale} items={LOCALE_LABELS} onValueChange={value => {
          if (!value || value === locale) return;
          const form = new FormData(); form.set("locale", value); form.set("path", window.location.pathname);
          void setLocaleAction(form);
        }}>
          <SelectTrigger aria-label={t.settings.general.language} className="min-h-11 min-w-28 text-[16px] md:min-h-8 md:text-sm"><SelectValue /></SelectTrigger>
          <SelectContent align="end">{LOCALES.map(value => <SelectItem key={value} value={value} className="min-h-11 md:min-h-8">{LOCALE_LABELS[value]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </header>
    <section className="mx-2 mb-2 flex min-h-0 flex-1 items-start justify-center overflow-y-auto rounded-2xl border border-border bg-card px-4 py-8 sm:px-8">
      <div className="my-auto w-full max-w-md space-y-6">
        <div className="space-y-2"><h1 className="text-2xl font-semibold">{t.desktopSession.title}</h1>
          {!checking && auth.phase === "idle" && <p className="text-sm leading-relaxed text-muted-foreground" role={denied || unavailable || recovery && recovery !== "signed-out" ? "alert" : undefined}>{message}</p>}
        </div>
        {checking ? <div aria-busy="true" aria-label={t.desktopSession.checking} className="h-40 animate-pulse rounded-xl bg-muted" />
          : auth.phase !== "idle" ? <BrowserSignInProgress state={auth} /> : <>
            {native ? <DesktopAccounts variant="standalone" /> : <div className="space-y-2">
              {browserAccounts.map(account => <Button key={account.id} variant="outline" className="max-md:min-h-11 w-full justify-start" onClick={() => {
                const primary = primaryAuthUrl(); if (!primary) { signIn(false, true); return; }
                const url = new URL("/api/auth/switch-account-and-return", primary);
                url.searchParams.set("accountId", account.id);
                const path = new URLSearchParams(window.location.search).get("next") ?? window.location.pathname + window.location.search;
                url.searchParams.set("next", new URL(safeAccountReturn(path, window.location.origin), window.location.origin).href);
                window.location.assign(url.href);
              }}>{account.email || account.name}</Button>)}
            </div>}
            <div className="flex flex-wrap gap-3">
              {unavailable && <Button className="max-md:min-h-11" onClick={retryEntry}>{t.desktopSession.retry}</Button>}
              {reconnect && <Button className="max-md:min-h-11" onClick={() => signIn()}>{t.desktopSession.reconnect}</Button>}
              {!unavailable && !denied && !reconnect && <Button className="max-md:min-h-11" onClick={() => signIn(!selectedOutpost && (!recovery || recovery === "signed-out"))}>{native && !selectedOutpost ? t.workspaceSwitcher.addAccountDialog.cloud : t.desktopSession.signIn}</Button>}
              {selectedOutpost && !unavailable && !denied && !reconnect && <Button className="max-md:min-h-11" variant="outline" onClick={() => signIn(true)}>{t.workspaceSwitcher.addAccountDialog.cloud}</Button>}
              {native && !denied && !reconnect && <Button className="max-md:min-h-11" variant="outline" onClick={() => void connectServer()}>{t.desktopSession.connectServer}</Button>}
              {(denied || state.session === "authenticated") && <Button className="max-md:min-h-11" variant="outline" onClick={() => router.push("/teams")}>{t.desktopSession.chooseWorkspace}</Button>}
              {(!native || denied || reconnect) && <Button className="max-md:min-h-11" variant="ghost" onClick={() => native ? openDesktopAddAccount() : signIn(false, true)}>{t.desktopSession.switchAccount}</Button>}
              {!unavailable && (recovery && recovery !== "signed-out" || denied) && <Button className="max-md:min-h-11" variant="ghost" onClick={retryEntry}>{t.desktopSession.retry}</Button>}
            </div>
            {failed && <p role="alert" className="text-sm text-destructive">{t.desktopSession.signInError}</p>}
          </>}
      </div>
    </section>
  </main>;
}

/** Add-account authentication uses the same progress view while the current session remains intact. */
export function AccountSignInDialog() {
  const { state } = useAppSession();
  const auth = useSignInState();
  const t = useT().desktopSession;
  const path = usePathname();
  const workspaceId = /^\/w\/([^/]+)/.exec(path)?.[1] ?? /^\/desktop\/chat\/([^/]+)/.exec(path)?.[1];
  const explicitEntry = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("accountEntry") && path === "/";
  const open = path !== "/accounts" && !explicitEntry && state.session === "authenticated" && (!workspaceId || state.admissions[workspaceId]?.kind === "allowed") && auth.phase !== "idle";
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) desktopBridge()?.cancelSignIn?.(); }}>
    <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-[70] bg-background/80 backdrop-blur-sm" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-[70] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 space-y-5 rounded-2xl border border-border bg-background p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">{t.signIn}</Dialog.Title>
        <Dialog.Description className="sr-only">{t.browserWaiting}</Dialog.Description>
        <BrowserSignInProgress state={auth} />
      </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
