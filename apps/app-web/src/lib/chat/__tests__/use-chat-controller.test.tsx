// @vitest-environment jsdom
/** [COMP:app-web/chat-controller] Shared host transition traces. */
import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatControllerIdentity } from "@use-brian/chat-ui";
import {
  createChatControllerCoordinator,
  useChatController,
  type ChatControllerSnapshot,
} from "../use-chat-controller";

for (const host of ["full chat", "floating chat"] as const) {
  describe(`[COMP:app-web/chat-controller] ${host}`, () => {
    it("keeps an approval through disconnect and reconnect", () => {
      let selected: string | null = "session-a";
      const controller = createChatControllerCoordinator(() => selected);
      const run = controller.begin();
      controller.presentInteraction(run, {
        kind: "tool-confirmation",
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
        source: "live",
        status: "pending",
        payload: { tool: "fileWrite" },
      });
      controller.disconnect(run);
      expect(controller.getSnapshot()).toMatchObject({
        run: { phase: "suspended", connection: "disconnected" },
        interaction: { pending: { approvalId: "approval-1" } },
      });
      controller.reconnect(run);
      controller.connected(run);
      expect(controller.getSnapshot()).toMatchObject({
        run: { phase: "suspended", connection: "connected" },
        interaction: { pending: { approvalId: "approval-1" } },
      });
      selected = null;
      controller.teardown();
    });

    it("rejects late events across session switches and A to B to A", () => {
      let selected: string | null = "session-a";
      const controller = createChatControllerCoordinator(() => selected);
      const oldA = controller.begin();
      selected = "session-b";
      controller.capture();
      selected = "session-a";
      const newA = controller.capture();
      expect(controller.complete(oldA)).toBe(false);
      expect(controller.getSnapshot().run).toMatchObject({
        identity: newA,
        phase: "idle",
      });
    });

    it("claims terminal fallback once before any rerender", () => {
      const controller = createChatControllerCoordinator(() => "session-a");
      const run = controller.begin();
      expect(controller.claimExit(run)).toBe(true);
      expect(controller.claimExit(run)).toBe(false);
      controller.complete(run);
      expect(controller.claimExit(run)).toBe(false);
    });

    it("keeps disconnect distinct from explicit Stop", () => {
      const controller = createChatControllerCoordinator(() => "session-a");
      const run = controller.begin();
      controller.disconnect(run);
      expect(controller.getSnapshot().run).toMatchObject({
        phase: "running",
        connection: "disconnected",
      });
      controller.cancel(run);
      expect(controller.getSnapshot().run).toMatchObject({
        phase: "cancelled",
        connection: "idle",
      });
    });

    it("clears registered subscription and timer work on teardown", () => {
      const controller = createChatControllerCoordinator(() => "session-a");
      const run = controller.begin();
      const cleanup = vi.fn();
      controller.registerCleanup(run, cleanup);
      controller.teardown();
      controller.teardown();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(controller.complete(run)).toBe(false);
    });
  });
}


// Keep permanent coordinator destruction distinct from a React effect replay.
describe("[COMP:app-web/chat-controller] permanent coordinator teardown", () => {
  it("cannot be revived by capture, selection or begin after explicit teardown", () => {
    let selected: string | null = "session-a";
    const controller = createChatControllerCoordinator(() => selected);
    const first = controller.begin();
    const cleanup = vi.fn();
    controller.registerCleanup(first, cleanup);
    controller.teardown();
    const snapshot = controller.getSnapshot();
    selected = "session-b";
    const captured = controller.capture();
    const begun = controller.begin();
    controller.selectSession("session-a");
    expect(controller.isCurrent(first)).toBe(false);
    expect(controller.isCurrent(captured)).toBe(false);
    expect(controller.isCurrent(begun)).toBe(false);
    expect(controller.presentInteraction(begun, {
      kind: "question", approvalId: "late-approval", source: "restored",
      status: "pending", payload: { question: "Synthetic question" },
    })).toBe(false);
    expect(controller.claimExit(begun)).toBe(false);
    expect(controller.complete(begun)).toBe(false);
    const lateCleanup = vi.fn();
    controller.registerCleanup(begun, lateCleanup);
    controller.teardown();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(lateCleanup).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toBe(snapshot);
  });
});

type MountedController = ReturnType<typeof useChatController>;
type MountVisit = { controller: MountedController; identity: ChatControllerIdentity; cleanup: ReturnType<typeof vi.fn> };

