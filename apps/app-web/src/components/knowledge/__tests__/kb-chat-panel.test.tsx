// @vitest-environment jsdom
/**
 * [COMP:app-web/kb-chat-panel] Ask & update KB — embedded scoped chat.
 *
 * The panel's identity plumbing is what these tests pin: it runs as the
 * workspace PRIMARY assistant, resumes the sticky per-source session by the
 * `kb-scope:<sourceId>` channel id, and restores that session's transcript.
 * (The send/stream/confirmation legs ride `@use-brian/chat-ui` + the shared
 * `ChatConfirmationCard`, covered by their own suites.)
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

const mockListAssistants = vi.fn();
vi.mock("@/lib/api/views", () => ({
  listWorkspaceAssistants: (...args: unknown[]) => mockListAssistants(...args),
}));

import { KbChatPanel } from "../kb-chat-panel";

const dict = en as unknown as Dictionary;
const copy = dict.studioPage.knowledgePage.chat;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockListAssistants.mockResolvedValue([
    { id: "a-std", name: "Worker", iconSeed: 0, kind: "standard", appType: null },
    { id: "a-primary", name: "Brian", iconSeed: 0, kind: "primary", appType: null },
  ]);
  mockAuthFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        {ui}
      </I18nProvider>,
    );
  });
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("[COMP:app-web/kb-chat-panel] KbChatPanel", () => {
  it("resolves the workspace primary and resumes by the kb-scope channel id", async () => {
    render(<KbChatPanel workspaceId="ws-1" scope={{ kind: "source", sourceId: "src-1" }} />);
    await flush();

    expect(mockListAssistants).toHaveBeenCalledWith("ws-1");
    const resumeCall = mockAuthFetch.mock.calls.find((c) =>
      String(c[0]).includes("/api/sessions/by-channel"),
    )!;
    expect(resumeCall).toBeTruthy();
    const url = String(resumeCall[0]);
    expect(url).toContain("assistantId=a-primary");
    expect(url).toContain(encodeURIComponent("kb-scope:src-1"));

    // No prior session → empty state + an enabled composer.
    expect(host!.textContent).toContain(copy.empty);
    const composer = host!.querySelector("textarea")!;
    expect(composer.disabled).toBe(false);
    expect(composer.placeholder).toBe(copy.placeholder);
  });

  it("uses the manual sentinel channel for the manual-entries pseudo-row", async () => {
    render(<KbChatPanel workspaceId="ws-1" scope={{ kind: "manual" }} />);
    await flush();
    const resumeCall = mockAuthFetch.mock.calls.find((c) =>
      String(c[0]).includes("/api/sessions/by-channel"),
    )!;
    expect(String(resumeCall[0])).toContain(encodeURIComponent("kb-scope:manual"));
  });

  it("restores the resumed session's transcript", async () => {
    mockAuthFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/sessions/by-channel")) {
        return { ok: true, json: async () => ({ id: "sess-1" }) };
      }
      if (url.includes("/api/sessions/sess-1/messages")) {
        return {
          ok: true,
          json: async () => [
            { id: "m1", role: "user", content: "What are the vault fees?", timestamp: new Date().toISOString() },
            { id: "m2", role: "assistant", content: "Maker fee is 5 bps.", timestamp: new Date().toISOString() },
          ],
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    render(<KbChatPanel workspaceId="ws-1" scope={{ kind: "source", sourceId: "src-1" }} />);
    await flush();
    await flush();
    const text = host!.textContent ?? "";
    expect(text).toContain("What are the vault fees?");
    expect(text).toContain("Maker fee is 5 bps.");
  });

  it("disables the composer when the workspace has no assistant", async () => {
    mockListAssistants.mockResolvedValue([]);
    render(<KbChatPanel workspaceId="ws-1" scope={{ kind: "manual" }} />);
    await flush();
    const composer = host!.querySelector("textarea")!;
    expect(composer.disabled).toBe(true);
    expect(composer.placeholder).toBe(copy.noAssistant);
  });
});
