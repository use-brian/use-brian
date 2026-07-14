import { describe, it, expect } from "vitest";
import { canDeleteWorkspace } from "../workspace-permissions";

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
