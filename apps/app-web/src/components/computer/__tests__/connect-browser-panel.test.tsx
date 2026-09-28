// @vitest-environment jsdom
/**
 * [COMP:app-web/connect-browser] "My Browser" connect surface — static render
 * contract (SSR: `renderToString` + module mocks, the
 * domains-section test shape). Effects never run under SSR, so status stays
 * null and the panel renders its connect flow (install + generate). The
 * connected/gated/configured round-trips are web-QA.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getBrowserExtensionStatus, pairBrowserExtension } from "@/lib/api/computer";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/lib/edition", () => ({
  deploymentCapabilities: () => ({ billing: true }),
}));
vi.mock("@/components/settings-modal/settings-modal", () => ({
  openWorkspaceSettings: vi.fn(),
}));
vi.mock("@/lib/api/computer", () => ({
  getBrowserExtensionStatus: vi.fn(async () => ({ configured: true, connected: false })),
  getWorkspacePlan: vi.fn(async () => "pro"),
  pairBrowserExtension: vi.fn(async () => null),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ConnectBrowserPanel } from "../connect-browser-panel";

const dict = en as unknown as Dictionary;
const c = en.computer.connectBrowser;

function render(): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <ConnectBrowserPanel profileId="profile-1" profileName="Personal" />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/connect-browser] My Browser connect surface", () => {
  it("renders the connect flow (title, disconnected status, install CTA, generate) before status loads", () => {
    const html = render();
    expect(html).toContain(c.title);
    expect(html).toContain(c.statusDisconnected);
    expect(html).toContain(c.step1Cta);
    expect(html).toContain(c.generate);
  });

  it("shows neither the connected hint nor the not-configured notice until an effect resolves", () => {
    const html = render();
    expect(html).not.toContain(c.connectedHint);
    expect(html).not.toContain(c.notConfigured);
  });

  it("sends the install CTA to the Chrome Web Store", () => {
    const html = render();
    expect(html).toContain("chromewebstore.google.com");
  });

  it("points directly at the published Use Brian listing", () => {
    const html = render();
    expect(html).toContain(
      "chromewebstore.google.com/detail/use-brian-browser-agent/nnmbbacnkekaoccmkmlfaghjaamgdpjn",
    );
  });

  it("offers the copy-paste flow when no extension answers the probe", () => {
    // Effects do not run under SSR, so `installed` stays null, which is the
    // same state as "we have not found one". The manual path must be what
    // renders, or a user without the extension has no way forward at all.
    const html = render();
    expect(html).toContain(c.step1Cta);
    expect(html).not.toContain(c.oneClickCta);
  });
});


describe("[COMP:app-web/connect-browser] Desktop connect surface", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("offers the in-app connection immediately, never extension installation or manual tokens", () => {
    vi.stubGlobal("window", { usebrianDesktop: { browserControl: vi.fn() } });
    const html = render();
    expect(html).toContain(c.desktop.title);
    expect(html).toContain(c.desktop.description);
    expect(html).toContain(c.desktop.connect);
    expect(html).toContain(c.desktop.disconnected);
    expect(html).not.toContain("chromewebstore.google.com");
    expect(html).not.toContain(c.step1Cta);
    expect(html).not.toContain(c.generate);
  });
});


it("[COMP:app-web/connect-browser] keeps desktop pairing busy until ready and offers retry on refusal", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let ready!: (value: { ok: boolean }) => void;
  window.usebrianDesktop = {
    signIn: vi.fn(),
    browserControl: vi.fn((message) => message.type === "pair"
      ? new Promise<{ ok: boolean }>((resolve) => { ready = resolve; })
      : Promise.resolve({ ok: true, hasControl: true })),
  };
  vi.mocked(pairBrowserExtension).mockResolvedValue({
    relayUrl: "wss://relay.example", pairingToken: "token", browserProfileId: "profile-1", expiresInSeconds: 600,
  });
  const el = document.createElement("div");
  const root = createRoot(el);
  try {
    await act(async () => root.render(
      <I18nProvider locale="en" dict={dict}>
        <ConnectBrowserPanel profileId="profile-1" profileName="Personal" />
      </I18nProvider>,
    ));
    await act(async () => el.querySelector("button")!.click());
    expect(el.querySelector("button")!.disabled).toBe(true);
    expect(el.textContent).toContain(c.oneClickConnecting);
    await act(async () => ready({ ok: false }));
    expect(el.textContent).toContain(c.desktop.failed);
    expect(el.querySelector("button")!.disabled).toBe(false);
    expect(el.textContent).toContain(c.desktop.connect);
    expect(el.textContent).not.toContain(c.step1Cta);
    expect(el.querySelector("input")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    delete window.usebrianDesktop;
    vi.mocked(pairBrowserExtension).mockResolvedValue(null);
  }
});

 it.each(["other browser", "other profile", "missing fields", "rejected", "relay disconnected", "local connected"])(
  "[COMP:app-web/connect-browser] desktop can pair/replace with %s status",
  async (scenario) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let paired = false;
    const browserControl = vi.fn(async (message: { type: string }) => {
      if (message.type === "pair") {
        paired = true;
        return { ok: true };
      }
      if (!paired && scenario === "rejected") throw new Error("IPC unavailable");
      if (!paired && scenario === "missing fields") return { ok: true, hasControl: true };
      return {
        ok: true, hasControl: true,
        connected: paired || scenario !== "other browser",
        browserProfileId: !paired && scenario === "other profile" ? "profile-2" : "profile-1",
      };
    });
    window.usebrianDesktop = { signIn: vi.fn(), browserControl };
    vi.mocked(getBrowserExtensionStatus).mockImplementation(async () => ({
      configured: true, connected: paired || scenario !== "relay disconnected",
    }));
    vi.mocked(pairBrowserExtension).mockResolvedValue({
      relayUrl: "wss://relay.example", pairingToken: "token", browserProfileId: "profile-1", expiresInSeconds: 600,
    });
    const onConnectionChange = vi.fn();
    const el = document.createElement("div");
    const root = createRoot(el);
    try {
      await act(async () => root.render(
        <I18nProvider locale="en" dict={dict}>
          <ConnectBrowserPanel profileId="profile-1" profileName="Personal" onConnectionChange={onConnectionChange} />
        </I18nProvider>,
      ));
      expect(onConnectionChange).toHaveBeenLastCalledWith("profile-1", scenario === "local connected");
      expect(el.textContent).toContain(c.desktop.connect);
      await act(async () => el.querySelector("button")!.click());
      expect(browserControl).toHaveBeenCalledWith({ type: "pair", relayUrl: "wss://relay.example", pairingToken: "token" });
      expect(onConnectionChange).toHaveBeenLastCalledWith("profile-1", true);
      expect(el.textContent).toContain(c.desktop.connected);
      expect(el.textContent).toContain(c.desktop.connect);
    } finally {
      await act(async () => root.unmount());
      delete window.usebrianDesktop;
      vi.mocked(getBrowserExtensionStatus).mockResolvedValue({ configured: true, connected: false });
      vi.mocked(pairBrowserExtension).mockResolvedValue(null);
    }
  },
);
