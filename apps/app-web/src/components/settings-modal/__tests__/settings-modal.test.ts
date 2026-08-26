import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { deploymentCapabilitiesFor } from "@use-brian/shared/deployment-capabilities";

vi.mock("@/lib/edition", () => ({
  isOssEdition: () => true,
  usebrianEdition: () => "oss",
  deploymentCapabilities: () => ({
    teammateManagement: false,
    localOwnerSession: true,
    billing: false,
    creditEnforcement: false,
    planEntitlements: false,
    hostedPlanLimits: false,
    managedInfrastructure: false,
    selfManagedProviders: true,
    hostedUpgradePrompts: true,
    researchPlanGate: true,
  }),
  HOSTED_UPGRADE_URL: "https://usebrian.ai",
}));
import {
  OssVersionFooter,
  workspaceMembersSectionKind,
  workspaceSettingsSections,
} from "../settings-modal";

describe("[COMP:app-web/profile-management] settings navigation", () => {
  it("keeps Browser profiles out of Settings in both editions", () => {
    expect(workspaceSettingsSections(deploymentCapabilitiesFor("oss"))).not.toContain("ws-browser-profiles");
    expect(workspaceSettingsSections(deploymentCapabilitiesFor("hosted"))).not.toContain("ws-browser-profiles");
  });

  it("keeps hosted-only billing out of OSS but exposes model routing", () => {
    const sections = workspaceSettingsSections(deploymentCapabilitiesFor("oss"));
    expect(sections).not.toContain("ws-plan");
    expect(sections).toContain("ws-models");
  });

  it("enables Outpost teammate management without exposing billing", () => {
    const capabilities = deploymentCapabilitiesFor("outpost");
    const sections = workspaceSettingsSections(capabilities);
    expect(sections).toContain("ws-members");
    expect(sections).not.toContain("ws-plan");
    expect(workspaceMembersSectionKind(capabilities)).toBe("manage");
    expect(workspaceMembersSectionKind(deploymentCapabilitiesFor("oss"))).toBe("upgrade");
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
