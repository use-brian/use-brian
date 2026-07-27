import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));
vi.mock("@/lib/api/codex-provider", () => ({
  getCodexProviderStatus: vi.fn(),
  startCodexBrowserLogin: vi.fn(),
  startCodexDeviceLogin: vi.fn(),
  disconnectCodex: vi.fn(),
  setPreferredProvider: vi.fn(),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { CodexProviderCard } from "../codex-provider-card";

describe("[COMP:app-web/codex-provider] ChatGPT subscription settings card", () => {
  it("renders the localized loading contract without account or token data", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <CodexProviderCard />
      </I18nProvider>,
    );
    const t = en.chrome.settingsModal.codexProvider;
    expect(html).toContain(t.title);
    expect(html).toContain(t.description);
    expect(html).toContain(t.loading);
    expect(html).not.toContain("access_token");
    expect(html).not.toContain("refresh_token");
  });

  it("keeps every card string in the locale dictionary", () => {
    for (const value of Object.values(en.chrome.settingsModal.codexProvider)) {
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
