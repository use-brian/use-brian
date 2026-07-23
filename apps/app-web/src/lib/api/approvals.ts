/**
 * SDK for the unified approval queue (app-web).
 *
 * Ported from `apps/web/src/lib/api/approvals.ts` as part of the app
 * consolidation (docs/architecture/features/doc.md §5a). Identical
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
 * The staged_skill_* kinds also resolve in place, but through the
 * DEDICATED surface `/api/skills/approvals` (the unified respond route
 * 422s them by design) — `respondByKind` routes each row to the right
 * endpoint, and `listSkillApprovalDetails` fetches the target-skill
 * snapshot the diff view needs. Only `distribution_draft` (feed) and
 * `question` (chat) still defer to their originating surface via the
 * `nativeSurface` hint.
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
  | "staged_skill_update"
  | "workflow_refinement"
  | "browser_skill_send";

/** Provenance surface for `staged_write` rows — which credential class the agent used. */
type StagedWriteSurface = "brain_mcp" | "assistant_mcp" | "public_api";

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
    // browser_skill_send (computer-use R2-2/R2-5) — the block send's context
    skillId?: string;
    skillName?: string;
    profileId?: string;
    profileName?: string;
    site?: string;
    label?: string | null;
    /** Verb-ceiling hit — "Allow always" is never offered (R2-1). */
    ceiling?: string | null;
    /** Drift that voided a grant and re-gated this send (R2-2). */
    drift?: string | null;
    contractSummary?: string;
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

/**
 * Approve or reject. Resolves `workflow_step` and `tool_invocation` in
 * place; for the other kinds the backend replies 422 with a
 * `nativeSurface` directive, returned here as `{ ok: false,
 * nativeSurface }` so the caller can deep-link.
 */
async function respondToApproval(
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
  extra?: { grantAlways?: boolean },
): Promise<RespondResult> {
  const res = await authFetch(
    `${API_URL}/api/approvals/${encodeURIComponent(id)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason, ...(extra?.grantAlways ? { grantAlways: true } : {}) }),
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

// ── Curator approvals (staged_skill_* / workflow_refinement) ──────────
// These rows live in the same queue but action through the dedicated
// `/api/skills/approvals` routes (packages/api/src/routes/skill-approvals.ts).

export type SkillApprovalKind =
  | "staged_skill_creation"
  | "staged_skill_update"
  | "workflow_refinement";

export function isSkillApprovalKind(kind: ApprovalKind): kind is SkillApprovalKind {
  return (
    kind === "staged_skill_creation" ||
    kind === "staged_skill_update" ||
    kind === "workflow_refinement"
  );
}

/** Snapshot of a staged update's target skill, joined server-side. */
type SkillApprovalTargetSkill = {
  id: string;
  name: string;
  slug: string;
  content: string;
};

/** Snapshot of the workflow a `workflow_refinement` (or a creation row's
 *  attach offer) targets, joined server-side. */
export type SkillApprovalTargetWorkflow = {
  id: string;
  name: string;
  steps: Array<{ id: string; type: string; prompt: string | null }>;
};

export type SkillApprovalDetail = {
  id: string;
  kind: SkillApprovalKind;
  arguments: Record<string, unknown>;
  approvalPayload?: {
    // Origin-aware induction: a workflow-origin creation carries the offer
    // to wire the new skill into the source step's `skills` allow-list.
    attachTo?: { workflowId: string; stepId?: string };
    origin?: string;
    sourceWorkflowIds?: string[];
  };
  /** null for creation rows, and for update rows whose target skill was
   *  deleted after staging (the card blocks approve in that case). */
  targetSkill: SkillApprovalTargetSkill | null;
  /** null when the row touches no workflow, or the workflow vanished after
   *  staging (the card blocks refinement approve / hides the attach offer). */
  targetWorkflow?: SkillApprovalTargetWorkflow | null;
};

/**
 * Detail fetch for the queue's skill cards, keyed by approval id — one
 * request for the whole page, not one per card. Returns {} on failure so
 * the cards degrade to a proposed-only view.
 */
export async function listSkillApprovalDetails(
  workspaceId: string,
): Promise<Record<string, SkillApprovalDetail>> {
  const q = new URLSearchParams({ workspaceId });
  const res = await authFetch(`${API_URL}/api/skills/approvals?${q.toString()}`);
  if (!res.ok) return {};
  const data = (await res.json().catch(() => ({}))) as {
    approvals?: SkillApprovalDetail[];
  };
  const byId: Record<string, SkillApprovalDetail> = {};
  for (const row of data.approvals ?? []) byId[row.id] = row;
  return byId;
}

/** Approve or reject a curator row via its dedicated endpoints. `attach`
 *  applies only to workflow-origin `staged_skill_creation` approves: also
 *  wire the new skill into the offered step's `skills` allow-list. */
export async function respondToSkillApproval(
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
  extra?: { attach?: boolean; attachStepId?: string },
): Promise<RespondResult> {
  const action = decision === "approved" ? "approve" : "reject";
  const body =
    decision === "rejected"
      ? reason
        ? { reason }
        : {}
      : {
          ...(extra?.attach ? { attach: true } : {}),
          ...(extra?.attach && extra.attachStepId ? { attachStepId: extra.attachStepId } : {}),
        };
  const res = await authFetch(
    `${API_URL}/api/skills/approvals/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
    detail?: string;
  };
  if (res.ok) {
    return { ok: true, status: data.status ?? "resolved" };
  }
  return { ok: false, error: data.detail ?? data.error ?? "Request failed" };
}

/** Kind-aware respond dispatch — the queue's single action entry point.
 *  `grantAlways` applies only to `browser_skill_send` rows: approve AND mint
 *  the standing block+profile grant (R2-2's third button). */
export function respondByKind(
  row: Pick<PendingApprovalRow, "id" | "kind">,
  decision: "approved" | "rejected",
  reason?: string,
  extra?: { grantAlways?: boolean; attach?: boolean; attachStepId?: string },
): Promise<RespondResult> {
  return isSkillApprovalKind(row.kind)
    ? respondToSkillApproval(row.id, decision, reason, extra)
    : respondToApproval(row.id, decision, reason, extra);
}
