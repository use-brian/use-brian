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
  applyWorkspaceIcon,
  applyWorkspaceRename,
  type WorkspaceContextValue,
} from "@/lib/workspace-context";

const base: WorkspaceContextValue = {
  workspaceId: "ws1",
  name: "Acme",
  iconSeed: 12,
  iconUrl: null,
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

describe("[COMP:app-web/workspace-context] applyWorkspaceIcon", () => {
  it("overrides the generated icon with an uploaded picture for this workspace", () => {
    const next = applyWorkspaceIcon(base, {
      workspaceId: "ws1",
      iconSeed: 12,
      iconUrl: "https://api.example/api/workspace-icons/ws1?v=one",
    });
    expect(next.iconUrl).toContain("/api/workspace-icons/ws1");
    expect(next.iconSeed).toBe(12);
  });

  it("clears the picture while preserving a new generated seed", () => {
    const withPicture = {
      ...base,
      iconUrl: "https://api.example/api/workspace-icons/ws1?v=one",
    };
    const next = applyWorkspaceIcon(withPicture, {
      workspaceId: "ws1",
      iconSeed: 99,
      iconUrl: null,
    });
    expect(next.iconUrl).toBeNull();
    expect(next.iconSeed).toBe(99);
  });

  it("ignores another workspace and stays reference-stable on no change", () => {
    expect(
      applyWorkspaceIcon(base, {
        workspaceId: "ws2",
        iconSeed: 1,
        iconUrl: "https://example.com/other.png",
      }),
    ).toBe(base);
    expect(
      applyWorkspaceIcon(base, {
        workspaceId: "ws1",
        iconSeed: 12,
        iconUrl: null,
      }),
    ).toBe(base);
  });
});
