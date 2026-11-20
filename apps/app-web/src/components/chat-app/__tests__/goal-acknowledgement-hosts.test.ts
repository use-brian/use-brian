/**
 * [COMP:app-web/goal-acknowledgement] General web-chat host parity.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const hosts = [
  ["full-page Chat", source("../chat-surface.tsx")],
  ["universal workspace dock", source("../../chrome/floating-chat.tsx")],
] as const;

describe("[COMP:app-web/goal-acknowledgement] Feed assistant dock", () => {
  // A controller presentation since M5 WP-E: `goal_accepted` reaches the rail
  // through its frame observer, once, for the turn it started.
  it("handles and pins goal acceptance from the controller's frames", () => {
    const host = source("../../feed/tuning-chat-panel.tsx");
    expect(host).toContain('frame.event === "goal_accepted"');
    expect(host).toContain("goalAcceptedNoticeFromPayload(frame.payload)");
    expect(host).toContain("<GoalAcknowledgement");
    expect(host).toContain("acceptedGoal?.sessionId");
  });
});

describe("[COMP:app-web/goal-acknowledgement] general chat hosts", () => {
  it.each(hosts)("handles and pins goal acceptance in %s", (_name, host) => {
    expect(host).toContain('case "goal_accepted"');
    expect(host).toContain("goalAcceptedNoticeFromPayload(payload)");
    expect(host).toContain("<GoalAcknowledgement");
    expect(host).toContain("acceptedGoal?.sessionId");
  });
});

describe("[COMP:app-web/goal-acknowledgement] full-page Chat at the conversation boundary", () => {
  it("delivers goal_accepted once, in order, to the page that started the turn", async () => {
    const { createConversationController } = await import("@/lib/chat/conversation-controller");
    const { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } = await import("@/lib/chat/__tests__/conversation-fakes");
    const net = fakeTransport();
    const clock = fakeScheduler();
    const controller = createConversationController({ scope: SCOPE, sessionId: null, transport: net.transport, scheduler: clock.scheduler });
    const page: string[] = [];
    const other: string[] = [];
    controller.attach("page", { profile: "page", onFrame: (frame) => page.push(frame.event) });
    const sent = controller.send({ presentationId: "page", text: "/goal ship the release" });
    await settle();
    controller.attach("dock", { profile: "dock", onFrame: (frame) => other.push(frame.event) });
    const turn = net.lastChat().sse;
    turn.send("session", { sessionId: "s-1", turnId: TURN_A });
    turn.send("goal_accepted", { goalId: "goal-1", sessionId: "s-1", title: "Ship the release" });
    turn.send("done", { turnId: TURN_A });
    turn.close();
    await sent;
    expect(page.filter((event) => event === "goal_accepted")).toHaveLength(1);
    expect(page.indexOf("session")).toBeLessThan(page.indexOf("goal_accepted"));
    expect(other).not.toContain("goal_accepted");
    // The page's observer turns it into the pinned acknowledgement.
    const observer = hosts[0][1].slice(hosts[0][1].indexOf("const observePageFrame"), hosts[0][1].indexOf("pageFrameRef.current = (frame) => observePageFrame"));
    expect(observer).toMatch(/case "goal_accepted": \{[\s\S]*goalAcceptedNoticeFromPayload\(payload\)[\s\S]*setAcceptedGoal\(notice\)/);
  });
});
