import { describe, expect, it } from "vitest";
import {
  parseProposePlanInput,
  pendingProposedSlots,
  replayPlanProposal,
} from "@/lib/feed-plan-proposal";

function toolUse(input: unknown) {
  return {
    role: "assistant",
    content: [{ type: "tool_use", name: "proposePlan", input }],
  };
}

const VALID = {
  month: "2026-08",
  rationale: "Two a week, launch-weighted.",
  slots: [
    {
      index: 1,
      date: "2026-08-04",
      platform: "threads",
      title: "Launch recap",
      brief: "What shipped and what broke.",
    },
    { index: 2, date: "2026-08-06", platform: "twitter", title: "3 numbers" },
  ],
};

describe("[COMP:app-web/feed-plan-proposal] plan cardboard", () => {
  it("parses a well-formed proposal", () => {
    const parsed = parseProposePlanInput(VALID);
    expect(parsed?.month).toBe("2026-08");
    expect(parsed?.slots).toHaveLength(2);
    expect(parsed?.slots[0].brief).toBe("What shipped and what broke.");
    // A slot with no brief simply omits it rather than carrying an empty string.
    expect(parsed?.slots[1].brief).toBeUndefined();
  });

  // A malformed or half-streamed tool call must be ignored, never crash the rail.
  it("rejects malformed payloads without throwing", () => {
    expect(parseProposePlanInput(null)).toBeNull();
    expect(parseProposePlanInput("nope")).toBeNull();
    expect(parseProposePlanInput({ month: "2026-08" })).toBeNull();
    expect(parseProposePlanInput({ ...VALID, month: "August" })).toBeNull();
    expect(parseProposePlanInput({ ...VALID, slots: [] })).toBeNull();
  });

  it("drops individual slots that are unusable, keeping the rest", () => {
    const parsed = parseProposePlanInput({
      ...VALID,
      slots: [
        ...VALID.slots,
        { index: 3, date: "not-a-date", platform: "threads", title: "x" },
        { index: 4, date: "2026-08-08", platform: "mastodon", title: "x" },
        { index: 5, date: "2026-08-09", platform: "threads", title: "   " },
        { date: "2026-08-10", platform: "threads", title: "no index" },
      ],
    });
    expect(parsed?.slots.map((s) => s.index)).toEqual([1, 2]);
  });

  it("replays history, upserting revisions by index", () => {
    const proposal = replayPlanProposal([
      toolUse(VALID),
      toolUse({
        month: "2026-08",
        rationale: "Tightened.",
        slots: [
          { index: 1, date: "2026-08-05", platform: "threads", title: "Revised" },
          { index: 3, date: "2026-08-11", platform: "xhs", title: "Added" },
        ],
      }),
    ]);
    expect(proposal?.rationale).toBe("Tightened.");
    expect(proposal?.slots).toHaveLength(3);
    expect(proposal?.slots.find((s) => s.index === 1)?.title).toBe("Revised");
    expect(proposal?.slots.find((s) => s.index === 1)?.date).toBe("2026-08-05");
    // Sorted by date so the rail reads in calendar order.
    expect(proposal?.slots.map((s) => s.date)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-11",
    ]);
  });

  // Navigating to another month must not show the previous month's leftovers.
  it("replaces the proposal wholesale when the month changes", () => {
    const proposal = replayPlanProposal([
      toolUse(VALID),
      toolUse({
        month: "2026-09",
        rationale: "September.",
        slots: [
          { index: 1, date: "2026-09-02", platform: "threads", title: "Sept" },
        ],
      }),
    ]);
    expect(proposal?.month).toBe("2026-09");
    expect(proposal?.slots).toHaveLength(1);
  });

  it("ignores user messages and other tools", () => {
    expect(
      replayPlanProposal([
        { role: "user", content: [{ type: "tool_use", name: "proposePlan", input: VALID }] },
        { role: "assistant", content: [{ type: "tool_use", name: "proposeDrafts", input: VALID }] },
        { role: "assistant", content: "plain text" },
      ]),
    ).toBeNull();
  });

  // Re-running "Plan this month" should surface the gaps, not offer duplicates.
  it("filters proposals that already exist on the calendar", () => {
    const proposal = parseProposePlanInput(VALID);
    const pending = pendingProposedSlots(proposal, [
      { scheduledFor: "2026-08-04", platform: "threads", title: "  launch RECAP " },
    ]);
    expect(pending.map((s) => s.index)).toEqual([2]);
    expect(pendingProposedSlots(null, [])).toEqual([]);
  });
});
