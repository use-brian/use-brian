import { describe, expect, it } from "vitest";
import type { BrainInboxRow } from "../api/brain-inbox";
import {
  filterReviewItems,
  inboxPrimitivesForSelection,
  nextReviewKey,
  parseReviewKey,
  resolveReviewIndex,
  reviewItemKey,
  runReviewBatch,
  toReviewItems,
  type PendingReviewItem,
} from "../review-queue";

function inboxRow(overrides: Partial<BrainInboxRow> = {}): BrainInboxRow {
  return {
    primitive: "memory",
    id: "m-1",
    workspaceId: "w-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    createdByAssistantId: null,
    body: { summary: "A fact", detail: "The detail." },
    ...overrides,
  };
}

function item(primitive: PendingReviewItem["primitive"], id: string): PendingReviewItem {
  return {
    primitive,
    id,
    row: { id, kind: "memories", name: id },
  };
}

describe("[COMP:app-web/brain-review-panel] review queue helpers", () => {
  it("reviewItemKey uses the inbox primitive, not the projected kind", () => {
    const items = toReviewItems([
      inboxRow({
        primitive: "entity_link",
        id: "l-1",
        body: { edge_type: "works_at", source_kind: "person", target_kind: "company" },
      }),
    ]);
    // The projection maps entity_link to kind "other"; the key must keep
    // the real primitive so verify/delete hit the right endpoint.
    expect(items[0].row.kind).toBe("other");
    expect(reviewItemKey(items[0])).toBe("entity_link:l-1");
  });

  it("toReviewItems preserves endpoint order and projects each row", () => {
    const items = toReviewItems([
      inboxRow({ id: "m-1" }),
      inboxRow({ primitive: "task", id: "t-1", body: { title: "Ship it" } }),
    ]);
    expect(items.map(reviewItemKey)).toEqual(["memory:m-1", "task:t-1"]);
    expect(items[1].row.name).toBe("Ship it");
  });

  describe("resolveReviewIndex", () => {
    const items = [item("memory", "a"), item("task", "b"), item("contact", "c")];

    it("returns the selected item's index when present", () => {
      expect(resolveReviewIndex(items, "task:b")).toBe(1);
    });

    it("falls back to the first item when nothing is selected", () => {
      expect(resolveReviewIndex(items, null)).toBe(0);
    });

    it("falls back to the first item when the selection vanished", () => {
      expect(resolveReviewIndex(items, "memory:gone")).toBe(0);
    });

    it("returns -1 for an empty queue", () => {
      expect(resolveReviewIndex([], "memory:a")).toBe(-1);
    });
  });

  describe("inboxPrimitivesForSelection", () => {
    it("no selection → one unscoped fetch", () => {
      expect(inboxPrimitivesForSelection([])).toEqual({ kind: "all" });
    });

    it("maps selected kinds to their inbox primitives", () => {
      expect(inboxPrimitivesForSelection(["people", "memories"])).toEqual({
        kind: "some",
        primitives: ["contact", "memory"],
      });
    });

    it("drops inbox-less kinds, and an all-inbox-less selection fetches nothing", () => {
      expect(inboxPrimitivesForSelection(["knowledge", "deals"])).toEqual({
        kind: "some",
        primitives: ["deal"],
      });
      expect(inboxPrimitivesForSelection(["knowledge", "sessions"])).toEqual({
        kind: "none",
      });
    });

    it("the relationships filter maps to the entity_link primitive", () => {
      expect(inboxPrimitivesForSelection(["relationships"])).toEqual({
        kind: "some",
        primitives: ["entity_link"],
      });
    });

    it("selecting every chip (incl. relationships) collapses to one unscoped fetch", () => {
      // The chips still don't cover `entity` (generic, un-promoted entities);
      // only the unscoped fetch returns it, so checking every type must behave
      // like "All" rather than stranding it.
      expect(
        inboxPrimitivesForSelection([
          "people",
          "companies",
          "deals",
          "tasks",
          "memories",
          "files",
          "relationships",
        ]),
      ).toEqual({ kind: "all" });
    });

    it("a full selection that also includes inbox-less kinds is still all", () => {
      expect(
        inboxPrimitivesForSelection([
          "people",
          "companies",
          "deals",
          "tasks",
          "knowledge",
          "memories",
          "files",
          "sessions",
          "relationships",
        ]),
      ).toEqual({ kind: "all" });
    });

    it("the six primitive chips WITHOUT relationships stay scoped", () => {
      // entity_link isn't covered, so this is a narrowing filter, not "all" —
      // the relationship rows are correctly excluded.
      const scope = inboxPrimitivesForSelection([
        "people",
        "companies",
        "deals",
        "tasks",
        "memories",
        "files",
      ]);
      expect(scope.kind).toBe("some");
      expect(scope.kind === "some" && scope.primitives).not.toContain(
        "entity_link",
      );
    });
  });

  describe("entity_link human label projection", () => {
    it("uses the resolved target_label, qualified by a content target kind", () => {
      const [it0] = toReviewItems([
        inboxRow({
          primitive: "entity_link",
          id: "l-1",
          body: {
            edge_type: "documented_by",
            target_kind: "file",
            target_label: "roadmap.pdf",
          },
        }),
      ]);
      expect(it0.row.name).toBe("Documented by file: roadmap.pdf");
    });

    it("drops the kind qualifier for an entity target", () => {
      const [it0] = toReviewItems([
        inboxRow({
          primitive: "entity_link",
          id: "l-2",
          body: {
            edge_type: "works_at",
            target_kind: "entity",
            target_label: "DeltaDeFi",
          },
        }),
      ]);
      expect(it0.row.name).toBe("Works at: DeltaDeFi");
    });

    it("falls back to the humanised kind when target_label is unresolved", () => {
      const [it0] = toReviewItems([
        inboxRow({
          primitive: "entity_link",
          id: "l-3",
          body: { edge_type: "mentioned", target_kind: "file" },
        }),
      ]);
      expect(it0.row.name).toBe("Mentioned: File");
    });
  });

  describe("filterReviewItems", () => {
    const items: PendingReviewItem[] = [
      {
        primitive: "memory",
        id: "a",
        row: { id: "a", kind: "memories", name: "Pricing fact", summary: "We bill monthly" },
      },
      {
        primitive: "task",
        id: "b",
        row: { id: "b", kind: "tasks", name: "Ship invoice flow" },
      },
    ];

    it("empty needle passes everything through", () => {
      expect(filterReviewItems(items, "  ")).toEqual(items);
    });

    it("matches name or summary, case-insensitive", () => {
      expect(filterReviewItems(items, "INVOICE").map((i) => i.id)).toEqual(["b"]);
      expect(filterReviewItems(items, "bill").map((i) => i.id)).toEqual(["a"]);
    });
  });

  describe("nextReviewKey (auto-advance)", () => {
    const items = [item("memory", "a"), item("task", "b"), item("contact", "c")];

    it("advances to the next item in queue order", () => {
      expect(nextReviewKey(items, "memory:a")).toBe("task:b");
      expect(nextReviewKey(items, "task:b")).toBe("contact:c");
    });

    it("falls back to the previous item when the last one was acted on", () => {
      expect(nextReviewKey(items, "contact:c")).toBe("task:b");
    });

    it("returns null when the acted item was the only one", () => {
      expect(nextReviewKey([item("memory", "a")], "memory:a")).toBeNull();
    });

    it("tolerates an unknown acted key by selecting the first item", () => {
      expect(nextReviewKey(items, "deal:gone")).toBe("memory:a");
      expect(nextReviewKey([], "deal:gone")).toBeNull();
    });
  });
});

