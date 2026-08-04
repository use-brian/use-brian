import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("@/lib/edition", () => ({
  isOssEdition: () => true,
  HOSTED_UPGRADE_URL: "https://usebrian.ai",
}));
vi.mock("../sections/browser-profiles-section", () => ({
  BrowserProfilesSection: () => "my-browser-settings",
}));

import { OssVersionFooter, SectionBody, workspaceSettingsSections } from "../settings-modal";

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

describe("[COMP:app-web/settings-modal] OSS source version footer", () => {
  it("links the abbreviated build revision to its exact GitHub commit", () => {
    const commitSha = "a9132095d729d1c9f7f59068bf7c8ca67139b889";
    const html = renderToString(
      createElement(I18nProvider, {
        locale: "en",
        dict: en,
        children: createElement(OssVersionFooter, { commitSha }),
      }),
    );

    expect(html).toContain("Version a913209");
    expect(html).toContain(
      `href="https://github.com/use-brian/use-brian/commit/${commitSha}"`,
    );
    expect(html).toContain('aria-label="View version a913209 on GitHub"');
  });

  it("still links to the source repository when Git metadata is unavailable", () => {
    const html = renderToString(
      createElement(I18nProvider, {
        locale: "en",
        dict: en,
        children: createElement(OssVersionFooter, { commitSha: "" }),
      }),
    );

    expect(html).toContain("Source code");
    expect(html).toContain('href="https://github.com/use-brian/use-brian"');
  });
});
