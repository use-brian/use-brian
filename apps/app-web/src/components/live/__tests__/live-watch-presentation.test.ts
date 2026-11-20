// @vitest-environment jsdom
/**
 * [COMP:app-web/live-watch-pane] The Live watch pane as a presentation of the
 * shared conversation controller (M5 WP-E), exercised with fake transports and
 * the pane's own capabilities and reducer: exactly one watch stream per focus,
 * closed on defocus (`releaseOnDetach`) and after 60 s hidden (`setVisible`),
 * reopened on visible, never reopened after a personal `done`; Force stop is
 * the controller's compare-and-set Stop with "already stopped" copy for a turn
 * that had ended; a 403 decision shows the not-allowed copy; a pending question
 * is restored on focus. Replaces the pane's own SSE loop, reconnect timer,
 * visibility gate, pending read, confirm POST and Stop path.
 */
import { describe, expect, it } from "vitest";
import { createConversationController } from "@/lib/chat/conversation-controller";
import { createConversationRegistry } from "@/lib/chat/conversation-registry";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import { initialWatchState, reduceWatchEvent, type WatchState } from "@/lib/live-roster";
import { liveDecisionError, liveStopCopy, liveWatchCapabilities, selectWatch } from "../live-watch-pane";

const SESSION = "session-watch";

function fixture() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  /** One focused pane: the pane's capabilities and its reducer over observed frames. */
  const focus = (id = "live-watch:1") => {
    const controller = registry.acquire(SCOPE, { sessionId: SESSION });
    const view: { watch: WatchState } = { watch: initialWatchState() };
    const detach = registry.attach(controller, id, liveWatchCapabilities((frame) => {
      if (frame.stream === "follow") view.watch = reduceWatchEvent(view.watch, { event: frame.event, data: frame.payload });
    }));
    return { controller, view, detach, id };
  };
  const openFollows = () => net.follows.filter((follow) => follow.sse && !follow.sse.aborted()).length;
  return { net, clock, registry, focus, openFollows };
}

describe("[COMP:app-web/live-watch-pane] watch stream budget through the controller", () => {
  it("opens exactly one stream per focus and closes it on defocus", async () => {
    const t = fixture();
    const pane = t.focus();
    await settle();
    expect(t.net.follows).toHaveLength(1);
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    t.net.lastFollow().sse!.send("snapshot", { turnId: TURN_A, text: "Drafting the reply" });
    await settle();
    t.clock.runFrames();
    expect(pane.view.watch.text).toBe("Drafting the reply");
    expect(selectWatch(pane.controller.getSnapshot()).live).toBe(true);

    pane.detach();
    await t.clock.advance(0);
    expect(t.openFollows()).toBe(0);
    expect(t.registry.size()).toBe(0);

    const again = t.focus("live-watch:2");
    await settle();
    expect(again.controller).not.toBe(pane.controller);
    expect(t.net.follows).toHaveLength(2);
    expect(t.openFollows()).toBe(1);
  });

  it("releases the stream after 60 s hidden and reopens it when visible", async () => {
    const t = fixture();
    const pane = t.focus();
    await settle();
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    pane.controller.setVisible(pane.id, false);
    await t.clock.advance(59_000);
    expect(t.openFollows()).toBe(1);
    await t.clock.advance(1_000);
    expect(t.openFollows()).toBe(0);
    // Released transport only: the turn still reads as running.
    expect(selectWatch(pane.controller.getSnapshot()).live).toBe(true);
    pane.controller.setVisible(pane.id, true);
    await settle();
    expect(t.net.follows).toHaveLength(2);
    expect(t.openFollows()).toBe(1);
  });

  it("never reopens a personal stream that ended at done", async () => {
    const t = fixture();
    t.net.status.current = { status: "idle", turnId: null };
    const pane = t.focus();
    await settle();
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    expect(t.openFollows()).toBe(0);
    pane.controller.setVisible(pane.id, false);
    await t.clock.advance(61_000);
    pane.controller.setVisible(pane.id, true);
    await t.clock.advance(60_000);
    expect(t.net.follows).toHaveLength(1);
  });
});

