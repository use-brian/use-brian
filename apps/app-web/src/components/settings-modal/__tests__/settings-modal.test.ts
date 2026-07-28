import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edition", () => ({
  isOssEdition: () => true,
  HOSTED_UPGRADE_URL: "https://usebrian.ai",
}));
vi.mock("../sections/browser-profiles-section", () => ({
  BrowserProfilesSection: () => "my-browser-settings",
}));

import { SectionBody, workspaceSettingsSections } from "../settings-modal";

describe("[COMP:app-web/connect-browser] OSS settings navigation", () => {
  it("shows Browser profiles so OSS users can pair My Browser", () => {
    expect(workspaceSettingsSections(true)).toContain("ws-browser-profiles");
  });

  it("renders My Browser settings instead of the hosted upgrade in OSS", () => {
    const html = renderToString(
      createElement(SectionBody, { section: "ws-browser-profiles", onClose: () => undefined }),
    );
    expect(html).toContain("my-browser-settings");
    expect(html).not.toContain("Upgrade to hosted");
  });

  it("keeps hosted-only billing and model sections out of OSS", () => {
    expect(workspaceSettingsSections(true)).not.toContain("ws-plan");
    expect(workspaceSettingsSections(true)).not.toContain("ws-models");
  });
});
