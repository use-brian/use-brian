/**
 * [COMP:app-web/chat-controller] A pending explicit Stop waits for the
 * original direct POST to name its public owner, never stops a successor and
 * never paints a stale failure.
 *
 * The full page and every dock instance stop through the conversation
 * controller's one `stop()` (chat-app.md → "Stopping a turn"), so those
 * cases run at the controller boundary with fake transports, once per
 * presentation profile. The Feed tuning chat is a `page`-profile presentation
 * since M5 WP-E, so the page cases cover its Stop (its former AST-executed
 * callback was deleted with it).
 */
import { describe, expect, it } from "vitest";
import { createConversationController, type PresentationProfile } from "../conversation-controller";
import { SCOPE, TURN_A, TURN_B, deferred, fakeScheduler, fakeTransport, settle } from "./conversation-fakes";

function setup(profile: PresentationProfile, sessionId: string | null = "A") {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const controller = createConversationController({ scope: SCOPE, sessionId, transport: net.transport, scheduler: clock.scheduler });
  // Attach without the hydrate probe's follow stream getting in the way of
  // the direct POST under test.
  controller.attach(`${profile}-1`, { profile, pendingProbe: false });
  for (const follow of net.follows) follow.sse?.close();
  return { net, clock, controller, state: () => controller.getSnapshot() };
}

async function startTurn(t: ReturnType<typeof setup>, profile: PresentationProfile) {
  const sent = t.controller.send({ presentationId: `${profile}-1`, text: "Long task" });
  await settle();
  return { sent, sse: t.net.lastChat().sse };
}

const stopFailed = (t: ReturnType<typeof setup>) => t.state().notices.some((notice) => notice.code === "stopTurnFailed");

for (const profile of ["page", "dock"] as const) {
  describe(`[COMP:app-web/chat-controller] ${profile} presentation pending explicit Stop`, () => {
    it.each(["idle", "running"])("waits through previous %s status until the original direct POST identifies its owner", async (status) => {
      const t = setup(profile);
      t.net.status.current = { status, turnId: TURN_B };
      const { sent, sse } = await startTurn(t, profile);
      const stopping = t.controller.stop();
      await settle();
      expect(sse.aborted()).toBe(false);
      expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
      expect(t.net.transport.readStatus).not.toHaveBeenCalled();
      // Preclaim/queued session frames carry null; only the original
      // postclaim session frame may bind the exact public owner.
      sse.send("session", { sessionId: "A", turnId: null });
      await settle();
      expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
      sse.send("session", { sessionId: "A", turnId: TURN_A });
      await settle();
      expect(await stopping).toBe("stopped");
      expect(t.net.transport.stopTurn).toHaveBeenCalledExactlyOnceWith("A", TURN_A);
      expect(sse.aborted()).toBe(true);
      expect(await sent).toBe("stopped");
    });

    it("waits for a new session to be adopted before stopping its own public start", async () => {
      const t = setup(profile, null);
      const { sse } = await startTurn(t, profile);
      const stopping = t.controller.stop();
      await settle();
      // The preclaim session frame adopts the new session but names no owner.
      sse.send("session", { sessionId: "new-session", turnId: null });
      await settle();
      expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
      sse.send("session", { sessionId: "new-session", turnId: TURN_A });
      await settle();
      expect(await stopping).toBe("stopped");
      expect(t.net.transport.stopTurn).toHaveBeenCalledExactlyOnceWith("new-session", TURN_A);
    });

    it.each(["disconnect", "fail", "complete"] as const)("reports Stop failure if the original request reaches %s before identity", async (terminal) => {
      const t = setup(profile);
      if (terminal === "fail") t.net.failNextChat();
      const sent = t.controller.send({ presentationId: `${profile}-1`, text: "Long task" });
      const stopping = t.controller.stop();
      await settle();
      if (terminal !== "fail") {
        const { sse } = t.net.lastChat();
        if (terminal === "complete") sse.send("done", {});
        sse.close();
      }
      expect(await stopping).toBe("failed");
      await sent;
      expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
      expect(stopFailed(t)).toBe(true);
    });

    it.each([false, true])("a late acknowledged Stop (reject=%s) cannot clear a successor", async (reject) => {
      const t = setup(profile);
      const first = await startTurn(t, profile);
      first.sse.send("session", { sessionId: "A", turnId: TURN_A });
      await settle();
      const stopResult = deferred<{ stopped: boolean }>();
      t.net.transport.stopTurn.mockReturnValueOnce(stopResult.promise);
      const stopping = t.controller.stop();
      await settle();
      expect(t.net.transport.stopTurn).toHaveBeenCalledWith("A", TURN_A);
      first.sse.send("done", { turnId: TURN_A });
      first.sse.close();
      expect(await first.sent).toBe("completed");
      const successor = t.controller.send({ presentationId: `${profile}-1`, text: "Next" });
      await settle();
      const next = t.net.lastChat().sse;
      next.send("session", { sessionId: "A", turnId: TURN_B });
      await settle();
      if (reject) stopResult.reject(new Error("late failure"));
      else stopResult.resolve({ stopped: true });
      // A rejected late request reports failure to its caller, but neither
      // outcome touches the successor or paints a notice.
      expect(await stopping).toBe(reject ? "failed" : "revoked");
      expect(next.aborted()).toBe(false);
      expect(stopFailed(t)).toBe(false);
      expect(t.state().run.phase).toBe("running");
      expect(t.state().turnId).toBe(TURN_B);
      next.send("done", { turnId: TURN_B });
      next.close();
      expect(await successor).toBe("completed");
    });

    it("never transfers a waiting Stop to a successor generation or paints its failure", async () => {
      const t = setup(profile);
      const { sse } = await startTurn(t, profile);
      const stopping = t.controller.stop();
      await settle();
      // Identity change: the transport is aborted, never stopped.
      t.controller.dispose();
      expect(await stopping).toBe("revoked");
      expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
      expect(sse.aborted()).toBe(true);
      expect(stopFailed(t)).toBe(false);
    });
  });
}
