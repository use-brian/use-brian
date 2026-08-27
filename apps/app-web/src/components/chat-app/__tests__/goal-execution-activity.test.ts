/** [COMP:app-web/goal-live-activity] Goal SSE reducer parity with normal chat. */
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  emptyGoalExecutionActivity,
  reduceGoalExecutionActivity,
} from "../goal-execution-activity";

describe("[COMP:app-web/goal-live-activity] activity reducer", () => {
  it("folds reasoning and tool lifecycle frames into the chronological feed", () => {
    let state = emptyGoalExecutionActivity("running", 1_000);
    state = reduceGoalExecutionActivity(
      state,
      "reasoning",
      { text: "Checking the profile" },
      en.chat.toolNarration,
      1_100,
    );
    state = reduceGoalExecutionActivity(
      state,
      "tool_start",
      { id: "tool-1", name: "webSearch" },
      en.chat.toolNarration,
      1_200,
    );
    state = reduceGoalExecutionActivity(
      state,
      "tool_input",
      { id: "tool-1", name: "webSearch", input: { query: "CFA profile" } },
      en.chat.toolNarration,
      1_250,
    );
    state = reduceGoalExecutionActivity(
      state,
      "tool_result",
      { id: "tool-1", name: "webSearch", isError: false },
      en.chat.toolNarration,
      1_700,
    );

    expect(state.log.events.map((event) => event.kind)).toEqual(["reasoning", "step"]);
    expect(state.log.events.at(-1)?.text).toContain("CFA profile");
    expect(state.tools).toEqual([
      expect.objectContaining({ id: "tool-1", status: "done", durationMs: 500 }),
    ]);
  });

  it("marks live tools settled when the goal reaches a terminal state", () => {
    let state = emptyGoalExecutionActivity("running", 1_000);
    state = reduceGoalExecutionActivity(
      state,
      "tool_start",
      { id: "tool-1", name: "urlReader" },
      en.chat.toolNarration,
      1_100,
    );
    state = reduceGoalExecutionActivity(
      state,
      "done",
      { status: "blocked" },
      en.chat.toolNarration,
      1_200,
    );
    expect(state.status).toBe("blocked");
    expect(state.tools[0]?.status).toBe("done");
  });
});
