import { describe, expect, it } from "vitest";
import {
  PLAN_GATE_TRIAL_RETURN_PATH,
  modelTierPlanGateApplies,
  planGateApplies,
  planGateDismissKey,
  forwardPlanGateCheckoutReturn,
  planGateCheckoutReturn,
  planGateTrialCheckoutBody,
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

  it("starts the eligible trial directly and returns to the workspace entry", () => {
    expect(PLAN_GATE_TRIAL_RETURN_PATH).toBe("/home");
    expect(planGateTrialCheckoutBody("ws_1")).toEqual({
      workspace_id: "ws_1",
      plan: "pro",
      returnTo: "/home",
    });
  });

  it("parses and forwards a successful checkout handoff", () => {
    expect(
      planGateCheckoutReturn("?checkout=success&session_id=cs_test_123"),
    ).toEqual({ status: "success", sessionId: "cs_test_123" });
    expect(
      forwardPlanGateCheckoutReturn(
        "/w/ws_1/p",
        "?checkout=success&session_id=cs_test_123&ignored=value",
      ),
    ).toBe("/w/ws_1/p?checkout=success&session_id=cs_test_123");
  });

  it("preserves cancellation without inventing a session id", () => {
    expect(planGateCheckoutReturn("?checkout=cancelled")).toEqual({
      status: "cancelled",
      sessionId: null,
    });
    expect(
      forwardPlanGateCheckoutReturn("/w/ws_1/p", "?checkout=cancelled"),
    ).toBe("/w/ws_1/p?checkout=cancelled");
    expect(forwardPlanGateCheckoutReturn("/w/ws_1/p", "?foo=bar")).toBe(
      "/w/ws_1/p",
    );
  });
});
