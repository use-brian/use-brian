"use client";

/**
 * "My Browser" — connect, allow, or reconnect the local browser extension
 * without going through Settings.
 *
 * The pairing machinery already exists (`connect-browser-panel.tsx` +
 * `lib/browser-extension-bridge.ts`, my-browser.md P1); what it lacked was a
 * way in. The panel lives four levels deep — Settings → Workspace → Browser
 * profiles → scroll — which is a long way to travel for the two moments that
 * actually matter: connecting the first time, and reconnecting after Chrome
 * has been restarted and the relay socket is gone. Both are one click here.
 *
 * **Shape.** A 28px icon square in the **Browsers operator surface's top bar**
 * (`browsers-surface-shell.tsx`, the `right` slot, next to the live-session
 * count) — the browser controls sit where the browser lives. It began as a
 * square trailing the global operator app-bar, which put a browser affordance
 * on every surface; it moved onto the Browsers surface once Browsers became a
 * first-class operator app (doc.md → "Home operator app-bar").
 *
 * State lives in the glyph, since an icon has no room for a label: a primary
 * dot when connected, an amber dot when paired but not yet allowed to drive,
 * and no dot when there is nothing connected. The tooltip carries the words.
 *
 * It renders nothing at all when the deployment has no relay configured
 * (`status.configured === false`) or before the first status resolves — a
 * permanently dead button teaches people to ignore that slot.
 *
 * Clicking while disconnected runs the same one-click path the panel uses:
 * mint a token, hand it straight to the extension. Paired-but-not-allowed
 * asks the extension to raise Chrome's permission prompt. Anything other than
 * a clean result (no extension, wrong build id, refused origin) falls back to
 * opening the panel, which owns the install CTA and the copy-paste fields —
 * this button never becomes a dead end. Connected, it opens the panel to
 * manage the connection.
 *
 * [COMP:app-web/connect-browser-button]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n/client";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import {
  chromeMessenger,
  extensionHasControl,
  pairViaExtension,
  requestBrowserControl,
} from "@/lib/browser-extension-bridge";
import {
  getBrowserExtensionStatus,
  pairBrowserExtension,
  type BrowserExtensionStatus,
} from "@/lib/api/computer";

/**
 * Mounted only on the Browsers surface (the shell unmounts when you leave), so
 * it polls far more slowly than the Settings panel (5s) — a socket that dropped
 * is not urgent until someone looks. A window focus re-checks immediately,
 * which is the moment that actually matters: the user has just come back from
 * the extension popup or from restarting Chrome.
 */
const STATUS_POLL_MS = 60_000;

export function ConnectBrowserButton({ workspaceId }: { workspaceId: string }) {
  const c = useT().computer.connectBrowser.sidebarRow;

  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null);
  /**
   * Whether the extension holds the optional `debugger` grant. `null` means no
   * extension answered, which is NOT the same as "not granted" — nagging a user
   * to allow something on a machine with no extension installed is worse than
   * saying nothing, so only an explicit `false` shows the allow state.
   */
  const [hasControl, setHasControl] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Survives the await in `onConnect` — an unmount mid-pair must not set state.
  const alive = useRef(true);

  const refreshStatus = useCallback(async () => {
    const next = await getBrowserExtensionStatus();
    if (!alive.current) return;
    setStatus(next);
    // Only worth asking the extension once the relay says this user has one
    // connected; off that path the probe is a guaranteed null.
    if (!next.connected) {
      setHasControl(null);
      return;
    }
    const control = await extensionHasControl({ send: chromeMessenger() });
    if (alive.current) setHasControl(control);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshStatus]);

  const connected = status?.connected === true;
  // Paired, but the user has not granted browser control. Only an explicit
  // `false` counts — see `hasControl`.
  const needsControl = connected && hasControl === false;

  const onClick = useCallback(async () => {
    if (busy) return;
    // Paired but not allowed to drive: the one thing worth doing is asking for
    // the permission. Chrome will not let a web page raise its own prompt, so
    // the extension opens the window that can and the user clicks Allow there.
    if (needsControl) {
      setBusy(true);
      const result = await requestBrowserControl({ send: chromeMessenger() });
      if (alive.current) setBusy(false);
      // `not_installed` here means the extension stopped answering between the
      // probe and the click. The panel is the honest fallback: it owns the
      // install CTA, which is the actual remedy.
      if (result === "not_installed") openWorkspaceSettings("ws-browser-profiles");
      else await refreshStatus();
      return;
    }
    // Connected: nothing to pair, so the click is "let me look at this" —
    // hand it to the panel, which owns profiles + disconnect.
    if (connected || !workspaceId) {
      openWorkspaceSettings("ws-browser-profiles");
      return;
    }
    setBusy(true);
    const pairing = await pairBrowserExtension(workspaceId);
    if (!pairing) {
      // The mint failed (relay down, 503). The panel surfaces the error copy;
      // repeating it in a sidebar row would only shout the same thing twice.
      if (alive.current) setBusy(false);
      openWorkspaceSettings("ws-browser-profiles");
      return;
    }
    const result = await pairViaExtension({
      relayUrl: pairing.relayUrl,
      pairingToken: pairing.pairingToken,
      send: chromeMessenger(),
    });
    if (alive.current) setBusy(false);
    if (result === "paired") {
      await refreshStatus();
      return;
    }
    // Not installed, wrong build id, or refused: the panel has the install CTA
    // and the copy fields, and the token we just minted is still valid there.
    openWorkspaceSettings("ws-browser-profiles");
  }, [busy, connected, needsControl, workspaceId, refreshStatus]);

  // No relay on this deployment (OSS, or unconfigured) — and nothing rendered
  // until the first probe answers, so the slot never flips under the cursor.
  if (!status?.configured) return null;

  // One label does the work a row's text used to: the icon carries only state.
  const label = busy
    ? c.connecting
    : needsControl
      ? c.allowAria
      : connected
        ? c.manageAria
        : c.connectAria;

  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        aria-label={label}
        className="group relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-accent disabled:opacity-60"
      >
        <Globe
          className={cn(
            "size-4 shrink-0",
            connected && !needsControl
              ? "text-primary"
              : "text-sidebar-foreground/55 group-hover:text-sidebar-accent-foreground",
          )}
          strokeWidth={1.8}
          aria-hidden
        />
        {/* State dot — the icon's only affordance for saying which of the
            three states this is. Amber for "paired but not allowed to drive",
            because it is the one state that looks connected from the relay's
            side and still refuses every task. `ring-sidebar` keeps it legible
            over the hover wash. */}
        {!busy && (connected || needsControl) ? (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
              needsControl ? "bg-amber-500" : "bg-primary",
            )}
          />
        ) : null}
      </button>
    </Tooltip>
  );
}
