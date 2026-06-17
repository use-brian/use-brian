/**
 * SDK for the unified approval queue (app-web).
 *
 * Ported from `apps/web/src/lib/api/approvals.ts` as part of the app
 * consolidation (docs/plans/doc-web-app-consolidation.md §5a). Identical
 * wire contract — wraps `authFetch` with typed signatures matching the REST
 * routes mounted at `/api/approvals` in `apps/api/src/index.ts`. Kept as its
 * own file (not imported from apps/web) per the same convention as
 * `lib/api/views.ts` / `lib/api/kb-gaps.ts`.
 *
 *   GET  /api/approvals?workspaceId=
 *   GET  /api/approvals/count?workspaceId=
 *   POST /api/approvals/:id/respond
 *
 * `workflow_step`, `tool_invocation`, and `staged_write` approvals resolve
 * in place (on approve, a `staged_write`'s staged tool executes
 * server-side; a 502 means the apply failed and the row stays pending).
 * The other kinds (distribution_draft, staged_skill_*) list here for
 * visibility but resolve through their originating surface —
 * `respondToApproval` surfaces the backend's `nativeSurface` directive
 * so the UI can deep-link instead.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ApprovalKind =
  | "workflow_step"
  | "tool_invocation"
  | "question"
  | "staged_write"
  | "distribution_draft"
  | "staged_skill_creation"
  | "staged_skill_update";

/** Provenance surface for `staged_write` rows — which credential class the agent used. */
export type StagedWriteSurface = "brain_mcp" | "assistant_mcp" | "public_api";

export type PendingApprovalRow = {
  id: string;
  kind: ApprovalKind;
  status: string;
  toolName: string;
  arguments: Record<string, unknown>;
  approvalPayload: {
    description?: string;
    displayLines?: string[];
    allowPersistentApproval?: boolean;
    // staged_write provenance (kind='staged_write' only)
    surface?: StagedWriteSurface;
    credentialId?: string;
    originLabel?: string;
    originatingAssistantId?: string;
  };
  approverUserId: string;
  originatingAssistantId: string | null;
  blockingSessionId: string | null;
  workflowRunId: string | null;
  deliveryChannelType: string;
  createdAt: string;
  expiresAt: string | null;
};

export type RespondResult =
  | { ok: true; status: string }
  | { ok: false; nativeSurface: string; blockingSessionId: string | null }
  | { ok: false; error: string };

/** List every pending approval for the workspace. */
export async function listApprovals(
  workspaceId: string,
): Promise<PendingApprovalRow[]> {
  const q = new URLSearchParams({ workspaceId });
  const res = await authFetch(`${API_URL}/api/approvals?${q.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { approvals?: PendingApprovalRow[] };
  return Array.isArray(data.approvals) ? data.approvals : [];
}

/** Pending count for the workspace — backs the chrome badge. */
export async function approvalCount(workspaceId: string): Promise<number> {
  const q = new URLSearchParams({ workspaceId });
  const res = await authFetch(`${API_URL}/api/approvals/count?${q.toString()}`);
  if (!res.ok) return 0;
  const data = (await res.json()) as { pending?: number };
  return typeof data.pending === "number" ? data.pending : 0;
}

/**
 * Approve or reject. Resolves `workflow_step` and `tool_invocation` in
 * place; for the other kinds the backend replies 422 with a
 * `nativeSurface` directive, returned here as `{ ok: false,
 * nativeSurface }` so the caller can deep-link.
 */
export async function respondToApproval(
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
): Promise<RespondResult> {
  const res = await authFetch(
    `${API_URL}/api/approvals/${encodeURIComponent(id)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    nativeSurface?: string;
    blockingSessionId?: string | null;
    error?: string;
  };
  if (res.ok) {
    return { ok: true, status: data.status ?? "resolved" };
  }
  if (res.status === 422 && data.nativeSurface) {
    return {
      ok: false,
      nativeSurface: data.nativeSurface,
      blockingSessionId: data.blockingSessionId ?? null,
    };
  }
  return { ok: false, error: data.error ?? "Request failed" };
}
