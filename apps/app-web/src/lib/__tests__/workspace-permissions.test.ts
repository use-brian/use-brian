import { describe, it, expect } from "vitest";
import { canDeleteWorkspace } from "../workspace-permissions";

describe("[COMP:app-web/workspace-delete-guard] canDeleteWorkspace", () => {
  it("lets the owner delete any workspace", () => {
    expect(canDeleteWorkspace("owner")).toBe(true);
  });
  it("refuses non-owners", () => {
    for (const role of ["admin", "member", ""]) expect(canDeleteWorkspace(role)).toBe(false);
  });
});
