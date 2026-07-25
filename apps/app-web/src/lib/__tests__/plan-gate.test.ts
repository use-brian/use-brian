import { describe, expect, it } from "vitest";
import {
  modelTierPlanGateApplies,
  planGateApplies,
  planGateDismissKey,
} from "../plan-gate";

describe("[COMP:app-web/plan-gate] Plan gate decision", () => {
  it("gates a hosted workspace with no active plan ('free')", () => {
    expect(planGateApplies("hosted", "free")).toBe(true);
  });

  it("never gates the OSS edition, whatever the plan reads", () => {
    expect(planGateApplies("oss", "free")).toBe(false);
    expect(planGateApplies("oss", "pro")).toBe(false);
    expect(planGateApplies("oss", null)).toBe(false);
  });

  it("never gates paid plans on hosted", () => {
    for (const plan of ["pro", "max_5x", "max_10x", "enterprise"]) {
      expect(planGateApplies("hosted", plan)).toBe(false);
    }
  });

  it("does not gate while the plan is unknown (usage fetch in flight)", () => {
    expect(planGateApplies("hosted", null)).toBe(false);
    expect(planGateApplies("hosted", undefined)).toBe(false);
  });

  it("gates model tiers by plan only in hosted", () => {
    expect(modelTierPlanGateApplies("hosted", "free", "pro")).toBe(true);
    expect(modelTierPlanGateApplies("hosted", "free", "max")).toBe(true);
    expect(modelTierPlanGateApplies("hosted", "pro", "pro")).toBe(false);
    expect(modelTierPlanGateApplies("hosted", "pro", "max")).toBe(true);
    expect(modelTierPlanGateApplies("hosted", "max_5x", "max")).toBe(false);
  });

  it("never gates OSS model tiers even when its persisted plan is free", () => {
    expect(modelTierPlanGateApplies("oss", "free", "standard")).toBe(false);
    expect(modelTierPlanGateApplies("oss", "free", "pro")).toBe(false);
    expect(modelTierPlanGateApplies("oss", "free", "max")).toBe(false);
  });

  it("scopes the dismissal key per workspace", () => {
    expect(planGateDismissKey("ws_1")).not.toBe(planGateDismissKey("ws_2"));
    expect(planGateDismissKey("ws_1")).toContain("ws_1");
  });
});
