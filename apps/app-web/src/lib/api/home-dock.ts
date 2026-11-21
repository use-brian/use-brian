/** Home Dock SDK. See docs/architecture/features/home-dock.md. */
import type { CompatibleResolvedDock, HomeDockResponse } from "@use-brian/shared/home-dock";
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type ResolvedDock = CompatibleResolvedDock;

/**
 * Total items across the "Needs you" cards — the sidebar badge number (every
 * live needs-you count summed as one inbox-style number). The merge already
 * drops zero-count cards server-side; the clamp just keeps a buggy negative
 * signal from eating the others.
 */
export function needsYouTotal(dock: ResolvedDock | null): number {
  if (!dock) return 0;
  return dock.needsYou.reduce((sum, n) => sum + Math.max(0, n.count), 0);
}

/** Authoritative pending-approval total carried by the live approvals card. */
export function pendingApprovalTotal(dock: ResolvedDock | null): number {
  const approval = dock?.needsYou.find((need) => need.kind === "approvals");
  return Math.max(0, approval?.count ?? 0);
}

/** The resolved dock, or null on error (the caller renders a quiet fallback). */
export async function fetchHomeDock(workspaceId: string): Promise<ResolvedDock | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/home-dock?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<HomeDockResponse<ResolvedDock>>;
    return data.dock ?? null;
  } catch {
    return null;
  }
}
