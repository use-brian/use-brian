// @vitest-environment jsdom
/** [COMP:app-web/chat-controller] Shared host transition traces. */
import { act, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageStream, type ChatControllerIdentity } from "@use-brian/chat-ui";
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
  let latestStream: ReturnType<typeof useMessageStream> | undefined;
  let previousActEnvironment: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = undefined;
    latestStream = undefined;
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
    latestStream = useMessageStream();
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

  it("the real stream hook rejects an old completion after a successor takes the transport", async () => {
    await render();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const oldDone = vi.fn(), newDone = vi.fn();
    const old = latestStream!.start({
      url: "https://api.example/chat", body: {},
      authFetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { output = controller; } })),
      onEvent: async () => { await blocked; }, onDone: oldDone,
    });
    await act(async () => {
      output.enqueue(new TextEncoder().encode(`event: reply_complete\ndata: {"turnId":"${"a".repeat(64)}"}\n\n`));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const successor = latestStream!.start({
      url: "https://api.example/chat", body: {},
      authFetch: async () => new Response(`event: done\ndata: {"turnId":"${"b".repeat(64)}"}\n\n`),
      onEvent: () => undefined, onDone: newDone,
    });
    await act(async () => {
      unblock(); output.close(); await Promise.all([old, successor]);
    });
    expect(oldDone).not.toHaveBeenCalled();
    expect(newDone).toHaveBeenCalledExactlyOnceWith({ event: "done", turnId: "b".repeat(64) });
    expect(latestStream!.inFlight()).toBe(false);
  });

});

/** Actual coordinator ownership boundary used by full/floating/Doc/Office/watch. */
describe("[COMP:app-web/chat-controller] public turn receiving", () => {
  const first = "a".repeat(64), next = "b".repeat(64);
  const unavailable = async (): Promise<never> => { throw new Error("unavailable"); };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  };

  it.each(["turn_completed", "done", "reply_complete"])("does not let old %s clear a pending successor or its approval", async event => {
    const controller = createChatControllerCoordinator(() => "session-a");
    const old = controller.begin();
    controller.bindTurn(old, first);
    const successor = controller.begin();
    controller.presentInteraction(successor, { kind: "question", approvalId: "successor-question", source: "live", status: "pending", payload: {} });
    const accepted = await controller.receiveTurnEvent(successor, event, { turnId: first }, async () => ({ status: "idle", turnId: first }));
    if (accepted) controller.complete(successor);
    expect(accepted).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ run: { phase: "suspended" }, interaction: { pending: { approvalId: "successor-question" } } });
    expect(controller.claimExit(old)).toBe(false);
  });

  it("invalidates a delayed idle status ticket before the successor starts", async () => {
    const controller = createChatControllerCoordinator(() => "session-a");
    const follow = controller.capture();
    const pending = deferred<{ status: string; turnId: string | null }>();
    const oldRead = controller.receiveTurnEvent(follow, "status", { status: "idle" }, () => pending.promise);
    const successor = controller.begin();
    controller.bindTurn(successor, next);
    pending.resolve({ status: "idle", turnId: first });
    expect(await oldRead).toBe(false);
    expect(controller.getSnapshot().run.phase).toBe("running");
    expect(controller.getTurnId()).toBe(next);
  });

  it("fences terminal catch-up across a session switch during its fresh status read", async () => {
    let selected = "session-a";
    const controller = createChatControllerCoordinator(() => selected);
    const identity = controller.capture(); controller.bindTurn(identity, first);
    const pending = deferred<{ status: string; turnId: string | null }>();
    const caughtUp = controller.receiveTurnEvent(identity, "status", { status: "idle", turnId: next }, () => pending.promise, false, true);
    selected = "session-b"; const successor = controller.begin(); controller.bindTurn(successor, first);
    pending.resolve({ status: "idle", turnId: next });
    expect(await caughtUp).toBe(false);
    expect(controller.getSnapshot().run).toMatchObject({ phase: "running", identity: successor });
    expect(controller.getTurnId()).toBe(first);
  });

  it("cannot use delayed old terminal catch-up to settle a newer followed owner", async () => {
    const controller = createChatControllerCoordinator(() => "session-a");
    const identity = controller.capture(); controller.bindTurn(identity, first);
    const pending = deferred<{ status: string; turnId: string | null }>();
    const old = controller.receiveTurnEvent(identity, "status", { status: "idle", turnId: first }, () => pending.promise, false, true);
    expect(await controller.receiveTurnEvent(identity, "status", { status: "running", turnId: next }, async () => ({ status: "running", turnId: next }))).toBe(true);
    pending.resolve({ status: "idle", turnId: first });
    expect(await old).toBe(false);
    expect(controller.getTurnId()).toBe(next);
    expect(controller.getSnapshot().run.phase).toBe("running");
  });

  it("requires current status before adopting a different room start and ignores old activity", async () => {
    const controller = createChatControllerCoordinator(() => "session-a");
    const follow = controller.capture();
    expect(await controller.receiveTurnEvent(follow, "turn_started", { turnId: first }, async () => ({ status: "running", turnId: next }))).toBe(false);
    expect(controller.getTurnId()).toBe(next);
    expect(await controller.receiveTurnEvent(follow, "snapshot", { turnId: first, text: "obsolete" }, async () => ({ status: "running", turnId: next }))).toBe(false);
    expect(await controller.receiveTurnEvent(follow, "turn_completed", { turnId: first }, async () => ({ status: "running", turnId: next }))).toBe(false);
    expect(await controller.receiveTurnEvent(follow, "activity", { turnId: next }, unavailable)).toBe(true);
  });

  it("reconciles unknown legacy terminal frames freshly without mistaking running for idle", async () => {
    const controller = createChatControllerCoordinator(() => "session-a");
    const run = controller.begin();
    controller.bindTurn(run, first);
    expect(await controller.receiveTurnEvent(run, "done", {}, unavailable)).toBe(false);
    expect(await controller.receiveTurnEvent(run, "done", {}, async () => ({ status: "running", turnId: first }))).toBe(false);
    expect(await controller.receiveTurnEvent(run, "done", {}, async () => ({ status: "idle", turnId: first }))).toBe(true);
    expect(await controller.receiveTurnEvent(run, "done", { turnId: "invalid" }, async () => ({ status: "idle", turnId: first }))).toBe(false);
  });

  it("supports a legacy direct terminal only after its captured fresh idle read", async () => {
    const controller = createChatControllerCoordinator(() => "session-a");
    const run = controller.begin();
    expect(await controller.receiveTurnEvent(run, "status", { status: "idle" }, async () => ({ status: "idle", turnId: null }))).toBe(false);
    expect(await controller.receiveTurnEvent(run, "done", {}, async () => ({ status: "idle", turnId: null }), true)).toBe(true);
    controller.complete(run);
    expect(controller.getSnapshot().run.phase).toBe("completed");
  });
});

it("[COMP:app-web/chat-controller] a completed owner's delayed start and snapshot cannot restart its spinner", async () => {
  const controller = createChatControllerCoordinator(() => "session-a");
  const run = controller.capture(), turnId = "a".repeat(64);
  controller.bindTurn(run, turnId);
  expect(await controller.receiveTurnEvent(run, "turn_completed", { turnId }, async () => ({ status: "idle", turnId }))).toBe(true);
  expect(controller.getSnapshot().run.phase).toBe("completed");
  for (const event of ["turn_started", "snapshot", "activity"]) {
    expect(await controller.receiveTurnEvent(run, event, { turnId }, async () => ({ status: "idle", turnId }))).toBe(false);
  }
  expect(controller.getSnapshot().run.phase).toBe("completed");
});
