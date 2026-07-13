/**
 * Unified approval-queue filter helpers (app-web — the live queue surface).
 * Component tag: [COMP:app-web/approvals].
 *
 * Ported from the pre-consolidation `apps/web` copy (per the
 * `web/approvals-queue` component-map note) and extended for the kinds the
 * app-web queue resolves in place: `staged_write` plus the two
 * staged_skill_* kinds (2026-07-07, the skill-approvals surface).
 *
 * Pure unit tests — `approvals-filter.ts` has no runtime imports (its
 * only import is `import type`), so this needs no DOM and no mocks.
 * Covers the kind/assistant/age filter, the cumulative age buckets, the
 * "actionable kinds" rule, and the present-kinds / present-assistants
 * facet derivations the queue UI renders its filter chips from.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 */

import { describe, expect, it } from "vitest";
import type { ApprovalKind, PendingApprovalRow } from "../api/approvals";

import {
  ACTIONABLE_KINDS,
  filterApprovals,
  isActionable,
  isFilterActive,
  matchesAge,
  NO_FILTER,
  presentAssistantIds,
  presentKinds,
} from "../approvals-filter";

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** ISO string for a row created `msAgo` milliseconds before NOW. */
function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

let rowSeq = 0;
function makeRow(partial: Partial<PendingApprovalRow> = {}): PendingApprovalRow {
  rowSeq += 1;
  return {
    id: `appr-${rowSeq}`,
    kind: "tool_invocation",
    status: "pending",
    toolName: "someTool",
    arguments: {},
    approvalPayload: {},
    approverUserId: "user-1",
    originatingAssistantId: "asst-1",
    blockingSessionId: null,
    workflowRunId: null,
    deliveryChannelType: "web",
    createdAt: iso(HOUR),
    expiresAt: null,
    ...partial,
  };
}

describe("[COMP:app-web/approvals] isActionable", () => {
  it("treats the in-place kinds as actionable, including the skill kinds", () => {
    const inPlace: ApprovalKind[] = [
      "workflow_step",
      "tool_invocation",
      "staged_write",
      "staged_skill_creation",
      "staged_skill_update",
      "browser_skill_send",
    ];
    for (const kind of inPlace) {
      expect(isActionable(kind)).toBe(true);
    }
  });

  it("treats native-surface kinds as not actionable in-place", () => {
    const nativeSurfaceKinds: ApprovalKind[] = [
      "distribution_draft",
      "question",
    ];
    for (const kind of nativeSurfaceKinds) {
      expect(isActionable(kind)).toBe(false);
    }
  });

  it("ACTIONABLE_KINDS holds exactly the six in-place kinds", () => {
    expect([...ACTIONABLE_KINDS].sort()).toEqual(
      [
        "browser_skill_send",
        "staged_skill_creation",
        "staged_skill_update",
        "staged_write",
        "tool_invocation",
        "workflow_step",
      ].sort(),
    );
  });
});

describe("[COMP:app-web/approval-grants] browser_skill_send resolves on the queue's 3-button card (R2-2)", () => {
  it("is actionable in place - the block's runner polls the row, so responding IS the resume", () => {
    expect(isActionable("browser_skill_send")).toBe(true);
  });
});

describe("[COMP:app-web/approvals] matchesAge", () => {
  it("'all' matches any age", () => {
    expect(matchesAge(iso(100 * DAY), "all", NOW)).toBe(true);
    expect(matchesAge(iso(HOUR), "all", NOW)).toBe(true);
  });

  it("'24h' matches only rows younger than a day", () => {
    expect(matchesAge(iso(HOUR), "24h", NOW)).toBe(true);
    expect(matchesAge(iso(2 * DAY), "24h", NOW)).toBe(false);
  });

  it("'24h' is exclusive at the 24h boundary", () => {
    expect(matchesAge(iso(DAY), "24h", NOW)).toBe(false);
    expect(matchesAge(iso(DAY - 1), "24h", NOW)).toBe(true);
  });

  it("'7d' matches rows younger than a week (cumulative — includes <24h)", () => {
    expect(matchesAge(iso(HOUR), "7d", NOW)).toBe(true);
    expect(matchesAge(iso(3 * DAY), "7d", NOW)).toBe(true);
    expect(matchesAge(iso(10 * DAY), "7d", NOW)).toBe(false);
  });

  it("'older' matches only rows at least a week old", () => {
    expect(matchesAge(iso(10 * DAY), "older", NOW)).toBe(true);
    expect(matchesAge(iso(7 * DAY), "older", NOW)).toBe(true);
    expect(matchesAge(iso(3 * DAY), "older", NOW)).toBe(false);
  });
});

