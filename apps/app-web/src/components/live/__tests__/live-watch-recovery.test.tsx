// @vitest-environment jsdom
/** [COMP:app-web/live-watch-pane] Mounted Ask state and read-only reconnect. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ fetch: vi.fn(), history: vi.fn(), stop: vi.fn(), take: vi.fn(), drain: vi.fn(() => []), queue: vi.fn(), steer: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: f.fetch }));
vi.mock("@/lib/api/sessions", () => ({ fetchSessionMessages: f.history, stopTurn: f.stop, extractMessageText: () => "", stripAttachmentMarkup: (s: string) => s }));
vi.mock("@/lib/use-mid-turn-queue", () => ({ useMidTurnQueue: () => ({ take: f.take, drain: f.drain, queue: f.queue, steer: f.steer, queued: [] }) }));
vi.mock("@/components/chrome/chat-confirmation-card", () => ({ ChatConfirmationCard: ({ confirmation }: any) => <div data-approval={confirmation.approvalId ?? confirmation.toolCallId}>{confirmation.toolName}</div> }));
import { LiveWatchPane } from "../live-watch-pane";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";

let host: HTMLDivElement, root: Root;
let pending: Array<Response | Promise<Response>>;
let streamFailures: number;
let controllers: ReadableStreamDefaultController<Uint8Array>[];
let streamCalls: number;
const empty = () => new Response(JSON.stringify({ pending: null, toolConfirmation: null, externalConfirmations: [] }));
const ask = (id = "approval-1") => new Response(JSON.stringify({ pending: null, toolConfirmation: { approvalId: id, toolName: "new_task_with_context", input: { context: { project: "brian" } }, description: null, displayLines: [], allowPersistentApproval: false, expiresAt: null, createdAt: null } }));
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function mount(sessionId = "s1") {
  await act(async () => { root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><LiveWatchPane key={sessionId} sessionId={sessionId} workspaceId="w1" sessionState="working" canSteer /></I18nProvider>); await flush(); });
}
async function refresh() {
  await act(async () => { window.dispatchEvent(new CustomEvent(APPROVALS_REFRESH_EVENT, { detail: { workspaceId: "w1" } })); await flush(); });
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  pending = []; controllers = []; streamFailures = 0; streamCalls = 0;
  f.history.mockResolvedValue([]);
  f.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (String(url).endsWith("/pending")) return pending.shift() ?? empty();
    if (String(url).endsWith("/stream")) {
      streamCalls++;
      if (streamFailures-- > 0) throw new TypeError("offline");
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controllers.push(controller);
        options?.signal?.addEventListener("abort", () => { try { controller.error(new DOMException("aborted", "AbortError")); } catch {} }, { once: true });
      } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("Unexpected route");
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); await flush(); }); host.remove(); vi.useRealTimers(); });

describe("[COMP:app-web/live-watch-pane] approval recovery", () => {
  it("preserves a mounted Ask on HTTP503 and later recovers without any approval mutation", async () => {
    pending.push(ask()); await mount();
    expect(host.querySelector('[data-approval="approval-1"]')).not.toBeNull();
    pending.push(new Response("unavailable", { status: 503 }), ask("approval-2"));
    await refresh();
    expect(host.querySelector('[data-approval="approval-1"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await flush(); });
    expect(host.querySelector('[data-approval="approval-2"]')).not.toBeNull();
    expect(f.fetch.mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
    expect(streamCalls).toBe(1);
  });
  it.each([401, 403, 404])("clears mounted Ask when authenticated recovery loses session authority (%s)", async status => {
    pending.push(ask()); await mount();
    pending.push(new Response("unavailable", { status })); await refresh();
    expect(host.querySelector("[data-approval]")).toBeNull();
  });
  it("clears a mounted card on an authoritative successful empty result", async () => {
    pending.push(ask()); await mount(); pending.push(empty()); await refresh();
    expect(host.querySelector("[data-approval]")).toBeNull();
  });
  it("recovers a pending Ask and one watch stream after transport loss without a done event", async () => {
    pending.push(new Response("unavailable", { status: 500 }), ask()); streamFailures = 1;
    await mount(); expect(streamCalls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await flush(); });
    expect(host.querySelector('[data-approval="approval-1"]')).not.toBeNull();
    expect(streamCalls).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); await flush(); });
    expect(streamCalls).toBe(2);
  });
  it("does not fetch in hidden views, and recovers on visibility return", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    // The one mount snapshot remains allowed; periodic recovery/stream is gated.
    pending.push(empty()); await mount();
    expect(streamCalls).toBe(0);
    const count = f.fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.fetch.mock.calls).toHaveLength(count);
    pending.push(ask()); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await flush(); });
    expect(host.querySelector('[data-approval="approval-1"]')).not.toBeNull();
    expect(streamCalls).toBe(1);
  });
  it("deduplicates slow pending reads across periodic, online and workspace signals", async () => {
    let finish!: (response: Response) => void;
    pending.push(new Promise(resolve => { finish = resolve; })); await mount();
    await refresh();
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/pending"))).toHaveLength(1);
    await act(async () => { finish(ask()); await flush(); });
    expect(host.querySelector('[data-approval="approval-1"]')).not.toBeNull();
    expect(streamCalls).toBe(1);
  });
  it("does not let an old empty read erase a newer mirrored Ask", async () => {
    let finish!: (response: Response) => void;
    pending.push(new Promise(resolve => { finish = resolve; })); await mount();
    await act(async () => {
      controllers[0]!.enqueue(new TextEncoder().encode('event: activity\ndata: {"event":"tool_confirmation_required","toolCallId":"live-1","toolName":"mcp_call","input":{}}\n\n'));
      await flush();
      finish(empty()); await flush();
    });
    expect(host.querySelector('[data-approval="live-1"]')).not.toBeNull();
  });
  it("refuses a pre-end Ask snapshot and never reopens an ended watch stream", async () => {
    let finish!: (response: Response) => void;
    pending.push(new Promise(resolve => { finish = resolve; })); await mount();
    await act(async () => {
      controllers[0]!.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
      await flush(); finish(ask("stopped-turn")); await flush();
    });
    expect(host.querySelector("[data-approval]")).toBeNull();
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(streamCalls).toBe(1);
  });
  it("does not apply a late pending result to a different session", async () => {
    let finish!: (response: Response) => void;
    pending.push(new Promise(resolve => { finish = resolve; })); await mount("s1");
    pending.push(ask("new-session")); await mount("s2");
    await act(async () => { finish(ask("old-session")); await flush(); });
    expect(host.querySelector('[data-approval="new-session"]')).not.toBeNull();
    expect(host.querySelector('[data-approval="old-session"]')).toBeNull();
  });
});
