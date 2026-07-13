import { describe, it, expect } from "vitest";
import { originClue, type SourceOriginCopy } from "../source-origin";
import type { ExplainOrigin } from "@/lib/api/brain-inbox";

const copy: SourceOriginCopy = {
  originChat: "Saved from a {channel} conversation.",
  originWorkflow: "Created by an assistant during a workflow run.",
  originScheduled: "Created by an assistant during a scheduled run.",
  originManual: "Added manually.",
  originManualBy: "Added manually by {user}.",
  originConsolidation:
    "Created by memory consolidation on {date}, synthesized from earlier memories.",
  originExtraction: "Extracted from {source} on {date}.",
  originAuthorFallback: "Saved by {author} on {date}.",
  originChannelLabels: { web: "web chat", telegram: "Telegram", other: "chat" },
  originEpisodeKinds: { meeting: "a meeting", other: "an ingested source" },
};

const SAVED_AT = "2026-07-09T10:00:00Z";

function makeOrigin(overrides: Partial<ExplainOrigin>): ExplainOrigin {
  return {
    kind: "unknown",
    source: null,
    channelType: null,
    workflowId: null,
    episode: null,
    createdByUserId: null,
    createdByUserName: null,
    ...overrides,
  };
}

describe("[COMP:app-web/brain-source-origin] originClue", () => {
  it("returns null without a descriptor (old API deploys)", () => {
    expect(originClue(undefined, copy, SAVED_AT, null)).toBeNull();
  });

  it("labels a chat origin with the channel name, falling back for unknown channels", () => {
    const telegram = originClue(
      makeOrigin({ kind: "chat", channelType: "telegram" }),
      copy,
      SAVED_AT,
      "Nova",
    );
    expect(telegram).toBe("Saved from a Telegram conversation.");
    const exotic = originClue(
      makeOrigin({ kind: "chat", channelType: "matrix" }),
      copy,
      SAVED_AT,
      "Nova",
    );
    expect(exotic).toBe("Saved from a chat conversation.");
  });

  it("labels workflow and scheduled runs", () => {
    expect(
      originClue(makeOrigin({ kind: "workflow" }), copy, SAVED_AT, null),
    ).toBe("Created by an assistant during a workflow run.");
    expect(
      originClue(makeOrigin({ kind: "scheduled" }), copy, SAVED_AT, null),
    ).toBe("Created by an assistant during a scheduled run.");
  });

  it("labels a manual create, naming the user when known", () => {
    expect(
      originClue(
        makeOrigin({ kind: "manual", createdByUserName: "Hinson" }),
        copy,
        SAVED_AT,
        null,
      ),
    ).toBe("Added manually by Hinson.");
    expect(
      originClue(makeOrigin({ kind: "manual" }), copy, SAVED_AT, null),
    ).toBe("Added manually.");
  });

  it("labels extraction from the episode's source kind and occurred-at date", () => {
    const clue = originClue(
      makeOrigin({
        kind: "extraction",
        episode: {
          id: "ep-1",
          sourceKind: "meeting",
          occurredAt: "2026-07-08T09:00:00Z",
          summaryText: "Weekly sync",
        },
      }),
      copy,
      SAVED_AT,
      null,
    );
    expect(clue).toContain("Extracted from a meeting on");
    expect(clue).toContain(new Date("2026-07-08T09:00:00Z").toLocaleDateString());
  });

  it("labels consolidation with the row's save date", () => {
    const clue = originClue(
      makeOrigin({ kind: "consolidation" }),
      copy,
      SAVED_AT,
      null,
    );
    expect(clue).toContain("Created by memory consolidation on");
  });

  it("falls back to author + date for unknown kinds, and to null with no author", () => {
    const withAuthor = originClue(
      makeOrigin({ kind: "unknown" }),
      copy,
      SAVED_AT,
      "Nova",
    );
    expect(withAuthor).toContain("Saved by Nova on");
    expect(
      originClue(makeOrigin({ kind: "unknown" }), copy, SAVED_AT, null),
    ).toBeNull();
  });
});
