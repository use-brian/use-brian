/**
 * [COMP:app-web/teamspace-settings] Teamspace policy-error → copy-key mapping.
 * Spec: docs/architecture/features/teamspaces.md.
 */

import { describe, it, expect } from "vitest";
import { teamspaceErrorCopyKey } from "../teamspace-errors";
import { TeamspaceApiError } from "@/lib/api/teamspaces";

describe("[COMP:app-web/teamspace-settings] teamspaceErrorCopyKey", () => {
  it("maps each known policy code to its dictionary key", () => {
    const cases: Array<[string, string]> = [
      ["insufficient_clearance", "teamspaceErrorInsufficientClearance"],
      ["sensitivity_exceeds_clearance", "teamspaceErrorSensitivityExceedsClearance"],
      ["member_below_sensitivity", "teamspaceErrorMemberBelowSensitivity"],
      ["target_clearance_below_sensitivity", "teamspaceErrorTargetClearanceBelow"],
    ];
    for (const [code, key] of cases) {
      expect(teamspaceErrorCopyKey(new TeamspaceApiError(403, code, code))).toBe(key);
    }
  });

  it("returns null for an unrecognised policy code (caller shows raw message)", () => {
    expect(teamspaceErrorCopyKey(new TeamspaceApiError(500, "boom", "boom"))).toBeNull();
    expect(teamspaceErrorCopyKey(new TeamspaceApiError(409, null, "conflict"))).toBeNull();
  });

  it("returns null for a non-TeamspaceApiError (network / generic Error)", () => {
    expect(teamspaceErrorCopyKey(new Error("offline"))).toBeNull();
    expect(teamspaceErrorCopyKey("nope")).toBeNull();
  });
});
