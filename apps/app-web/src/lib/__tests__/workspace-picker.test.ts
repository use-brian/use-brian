/**
 * [COMP:app-web/workspace-picker] Threshold and section organization.
 */

import { describe, expect, it } from "vitest";
import {
  organizeWorkspacePicker,
  usesScalableWorkspacePicker,
  type WorkspacePickerItem,
} from "../workspace-picker";

function workspace(
  id: string,
  overrides: Partial<WorkspacePickerItem> = {},
): WorkspacePickerItem {
  return { id, name: `Workspace ${id}`, ...overrides };
}

describe("[COMP:app-web/workspace-picker] scalable workspace picker", () => {
  it("keeps the simple picker through five memberships and scales at six", () => {
    expect(usesScalableWorkspacePicker(1)).toBe(false);
    expect(usesScalableWorkspacePicker(5)).toBe(false);
    expect(usesScalableWorkspacePicker(6)).toBe(true);
  });

  it("creates mutually-exclusive pinned, recent, all, and hidden sections", () => {
    const groups = organizeWorkspacePicker([
      workspace("all"),
      workspace("recent-old", {
        pickerLastOpenedAt: "2026-08-01T00:00:00.000Z",
      }),
      workspace("recent-new", {
        pickerLastOpenedAt: "2026-08-03T00:00:00.000Z",
      }),
      workspace("pinned", {
        pickerPinnedAt: "2026-08-02T00:00:00.000Z",
        pickerLastOpenedAt: "2026-08-04T00:00:00.000Z",
      }),
      workspace("hidden", {
        pickerHiddenAt: "2026-08-05T00:00:00.000Z",
      }),
    ]);

    expect(groups.pinned.map((row) => row.id)).toEqual(["pinned"]);
    expect(groups.recent.map((row) => row.id)).toEqual([
      "recent-new",
      "recent-old",
    ]);
    expect(groups.all.map((row) => row.id)).toEqual(["all"]);
    expect(groups.hidden.map((row) => row.id)).toEqual(["hidden"]);
    expect(groups.allCount).toBe(1);
  });

  it("limits recents to five and searches hidden rows without restoring them", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      workspace(`recent-${index}`, {
        name: index === 6 ? "Needle Client" : `Client ${index}`,
        pickerLastOpenedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        pickerHiddenAt:
          index === 6 ? "2026-08-10T00:00:00.000Z" : null,
      }),
    );

    const unfiltered = organizeWorkspacePicker(rows);
    expect(unfiltered.recent).toHaveLength(5);
    expect(unfiltered.hidden.map((row) => row.id)).toEqual(["recent-6"]);

    const searched = organizeWorkspacePicker(rows, "needle");
    expect(searched.pinned).toEqual([]);
    expect(searched.recent).toEqual([]);
    expect(searched.all).toEqual([]);
    expect(searched.hidden.map((row) => row.id)).toEqual(["recent-6"]);
  });
});
