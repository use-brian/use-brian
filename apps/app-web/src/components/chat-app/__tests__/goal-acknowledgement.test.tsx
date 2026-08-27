// @vitest-environment jsdom
/**
 * [COMP:app-web/goal-acknowledgement] Pinned execution feedback.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../goal-execution-activity", () => ({
  GoalExecutionActivity: () => null,
}));

import {
  GoalAcknowledgement,
  goalAcceptedNoticeFromPayload,
} from "../goal-acknowledgement";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const labels = {
  accepted: "Goal accepted",
  executing: "Executing in Autopilot",
  done: "Goal completed",
  blocked: "Goal needs attention",
  abandoned: "Goal stopped",
  open: "Open goal",
  dismiss: "Dismiss goal status",
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("[COMP:app-web/goal-acknowledgement] goal pin", () => {
  it("accepts only a complete session-scoped SSE payload", () => {
    expect(
      goalAcceptedNoticeFromPayload({
        goalId: "goal-1",
        outcome: "Prepare and ship the launch brief",
        sessionId: "session-1",
      }),
    ).toEqual({
      goalId: "goal-1",
      outcome: "Prepare and ship the launch brief",
      sessionId: "session-1",
    });
    expect(goalAcceptedNoticeFromPayload({ goalId: "goal-1" })).toBeNull();
    expect(
      goalAcceptedNoticeFromPayload({
        goalId: "goal-1",
        outcome: " ",
        sessionId: "session-1",
      }),
    ).toBeNull();
  });

  it("renders the outcome, execution state, deep link, and dismiss control", () => {
    const onDismiss = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <GoalAcknowledgement
          notice={{
            goalId: "goal-1",
            outcome: "Prepare and ship the launch brief",
            sessionId: "session-1",
          }}
          workspaceId="workspace-1"
          labels={labels}
          onDismiss={onDismiss}
          followActivity={false}
        />,
      );
    });

    expect(host.textContent).toContain("Goal accepted");
    expect(host.textContent).toContain("Executing in Autopilot");
    expect(host.textContent).toContain("Prepare and ship the launch brief");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/w/workspace-1/goals/goal-1",
    );

    act(() => {
      host!
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Dismiss goal status"]',
        )!
        .click();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
