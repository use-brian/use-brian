import { describe, expect, it } from "vitest";

import {
  parseDesktopWorkspaceContext,
  parseDesktopWorkspaceRows,
} from "../offline-bootstrap";

describe("[COMP:app-web/desktop-spa] offline workspace bootstrap", () => {
  it("normalizes both workspace API shapes and drops unusable rows", () => {
    const rows = parseDesktopWorkspaceRows({
      workspaces: [
        {
          id: "ws-1",
          name: "Local workspace",
          role: "owner",
          iconSeed: 4,
          pickerPinnedAt: "2026-08-01T00:00:00.000Z",
        },
        { name: "missing id" },
      ],
    });

    expect(rows).toEqual([
      {
        id: "ws-1",
        name: "Local workspace",
        role: "owner",
        iconSeed: 4,
        iconUrl: null,
        plan: null,
        pickerPinnedAt: "2026-08-01T00:00:00.000Z",
        pickerHiddenAt: null,
        pickerLastOpenedAt: null,
      },
    ]);
    expect(parseDesktopWorkspaceRows(rows)).toEqual(rows);
  });

  it("normalizes cached workspace identity with safe authority defaults", () => {
    expect(
      parseDesktopWorkspaceContext("ws-1", {
        name: "Local workspace",
        role: "admin",
        clearance: "confidential",
        me: { id: "viewer-1" },
      }),
    ).toEqual({
      workspaceId: "ws-1",
      name: "Local workspace",
      iconSeed: null,
      iconUrl: null,
      role: "admin",
      clearance: "confidential",
      me: { id: "viewer-1" },
    });

    expect(
      parseDesktopWorkspaceContext("ws-1", {
        name: "Ordered workspace",
        role: "owner",
        homeApps: ["chat", "page"],
      })?.homeApps,
    ).toEqual(["chat", "page"]);

    expect(parseDesktopWorkspaceContext("ws-1", null)).toBeNull();
    expect(parseDesktopWorkspaceContext("ws-1", { role: "superuser" })).toMatchObject({
      role: "member",
      clearance: "internal",
    });
  });

});
