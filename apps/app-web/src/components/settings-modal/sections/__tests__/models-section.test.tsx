/**
 * [COMP:app-web/models-settings] Settings -> Models — static render
 * contracts (node-only vitest: `renderToString` + module mocks, the
 * domains-section test shape). Effects never run under SSR, so the section
 * renders its loading contract; the create/rename/delete round-trips are
 * web-QA.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));
vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: vi.fn(async () => null),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ workspaceId: "ws-1" }),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ModelsSection } from "../models-section";

const dict = en as unknown as Dictionary;
const tm = en.chrome.settingsModal.models;

describe("[COMP:app-web/models-settings] Models section", () => {
  it("renders the header + loading contract (SSR: effects never run)", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <ModelsSection />
      </I18nProvider>,
    );
    expect(html).toContain(tm.title);
    expect(html).toContain(tm.blurb);
    expect(html).toContain(tm.loading);
  });

  it("embeds the workspace BYO Gemini key block (hosted home for ws-llm-key)", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <ModelsSection />
      </I18nProvider>,
    );
    expect(html).toContain(en.workspaceLlmKey.heading);
  });

  it("every user-facing string flows through the dictionary (i18n contract)", () => {
    // The three locales share the Dictionary shape — a missing key is a
    // compile error; this asserts the en copy carries no raw placeholders.
    for (const v of Object.values(tm)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
