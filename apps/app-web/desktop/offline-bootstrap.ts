/**
 * Pure normalization for the bundled desktop shell's offline bootstrap cache.
 *
 * The renderer persists only successful workspace-list and workspace-identity
 * responses. On a later cold start it runs these normalizers again before
 * trusting the structured-clone value, so a stale/older cache shape cannot
 * crash the local shell. Network responses use the same path, keeping cache
 * and live state byte-for-byte aligned.
 *
 * Part of [COMP:app-web/desktop-spa].
 */

import type { WorkspacePickerItem } from "@/lib/workspace-picker";
import type { WorkspaceContextValue } from "@/lib/workspace-context";

export const DESKTOP_WORKSPACES_CACHE_KEY = "desktop:workspaces:v1";

export function desktopWorkspaceCacheKey(workspaceId: string): string {
  return `desktop:workspace:v1:${workspaceId}`;
}
/** Normalize either API response shape or a previously cached list. */
export function parseDesktopWorkspaceRows(data: unknown): WorkspacePickerItem[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { workspaces?: unknown[] } | null)?.workspaces)
      ? (data as { workspaces: unknown[] }).workspaces
      : [];

  return rows
    .map((value): WorkspacePickerItem | null => {
      const row = (value ?? {}) as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : null;
      if (!id) return null;
      return {
        id,
        name: typeof row.name === "string" ? row.name : id,
        role:
          row.role === "owner" || row.role === "admin" || row.role === "member"
            ? row.role
            : undefined,
        iconSeed: typeof row.iconSeed === "number" ? row.iconSeed : null,
        iconUrl: typeof row.iconUrl === "string" ? row.iconUrl : null,
        plan: typeof row.plan === "string" ? row.plan : null,
        pickerPinnedAt:
          typeof row.pickerPinnedAt === "string" ? row.pickerPinnedAt : null,
        pickerHiddenAt:
          typeof row.pickerHiddenAt === "string" ? row.pickerHiddenAt : null,
        pickerLastOpenedAt:
          typeof row.pickerLastOpenedAt === "string" ? row.pickerLastOpenedAt : null,
      };
    })
    .filter((row): row is WorkspacePickerItem => row !== null);
}

/** Normalize an API response or cache entry for WorkspaceContextProvider. */
export function parseDesktopWorkspaceContext(
  workspaceId: string,
  data: unknown,
): WorkspaceContextValue | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const role = row.role;
  const clearance = row.clearance;
  const me = row.me && typeof row.me === "object"
    ? (row.me as Record<string, unknown>)
    : null;

  return {
    workspaceId,
    name: typeof row.name === "string" ? row.name : "Workspace",
    iconSeed: typeof row.iconSeed === "number" ? row.iconSeed : null,
    iconUrl: typeof row.iconUrl === "string" ? row.iconUrl : null,
    role:
      role === "owner" || role === "admin" || role === "member"
        ? role
        : "member",
    clearance:
      clearance === "public" || clearance === "internal" || clearance === "confidential"
        ? clearance
        : "internal",
    me: { id: typeof me?.id === "string" ? me.id : "" },
  };
}
