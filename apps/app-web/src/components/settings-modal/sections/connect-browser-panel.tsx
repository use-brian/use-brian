"use client";

/**
 * "My Browser" connect surface (my-browser.md P1): pair the user's own Chrome
 * (via the browser extension + relay) so the assistant can browse as them, with
 * their logins and home network, for hardened/authenticated sites the cloud
 * browser cannot reach. Paid-gated on the hosted edition (D3); OSS never gates
 * (and never shows this section). Renders at the top of the Browser profiles
 * section - setting a profile's backend to "My Browser" routes browsing to the
 * paired Chrome.
 *
 * [COMP:app-web/connect-browser]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
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
  chromeMessenger,
  detectExtension,
  pairViaExtension,
} from "@/lib/browser-extension-bridge";

// Set to the published listing at P2 (Chrome Web Store publish). A search link
// keeps the CTA honest pre-publish rather than pointing at a dead extension id.
const EXTENSION_STORE_URL = "https://chromewebstore.google.com/search/Use%20Brian";

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
          className="h-8 shrink-0 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
    </div>
  );
}

export function ConnectBrowserPanel() {
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
    setStatus(await getBrowserExtensionStatus());
  }, []);

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
    const p = await pairBrowserExtension(workspaceId);
    setBusy(false);
    if (!p) {
      setError(c.generateFailed);
      return;
    }
    setPairing(p);
  }, [busy, workspaceId, c.generateFailed]);

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
    const p = await pairBrowserExtension(workspaceId);
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
  }, [busy, workspaceId, c.generateFailed, c.oneClickFailed, refreshStatus]);

  // Gated: paid feature upsell (opens the Plan section in-app).
  if (gated) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <h3 className="text-sm font-medium">{c.gatedTitle}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{c.gatedBody}</p>
        <button
          type="button"
          onClick={() => openWorkspaceSettings("ws-plan")}
          className="mt-2 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
        >
          {c.gatedCta}
        </button>
      </div>
    );
  }

  const connected = status?.connected === true;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{c.title}</h3>
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
      <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>

      {status && !status.configured ? (
        <p className="mt-3 text-xs text-muted-foreground">{c.notConfigured}</p>
      ) : connected ? (
        <p className="mt-3 text-xs text-muted-foreground">{c.connectedHint}</p>
      ) : installed && !pairing ? (
        // The extension answered, so it already has everything it needs from
        // us. Asking the user to copy a relay address and a code into a popup
        // before a 10 minute expiry buys nothing here.
        <div className="mt-3">
          <p className="text-[11px] text-muted-foreground">{c.oneClickBody}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onOneClickConnect()}
            className="mt-2 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? c.oneClickConnecting : c.oneClickCta}
          </button>
          {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {/* Step 1: install */}
          <div>
            <p className="text-[11px] font-medium">{c.step1Title}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{c.step1Body}</p>
            <a
              href={EXTENSION_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
            >
              {c.step1Cta}
            </a>
          </div>

          {/* Step 2: pair */}
          <div>
            <p className="text-[11px] font-medium">{c.step2Title}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{c.step2Body}</p>
            {pairing ? (
              <div className="mt-2 space-y-2">
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
                  className="h-8 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
                >
                  {c.refresh}
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onGenerate()}
                className="mt-1 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? c.generating : c.generate}
              </button>
            )}
            {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
          </div>
        </div>
      )}
    </div>
  );
}
