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

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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

export async function fetchLiveRoster(
  workspaceId: string,
): Promise<LiveWorkItem[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/live`,
  );
  if (!res.ok) throw new Error(`live roster failed: ${res.status}`);
  const body = (await res.json()) as { items?: LiveWorkItem[] };
  return body.items ?? [];
}