describe("[COMP:app-web/approvals] isFilterActive", () => {
  it("NO_FILTER is inactive", () => {
    expect(isFilterActive(NO_FILTER)).toBe(false);
  });

  it("any non-'all' facet makes the filter active", () => {
    expect(isFilterActive({ ...NO_FILTER, kind: "tool_invocation" })).toBe(true);
    expect(isFilterActive({ ...NO_FILTER, assistant: "asst-1" })).toBe(true);
    expect(isFilterActive({ ...NO_FILTER, age: "24h" })).toBe(true);
  });
});

describe("[COMP:app-web/approvals] filterApprovals", () => {
  it("NO_FILTER returns every row", () => {
    const rows = [makeRow(), makeRow(), makeRow()];
    expect(filterApprovals(rows, NO_FILTER, NOW)).toHaveLength(3);
  });

  it("narrows by kind", () => {
    const rows = [
      makeRow({ kind: "tool_invocation" }),
      makeRow({ kind: "staged_skill_update" }),
      makeRow({ kind: "distribution_draft" }),
    ];
    const out = filterApprovals(
      rows,
      { ...NO_FILTER, kind: "staged_skill_update" },
      NOW,
    );
    expect(out.map((r) => r.kind)).toEqual(["staged_skill_update"]);
  });

  it("narrows by originating assistant", () => {
    const rows = [
      makeRow({ originatingAssistantId: "asst-a" }),
      makeRow({ originatingAssistantId: "asst-b" }),
    ];
    const out = filterApprovals(rows, { ...NO_FILTER, assistant: "asst-a" }, NOW);
    expect(out.map((r) => r.originatingAssistantId)).toEqual(["asst-a"]);
  });

  it("excludes a null-assistant row when an assistant filter is set", () => {
    const rows = [
      makeRow({ originatingAssistantId: "asst-a" }),
      makeRow({ originatingAssistantId: null }),
    ];
    const out = filterApprovals(rows, { ...NO_FILTER, assistant: "asst-a" }, NOW);
    expect(out).toHaveLength(1);
  });

  it("narrows by age bucket", () => {
    const rows = [
      makeRow({ createdAt: iso(HOUR) }),
      makeRow({ createdAt: iso(10 * DAY) }),
    ];
    const out = filterApprovals(rows, { ...NO_FILTER, age: "24h" }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toBe(iso(HOUR));
  });

  it("applies kind + assistant + age as an AND", () => {
    const match = makeRow({
      kind: "tool_invocation",
      originatingAssistantId: "asst-a",
      createdAt: iso(HOUR),
    });
    const wrongKind = makeRow({
      kind: "workflow_step",
      originatingAssistantId: "asst-a",
      createdAt: iso(HOUR),
    });
    const wrongAge = makeRow({
      kind: "tool_invocation",
      originatingAssistantId: "asst-a",
      createdAt: iso(10 * DAY),
    });
    const out = filterApprovals(
      [match, wrongKind, wrongAge],
      { kind: "tool_invocation", assistant: "asst-a", age: "24h" },
      NOW,
    );
    expect(out.map((r) => r.id)).toEqual([match.id]);
  });
});

describe("[COMP:app-web/approvals] facet derivations", () => {
  it("presentKinds lists distinct kinds in first-seen order", () => {
    const rows = [
      makeRow({ kind: "workflow_step" }),
      makeRow({ kind: "staged_skill_creation" }),
      makeRow({ kind: "workflow_step" }),
    ];
    expect(presentKinds(rows)).toEqual([
      "workflow_step",
      "staged_skill_creation",
    ]);
  });

  it("presentAssistantIds lists distinct ids, skipping null", () => {
    const rows = [
      makeRow({ originatingAssistantId: "asst-b" }),
      makeRow({ originatingAssistantId: null }),
      makeRow({ originatingAssistantId: "asst-a" }),
      makeRow({ originatingAssistantId: "asst-b" }),
    ];
    expect(presentAssistantIds(rows)).toEqual(["asst-b", "asst-a"]);
  });

  it("both derivations are empty for an empty queue", () => {
    expect(presentKinds([])).toEqual([]);
    expect(presentAssistantIds([])).toEqual([]);
  });
});
