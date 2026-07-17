import { describe, expect, it } from "vitest";
import {
  applyChangesToBody,
  attributePriority,
  bodyTags,
  dateInputToIso,
  extraBodyFields,
  flattenAttributes,
  formatValue,
  humaniseKey,
  isoToDateInput,
  memberDisplayName,
  parseAdjustNewId,
  parseTagsInput,
  resolveAssignee,
  tagsEqual,
  type AssignableMember,
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

  it("patches assignee_id and merges priority into attributes (null removes the key)", () => {
    const body = { assignee_id: null, attributes: { order: 3 } };
    const next = applyChangesToBody(
      body,
      { assignee_id: "wm-1", priority: "high" },
      "task",
    );
    expect(next.assignee_id).toBe("wm-1");
    expect(next.attributes).toEqual({ order: 3, priority: "high" });
    // Original body (and its attributes object) untouched.
    expect(body.attributes).toEqual({ order: 3 });

    const cleared = applyChangesToBody(
      { assignee_id: "wm-1", attributes: { order: 3, priority: "high" } },
      { assignee_id: null, priority: null },
      "task",
    );
    expect(cleared.assignee_id).toBeNull();
    expect(cleared.attributes).toEqual({ order: 3 });

    // A malformed attributes value is replaced, never crashed on.
    const fromGarbage = applyChangesToBody(
      { attributes: "junk" },
      { priority: "low" },
      "task",
    );
    expect(fromGarbage.attributes).toEqual({ priority: "low" });
  });

  it("reads the conventional attributes.priority key, empty when unset or malformed", () => {
    expect(attributePriority({ priority: "urgent" })).toBe("urgent");
    expect(attributePriority({ order: 3 })).toBe("");
    expect(attributePriority({ priority: 2 })).toBe("");
    expect(attributePriority(null)).toBe("");
    expect(attributePriority(["priority"])).toBe("");
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

  it("excludes assignee_id from a task's generic remainder (dedicated Assignee row)", () => {
    const rows = extraBodyFields("task", {
      assignee_id: "c97f1dcd-cd3a-467e-94e0-e8789f7f35dc",
    });
    expect(rows).toEqual([]);
  });

  it("resolves an assignee by workspace_members row id, not user id", () => {
    const members: AssignableMember[] = [
      {
        id: "wm-1",
        userName: "Jack",
        email: "jack@example.com",
        avatarUrl: null,
        role: "member",
      },
      {
        id: "wm-2",
        userName: null,
        email: "no-name@example.com",
        avatarUrl: null,
        role: "admin",
      },
    ];
    expect(resolveAssignee(members, "wm-1")?.userName).toBe("Jack");
    // A user id must not match — assignee_id stores the member-row id.
    expect(resolveAssignee(members, "jack@example.com")).toBeNull();
    expect(resolveAssignee(members, "wm-missing")).toBeNull();
    expect(resolveAssignee(members, "")).toBeNull();
    expect(resolveAssignee(members, null)).toBeNull();
    expect(resolveAssignee(members, 42)).toBeNull();
    expect(resolveAssignee([], "wm-1")).toBeNull();
  });

  it("prefers the member's name, falls back to email, then null", () => {
    const base = { id: "wm", avatarUrl: null, role: "member" };
    expect(
      memberDisplayName({ ...base, userName: "Jack", email: "j@x.com" }),
    ).toBe("Jack");
    expect(memberDisplayName({ ...base, userName: null, email: "j@x.com" })).toBe(
      "j@x.com",
    );
    expect(memberDisplayName({ ...base, userName: "", email: null })).toBeNull();
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

  it("omits attribute keys that render as dedicated rows (the Priority row)", () => {
    expect(
      flattenAttributes({ priority: "high", order: 3 }, new Set(["priority"])),
    ).toEqual([["order", "3"]]);
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
