"use client";

/**
 * "My Browser" connect surface (my-browser.md P1): pair the user's own Chrome
 * (via the browser extension + relay) so the assistant can browse as them, with
 * their logins and home network, for hardened/authenticated sites the cloud
 * browser cannot reach. Paid-gated on the hosted edition (D3); OSS exposes the
 * same section without a plan gate for a configured self-hosted relay. Renders
 * inside one Browser profile card. Each card pairs independently, so separate
 * Chrome profiles can serve separate assistants at the same time.
 *
 * [COMP:app-web/connect-browser]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Cable, Check, Copy, Download, Link2, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { isOssEdition } from "@/lib/edition";
import { planGateApplies } from "@/lib/plan-gate";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import {
  getBrowserExtensionStatus,
  getWorkspacePlan,
  pairBrowserExtension,
  type BrowserExtensionPairing,
  type BrowserExtensionStatus,
} from "@/lib/api/computer";
import {
  BROWSER_EXTENSION_INSTALL_URL,
  chromeMessenger,
  detectExtension,
  pairViaExtension,
} from "@/lib/browser-extension-bridge";

const STATUS_POLL_MS = 5000;

/** Small copyable read-only field for the relay address + pairing code. */
function CopyField({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context); the field stays selectable.
    }
  }, [value]);
  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="h-8 flex-1 rounded-md border border-border bg-muted px-2.5 font-mono text-xs outline-none"
        />
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label={copied ? copiedLabel : copyLabel}
          title={copied ? copiedLabel : copyLabel}
          className="grid size-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

export function ConnectBrowserPanel({
  profileId,
  profileName,
  onConnectionChange,
}: {
  profileId: string;
  profileName: string;
  onConnectionChange?: (profileId: string, connected: boolean) => void;
}) {
  const t = useT();
  const c = t.computer.connectBrowser;
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params?.workspaceId ?? "";

  const [gated, setGated] = useState(false);
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null);
  const [pairing, setPairing] = useState<BrowserExtensionPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Null while we have not asked yet, so the button does not flicker in. */
  const [installed, setInstalled] = useState<boolean | null>(null);

  // Plan gate (D3): hosted paid only; OSS never gates. A null/unknown plan does
  // NOT gate (planGateApplies) so a paid user never sees the upsell flash.
  useEffect(() => {
    const edition = isOssEdition() ? "oss" : "hosted";
    if (edition === "oss" || !workspaceId) {
      setGated(false);
      return;
    }
    let cancelled = false;
    void getWorkspacePlan(workspaceId).then((plan) => {
      if (!cancelled) setGated(planGateApplies(edition, plan));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const refreshStatus = useCallback(async () => {
    const next = await getBrowserExtensionStatus(workspaceId, profileId);
    setStatus(next);
    onConnectionChange?.(profileId, next.connected);
  }, [onConnectionChange, profileId, workspaceId]);

  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Probe once for a reachable extension. A negative answer is not final (the
  // user may install it while this panel is open), so the manual flow stays
  // reachable either way rather than being hidden behind this result.
  useEffect(() => {
    let cancelled = false;
    void detectExtension({ send: chromeMessenger() }).then((found) => {
      if (!cancelled) setInstalled(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onGenerate = useCallback(async () => {
    if (busy || !workspaceId) return;
    setBusy(true);
    setError(null);
    const p = await pairBrowserExtension(workspaceId, profileId);
    setBusy(false);
    if (!p) {
      setError(c.generateFailed);
      return;
    }
    setPairing(p);
  }, [busy, workspaceId, profileId, c.generateFailed]);

  /**
   * One click: mint a code and hand it straight to the extension. Falling back
   * to the copy fields on `not_installed` matters more than it looks - the
   * probe can be stale, and stranding someone with no visible next step is the
   * failure this panel already had.
   */
  const onOneClickConnect = useCallback(async () => {
    if (busy || !workspaceId) return;
    setBusy(true);
    setError(null);
    const p = await pairBrowserExtension(workspaceId, profileId);
    if (!p) {
      setBusy(false);
      setError(c.generateFailed);
      return;
    }
    const result = await pairViaExtension({
      relayUrl: p.relayUrl,
      pairingToken: p.pairingToken,
      send: chromeMessenger(),
    });
    setBusy(false);
    if (result === "paired") {
      setInstalled(true);
      await refreshStatus();
      return;
    }
    // Show the copy fields so the user is never left without a way forward.
    setPairing(p);
    setInstalled(false);
    if (result === "refused") setError(c.oneClickFailed);
  }, [busy, workspaceId, profileId, c.generateFailed, c.oneClickFailed, refreshStatus]);

  // Gated: paid feature upsell (opens the Plan section in-app).
  if (gated) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <h3 className="text-sm font-medium">{c.gatedTitle}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{c.gatedBody}</p>
        <button
          type="button"
          onClick={() => openWorkspaceSettings("ws-plan")}
          className="mt-2 h-8 rounded-md bg-action px-3 text-xs font-medium text-action-foreground"
        >
          {c.gatedCta}
        </button>
      </div>
    );
  }

  const connected = status?.connected === true;

  return (
    <div className="rounded-lg border border-border bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Cable className="size-4 text-muted-foreground" aria-hidden />
          {c.title}
          <span className="sr-only">{profileName}</span>
        </h3>
        <span
          className={
            connected
              ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
              : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          }
        >
          {connected ? c.statusConnected : c.statusDisconnected}
        </span>
      </div>
      {/* Shown alongside the connected badge, never instead of it: a stale
          extension is genuinely connected, and saying otherwise would send the
          user to re-pair when the fix is to reload. */}
      {status?.staleBuild ? (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          {c.staleBuildWarning}
        </p>
      ) : null}

      {status && !status.configured ? (
        <p className="mt-3 text-xs text-muted-foreground">{c.notConfigured}</p>
      ) : connected ? (
        null
      ) : installed && !pairing ? (
        // The extension answered, so it already has everything it needs from
        // us. Asking the user to copy a relay address and a code into a popup
        // before a 10 minute expiry buys nothing here.
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onOneClickConnect()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50"
          >
            <Cable className="size-3.5" aria-hidden />
            {busy ? c.oneClickConnecting : c.oneClickCta}
          </button>
          {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            <a
              href={BROWSER_EXTENSION_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
            >
              <Download className="size-3.5" aria-hidden />
              {c.step1Cta}
            </a>
            {!pairing ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onGenerate()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50"
              >
                <Link2 className="size-3.5" aria-hidden />
                {busy ? c.generating : c.generate}
              </button>
            ) : null}
          </div>
            {pairing ? (
              <div className="mt-3 space-y-2">
                <CopyField
                  label={c.relayLabel}
                  value={pairing.relayUrl}
                  copyLabel={c.copy}
                  copiedLabel={c.copied}
                />
                <CopyField
                  label={c.tokenLabel}
                  value={pairing.pairingToken}
                  copyLabel={c.copy}
                  copiedLabel={c.copied}
                />
                <p className="text-[11px] text-muted-foreground">{c.tokenExpiry}</p>
                <button
                  type="button"
                  onClick={() => void refreshStatus()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {c.refresh}
                </button>
              </div>
            ) : null}
            {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
