// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

const { getCodexProviderStatus } = vi.hoisted(() => ({
  getCodexProviderStatus: vi.fn(),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));
vi.mock("@/lib/api/codex-provider", () => ({
  getCodexProviderStatus,
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

  it("keeps recovery controls visible when the runtime reports unavailable", async () => {
    getCodexProviderStatus.mockResolvedValue({
      runtimeAvailable: false,
      account: {
        connected: false,
        authType: "none",
        planType: null,
        emailHint: null,
        requiresOpenaiAuth: true,
      },
      models: [],
      preferredProvider: "openai-codex",
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <CodexProviderCard />
        </I18nProvider>,
      );
    });

    const t = en.chrome.settingsModal.codexProvider;
    expect(container.textContent).toContain(t.runtimeUnavailable);
    expect(container.textContent).toContain(t.connect);
    expect(container.textContent).toContain(t.deviceCode);
    expect(container.textContent).toContain(t.refresh);

    await act(async () => root.unmount());
  });

  it("keeps every card string in the locale dictionary", () => {
    for (const value of Object.values(en.chrome.settingsModal.codexProvider)) {
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
