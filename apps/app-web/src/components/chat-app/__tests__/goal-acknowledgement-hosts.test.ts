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
  ["Feed assistant dock", source("../../feed/tuning-chat-panel.tsx")],
] as const;

describe("[COMP:app-web/goal-acknowledgement] general chat hosts", () => {
  it.each(hosts)("handles and pins goal acceptance in %s", (_name, host) => {
    expect(host).toContain('case "goal_accepted"');
    expect(host).toContain("goalAcceptedNoticeFromPayload(payload)");
    expect(host).toContain("<GoalAcknowledgement");
    expect(host).toContain("acceptedGoal?.sessionId");
  });
});
