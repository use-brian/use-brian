// @vitest-environment jsdom
/**
 * [COMP:app-web/connect-browser-button] "My Browser" sidebar button.
 *
 * The row's whole value is that it never dead-ends: it hides where no relay
 * exists, pairs in one click where the extension answers, and hands off to the
 * Settings panel in every other case. Those branches are what is asserted here
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

const openWorkspaceSettings = vi.fn();
vi.mock("@/components/settings-modal/settings-modal", () => ({
  openWorkspaceSettings: (...a: unknown[]) => openWorkspaceSettings(...a),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
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

describe("[COMP:app-web/connect-browser-button] My Browser sidebar button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pairBrowserExtension.mockResolvedValue(PAIRING);
    pairViaExtension.mockResolvedValue("paired");
    extensionHasControl.mockResolvedValue(true);
    requestBrowserControl.mockResolvedValue("prompted");
  });

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

  it("pairs in one click and flips to connected without opening Settings", async () => {
    getBrowserExtensionStatus
      .mockResolvedValueOnce({ configured: true, connected: false })
      .mockResolvedValue({ configured: true, connected: true });
    const { el } = await mount();

    await click(el);

    expect(pairBrowserExtension).toHaveBeenCalledWith("ws-1");
    expect(pairViaExtension).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: PAIRING.relayUrl, pairingToken: PAIRING.pairingToken }),
    );
    expect(openWorkspaceSettings).not.toHaveBeenCalled();
    expect(labelOf(el)).toBe(c.manageAria);
    expect(dotOf(el)).toBe("primary");
  });

  it("falls back to the Settings panel when no extension answers", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    pairViaExtension.mockResolvedValue("not_installed");
    const { el } = await mount();

    await click(el);

    expect(openWorkspaceSettings).toHaveBeenCalledWith("ws-browser-profiles");
  });

  it("falls back to the Settings panel when the extension refuses", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    pairViaExtension.mockResolvedValue("refused");
    const { el } = await mount();

    await click(el);

    expect(openWorkspaceSettings).toHaveBeenCalledWith("ws-browser-profiles");
  });

  it("falls back to the Settings panel when the token mint itself fails", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: false });
    pairBrowserExtension.mockResolvedValue(null);
    const { el } = await mount();

    await click(el);

    expect(pairViaExtension).not.toHaveBeenCalled();
    expect(openWorkspaceSettings).toHaveBeenCalledWith("ws-browser-profiles");
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
    expect(openWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("falls back to the panel if the extension stops answering before the allow click", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: true });
    extensionHasControl.mockResolvedValue(false);
    requestBrowserControl.mockResolvedValue("not_installed");
    const { el } = await mount();

    await click(el);

    expect(openWorkspaceSettings).toHaveBeenCalledWith("ws-browser-profiles");
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

  it("opens the panel to manage an already-connected browser instead of re-pairing", async () => {
    getBrowserExtensionStatus.mockResolvedValue({ configured: true, connected: true });
    const { el } = await mount();
    expect(dotOf(el)).toBe("primary");

    await click(el);

    expect(pairBrowserExtension).not.toHaveBeenCalled();
    expect(openWorkspaceSettings).toHaveBeenCalledWith("ws-browser-profiles");
  });
});
