// @vitest-environment jsdom
/**
 * [COMP:app-web/conversation-registry] [COMP:app-web/chat-controller]
 * Scoped ownership above unmount: isolation, identity switch, StrictMode,
 * shared presentations, provisional re-key and the detached live cap.
 */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatControllerIdentity } from "@use-brian/chat-ui";
import { createConversationController } from "../conversation-controller";
import { createConversationRegistry, createDefaultConversationTransport, installConversationIdentityHooks, provisionalConversationKey } from "../conversation-registry";
import { useConversation } from "../use-conversation";
import { useChatController } from "../use-chat-controller";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "./conversation-fakes";

const retained = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/offline/chat-history-cache", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/offline/chat-history-cache")>(), retainedChatHistoryIsCurrent: async () => retained.current }));
const authority = vi.hoisted(() => ({ current: { apiOrigin: "https://api.example", viewerId: "viewer-1", workspaceId: "workspace-1", applicationId: "native" } as Record<string, string> | null }));
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: () => authority.current }));

function fixture(liveCap?: number) {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const identity = { current: { viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin } as { viewerId: string; apiOrigin: string } | null };
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => identity.current,
    liveCap,
  });
  return { net, clock, registry, identity };
}

describe("[COMP:app-web/conversation-registry] scope isolation and identity", () => {
  it("keys entries by deployment, viewer and workspace", () => {
    const { registry } = fixture();
    const a = registry.acquire(SCOPE, { sessionId: "s-1" });
    expect(registry.acquire(SCOPE, { sessionId: "s-1" })).toBe(a);
    expect(registry.acquire({ ...SCOPE, viewerId: "viewer-2" }, { sessionId: "s-1" })).not.toBe(a);
    expect(registry.acquire({ ...SCOPE, apiOrigin: "https://other.example" }, { sessionId: "s-1" })).not.toBe(a);
    expect(registry.acquire({ ...SCOPE, workspaceId: "workspace-2" }, { sessionId: "s-1" })).not.toBe(a);
  });

  it("consults the current durable fence before a delayed cross-window signal changes a mounted transcript", async () => {
    const { registry } = fixture();
    const controller = registry.acquire(SCOPE, { sessionId: "s-1" });
    registry.attach(controller, "page", { profile: "page" });
    const messages = [{ id: "reply", role: "assistant" as const, text: "Newly admitted reply", timestamp: new Date("2026-11-18T00:00:00Z") }];
    controller.loadMessages(messages);
    retained.current = true;
    await registry.reconcileCacheFence(SCOPE);
    expect(controller.getSnapshot().transcript.messages).toEqual(messages);
    retained.current = false;
    await registry.reconcileCacheFence({ ...SCOPE, viewerId: "someone-else" });
    expect(controller.getSnapshot().transcript.messages).toEqual(messages);
    await registry.reconcileCacheFence(SCOPE);
    expect(controller.getSnapshot().transcript.messages).toEqual([]);
    registry.disposeAll(); retained.current = true;
  });

  it("disposes the previous identity's entries on a switch without a Stop request", async () => {
    const { registry, net, identity } = fixture();
    const previous = registry.acquire(SCOPE, { provisional: provisionalConversationKey("page", "c1") });
    registry.attach(previous, "page-1", { profile: "page" });
    const sent = previous.send({ presentationId: "page-1", text: "Private question" });
    await settle();
    const other = registry.acquire({ ...SCOPE, viewerId: "viewer-2" }, { sessionId: "s-9" });
    registry.attach(other, "page-2", { profile: "page" });
    identity.current = { viewerId: "viewer-2", apiOrigin: SCOPE.apiOrigin };
    const handlers = new Map<string, () => void>();
    let restored: (() => void) | undefined;
    installConversationIdentityHooks(registry, {
      target: { addEventListener: (name: string, listener: () => void) => handlers.set(name, listener), removeEventListener: () => {} } as never,
      onSessionRestored: (callback) => { restored = callback; return () => {}; },
    });
    restored!();
    expect(previous.isDisposed()).toBe(true);
    expect(other.isDisposed()).toBe(false);
    expect(net.lastChat().sse.aborted()).toBe(true);
    expect(await sent).toBe("disposed");
    expect(net.transport.stopTurn).not.toHaveBeenCalled();
    // A late frame for the old identity cannot repopulate anything.
    net.lastChat().sse.send("text_delta", { text: "late" });
    await settle();
    expect(previous.getSnapshot().transcript.messages).toEqual([]);
    handlers.get("brian:local-data-cleared")!();
    expect(other.isDisposed()).toBe(true);
    expect(registry.size()).toBe(0);
  });
});

