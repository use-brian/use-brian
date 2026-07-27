import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  isOssEdition: vi.fn(() => true),
}));

vi.mock("@/lib/edition", () => ({
  isOssEdition: mocks.isOssEdition,
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({
    workspaceId: "workspace-1",
    name: "Personal",
    role: "owner",
    clearance: "internal",
    me: { id: "user-1" },
  }),
}));
vi.mock("@/lib/support-diagnostics", () => ({
  getSupportDiagnosticStatus: vi.fn(),
  startSupportDiagnosticCapture: vi.fn(),
  stopSupportDiagnosticCapture: vi.fn(),
  previewSupportDiagnosticCapsule: vi.fn(),
  downloadSupportDiagnosticCapsule: vi.fn(),
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: vi.fn(),
  getCachedUserInfo: vi.fn(() => null),
}));
vi.mock("@/lib/desktop-auth-source", () => ({
  desktopSignOut: vi.fn(() => false),
}));
vi.mock("@/lib/offline/idb", () => ({
  clearLocalDocCaches: vi.fn(),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en, type Dictionary } from "@/lib/i18n/dictionaries/en";
import { PrivacySection } from "../privacy-section";

function renderPrivacy(): string {
  return renderToString(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <PrivacySection />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/support-diagnostics] Support Mode settings card", () => {
  it("renders the local-only consent controls in the OSS edition", () => {
    mocks.isOssEdition.mockReturnValue(true);
    const html = renderPrivacy();
    const t = en.settings.privacy;

    expect(html).toContain(t.supportTitle);
    expect(html).toContain(t.supportDurationOneHour);
    expect(html).toContain(t.supportDurationOneDay);
    expect(html).toContain(t.supportDurationOneWeek);
    expect(html).toContain(t.supportIncludeContent);
    expect(html).toContain(t.supportLocalOnly);
  });

  it("does not render the feature in the hosted edition", () => {
    mocks.isOssEdition.mockReturnValue(false);
    expect(renderPrivacy()).not.toContain(en.settings.privacy.supportTitle);
  });

  it("keeps every Support Mode string in the locale dictionary", () => {
    for (const [key, value] of Object.entries(en.settings.privacy)) {
      if (key.startsWith("support")) expect(value.length).toBeGreaterThan(0);
    }
  });
});
