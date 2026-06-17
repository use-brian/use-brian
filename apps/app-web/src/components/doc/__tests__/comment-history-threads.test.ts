import { describe, it, expect } from "vitest";
import type { CommentThread } from "@/lib/api/comments";
import {
  orderHistoryThreads,
  historyThreadStatus,
  historyActivityTime,
} from "../comment-history-threads";

function thread(over: Partial<CommentThread>): CommentThread {
  return {
    id: "t1",
    pageId: "p1",
    workspaceId: "w1",
    sessionId: "s1",
    anchorKind: "human_range",
    anchorBlockId: null,
    quote: null,
    resolvedAt: null,
    resolvedBy: null,
    createdBy: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("[COMP:app-web/comment-history] History thread ordering", () => {
  it("flags resolved vs open by resolvedAt", () => {
    expect(historyThreadStatus(thread({ resolvedAt: null }))).toBe("open");
    expect(
      historyThreadStatus(thread({ resolvedAt: "2026-02-01T00:00:00.000Z" })),
    ).toBe("resolved");
  });

  it("orders most-recent activity first: resolved by resolvedAt, open by createdAt", () => {
    const openOld = thread({
      id: "open-old",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Created before openRecent, but resolved later → its resolvedAt is what
    // History sorts by, so it floats to the top.
    const resolvedRecent = thread({
      id: "resolved-recent",
      createdAt: "2026-01-02T00:00:00.000Z",
      resolvedAt: "2026-03-01T00:00:00.000Z",
    });
    const openRecent = thread({
      id: "open-recent",
      createdAt: "2026-02-15T00:00:00.000Z",
    });
    const ordered = orderHistoryThreads([openOld, resolvedRecent, openRecent]);
    expect(ordered.map((t) => t.id)).toEqual([
      "resolved-recent",
      "open-recent",
      "open-old",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const a = thread({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = thread({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" });
    const input = [a, b];
    orderHistoryThreads(input);
    expect(input.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("sinks a row with a missing/unparseable timestamp to the bottom", () => {
    const good = thread({ id: "good", createdAt: "2026-02-01T00:00:00.000Z" });
    const bad = thread({ id: "bad", createdAt: "not-a-date" });
    expect(historyActivityTime(bad)).toBe(0);
    expect(orderHistoryThreads([bad, good]).map((t) => t.id)).toEqual([
      "good",
      "bad",
    ]);
  });
});
