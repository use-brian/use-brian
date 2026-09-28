// @vitest-environment jsdom
/**
 * [COMP:app-web/connect-browser-button] "My Browser" connect control
 * (Browsers surface top bar).
 *
 * The control's whole value is that it never dead-ends: it hides where no relay
 * exists, pairs in one click where the extension answers, and hands off to the
 * Browsers profile index in every other case. Those branches are what is asserted here
 * — jsdom (not the SSR shape the panel test uses), because all of them live
 * behind an effect and a click.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const getBrowserExtensionStatus = vi.fn();
const pairBrowserExtension = vi.fn();
vi.mock("@/lib/api/computer", () => ({
  getBrowserExtensionStatus: (...a: unknown[]) => getBrowserExtensionStatus(...a),
  pairBrowserExtension: (...a: unknown[]) => pairBrowserExtension(...a),
}));

const pairViaExtension = vi.fn();
const extensionHasControl = vi.fn();
const requestBrowserControl = vi.fn();
vi.mock("@/lib/browser-extension-bridge", () => ({
  chromeMessenger: () => null,
  pairViaExtension: (...a: unknown[]) => pairViaExtension(...a),
  extensionHasControl: (...a: unknown[]) => extensionHasControl(...a),
  requestBrowserControl: (...a: unknown[]) => requestBrowserControl(...a),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { automaticDesktopBrowser as browser, type BrowserState } from "@/lib/automatic-desktop-browser";
import { ConnectBrowserButton } from "../connect-browser-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
const c = en.computer.connectBrowser.sidebarRow;

const PAIRING = { relayUrl: "wss://relay.example", pairingToken: "tok-1", expiresInSeconds: 600 };

async function mount(): Promise<{ el: HTMLElement; root: Root }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={dict}>
        <ConnectBrowserButton workspaceId="ws-1" />
      </I18nProvider>,
    );
  });
  return { el, root };
}

async function click(el: HTMLElement) {
  const button = el.querySelector("button");
  if (!button) throw new Error("no button rendered");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * The button carries no text - it is a 28px icon square in the app-bar strip -
 * so its state reads off the accessible name and the corner dot.
 */
function labelOf(el: HTMLElement): string {
  return el.querySelector("button")?.getAttribute("aria-label") ?? "";
}
/** "primary" = connected, "amber" = paired but not allowed, null = neither. */
function dotOf(el: HTMLElement): "primary" | "amber" | null {
  const dot = el.querySelector("button > span[class*=rounded-full]");
  if (!dot) return null;
  return dot.className.includes("bg-amber") ? "amber" : "primary";
}

