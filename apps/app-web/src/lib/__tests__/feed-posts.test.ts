import { describe, expect, it } from "vitest";
import type { FeedDraftSessionSummary } from "@/lib/api/feed";
import {
  buildPostQueue,
  displayPostTitle,
  filterQueue,
  nextAfterAction,
  parseQueueFilter,
  postQueueStatus,
  queueCounts,
  toQueueItem,
} from "@/lib/feed-posts";

function session(
  overrides: Partial<FeedDraftSessionSummary> = {},
): FeedDraftSessionSummary {
  return {
    id: "session-1",
    platform: "threads",
    title: "[threads] Launch recap",
    startedBy: { id: "user-1", name: "Ada" },
    createdAt: "2026-07-28T01:00:00Z",
    lastActiveAt: "2026-07-28T02:00:00Z",
    preview: "chat preview",
    replyTarget: null,
    draftText: "proposed body",
    selectedDraft: null,
    draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0, deleted: 0 },
    seedKind: "freeform",
    ...overrides,
  };
}

describe("[COMP:app-web/feed-posts-queue] merged post queue", () => {
  it("hides every storage-level platform prefix from operator titles", () => {
    expect(displayPostTitle("[twitter] Launch recap")).toBe("Launch recap");
    expect(displayPostTitle("[linkedin] Article launch note")).toBe(
      "Article launch note",
    );
  });

  it("maps every draft state onto one of the four lifecycle states", () => {
    expect(postQueueStatus(session())).toBe("drafting");
    expect(
      postQueueStatus(
        session({ selectedDraft: { text: "x", status: "pending" } }),
      ),
    ).toBe("review");
    expect(
      postQueueStatus(session({ selectedDraft: { text: "x", status: "ready" } })),
    ).toBe("ready");
    expect(
      postQueueStatus(session({ selectedDraft: { text: "x", status: "posted" } })),
    ).toBe("posted");
  });

  // A rejected draft means the copy was wrong, not the intent - the session is
  // exactly where the operator writes the next version.
  it("returns a rejected draft to drafting rather than hiding it", () => {
    expect(
      postQueueStatus(
        session({ selectedDraft: { text: "x", status: "rejected" } }),
      ),
    ).toBe("drafting");
  });

  it("prefers the committed draft over a proposal for the row body", () => {
    const committed = toQueueItem(
      "assistant-1",
      session({ selectedDraft: { text: "committed", status: "pending" } }),
    );
    expect(committed.body).toBe("committed");
    expect(toQueueItem("assistant-1", session()).body).toBe("proposed body");
    expect(
      toQueueItem("assistant-1", session({ draftText: null })).body,
    ).toBe("chat preview");
  });

  it("flags a post that was published then taken down", () => {
    const item = toQueueItem(
      "assistant-1",
      session({
        selectedDraft: { text: "x", status: "posted" },
        draftCounts: { pending: 0, ready: 0, posted: 1, rejected: 0, deleted: 1 },
      }),
    );
    expect(item.takenDown).toBe(true);
  });

  it("flattens every brand voice into one rail, newest activity first", () => {
    const items = buildPostQueue([
      {
        assistantId: "a1",
        sessions: [session({ id: "old", lastActiveAt: "2026-07-20T00:00:00Z" })],
      },
      {
        assistantId: "a2",
        sessions: [session({ id: "new", lastActiveAt: "2026-07-28T00:00:00Z" })],
      },
    ]);
    expect(items.map((i) => i.sessionId)).toEqual(["new", "old"]);
    expect(items[0].assistantId).toBe("a2");
  });

  it("filters by status and platform independently", () => {
    const items = buildPostQueue([
      {
        assistantId: "a1",
        sessions: [
          session({ id: "s1", platform: "threads" }),
          session({
            id: "s2",
            platform: "twitter",
            selectedDraft: { text: "x", status: "ready" },
          }),
          session({
            id: "s3",
            platform: "threads",
            selectedDraft: { text: "x", status: "ready" },
          }),
        ],
      },
    ]);
    expect(filterQueue(items, "all").length).toBe(3);
    expect(filterQueue(items, "ready").map((i) => i.sessionId).sort()).toEqual([
      "s2",
      "s3",
    ]);
    expect(filterQueue(items, "all", "threads").length).toBe(2);
    expect(filterQueue(items, "ready", "threads").map((i) => i.sessionId)).toEqual([
      "s3",
    ]);
  });

  it("counts each lifecycle state for the filter chips", () => {
    const items = buildPostQueue([
      {
        assistantId: "a1",
        sessions: [
          session({ id: "s1" }),
          session({ id: "s2", selectedDraft: { text: "x", status: "pending" } }),
          session({ id: "s3", selectedDraft: { text: "x", status: "posted" } }),
        ],
      },
    ]);
    expect(queueCounts(items)).toEqual({
      drafting: 1,
      review: 1,
      ready: 0,
      posted: 1,
    });
  });

  it("parses the ?status= filter, defaulting to the unfiltered rail", () => {
    expect(parseQueueFilter("review")).toBe("review");
    expect(parseQueueFilter("all")).toBe("all");
    expect(parseQueueFilter("nonsense")).toBe("all");
    expect(parseQueueFilter(null)).toBe("all");
  });

  // Acting should advance the queue, not drop the operator into an empty pane.
  it("advances to the next row after acting, then falls back to the last", () => {
    const items = buildPostQueue([
      {
        assistantId: "a1",
        sessions: [
          session({ id: "s1", lastActiveAt: "2026-07-28T03:00:00Z" }),
          session({ id: "s2", lastActiveAt: "2026-07-28T02:00:00Z" }),
          session({ id: "s3", lastActiveAt: "2026-07-28T01:00:00Z" }),
        ],
      },
    ]);
    expect(nextAfterAction(items, "s1")?.sessionId).toBe("s2");
    // Acting on the last row falls back to the new last row.
    expect(nextAfterAction(items, "s3")?.sessionId).toBe("s2");
    expect(nextAfterAction([items[0]], "s1")).toBeNull();
    // An id that is not in the rail selects the head rather than nothing.
    expect(nextAfterAction(items, "missing")?.sessionId).toBe("s1");
  });
});
