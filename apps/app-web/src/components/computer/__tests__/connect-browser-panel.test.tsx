/**
 * [COMP:app-web/connect-browser] "My Browser" connect surface — static render
 * contract (node-only vitest: `renderToString` + module mocks, the
 * domains-section test shape). Effects never run under SSR, so status stays
 * null and the panel renders its connect flow (install + generate). The
 * connected/gated/configured round-trips are web-QA.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/lib/edition", () => ({ isOssEdition: () => false }));
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
