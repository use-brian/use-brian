import { describe, expect, it } from "vitest";
import {
  applyChangesToBody,
  bodyTags,
  dateInputToIso,
  extraBodyFields,
  flattenAttributes,
  formatValue,
  humaniseKey,
  isoToDateInput,
  parseAdjustNewId,
  parseTagsInput,
  tagsEqual,
} from "../property-edit";

describe("[COMP:app-web/brain-property-fields] property-edit logic", () => {
  it("parses the comma-separated tags editor with server-parity trim + drop-empties", () => {
    expect(parseTagsInput("a, b ,  c")).toEqual(["a", "b", "c"]);
    expect(parseTagsInput(" , ,")).toEqual([]);
    expect(parseTagsInput("")).toEqual([]);
    expect(parseTagsInput("one")).toEqual(["one"]);
  });

  it("compares tag sets element-wise", () => {
    expect(tagsEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(tagsEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(tagsEqual([], [])).toBe(true);
    expect(tagsEqual(["a"], ["a", "b"])).toBe(false);
  });

  it("reads only string tags out of an untyped body value", () => {
    expect(bodyTags(["a", 1, "b", null])).toEqual(["a", "b"]);
    expect(bodyTags("not-an-array")).toEqual([]);
    expect(bodyTags(undefined)).toEqual([]);
  });

  it("converts a date input to day-start-UTC ISO, empty clearing to null", () => {
    expect(dateInputToIso("2026-07-04")).toBe("2026-07-04T00:00:00.000Z");
    expect(dateInputToIso("")).toBeNull();
    expect(dateInputToIso("   ")).toBeNull();
  });

  it("seeds the date input from an ISO body value, rejecting garbage", () => {
    expect(isoToDateInput("2026-07-04T00:00:00.000Z")).toBe("2026-07-04");
    expect(isoToDateInput("2026-07-04")).toBe("2026-07-04");
    expect(isoToDateInput(null)).toBe("");
    expect(isoToDateInput("soon")).toBe("");
    expect(isoToDateInput(123456)).toBe("");
  });

  it("extracts the superseded id from task and memory adjust responses", () => {
    // Task adjust shape.
    expect(parseAdjustNewId({ ok: true, stamped: true, id: "t2" })).toBe("t2");
    // Memory adjust shape (behind the 308 redirect).
    expect(parseAdjustNewId({ memory: { id: "m2", summary: "s" } })).toBe("m2");
    // In-place adjusts (entity / CRM / file) carry no id.
    expect(parseAdjustNewId({ ok: true, stamped: true })).toBeNull();
    expect(parseAdjustNewId({})).toBeNull();
    expect(parseAdjustNewId(null)).toBeNull();
    expect(parseAdjustNewId("nope")).toBeNull();
    expect(parseAdjustNewId({ id: "" })).toBeNull();
  });

  it("patches the body optimistically per changed field", () => {
    const body = { title: "Old", status: "todo", tags: ["x"], due_at: null };
    const next = applyChangesToBody(
      body,
      { title: "New", status: "in_progress", due_at: "2026-07-05T00:00:00.000Z" },
      "task",
    );
    expect(next.title).toBe("New");
    expect(next.status).toBe("in_progress");
    expect(next.due_at).toBe("2026-07-05T00:00:00.000Z");
    expect(next.tags).toEqual(["x"]);
    // Original body untouched.
    expect(body.title).toBe("Old");
  });

  it("mirrors display_name onto name for CRM primitives only", () => {
    const crm = applyChangesToBody(
      { name: "Acme", display_name: "Acme" },
      { display_name: "Acme Corp" },
      "company",
    );
    expect(crm.name).toBe("Acme Corp");
    expect(crm.display_name).toBe("Acme Corp");

    const entity = applyChangesToBody(
      { name: "Acme", display_name: "Acme" },
      { display_name: "Acme Corp" },
      "entity",
    );
    expect(entity.display_name).toBe("Acme Corp");
    expect(entity.name).toBe("Acme");
  });

  it("never copies the audit reason into the body", () => {
    const next = applyChangesToBody({}, { sensitivity: "public", reason: "why" }, "memory");
    expect(next.sensitivity).toBe("public");
    expect("reason" in next).toBe(false);
  });

  it("lists only non-dedicated, non-hidden, non-empty body fields", () => {
    const rows = extraBodyFields("task", {
      title: "T",
      status: "todo",
      due_at: "2026-07-04T00:00:00.000Z",
      tags: ["a"],
      sensitivity: "internal",
      attributes: { repo: "x" },
      source_session_id: "hidden",
      priority: "high",
      empty: "",
      nullish: null,
    });
    expect(rows).toEqual([["priority", "high"]]);
  });

  it("keeps generic fields for primitives without a dedicated set", () => {
    const rows = extraBodyFields("unknown_primitive", {
      alpha: "a",
      user_id: "hidden",
    });
    expect(rows).toEqual([["alpha", "a"]]);
  });

  it("flattens attribute objects into displayable rows and ignores non-objects", () => {
    expect(flattenAttributes({ repo: "sidanclaw", stars: 5, skip: null })).toEqual([
      ["repo", "sidanclaw"],
      ["stars", "5"],
    ]);
    expect(flattenAttributes(["a"])).toEqual([]);
    expect(flattenAttributes("x")).toEqual([]);
    expect(flattenAttributes(null)).toEqual([]);
  });

  it("formats values for display (dates localized, arrays joined, empties blank)", () => {
    const iso = "2026-07-04T10:30:00.000Z";
    expect(formatValue(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue([])).toBe("");
    expect(formatValue({})).toBe("");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(null)).toBe("");
    expect(formatValue("plain")).toBe("plain");
  });

  it("humanises snake_case keys", () => {
    expect(humaniseKey("due_at")).toBe("Due At");
    expect(humaniseKey("status")).toBe("Status");
  });
});
