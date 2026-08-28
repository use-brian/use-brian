import { describe, expect, it } from "vitest";
import {
  parseProposePlanInput,
  pendingBriefPatch,
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

describe("[COMP:app-web/feed-plan-proposal] filling an existing slot (D31)", () => {
  const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("carries a valid slotId through, so Accept can patch instead of create", () => {
    // Without this the opt-in fill creates a SECOND slot beside the empty one
    // the operator already made, which is the exact duplicate it exists to
    // avoid.
    const parsed = parseProposePlanInput({
      month: "2026-08",
      rationale: "fill the gaps",
      slots: [
        {
          index: 1,
          slotId: UUID,
          date: "2026-08-04",
          platform: "threads",
          title: "Launch recap",
          brief: "What shipped.",
        },
      ],
    });
    expect(parsed?.slots[0].slotId).toBe(UUID);
  });

  it("drops a malformed slotId rather than discarding the whole card", () => {
    // Falling back to "create a new slot" is safe; throwing away a good
    // proposal because the model fumbled one field is not.
    const parsed = parseProposePlanInput({
      month: "2026-08",
      rationale: "fill the gaps",
      slots: [
        {
          index: 1,
          slotId: "not-a-uuid",
          date: "2026-08-04",
          platform: "threads",
          title: "Launch recap",
        },
      ],
    });
    expect(parsed?.slots).toHaveLength(1);
    expect(parsed?.slots[0].slotId).toBeUndefined();
  });

  it("leaves slotId unset on an ordinary proposal", () => {
    const parsed = parseProposePlanInput({
      month: "2026-08",
      rationale: "a fresh month",
      slots: [
        { index: 1, date: "2026-08-04", platform: "threads", title: "Launch recap" },
      ],
    });
    expect(parsed?.slots[0].slotId).toBeUndefined();
  });
});

describe("[COMP:app-web/feed-plan-proposal] month-brief patch card (P11)", () => {
  it("parses a brief-only direction change with zero slots", () => {
    const parsed = parseProposePlanInput({
      month: "2026-08",
      rationale: "Pivot to hiring content.",
      briefPatch: { brief: "Hiring-first month", cadencePerWeek: 2 },
      slots: [],
    });
    expect(parsed?.slots).toHaveLength(0);
    expect(parsed?.briefPatch).toEqual({
      brief: "Hiring-first month",
      cadencePerWeek: 2,
    });
  });

  it("drops a malformed patch and still refuses an empty proposal", () => {
    const parsed = parseProposePlanInput({
      month: "2026-08",
      rationale: "ok",
      briefPatch: { cadencePerWeek: 99 },
      slots: [
        { index: 1, date: "2026-08-04", platform: "threads", title: "A" },
      ],
    });
    expect(parsed?.briefPatch).toBeUndefined();
    expect(
      parseProposePlanInput({
        month: "2026-08",
        rationale: "nothing",
        briefPatch: {},
        slots: [],
      }),
    ).toBeNull();
  });

  it("replays: the newest patch wins, an omitted one carries forward", () => {
    const replayed = replayPlanProposal([
      toolUse({
        month: "2026-08",
        rationale: "first",
        briefPatch: { brief: "Old direction" },
        slots: [
          { index: 1, date: "2026-08-04", platform: "threads", title: "A" },
        ],
      }),
      toolUse({
        month: "2026-08",
        rationale: "revise slot only",
        slots: [
          { index: 1, date: "2026-08-05", platform: "threads", title: "A2" },
        ],
      }),
    ]);
    expect(replayed?.briefPatch).toEqual({ brief: "Old direction" });

    const replaced = replayPlanProposal([
      toolUse({
        month: "2026-08",
        rationale: "first",
        briefPatch: { brief: "Old direction" },
        slots: [
          { index: 1, date: "2026-08-04", platform: "threads", title: "A" },
        ],
      }),
      toolUse({
        month: "2026-08",
        rationale: "new direction",
        briefPatch: { brief: "New direction" },
        slots: [],
      }),
    ]);
    expect(replaced?.briefPatch).toEqual({ brief: "New direction" });
  });

  it("pendingBriefPatch retires the card once the saved brief matches", () => {
    const patch = { brief: "Hiring-first month", cadencePerWeek: 2 };
    expect(
      pendingBriefPatch(patch, { brief: "Launch month", cadencePerWeek: 3 }),
    ).toEqual(patch);
    // Cadence already matches - only the text is still pending.
    expect(
      pendingBriefPatch(patch, { brief: "Launch month", cadencePerWeek: 2 }),
    ).toEqual({ brief: "Hiring-first month" });
    // Fully applied (or hand-typed to the same thing) - nothing pending.
    expect(
      pendingBriefPatch(patch, {
        brief: "Hiring-first month",
        cadencePerWeek: 2,
      }),
    ).toBeNull();
    expect(pendingBriefPatch(null, null)).toBeNull();
  });
});
