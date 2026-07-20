/**
 * [COMP:app-web/workspace-context] Rename override for the static workspace
 * snapshot.
 *
 * The `/w/[workspaceId]` context value is fetched once (Next server layout /
 * desktop `WorkspaceShell`) and never refetched, so a settings-modal rename
 * must flow through the `WORKSPACE_RENAMED_EVENT` broadcast into
 * `applyWorkspaceRename` for the top-left chrome to update without a reload.
 * app-web vitest has no DOM, so the pure override core is what's under test;
 * the event wiring (dispatch in `workspace-sections.tsx` `rename()`, listeners
 * in the provider + workspace-switcher) is exercised by hand / e2e.
 */

import { describe, expect, it } from "vitest";
import {
  applyWorkspaceRename,
  type WorkspaceContextValue,
} from "@/lib/workspace-context";

const base: WorkspaceContextValue = {
  workspaceId: "ws1",
  name: "Acme",
  role: "owner",
  clearance: "internal",
  me: { id: "u1" },
};

describe("[COMP:app-web/workspace-context] applyWorkspaceRename", () => {
  it("overrides the name when the rename targets this workspace", () => {
    const next = applyWorkspaceRename(base, {
      workspaceId: "ws1",
      name: "Acme Robotics",
    });
    expect(next.name).toBe("Acme Robotics");
    // Everything else carries through unchanged.
    expect(next).toMatchObject({
      workspaceId: "ws1",
      role: "owner",
      clearance: "internal",
      me: { id: "u1" },
    });
  });

  it("ignores a rename for a different workspace (reference-stable)", () => {
    const next = applyWorkspaceRename(base, {
      workspaceId: "ws2",
      name: "Other",
    });
    expect(next).toBe(base);
  });

  it("passes the snapshot through when no rename was observed", () => {
    expect(applyWorkspaceRename(base, null)).toBe(base);
  });

  it("stays reference-stable when the rename matches the current name", () => {
    // e.g. after a full reload the server snapshot already carries the new
    // name; the lingering override must not mint a new object every render.
    const next = applyWorkspaceRename(base, { workspaceId: "ws1", name: "Acme" });
    expect(next).toBe(base);
  });
});
