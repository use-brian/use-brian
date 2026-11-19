/**
 * [COMP:app-web/conversation-controller] Room live-progress ownership at the
 * controller boundary. Ported in M5 WP-F from the deleted
 * `shouldAcceptRoomMirror` predicate tests (`lib/__tests__/chat-session-events.test.ts`):
 * the controller's own-echo gate now owns the rule.
 */
import { describe, expect, it } from "vitest";
import { createConversationController } from "../conversation-controller";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "./conversation-fakes";

async function roomTurn() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const controller = createConversationController({
    scope: SCOPE, sessionId: "s-1", room: true, transport: net.transport, scheduler: clock.scheduler,
  });
  controller.attach("host", { profile: "page" });
  await settle();
  controller.send({ presentationId: "host", text: "Hello" });
  await settle();
  const direct = net.lastChat().sse;
  direct.send("session", { sessionId: "s-1", turnId: TURN_A });
  await settle();
  const follow = net.lastFollow().sse!;
  const snapshot = async (payload: Record<string, unknown>) => {
    follow.send("snapshot", { turnId: TURN_A, ...payload });
    await settle();
    clock.runFrames();
  };
  return { net, controller, direct, snapshot, mirror: () => controller.getSnapshot().mirror };
}

describe("[COMP:app-web/conversation-controller] room live-progress ownership", () => {
  it("suppresses the own mirror while this room's direct POST is live", async () => {
    const t = await roomTurn();
    await t.snapshot({ text: "own echo", senderUserId: SCOPE.viewerId });
    expect(t.mirror().active).toBe(false);
  });

  it("suppresses an exact-room mirror that names no sender while the POST is live", async () => {
    const t = await roomTurn();
    await t.snapshot({ text: "unnamed echo" });
    expect(t.mirror().active).toBe(false);
  });

  it("always accepts a teammate's mirrored turn", async () => {
    const t = await roomTurn();
    await t.snapshot({ text: "teammate", senderUserId: "viewer-2" });
    expect(t.mirror()).toMatchObject({ active: true, text: "teammate" });
  });

  it("accepts the sender's own mirror once the direct POST no longer paints the turn", async () => {
    const t = await roomTurn();
    t.direct.close();
    await settle();
    await t.snapshot({ text: "returning sender", senderUserId: SCOPE.viewerId });
    expect(t.mirror()).toMatchObject({ active: true, text: "returning sender" });
  });
});

describe("[COMP:app-web/turn-reconnect] follow lifecycle at the controller", () => {
  it("never reopens a personal follow after done", async () => {
    const net = fakeTransport();
    const clock = fakeScheduler();
    const controller = createConversationController({ scope: SCOPE, sessionId: null, transport: net.transport, scheduler: clock.scheduler });
    controller.attach("host", { profile: "page" });
    controller.send({ presentationId: "host", text: "Hello" });
    await settle();
    const direct = net.lastChat().sse;
    direct.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    direct.close(); // bare close: the follow opens to re-attach
    await settle();
    expect(net.follows).toHaveLength(1);
    net.status.current = { status: "idle", turnId: TURN_A };
    net.lastFollow().sse!.send("done", { turnId: TURN_A });
    await settle();
    net.lastFollow().sse!.close();
    await settle();
    await clock.advance(60_000);
    expect(net.follows).toHaveLength(1);
  });

  it("reopens a room follow after any close, done included", async () => {
    const net = fakeTransport();
    const clock = fakeScheduler();
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-1", room: true, transport: net.transport, scheduler: clock.scheduler });
    controller.attach("host", { profile: "page" });
    await settle();
    expect(net.follows).toHaveLength(1);
    net.lastFollow().sse!.send("done", {});
    net.lastFollow().sse!.close();
    await settle();
    await clock.advance(clock.timerDelays()[0] ?? 0);
    await settle();
    expect(net.follows.length).toBeGreaterThan(1);
  });
});
