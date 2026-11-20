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

// The fixture supplies the signed-in identity and real workspace route.
vi.mock("@/lib/user", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/user")>(),
  getUserInfo: () => ({ id: "viewer-1" }),
}));

const mockListAssistants = vi.fn();
vi.mock("@/lib/api/views", () => ({
  listWorkspaceAssistants: (...args: unknown[]) => mockListAssistants(...args),
}));

import { KbChatPanel } from "../kb-chat-panel";
import { conversationRegistry } from "@/lib/chat/conversation-registry";

const dict = en as unknown as Dictionary;
const copy = dict.studioPage.knowledgePage.chat;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  window.history.replaceState(null, "", "/w/ws-1/knowledge");
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
  // Cases reuse session ids: drop entries a case left following (never a Stop).
  conversationRegistry().disposeAll();
  window.history.replaceState(null, "", "/");
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

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

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
        return Response.json([
          { id: "m1", role: "user", content: "What are the vault fees?", timestamp: new Date().toISOString() },
          { id: "m2", role: "assistant", content: "Maker fee is 5 bps.", timestamp: new Date().toISOString() },
        ]);
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

for (const ending of ["claim", "disconnect", "failure", "queued", "navigate"] as const) {
  it(`[COMP:app-web/kb-chat-panel] preserves pre-start Stop until its own ${ending} receiving boundary`, async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } });
    mockAuthFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/sessions/by-channel")) return Response.json({ id: "session-a" });
      if (url.includes("/messages")) return Response.json([]);
      if (url.endsWith("/api/chat")) return new Response(body);
      if (url.includes("/api/chat/stop")) return Response.json({ stopped: true, turnId: "a".repeat(64) });
      return Response.json({ status: "idle", turnId: "b".repeat(64) });
    });
    render(<KbChatPanel workspaceId="ws-1" scope={{ kind: "manual" }} />);
    await flush(); await flush();
    const composer = host!.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Work on this source");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    act(() => (host!.querySelector(`button[aria-label="${copy.send}"]`) as HTMLButtonElement).click());
    await flush();
    expect(mockAuthFetch.mock.calls.filter(call => String(call[0]).endsWith("/api/chat"))).toHaveLength(1);
    act(() => (host!.querySelector(`button[aria-label="${copy.stop}"]`) as HTMLButtonElement).click());
    await flush();
    expect(mockAuthFetch.mock.calls.some(call => String(call[0]).includes("/api/chat/stop"))).toBe(false);
    expect(mockAuthFetch.mock.calls.some(call => String(call[0]).includes("/api/chat/status"))).toBe(false);
    act(() => wire.enqueue(new TextEncoder().encode(`event: session\ndata: ${JSON.stringify({ sessionId: "session-a", turnId: null })}\n\n`)));
    await flush();
    expect(mockAuthFetch.mock.calls.some(call => String(call[0]).includes("/api/chat/stop"))).toBe(false);
    if (ending === "claim") {
      act(() => wire.enqueue(new TextEncoder().encode(`event: session\ndata: ${JSON.stringify({ sessionId: "session-a", turnId: "a".repeat(64) })}\n\n`)));
      await flush(); await flush();
      const stops = mockAuthFetch.mock.calls.filter(call => String(call[0]).includes("/api/chat/stop"));
      expect(stops).toHaveLength(1);
      expect(JSON.parse(stops[0][1].body)).toEqual({ sessionId: "session-a", turnId: "a".repeat(64) });
    } else if (ending === "navigate") {
      act(() => root!.render(<I18nProvider locale="en" dict={dict}><KbChatPanel workspaceId="ws-1" scope={{ kind: "source", sourceId: "other" }} /></I18nProvider>));
      await flush();
      expect(host!.textContent).not.toContain(dict.chatApp.stopTurnFailed);
    } else {
      if (ending === "failure") act(() => wire.error(new Error("transport unavailable")));
      else if (ending === "queued") act(() => { wire.enqueue(new TextEncoder().encode('event: done\ndata: {"turnId":null}\n\n')); wire.close(); });
      else act(() => wire.close());
      await flush(); await flush();
      expect(host!.textContent).toContain(dict.chatApp.stopTurnFailed);
    }
    expect(mockAuthFetch.mock.calls.filter(call => String(call[0]).includes("/api/chat/stop"))).toHaveLength(ending === "claim" ? 1 : 0);
  });
}
