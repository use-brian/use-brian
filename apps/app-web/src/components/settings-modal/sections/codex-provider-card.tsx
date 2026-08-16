"use client";

/**
 * OSS ChatGPT subscription provider card.
 *
 * Browser/device login handoffs come from the local API's validated Codex
 * routes. The card polls masked status after handoff; no token or raw account
 * object reaches the browser.
 *
 * [COMP:app-web/codex-provider]
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import {
  disconnectCodex,
  getCodexProviderStatus,
  startCodexBrowserLogin,
  startCodexDeviceLogin,
  type BrowserLogin,
  type CodexProviderStatus,
  type DeviceCodeLogin,
} from "@/lib/api/codex-provider";

export function CodexProviderCard() {
  const t = useT().chrome.settingsModal.codexProvider;
  const [status, setStatus] = useState<CodexProviderStatus | null>(null);
  const [browserLogin, setBrowserLogin] = useState<BrowserLogin | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<DeviceCodeLogin | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await getCodexProviderStatus();
      setStatus(next);
      setError("");
      if (next.account.connected) {
        setBrowserLogin(null);
        setDeviceLogin(null);
      }
    } catch {
      setError(t.error);
    } finally {
      setLoading(false);
    }
  }, [t.error]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if ((!browserLogin && !deviceLogin) || status?.account.connected) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [browserLogin, deviceLogin, refresh, status?.account.connected]);

  async function connectBrowser() {
    setBusy(true);
    setError("");
    try {
      const login = await startCodexBrowserLogin();
      setBrowserLogin(login);
      setDeviceLogin(null);
      window.open(login.authUrl, "_blank", "noopener,noreferrer");
    } catch {
      setError(t.error);
    } finally {
      setBusy(false);
    }
  }

  async function connectDevice() {
    setBusy(true);
    setError("");
    try {
      const login = await startCodexDeviceLogin();
      setDeviceLogin(login);
      setBrowserLogin(null);
    } catch {
      setError(t.error);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const confirmed = await confirmDialog({
      title: t.disconnectConfirmTitle,
      description: t.disconnectConfirmBody,
      confirmLabel: t.disconnect,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await disconnectCodex();
      setBrowserLogin(null);
      setDeviceLogin(null);
      await refresh();
    } catch {
      setError(t.error);
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.account.connected === true;

  return (
    <div className="border-t border-border pt-6 space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t.title}</h3>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t.description}</p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">{t.loading}</div>
      ) : status?.runtimeAvailable === false ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
            {t.runtimeUnavailable}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void connectBrowser()} disabled={busy}>
              {busy ? t.connecting : t.connect}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void connectDevice()} disabled={busy}>
              {t.deviceCode}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy}>
              {t.refresh}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="rounded-lg bg-muted/30 px-3 py-2 text-[13px] space-y-1">
            <div className={connected ? "font-medium text-emerald-500" : "text-muted-foreground"}>
              {connected ? t.connected : t.disconnected}
            </div>
            {connected && status?.account.emailHint ? (
              <div>
                <span className="text-muted-foreground">{t.emailLabel}: </span>
                {status.account.emailHint}
              </div>
            ) : null}
            {connected && status?.account.planType ? (
              <div>
                <span className="text-muted-foreground">{t.planLabel}: </span>
                {status.account.planType}
              </div>
            ) : null}
          </div>

          {browserLogin ? (
            <div className="rounded-lg border border-border px-3 py-3 text-[13px] space-y-2">
              <p className="text-muted-foreground">{t.browserInstruction}</p>
              <a
                href={browserLogin.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t.openAuthorization}
              </a>
            </div>
          ) : null}

          {deviceLogin ? (
            <div className="rounded-lg border border-border px-3 py-3 text-[13px] space-y-2">
              <p className="text-muted-foreground">{t.deviceInstruction}</p>
              <div className="font-mono text-base tracking-wider">{deviceLogin.userCode}</div>
              <a
                href={deviceLogin.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t.openVerification}
              </a>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {connected ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void connectBrowser()} disabled={busy}>
                  {t.reconnect}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy}>
                  {t.disconnect}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" onClick={() => void connectBrowser()} disabled={busy}>
                  {busy ? t.connecting : t.connect}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void connectDevice()} disabled={busy}>
                  {t.deviceCode}
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy}>
              {t.refresh}
            </Button>
          </div>

          {connected ? (
            <div className="space-y-2">
              <div className="text-[12px] font-medium text-muted-foreground">{t.modelsTitle}</div>
              {status?.models.length ? (
                <div className="grid gap-2">
                  {status.models.map((model) => (
                    <div key={model.model} className="rounded-lg border border-border px-3 py-2">
                      <div className="text-sm font-medium">
                        {model.displayName}
                        {model.isDefault ? (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t.defaultModel}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[12px] text-muted-foreground">{model.description}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[13px] text-muted-foreground">{t.noModels}</div>
              )}
            </div>
          ) : null}
        </>
      )}

      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </div>
  );
}
