import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * SDK for the Live all-activity roster (docs/architecture/features/live-work.md §3).
 *
 *   GET /api/workspaces/:workspaceId/live
 *
 * Types mirror the route's server-side-tiered projection: a `presence`
 * session row carries EXACTLY the §6.1 allowlist (no `title`, no
 * `visibility`); above-clearance rows never arrive at all — the client
 * renders what it is shipped and adds nothing.
 *
 * [COMP:app-web/live-app]
 */

import { SurfaceCacheEvictionError } from "@/lib/surface-cache";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type LiveWorkState = "working" | "waiting" | "stalled" | "settled";

export type LiveSessionItem = {
  kind: "session";
  tier: "full" | "presence";
  id: string;
  assistantId: string;
  assistantName: string;
  assistantIconSeed: number;
  ownerUserId: string | null;
  ownerName: string | null;
  channelType: string;
  state: LiveWorkState;
  startedAt: string;
  lastActiveAt: string;
  /** Full tier only. */
  visibility?: string | null;
  /** Full tier only. */
  title?: string;
  /** Full tier only. The running lane owns a turn inbox and can accept steer. */
  canSteer?: boolean;
};

export type LiveWorkflowRunItem = {
  kind: "workflow_run";
  id: string;
  workflowId: string;
  workflowName: string;
  assistantId: string | null;
  assistantName: string | null;
  trigger: "scheduled" | "manual" | "event";
  state: LiveWorkState;
  startedAt: string;
  lastActiveAt: string;
  stepSummary?: string;
};

export type LiveWorkItem = LiveSessionItem | LiveWorkflowRunItem;

const deadlines = new WeakMap<LiveWorkItem[], number>();
const MAX_AGE_MS = 30_000;

/** Expiry metadata stays local to each authorized response, including prefetch. */
export function liveRosterRemaining(value: unknown): number {
  return Math.max(0, (deadlines.get(value as LiveWorkItem[]) ?? 0) - performance.now());
}

export async function fetchLiveRoster(
  workspaceId: string,
): Promise<LiveWorkItem[]> {
  const started = performance.now();
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/live`,
  );
  if (!res.ok) {
    const error = new Error(`live roster failed: ${res.status}`);
    if ([401, 403, 404].includes(res.status)) throw new SurfaceCacheEvictionError(error);
    throw error;
  }
  const body = (await res.json()) as { items?: LiveWorkItem[] };
  const items = body.items ?? [];
  deadlines.set(items, started + MAX_AGE_MS);
  if (liveRosterRemaining(items) <= 0) throw new SurfaceCacheEvictionError(new Error('live_roster_expired'));
  return items;
}