describe("[COMP:app-web/live-watch-pane] interventions through the controller", () => {
  it("Force stop sends the watched turn's ID and reports an already-ended turn", async () => {
    const t = fixture();
    const pane = t.focus();
    await settle();
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    t.net.transport.stopTurn.mockResolvedValueOnce({ stopped: false });
    expect(liveStopCopy(await pane.controller.stop())).toBe("alreadyStopped");
    expect(t.net.transport.stopTurn).toHaveBeenLastCalledWith(SESSION, TURN_A);
    expect(liveStopCopy(await pane.controller.stop())).toBe("stopRequested");
    t.net.transport.stopTurn.mockRejectedValueOnce(new Error("unavailable"));
    expect(liveStopCopy(await pane.controller.stop())).toBe("stopFailed");
  });

  it("a forbidden decision keeps the card and maps to the not-allowed copy", async () => {
    const t = fixture();
    const pane = t.focus();
    await settle();
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("activity", { turnId: TURN_A, event: "tool_confirmation_required", toolCallId: "tool-1", toolName: "sendEmail" });
    await settle();
    const card = selectWatch(pane.controller.getSnapshot()).confirmation;
    expect(card?.toolCallId).toBe("tool-1");
    t.net.transport.confirmLive.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(liveDecisionError(await pane.controller.respondConfirmation("tool-1", "approve"))).toBe("confirmNotAllowed");
    expect(selectWatch(pane.controller.getSnapshot()).confirmation?.status).toBe("pending");
    expect(liveDecisionError(await pane.controller.respondConfirmation("tool-1", "approve"))).toBeNull();
  });

  it("restores a pending question on focus and follows the resumed turn once settled", async () => {
    const t = fixture();
    t.net.pending.current = { pending: { approvalId: "question-1", question: "Which draft?", expiresAt: null }, toolConfirmation: null };
    const pane = t.focus();
    await settle();
    expect(selectWatch(pane.controller.getSnapshot()).question?.approvalId).toBe("question-1");
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    expect(pane.controller.questionSettled("question-1")).toBe(true);
    await settle();
    expect(selectWatch(pane.controller.getSnapshot()).question).toBeNull();
    expect(t.openFollows()).toBe(1);
  });
});

describe("[COMP:app-web/mid-turn-queue] Live Steer now through the controller's queue", () => {
  async function runningPane() {
    const t = fixture();
    const pane = t.focus();
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    return { t, pane };
  }

  it("posts a steer on the side connection and retires it when the watch stream mirrors input_applied", async () => {
    const { t, pane } = await runningPane();
    expect(pane.controller.queue("Use the shorter outline", true, { presentationId: pane.id })).toBe(true);
    await settle();
    expect(t.net.sides).toHaveLength(1);
    expect(t.net.sides[0]).toMatchObject({ midTurn: true, steer: true, sessionId: SESSION, message: "Use the shorter outline" });
    const inputId = t.net.sides[0]!.inputId as string;
    expect(selectWatch(pane.controller.getSnapshot()).queued.map((entry) => entry.inputId)).toEqual([inputId]);

    t.net.lastFollow().sse!.send("activity", { event: "input_applied", inputId, messageId: "applied-1", turnId: TURN_A });
    await settle();
    expect(selectWatch(pane.controller.getSnapshot()).queued).toEqual([]);

    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse!.send("turn_completed", { turnId: TURN_A });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    await t.clock.advance(0);
    // Applied: nothing is handed back and nothing is sent as a new turn.
    expect(selectWatch(pane.controller.getSnapshot()).unsentCount).toBe(0);
    expect(t.net.chats).toHaveLength(0);
  });

  it("returns a steer the turn never took to the field instead of sending it as a turn", async () => {
    const { t, pane } = await runningPane();
    expect(pane.controller.queue("Stop after the summary", true, { presentationId: pane.id })).toBe(true);
    await settle();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse!.send("turn_completed", { turnId: TURN_A });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    await t.clock.advance(0);
    expect(t.net.chats).toHaveLength(0);
    expect(selectWatch(pane.controller.getSnapshot()).unsentCount).toBe(1);
    expect(pane.controller.takeUnsent()).toEqual(["Stop after the summary"]);
  });
});