describe("[COMP:app-web/brain-review-panel] bulk selection batch", () => {
  describe("parseReviewKey", () => {
    it("round-trips reviewItemKey", () => {
      expect(parseReviewKey("entity_link:abc-123")).toEqual({
        primitive: "entity_link",
        id: "abc-123",
      });
      expect(parseReviewKey("memory:m-1")).toEqual({
        primitive: "memory",
        id: "m-1",
      });
    });

    it("rejects malformed keys", () => {
      expect(parseReviewKey("no-colon")).toBeNull();
      expect(parseReviewKey(":id-only")).toBeNull();
      expect(parseReviewKey("memory:")).toBeNull();
    });
  });

  describe("runReviewBatch", () => {
    it("runs the action per key and partitions succeeded/failed", async () => {
      const acted: Array<[string, string]> = [];
      const { succeeded, failed } = await runReviewBatch(
        ["memory:a", "task:b", "contact:c"],
        async (primitive, id) => {
          acted.push([primitive, id]);
          return { ok: id !== "b" };
        },
      );
      expect(acted).toEqual([
        ["memory", "a"],
        ["task", "b"],
        ["contact", "c"],
      ]);
      expect(succeeded).toEqual(["memory:a", "contact:c"]);
      expect(failed).toEqual(["task:b"]);
    });

    it("counts a thrown action and a malformed key as failed", async () => {
      const { succeeded, failed } = await runReviewBatch(
        ["memory:a", "garbage", "task:b"],
        async (_primitive, id) => {
          if (id === "a") throw new Error("boom");
          return { ok: true };
        },
      );
      expect(succeeded).toEqual(["task:b"]);
      expect(failed).toEqual(["memory:a", "garbage"]);
    });

    it("handles an empty selection", async () => {
      const { succeeded, failed } = await runReviewBatch([], async () => ({
        ok: true,
      }));
      expect(succeeded).toEqual([]);
      expect(failed).toEqual([]);
    });
  });
});