describe("[COMP:app-web/connect-browser-button] My Browser connect control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pairBrowserExtension.mockResolvedValue(PAIRING);
    pairViaExtension.mockResolvedValue("paired");
    extensionHasControl.mockResolvedValue(true);
    requestBrowserControl.mockResolvedValue("prompted");
  });

  it.each(["idle", "connecting", "connected", "paused", "failed"] as const)(
    "desktop observes coordinator %s state without manual pairing", async (phase) => {
      const state: BrowserState = { workspaceId: "ws-1", profileId: "p", phase };
      const snapshot = vi.spyOn(browser, "snapshot").mockReturnValue(state);
      const show = vi.spyOn(browser, "show").mockResolvedValue();
      const retry = vi.spyOn(browser, "retry").mockResolvedValue();
      window.usebrianDesktop = { signIn: vi.fn(), browserControl: vi.fn() };
      const { el, root } = await mount();
      try {
        const d = en.computer.connectBrowser.desktop;
        expect(labelOf(el)).toBe(phase === "connected" ? d.open : phase === "paused" ? d.resume :
          phase === "failed" ? d.retry : phase === "connecting" ? en.computer.connectBrowser.oneClickConnecting : d.automatic);
        expect(getBrowserExtensionStatus).not.toHaveBeenCalled();
        await click(el);
        expect(pairViaExtension).not.toHaveBeenCalled();
        expect(pairBrowserExtension).not.toHaveBeenCalled();
        if (phase === "connected") expect(show).toHaveBeenCalledOnce();
        if (phase === "paused" || phase === "failed") expect(retry).toHaveBeenCalledOnce();
        if (phase === "idle") expect(routerPush).toHaveBeenCalledWith("/w/ws-1/computer/profiles");
      } finally {
        await act(async () => root.unmount()); el.remove();
        delete window.usebrianDesktop;
        snapshot.mockRestore(); show.mockRestore(); retry.mockRestore();
      }
    },
  );

  it("renders nothing where the deployment has no relay configured", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: false, connected: false });
    const { el } = await mount();
    expect(el.querySelector("button")).toBeNull();
  });

  it("offers to connect once a configured-but-disconnected status resolves", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    const { el } = await mount();
    expect(labelOf(el)).toBe(c.connectAria);
    expect(dotOf(el)).toBeNull();
  });

  it("pairs in one click and flips to connected without opening profile management", async () => {
    getBrowserExtensionStatus
      .mockResolvedValueOnce({ configured: true, connected: false })
      .mockResolvedValue({ configured: true, connected: true });
    const { el } = await mount();

    await click(el);

    expect(pairBrowserExtension).toHaveBeenCalledWith("ws-1");
    expect(pairViaExtension).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: PAIRING.relayUrl, pairingToken: PAIRING.pairingToken }),
    );
    expect(routerPush).not.toHaveBeenCalled();
    expect(labelOf(el)).toBe(c.manageAria);
    expect(dotOf(el)).toBe("primary");
  });

  it("falls back to Browser profile management when no extension answers", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    pairViaExtension.mockResolvedValue("not_installed");
    const { el } = await mount();

    await click(el);

    expect(routerPush).toHaveBeenCalledWith("/w/ws-1/computer/profiles");
  });

  it("falls back to Browser profile management when the extension refuses", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    pairViaExtension.mockResolvedValue("refused");
    const { el } = await mount();

    await click(el);

    expect(routerPush).toHaveBeenCalledWith("/w/ws-1/computer/profiles");
  });

  it("falls back to Browser profile management when the token mint itself fails", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    pairBrowserExtension.mockResolvedValue(null);
    const { el } = await mount();

    await click(el);

    expect(pairViaExtension).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith("/w/ws-1/computer/profiles");
  });

  it("asks for browser control when the extension is paired but not allowed", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: true });
    extensionHasControl.mockResolvedValue(false);
    const { el } = await mount();

    expect(labelOf(el)).toBe(c.allowAria);
    expect(dotOf(el)).toBe("amber");
    // "Connected" would be a lie here: the socket is up but nothing can run.
    expect(dotOf(el)).not.toBe("primary");

    await click(el);

    expect(requestBrowserControl).toHaveBeenCalled();
    expect(pairBrowserExtension).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("falls back to the panel if the extension stops answering before the allow click", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: true });
    extensionHasControl.mockResolvedValue(false);
    requestBrowserControl.mockResolvedValue("not_installed");
    const { el } = await mount();

    await click(el);

    expect(routerPush).toHaveBeenCalledWith("/w/ws-1/computer/profiles");
  });

  it("never shows the allow state when no extension answered the control probe", async () => {
    // `null` is "we could not ask", not "not granted" — nagging someone to
    // allow something on a machine with no extension is worse than silence.
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: true });
    extensionHasControl.mockResolvedValue(null);
    const { el } = await mount();

    expect(labelOf(el)).toBe(c.manageAria);
    expect(dotOf(el)).toBe("primary");
  });

  it("opens profile management for an already-connected browser instead of re-pairing", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: true });
    const { el } = await mount();
    expect(dotOf(el)).toBe("primary");

    await click(el);

    expect(pairBrowserExtension).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith("/w/ws-1/computer/profiles");
  });
});