describe("[COMP:app-web/conversation-registry] shared presentations and re-key", () => {
  it("attaches two presentations of one session to one controller and one stream", async () => {
    const { registry, net } = fixture();
    const dock = registry.acquire(SCOPE, { sessionId: "s-1" });
    const drawer = registry.acquire(SCOPE, { sessionId: "s-1" });
    expect(drawer).toBe(dock);
    registry.attach(dock, "dock", { profile: "dock" });
    registry.attach(drawer, "drawer", { profile: "dock" });
    await settle();
    expect(net.follows).toHaveLength(1);
    expect(dock.getSnapshot().presentations).toBe(2);
  });

  it("re-keys a provisional entry on its session frame and never merges two controllers", async () => {
    const { registry, net } = fixture();
    const provisional = registry.acquire(SCOPE, { provisional: "new:page:c1" });
    registry.attach(provisional, "page", { profile: "page" });
    void provisional.send({ presentationId: "page", text: "First" });
    await settle();
    net.lastChat().sse.send("session", { sessionId: "s-new", turnId: TURN_A });
    await settle();
    expect(registry.lookup(SCOPE, { sessionId: "s-new" })).toBe(provisional);
    // The provisional key stays an alias, so a render that has not learned the
    // session id yet reaches the same controller instead of a fresh one.
    expect(registry.lookup(SCOPE, { provisional: "new:page:c1" })).toBe(provisional);
    expect(registry.acquire(SCOPE, { provisional: "new:page:c1" })).toBe(provisional);

    const owner = registry.acquire(SCOPE, { sessionId: "s-taken" });
    registry.attach(owner, "dock", { profile: "dock" });
    const second = registry.acquire(SCOPE, { provisional: "new:page:c2" });
    registry.attach(second, "page-2", { profile: "page" });
    void second.send({ presentationId: "page-2", text: "Second" });
    await settle();
    net.lastChat().sse.send("session", { sessionId: "s-taken", turnId: TURN_A });
    await settle();
    expect(registry.lookup(SCOPE, { sessionId: "s-taken" })).toBe(owner);
    expect(registry.lookup(SCOPE, { provisional: "new:page:c2" })).toBe(second);
    expect(second.getSessionId()).toBe("s-taken");
  });

  it("keeps at most four detached live turns, evicting the least recently used", async () => {
    const { registry, net, clock } = fixture();
    const controllers = [];
    for (let i = 0; i < 6; i++) {
      const controller = registry.acquire(SCOPE, { provisional: `new:page:${i}` });
      const detach = registry.attach(controller, `p-${i}`, { profile: "page" });
      void controller.send({ presentationId: `p-${i}`, text: `turn ${i}` });
      controllers.push({ controller, detach });
    }
    await settle();
    const idle = registry.acquire(SCOPE, { sessionId: "s-idle" });
    registry.attach(idle, "idle", { profile: "page" })();
    for (const { detach } of controllers) detach();
    await clock.advance(0);
    expect(idle.isDisposed()).toBe(true);
    expect(controllers.map(({ controller }) => controller.isDisposed())).toEqual([true, true, false, false, false, false]);
    expect(net.chats[0]!.sse.aborted()).toBe(true);
    expect(net.chats[5]!.sse.aborted()).toBe(false);
    expect(net.transport.stopTurn).not.toHaveBeenCalled();
  });
});

