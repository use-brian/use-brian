/**
 * Unit tests for the webhook `match` codec (guided rules ↔ JSONLogic).
 * Component tag: [COMP:app-web/workflow].
 */

import { describe, it, expect } from "vitest";
import {
  conditionToRules,
  emptyRule,
  rulesToCondition,
  type WebhookRule,
} from "../webhook-match";

describe("[COMP:app-web/workflow] webhook-match codec", () => {
  it("emits a bare comparator for a single rule and prefixes input.", () => {
    const rules: WebhookRule[] = [{ path: "type", op: "==", value: "deal.won" }];
    expect(rulesToCondition(rules, "and")).toEqual({
      "==": [{ var: "input.type" }, "deal.won"],
    });
  });

  it("combines multiple rules under and / or", () => {
    const rules: WebhookRule[] = [
      { path: "type", op: "==", value: "deal.won" },
      { path: "amount", op: ">", value: "1000" },
    ];
    expect(rulesToCondition(rules, "or")).toEqual({
      or: [
        { "==": [{ var: "input.type" }, "deal.won"] },
        { ">": [{ var: "input.amount" }, 1000] }, // numeric op coerces value
      ],
    });
  });

  it("coerces true/false/null but keeps equality ids as strings", () => {
    expect(rulesToCondition([{ path: "active", op: "==", value: "true" }], "and")).toEqual({
      "==": [{ var: "input.active" }, true],
    });
    expect(rulesToCondition([{ path: "ref", op: "==", value: "007" }], "and")).toEqual({
      "==": [{ var: "input.ref" }, "007"],
    });
  });

  it("maps contains to an `in` node (value in field)", () => {
    expect(
      rulesToCondition([{ path: "labels", op: "contains", value: "urgent" }], "and"),
    ).toEqual({ in: ["urgent", { var: "input.labels" }] });
  });

  it("returns undefined when no rule has a path (fire on every delivery)", () => {
    expect(rulesToCondition([emptyRule()], "and")).toBeUndefined();
    expect(rulesToCondition([], "and")).toBeUndefined();
  });

  it("round-trips a single comparator back to a rule", () => {
    expect(conditionToRules({ "==": [{ var: "input.type" }, "deal.won"] })).toEqual({
      rules: [{ path: "type", op: "==", value: "deal.won" }],
      combine: "and",
    });
  });

  it("round-trips an and/or group back to rules", () => {
    expect(
      conditionToRules({
        and: [
          { "!=": [{ var: "input.stage" }, "lost"] },
          { in: ["vip", { var: "input.tags" }] },
        ],
      }),
    ).toEqual({
      rules: [
        { path: "stage", op: "!=", value: "lost" },
        { path: "tags", op: "contains", value: "vip" },
      ],
      combine: "and",
    });
  });

  it("treats an absent condition as zero rules (guided mode)", () => {
    expect(conditionToRules(undefined)).toEqual({ rules: [], combine: "and" });
    expect(conditionToRules(null)).toEqual({ rules: [], combine: "and" });
  });

  it("returns null for conditions too complex for the simple editor", () => {
    // nested boolean logic
    expect(
      conditionToRules({ and: [{ or: [{ "==": [{ var: "input.a" }, "1"] }] }] }),
    ).toBeNull();
    // unsupported operator
    expect(conditionToRules({ "+": [1, 2] })).toBeNull();
    // a comparator whose left side is not a var
    expect(conditionToRules({ "==": ["x", "y"] })).toBeNull();
  });

  it("full round-trip: rules → condition → rules is stable", () => {
    const rules: WebhookRule[] = [
      { path: "type", op: "==", value: "deal.won" },
      { path: "amount", op: ">=", value: "500" },
    ];
    const cond = rulesToCondition(rules, "and");
    expect(conditionToRules(cond)).toEqual({ rules, combine: "and" });
  });
});
