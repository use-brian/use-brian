import { describe, it, expect } from "vitest";
import {
  brainRowUrl,
  parseBrainDeepLink,
  DEFAULT_LINKED_PRIMITIVE,
} from "@/lib/brain-deep-link";

describe("[COMP:app-web/brain-deep-link] Brain row deep links", () => {
  describe("parseBrainDeepLink", () => {
    it("defaults a bare ?row= link to a task", () => {
      const link = parseBrainDeepLink(new URLSearchParams("row=abc-123"));
      expect(link).toEqual({ rowId: "abc-123", primitive: "task" });
      expect(DEFAULT_LINKED_PRIMITIVE).toBe("task");
    });

    it("honours an explicit linkable kind", () => {
      expect(
        parseBrainDeepLink(new URLSearchParams("row=abc-123&kind=company")),
      ).toEqual({ rowId: "abc-123", primitive: "company" });
    });

    it("returns null when no row is addressed", () => {
      expect(parseBrainDeepLink(new URLSearchParams(""))).toBeNull();
      expect(parseBrainDeepLink(new URLSearchParams("row="))).toBeNull();
      expect(parseBrainDeepLink(new URLSearchParams("view=graph"))).toBeNull();
    });

    it("drops an unknown kind rather than coercing it to a task", () => {
      // A typo'd link must land on the plain list, never open a DIFFERENT row
      // that happens to share the id namespace.
      expect(
        parseBrainDeepLink(new URLSearchParams("row=abc-123&kind=tasks")),
      ).toBeNull();
      expect(
        parseBrainDeepLink(new URLSearchParams("row=abc-123&kind=knowledge")),
      ).toBeNull();
    });

    it("ignores the other brain params it shares the query with", () => {
      expect(
        parseBrainDeepLink(new URLSearchParams("view=graph&row=abc&kind=deal")),
      ).toEqual({ rowId: "abc", primitive: "deal" });
    });
  });

  describe("brainRowUrl", () => {
    it("omits kind for a task so the common link stays short", () => {
      expect(brainRowUrl("https://app.usebrian.ai", "ws-1", "task-1")).toBe(
        "https://app.usebrian.ai/w/ws-1/brain?row=task-1",
      );
    });

    it("carries kind for every other primitive", () => {
      expect(brainRowUrl("", "ws-1", "row-9", "memory")).toBe(
        "/w/ws-1/brain?row=row-9&kind=memory",
      );
    });

    it("round-trips through the parser", () => {
      const url = brainRowUrl("https://app.usebrian.ai", "ws-1", "row-9", "deal");
      const query = url.slice(url.indexOf("?") + 1);
      expect(parseBrainDeepLink(new URLSearchParams(query))).toEqual({
        rowId: "row-9",
        primitive: "deal",
      });
    });
  });
});
