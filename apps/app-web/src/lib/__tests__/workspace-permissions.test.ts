import { describe, it, expect } from "vitest";
import { canDeleteWorkspace, isSharedWorkspace } from "../workspace-permissions";

describe("[COMP:app-web/workspace-delete-guard] canDeleteWorkspace", () => {
  it("lets the owner delete a non-personal (team) workspace", () => {
    expect(canDeleteWorkspace("owner", false)).toBe(true);
  });

  it("refuses a personal workspace even for its owner — the API would 404", () => {
    // Regression guard: a personal workspace shown a working Delete button is a
    // dead 404 because workspaceStore.delete() filters `is_personal = false`.
    expect(canDeleteWorkspace("owner", true)).toBe(false);
  });

  it("refuses non-owners regardless of the personal flag", () => {
    expect(canDeleteWorkspace("admin", false)).toBe(false);
    expect(canDeleteWorkspace("member", false)).toBe(false);
  });
});

describe("[COMP:app-web/workspace-delete-guard] isSharedWorkspace", () => {
  it("is shared once there is more than one member", () => {
    expect(isSharedWorkspace(2)).toBe(true);
    expect(isSharedWorkspace(10)).toBe(true);
  });

  it("is solo at one member — keyed on count, never on is_personal", () => {
    expect(isSharedWorkspace(1)).toBe(false);
    expect(isSharedWorkspace(0)).toBe(false);
  });

  it("treats an absent count as solo (fail to 'not shared')", () => {
    expect(isSharedWorkspace(undefined)).toBe(false);
  });
});
