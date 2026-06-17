// [COMP:app-web/block-data]
/**
 * Unit tests for `translateCustomCommit` — the widget-commit → user-defined
 * `CellValue` mapping that backs inline editing of custom (Phase B) entity
 * tables. Keyed by the entity property kind (the real kind, e.g. `multi_select`,
 * not the renderer's `tags`).
 */

import { describe, expect, it } from "vitest";
import { translateCustomCommit } from "../block-data";

describe("[COMP:app-web/block-data] translateCustomCommit", () => {
  it("text passes a string through, else null", () => {
    expect(translateCustomCommit("hi", "text")).toEqual({ kind: "text", value: "hi" });
    expect(translateCustomCommit(null, "text")).toEqual({ kind: "text", value: null });
  });

  it("url / email / phone pass strings through", () => {
    expect(translateCustomCommit("a@b.co", "email")).toEqual({ kind: "email", value: "a@b.co" });
    expect(translateCustomCommit("+123", "phone")).toEqual({ kind: "phone", value: "+123" });
    expect(translateCustomCommit(null, "url")).toEqual({ kind: "url", value: null });
  });

  it("number from a primitive or a NumberWidget", () => {
    expect(translateCustomCommit(5, "number")).toEqual({ kind: "number", value: 5 });
    expect(translateCustomCommit({ type: "number", value: 3 }, "number")).toEqual({ kind: "number", value: 3 });
    expect(translateCustomCommit(null, "number")).toEqual({ kind: "number", value: null });
  });

  it("date from an ISO string or a DateWidget → { start }", () => {
    const iso = "2026-02-02T00:00:00.000Z";
    expect(translateCustomCommit(iso, "date")).toEqual({ kind: "date", value: { start: iso } });
    expect(translateCustomCommit({ type: "date", iso, format: "absolute" }, "date")).toEqual({
      kind: "date",
      value: { start: iso },
    });
    expect(translateCustomCommit(null, "date")).toEqual({ kind: "date", value: null });
  });

  it("checkbox is truthy for the ✓ glyph", () => {
    expect(translateCustomCommit("✓", "checkbox")).toEqual({ kind: "checkbox", value: true });
    expect(translateCustomCommit(null, "checkbox")).toEqual({ kind: "checkbox", value: false });
  });

  it("select from a string or a BadgeWidget", () => {
    expect(translateCustomCommit("opt_1", "select")).toEqual({ kind: "select", value: "opt_1" });
    expect(translateCustomCommit({ type: "badge", text: "Sci-Fi" }, "select")).toEqual({
      kind: "select",
      value: "Sci-Fi",
    });
  });

  it("status from a StatusWidget", () => {
    expect(
      translateCustomCommit({ type: "status", optionId: "s_seen", groupId: "done" }, "status"),
    ).toEqual({ kind: "status", value: "s_seen" });
  });

  it("multi_select from a container of badges or an array", () => {
    expect(
      translateCustomCommit(
        { type: "container", direction: "row", children: [
          { type: "badge", text: "a" },
          { type: "badge", text: "b" },
        ] },
        "multi_select",
      ),
    ).toEqual({ kind: "multi_select", value: ["a", "b"] });
    expect(translateCustomCommit(["x", "y"] as never, "multi_select")).toEqual({
      kind: "multi_select",
      value: ["x", "y"],
    });
  });

  it("returns null for editor-less kinds (person / relation / files)", () => {
    expect(translateCustomCommit({ type: "person", id: "u1", name: "Jack" }, "person")).toBeNull();
    expect(translateCustomCommit(null, "files")).toBeNull();
  });
});
