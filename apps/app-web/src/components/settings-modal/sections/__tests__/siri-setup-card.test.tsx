import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { SiriSetupCard } from "../siri-setup-card";

function setBridge(bridge: unknown): void {
  (globalThis as { window?: unknown }).window = { usebrianDesktop: bridge };
}

function renderCard(): string {
  return renderToString(
    <I18nProvider locale="en" dict={en}>
      <SiriSetupCard />
    </I18nProvider>,
  );
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("[COMP:app-web/siri-settings] Siri setup settings card", () => {
  it("is mounted in Settings Preferences", () => {
    const source = readFileSync(
      new URL("../general-section.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('import { SiriSetupCard } from "./siri-setup-card"');
    expect(source).toContain("<SiriSetupCard />");
  });

  it("renders only for a macOS Electron bridge with setup support", () => {
    expect(renderCard()).toBe("");

    setBridge({ platform: "win32", openSiriSetup: async () => true });
    expect(renderCard()).toBe("");

    setBridge({ platform: "darwin" });
    expect(renderCard()).toBe("");

    setBridge({ platform: "darwin", openSiriSetup: async () => true });
    const html = renderCard();
    expect(html).toContain("Use Brian with Siri");
    expect(html).toContain("Set up Siri");
    expect(html).toContain("preconfigured macOS shortcut");
    expect(html).toContain("Add Shortcut");
  });
});
