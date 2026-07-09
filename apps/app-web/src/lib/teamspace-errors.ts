/**
 * Pure mapping from a teamspace route's `{error}` code to the `docPage`
 * dictionary key that explains it (docs/architecture/features/teamspaces.md).
 * Kept out of the React modal so it unit-tests without mounting base-ui.
 *
 * Returns `null` for an unrecognised failure (network, 500, a code we don't
 * have copy for) — the caller falls back to the raw error message.
 *
 * [COMP:app-web/teamspace-settings]
 */

import { TeamspaceApiError } from "@/lib/api/teamspaces";

/** The `docPage` dictionary keys that render a teamspace policy error. */
export type TeamspaceErrorCopyKey =
  | "teamspaceErrorInsufficientClearance"
  | "teamspaceErrorSensitivityExceedsClearance"
  | "teamspaceErrorMemberBelowSensitivity"
  | "teamspaceErrorTargetClearanceBelow";

const CODE_TO_KEY: Record<string, TeamspaceErrorCopyKey> = {
  insufficient_clearance: "teamspaceErrorInsufficientClearance",
  sensitivity_exceeds_clearance: "teamspaceErrorSensitivityExceedsClearance",
  member_below_sensitivity: "teamspaceErrorMemberBelowSensitivity",
  target_clearance_below_sensitivity: "teamspaceErrorTargetClearanceBelow",
};

/**
 * The dictionary key for a teamspace error, or `null` when the failure isn't
 * a recognised policy code (so the caller shows the raw message instead).
 */
export function teamspaceErrorCopyKey(err: unknown): TeamspaceErrorCopyKey | null {
  if (err instanceof TeamspaceApiError && err.code) {
    return CODE_TO_KEY[err.code] ?? null;
  }
  return null;
}
