// @vitest-environment jsdom
/** [COMP:app-web/live-watch-pane] Actual mounted turn receiving and Stop CAS through the shared controller. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { LiveWatchPane } from "../live-watch-pane";

const net = vi.hoisted(() => ({
  output: null as ReadableStreamDefaultController<Uint8Array> | null,
  status: { status: "running", turnId: "a".repeat(64), turnEndReason: null as string | null },
  stops: [] as unknown[],
}));
vi.mock("@/lib/api/sessions", async original => ({
  ...await original<typeof import("@/lib/api/sessions")>(),
  fetchSessionMessages: vi.fn(async () => []),
}));
vi.mock("@/lib/api/pending-questions", async original => ({
  ...await original<typeof import("@/lib/api/pending-questions")>(),
  fetchPendingSessionInput: vi.fn(async () => ({ pending: null, toolConfirmation: null })),
}));
// The pane is a controller presentation: it needs a signed-in write authority.
vi.mock("@/lib/user", async original => ({
  ...await original<typeof import("@/lib/user")>(),
  getUserInfo: () => ({ id: "viewer-a" }),
  subscribeUserInfo: () => () => {},
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({ start(output) { net.output = output; } }));
  if (url.endsWith("/api/chat/stop")) { net.stops.push(JSON.parse(String(init?.body))); return Response.json({ stopped: true, turnId: net.status.turnId }); }
  return Response.json(net.status);
}) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  net.status = { status: "running", turnId: "a".repeat(64), turnEndReason: null };
  net.stops = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>
    <LiveWatchPane sessionId="session-a" workspaceId="workspace-a" sessionState="working" canSteer />
  </I18nProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function frame(event: string, data: unknown) {
  await act(async () => {
    net.output!.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe("[COMP:app-web/live-watch-pane] correlated live receiving", () => {
  it("keeps the successor live after old activity/completion and uses its ID for Stop", async () => {
    const first = "a".repeat(64), successor = "b".repeat(64);
    // The list can still describe the previous settled owner. Fresh current
    // status owns this watch's controls once a successor is running.
    await act(async () => root.render(<I18nProvider locale="en" dict={en}>
      <LiveWatchPane sessionId="session-a" workspaceId="workspace-a" sessionState="settled" canSteer />
    </I18nProvider>));
    await frame("status", { ...net.status });
    await frame("snapshot", { turnId: first, text: "Earlier live reply" });
    net.status = { status: "running", turnId: successor, turnEndReason: null };
    await frame("turn_started", { turnId: successor });
    await frame("snapshot", { turnId: successor, text: "Current live reply" });
    await frame("activity", { turnId: first, event: "tool_start", name: "obsolete" });
    await frame("turn_completed", { turnId: first, reason: "failed" });
    await frame("done", { turnId: first });
    expect(host.textContent).toContain("Current live reply");
    expect(host.textContent).not.toContain(en.liveApp.turnEndedAbnormally);
    const stop = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes(en.liveApp.forceStop));
    expect(stop).toBeDefined();
    await act(async () => stop!.click());
    expect(net.stops).toEqual([{ sessionId: "session-a", turnId: successor }]);
    net.status = { status: "idle", turnId: successor, turnEndReason: "publication_recovered" };
    await frame("turn_completed", { turnId: successor, reason: "publication_recovered" });
    await frame("done", { turnId: successor });
    expect(host.textContent).toContain(en.liveApp.turnEnded);
    expect(host.textContent).not.toContain(en.liveApp.turnEndedAbnormally);
  });
});
