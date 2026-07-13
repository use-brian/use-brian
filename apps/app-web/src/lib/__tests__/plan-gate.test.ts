import { describe, expect, it } from "vitest";
import { planGateApplies, planGateDismissKey } from "../plan-gate";

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

  it("scopes the dismissal key per workspace", () => {
    expect(planGateDismissKey("ws_1")).not.toBe(planGateDismissKey("ws_2"));
    expect(planGateDismissKey("ws_1")).toContain("ws_1");
  });
});