describe("[COMP:app-web/conversation-registry] policy and transport", () => {
  it("never changes an existing entry while acquiring (acquire runs during render)", async () => {
    const { registry, net } = fixture();
    const entry = registry.acquire(SCOPE, { sessionId: "s-1" });
    registry.attach(entry, "page", { profile: "page" });
    await settle();
    const published = vi.fn();
    entry.subscribe(published);
    expect(registry.acquire(SCOPE, { sessionId: "s-1" }, { room: true })).toBe(entry);
    expect(entry.isRoom()).toBe(false);
    expect(published).not.toHaveBeenCalled();
    const opened = net.follows.length;
    entry.setRoom(true);
    await settle();
    expect(net.follows.length).toBe(opened + 1);
  });

  it("the default transport loads authorized history rows for presentation mapping", () => {
    expect(typeof createDefaultConversationTransport().fetchHistoryRows).toBe("function");
  });
});

describe("[COMP:app-web/conversation-registry] mounted presentations", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("StrictMode attach keeps one entry, one hydrate probe and survives unmount while live", async () => {
    const { registry, net, clock } = fixture();
    let seen = null as ReturnType<typeof useConversation<string>> | null;
    function Dock() {
      seen = useConversation({ workspaceId: "workspace-1", sessionId: "s-1", provisionalKey: "new:dock:x", presentationId: "dock", capabilities: { profile: "dock" }, registry },
        (state) => state.run.phase);
      return <output>{seen.value}</output>;
    }
    await act(async () => root.render(<StrictMode><Dock /></StrictMode>));
    await act(async () => { await settle(); });
    expect(registry.size()).toBe(1);
    expect(net.follows).toHaveLength(1);
    net.status.current = { status: "running", turnId: TURN_A };
    await act(async () => { net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A }); await settle(); });
    expect(container.textContent).toBe("running");
    const controller = seen!.controller!;
    await act(async () => root.render(<StrictMode><p /></StrictMode>));
    await act(async () => { await clock.advance(0); });
    expect(controller.isDisposed()).toBe(false);
    await act(async () => root.render(<StrictMode><Dock /></StrictMode>));
    expect(seen!.controller).toBe(controller);
    expect(container.textContent).toBe("running");
  });

  it("C18: useConversation forwards queueDrain through its capability proxy", async () => {
    const { registry, net, clock } = fixture();
    let seen = null as ReturnType<typeof useConversation<string>> | null;
    function Live() {
      seen = useConversation({ workspaceId: "workspace-1", sessionId: null, provisionalKey: "new:live:x", presentationId: "live",
        capabilities: { profile: "page", queueDrain: "return" }, registry }, (state) => state.run.phase);
      return null;
    }
    await act(async () => root.render(<StrictMode><Live /></StrictMode>));
    const controller = seen!.controller!;
    let sent!: Promise<unknown>;
    await act(async () => { sent = controller.send({ presentationId: "live", text: "Watch" }); await settle(); });
    const sse = net.lastChat().sse;
    await act(async () => { sse.send("session", { sessionId: "s-live", turnId: TURN_A }); await settle(); });
    expect(controller.queue("steer, not send", true, { presentationId: "live" })).toBe(true);
    await act(async () => { sse.send("done", { turnId: TURN_A }); sse.close(); await sent; await clock.advance(0); });
    expect(controller.getSnapshot().unsent).toEqual(["steer, not send"]);
    expect(net.chats).toHaveLength(1);
  });

  it("re-expresses useChatController over the registry with its old lifecycle", async () => {
    const { registry } = fixture();
    let coordinator = null as ReturnType<typeof useChatController> | null;
    function Host() { coordinator = useChatController(() => "s-1", registry); return null; }
    await act(async () => root.render(<StrictMode><Host /></StrictMode>));
    expect(registry.presentationCoordinatorCount()).toBe(1);
    let run!: ChatControllerIdentity;
    await act(async () => { run = coordinator!.begin(); });
    expect(coordinator!.isCurrent(run)).toBe(true);
    await act(async () => root.render(<p />));
    expect(registry.presentationCoordinatorCount()).toBe(0);
    expect(coordinator!.isCurrent(run)).toBe(false);
  });
});
