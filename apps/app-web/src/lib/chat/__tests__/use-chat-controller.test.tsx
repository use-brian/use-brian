/** [COMP:app-web/chat-controller] Shared host transition traces. */
import { describe, expect, it, vi } from "vitest";
import { createChatControllerCoordinator } from "../use-chat-controller";

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
