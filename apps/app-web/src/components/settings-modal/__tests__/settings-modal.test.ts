import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("@/lib/edition", () => ({
  isOssEdition: () => true,
  HOSTED_UPGRADE_URL: "https://usebrian.ai",
}));
import { OssVersionFooter, workspaceSettingsSections } from "../settings-modal";

describe("[COMP:app-web/profile-management] settings navigation", () => {
  it("keeps Browser profiles out of Settings in both editions", () => {
    expect(workspaceSettingsSections(true)).not.toContain("ws-browser-profiles");
    expect(workspaceSettingsSections(false)).not.toContain("ws-browser-profiles");
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