/** Actual hook + React subscription/effects; no coordinator, reducer or hook mock. */
describe("[COMP:app-web/chat-controller] mounted React lifecycle", () => {
  let root: Root;
  let container: HTMLDivElement;
  let mounted = false;
  let latest: MountedController | undefined;
  let previousActEnvironment: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = undefined;
    mounted = true;
  });
  afterEach(async () => {
    try {
      if (mounted) await act(async () => root.unmount());
      container.remove();
    } finally {
      if (previousActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });

  function Harness({ sessionId, onSetup }: {
    sessionId: string | null;
    onSetup?: (controller: MountedController) => void;
  }) {
    const selected = useRef(sessionId);
    selected.current = sessionId;
    const controller = useChatController(() => selected.current);
    latest = controller;
    useEffect(() => { onSetup?.(controller); }, [controller, onSetup]);
    return <output data-testid="controller-snapshot">{JSON.stringify(controller.state)}</output>;
  }

  const current = () => {
    if (!latest) throw new Error("Controller fixture is not mounted");
    return latest;
  };
  const shown = (): ChatControllerSnapshot => JSON.parse(container.querySelector("output")!.textContent!);
  const render = async (sessionId: string | null = "session-a", strict = true, onSetup?: (controller: MountedController) => void) => {
    const node = <Harness sessionId={sessionId} onSetup={onSetup} />;
    await act(async () => root.render(strict ? <StrictMode>{node}</StrictMode> : node));
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    mounted = false;
  };

  it("begins a current generation and renders a live approval after StrictMode setup replay", async () => {
    await render();
    let run!: ChatControllerIdentity;
    await act(async () => { run = current().begin(); });
    expect(current().isCurrent(run)).toBe(true);
    expect(shown().run).toMatchObject({ identity: run, phase: "running", connection: "connected" });
    let admitted = false;
    await act(async () => {
      admitted = current().presentInteraction(run, {
        kind: "tool-confirmation", approvalId: "approval-live", toolCallId: "tool-live",
        source: "live", status: "pending", payload: { tool: "fileWrite" },
      });
    });
    expect(admitted).toBe(true);
    expect(shown()).toMatchObject({
      run: { phase: "suspended" },
      interaction: { pending: { approvalId: "approval-live", source: "live", status: "pending" } },
    });
    await act(async () => { current().beginResponse(run, "approval-live"); });
    expect(shown().interaction.pending?.status).toBe("responding");
    await act(async () => { current().responseFailed(run, "approval-live", "Synthetic retryable error"); });
    expect(shown().interaction.pending).toMatchObject({ status: "retryable", error: "Synthetic retryable error" });
    await act(async () => { current().beginResponse(run, "approval-live"); current().resolveInteraction(run, "approval-live"); });
    expect(shown().interaction.pending).toBeNull();
  });

  it("admits the host pending-input probe and preserves its card through reconnect after replay", async () => {
    await render();
    const probe = current().capture();
    // Both real hosts check isCurrent before restoring a pending question/card.
    expect(current().isCurrent(probe)).toBe(true);
    await act(async () => {
      current().presentInteraction(probe, {
        kind: "question", approvalId: "approval-restored", source: "restored", status: "pending",
        payload: { question: "Choose the next step" },
      });
      current().disconnect(probe);
    });
    expect(shown()).toMatchObject({
      run: { phase: "suspended", connection: "disconnected" },
      interaction: { pending: { approvalId: "approval-restored", source: "restored" } },
    });
    await act(async () => { current().reconnect(probe); });
    expect(shown().run.connection).toBe("reconnecting");
    const abortFollow = vi.fn();
    const unregister = current().registerCleanup(probe, abortFollow);
    expect(abortFollow).not.toHaveBeenCalled();
    await act(async () => { current().connected(probe); });
    expect(shown()).toMatchObject({
      run: { phase: "suspended", connection: "connected" },
      interaction: { pending: { approvalId: "approval-restored" } },
    });
    unregister();
    await unmount();
    expect(abortFollow).not.toHaveBeenCalled();
  });

  it("admits exactly one terminal queue-exit claim per post-replay generation", async () => {
    await render();
    let first!: ChatControllerIdentity;
    await act(async () => { first = current().begin(); current().complete(first); });
    const flushQueue = vi.fn();
    // The same gate surrounds flushQueuedInputs in both real host onDone paths.
    if (current().claimExit(first)) flushQueue(first.sessionId);
    if (current().claimExit(first)) flushQueue(first.sessionId);
    expect(flushQueue).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(shown().run.phase).toBe("completed");
    let second!: ChatControllerIdentity;
    await act(async () => { second = current().begin(); });
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(current().claimExit(first)).toBe(false);
    expect(current().claimExit(second)).toBe(true);
    expect(current().claimExit(second)).toBe(false);
  });

  it("cleans each abandoned replay generation once and rejects its late deferred approval", async () => {
    const visits: MountVisit[] = [];
    const onSetup = (controller: MountedController) => {
      const identity = controller.capture();
      const cleanup = vi.fn(() => ({
        current: controller.isCurrent(identity),
        completed: controller.complete(identity),
        claimed: controller.claimExit(identity),
      }));
      controller.registerCleanup(identity, cleanup);
      visits.push({ controller, identity, cleanup });
    };
    await render("session-a", true, onSetup);
    expect(visits.length).toBeGreaterThanOrEqual(2); // Prove that real effect replay occurred.
    const active = visits.at(-1)!;
    const abandoned = visits.slice(0, -1);
    for (const visit of abandoned) {
      expect(visit.cleanup).toHaveBeenCalledTimes(1);
      expect(visit.cleanup.mock.results[0]?.value).toEqual({ current: false, completed: false, claimed: false });
      expect(current().isCurrent(visit.identity)).toBe(false);
    }
    expect(active.cleanup).not.toHaveBeenCalled();
    expect(current().isCurrent(active.identity)).toBe(true);
    expect(active.identity.generation).toBeGreaterThan(abandoned[0]!.identity.generation);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const lateAdmissions: boolean[] = [];
    const continuation = pending.then(() => {
      for (const visit of abandoned) {
        lateAdmissions.push(visit.controller.presentInteraction(visit.identity, {
          kind: "question", approvalId: "abandoned-approval", source: "restored", status: "pending",
          payload: { question: "Old pending probe" },
        }));
      }
    });
    await act(async () => { finish(); await continuation; });
    expect(lateAdmissions).toEqual(abandoned.map(() => false));
    expect(shown().interaction.pending).toBeNull();
    await unmount();
    for (const visit of visits) {
      expect(visit.cleanup).toHaveBeenCalledTimes(1);
      expect(visit.cleanup.mock.results[0]?.value).toEqual({ current: false, completed: false, claimed: false });
    }
  });

  it("invalidates mounted session A to B to A generations without accepting old events", async () => {
    await render("session-a");
    let oldA!: ChatControllerIdentity;
    await act(async () => { oldA = current().begin(); });
    const cleanupA = vi.fn();
    current().registerCleanup(oldA, cleanupA);
    await render("session-b");
    const b = current().capture();
    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(current().complete(oldA)).toBe(false);
    const cleanupB = vi.fn();
    current().registerCleanup(b, cleanupB);
    await render("session-a");
    const newA = current().capture();
    expect(newA.generation).toBeGreaterThan(b.generation);
    expect(newA.generation).toBeGreaterThan(oldA.generation);
    expect(cleanupB).toHaveBeenCalledTimes(1);
    expect(current().isCurrent(newA)).toBe(true);
    const before = shown();
    expect(current().complete(oldA)).toBe(false);
    expect(current().cancel(b)).toBe(false);
    expect(current().presentInteraction(oldA, {
      kind: "question", approvalId: "old-session-approval", source: "restored", status: "pending", payload: {},
    })).toBe(false);
    expect(shown()).toEqual(before);
    expect(shown().run).toMatchObject({ identity: newA, phase: "idle" });
    await act(async () => { current().begin(); });
    expect(shown().run.phase).toBe("running");
  });

  it.each([false, true])("actual unmount permanently rejects late work (StrictMode=%s)", async strict => {
    await render("session-a", strict);
    const controller = current();
    let run!: ChatControllerIdentity;
    await act(async () => { run = controller.begin(); });
    expect(controller.isCurrent(run)).toBe(true);
    const abortStream = vi.fn();
    controller.registerCleanup(run, abortStream);
    expect(abortStream).not.toHaveBeenCalled();
    await unmount();
    expect(abortStream).toHaveBeenCalledTimes(1);
    expect(controller.complete(run)).toBe(false);
    expect(controller.claimExit(run)).toBe(false);
    const afterUnmount = controller.begin();
    expect(controller.isCurrent(afterUnmount)).toBe(false);
    const lateCleanup = vi.fn();
    controller.registerCleanup(afterUnmount, lateCleanup);
    expect(lateCleanup).toHaveBeenCalledTimes(1);
    controller.teardown();
    expect(abortStream).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });
});
