/**
 * Pure workspace-picker organization shared by the web picker, the desktop
 * picker, and the in-workspace switcher.
 *
 * [COMP:app-web/workspace-picker]
 */

const SCALABLE_WORKSPACE_THRESHOLD = 5;
const RECENT_WORKSPACE_LIMIT = 5;

export type WorkspacePickerItem = {
  id: string;
  name: string;
  role?: "owner" | "admin" | "member";
  iconSeed?: number | null;
  iconUrl?: string | null;
  plan?: string | null;
  pickerPinnedAt?: string | null;
  pickerHiddenAt?: string | null;
  pickerLastOpenedAt?: string | null;
};

export type WorkspacePickerGroups<T extends WorkspacePickerItem = WorkspacePickerItem> = {
  pinned: T[];
  recent: T[];
  all: T[];
  hidden: T[];
  allCount: number;
};

export function usesScalableWorkspacePicker(totalMemberships: number): boolean {
  return totalMemberships > SCALABLE_WORKSPACE_THRESHOLD;
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestBy(
  field: "pickerPinnedAt" | "pickerHiddenAt" | "pickerLastOpenedAt",
) {
  return (a: WorkspacePickerItem, b: WorkspacePickerItem) =>
    timestamp(b[field]) - timestamp(a[field]);
}

/**
 * Produce mutually-exclusive picker sections. Unranked "All" rows retain the
 * API's stable Personal-then-created ordering; only pinned/recent/hidden rows
 * need timestamp sorting.
 */
export function organizeWorkspacePicker<T extends WorkspacePickerItem>(
  workspaces: readonly T[],
  query = "",
): WorkspacePickerGroups<T> {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (workspace: WorkspacePickerItem) =>
    !needle || workspace.name.toLocaleLowerCase().includes(needle);

  const matched = workspaces.filter(matches);
  const visible = matched.filter((workspace) => !workspace.pickerHiddenAt);
  const hidden = matched
    .filter((workspace) => !!workspace.pickerHiddenAt)
    .sort(newestBy("pickerHiddenAt"));
  const pinned = visible
    .filter((workspace) => !!workspace.pickerPinnedAt)
    .sort(newestBy("pickerPinnedAt"));
  const pinnedIds = new Set(pinned.map((workspace) => workspace.id));
  const recent = visible
    .filter(
      (workspace) =>
        !pinnedIds.has(workspace.id) && !!workspace.pickerLastOpenedAt,
    )
    .sort(newestBy("pickerLastOpenedAt"))
    .slice(0, RECENT_WORKSPACE_LIMIT);
  const recentIds = new Set(recent.map((workspace) => workspace.id));
  const all = visible.filter(
    (workspace) =>
      !pinnedIds.has(workspace.id) && !recentIds.has(workspace.id),
  );

  return {
    pinned,
    recent,
    all,
    hidden,
    allCount: all.length,
  };
}
