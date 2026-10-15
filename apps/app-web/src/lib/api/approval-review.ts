/**
 * Delegated approval review API (docs/architecture/features/approval-review.md
 * -> "Surfaces"). Every call goes through the same server services Brian and
 * the brain MCP use; the actor is the signed-in member, never a body field.
 * The normal human response stays on `/api/approvals/:id/respond`.
 */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type ApprovalReviewScopeKind = "request" | "task" | "session" | "workflow" | "browser_skill";

export type ApprovalReviewAssignment = {
  id: string;
  workspaceId: string;
  reviewerAssistantId: string;
  delegatorUserId: string;
  scopeKind: ApprovalReviewScopeKind;
  scopeId: string;
  status: "active" | "revoked";
  revision: number;
  origin: "ui" | "chat";
};

type AttentionReview = {
  assignmentId: string;
  reviewerAssistantId: string;
  reviewerName: string | null;
  lastAttempt: { outcome: "resolved" | "needs_human" | "blocked"; reasons: string[]; at: string } | null;
} | null;

export type AttentionItem =
  | { key: string; kind: "approval_waiting"; approvalId: string; approvalKind: string; toolName: string | null; summary: string | null
      createdAt: string; sessionId: string | null; workflowRunId: string | null; projectIds: string[]; review: AttentionReview; seen: boolean }
  | { key: string; kind: "delegated_decision"; approvalId: string; receiptId: string; reviewerAssistantId: string; reviewerName: string | null
      toolName: string | null; decidedAt: string; invalidated: boolean; sessionId: string | null; projectIds: string[]; seen: boolean }
  | { key: string; kind: "route_blocker"; eventId: string; workflowId: string; blocker: string; createdAt: string; projectIds: string[]; seen: boolean };

export type AttentionPayload = { items: AttentionItem[]; unseen: number };

export type ApprovalPatternView = {
  id: string;
  status: "proposed" | "active" | "suspended" | "revoked";
  version: number;
  revision: number;
  actionKind: string;
  procedureKind: "workflow" | "browser_skill";
  procedureId: string;
  suspendedReason: string | null;
  support: { approvedChains: number; required: number; contradicted: boolean };
  updatedAt: string;
};

export type ReviewResult =
  | { outcome: "resolved"; receipt: { id: string; reviewerAssistantId: string }; replay: boolean }
  | { outcome: "needs_human" | "blocked"; reasons: string[] };

class ApprovalReviewApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
  }
}

function base(workspaceId: string) {
  return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/approval-review`;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApprovalReviewApiError(body.error ?? "request_failed", res.status, body.message ?? `Request failed (${res.status})`);
  return body as T;
}

export function attentionCacheKey(workspaceId: string, scope: { sessionId?: string | null; projectId?: string | null }) {
  return `approval-review:attention:${workspaceId}:${scope.projectId ?? ""}:${scope.sessionId ?? ""}`;
}

export function fetchAttention(workspaceId: string, scope: { sessionId?: string | null; projectId?: string | null } = {}) {
  const q = new URLSearchParams();
  if (scope.projectId) q.set("projectId", scope.projectId);
  else if (scope.sessionId) q.set("sessionId", scope.sessionId);
  const qs = q.toString();
  return call<AttentionPayload>(`${base(workspaceId)}/attention${qs ? `?${qs}` : ""}`);
}

export function markAttentionSeen(workspaceId: string, keys: string[]) {
  return call<{ marked: number }>(`${base(workspaceId)}/attention/seen`, { method: "POST", body: JSON.stringify({ keys }) });
}

export function listAssignments(workspaceId: string) {
  return call<{ assignments: ApprovalReviewAssignment[] }>(`${base(workspaceId)}/assignments`);
}

export function assignReviewer(workspaceId: string, input: { reviewerAssistantId: string; scopeKind: ApprovalReviewScopeKind; scopeId: string; idempotencyKey: string }) {
  return call<{ outcome: "created" | "duplicate"; assignment: ApprovalReviewAssignment }>(`${base(workspaceId)}/assignments`, { method: "POST", body: JSON.stringify(input) });
}

export function changeReviewer(workspaceId: string, assignmentId: string, input: { expectedRevision: number; reviewerAssistantId: string }) {
  return call<ApprovalReviewAssignment>(`${base(workspaceId)}/assignments/${encodeURIComponent(assignmentId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function revokeReviewer(workspaceId: string, assignmentId: string, expectedRevision?: number) {
  return call<ApprovalReviewAssignment>(`${base(workspaceId)}/assignments/${encodeURIComponent(assignmentId)}/revoke`, { method: "POST", body: JSON.stringify({ expectedRevision }) });
}

export function requestReview(workspaceId: string, approvalId: string) {
  return call<ReviewResult>(`${base(workspaceId)}/requests/${encodeURIComponent(approvalId)}/review`, { method: "POST", body: "{}" });
}

export function listPatterns(workspaceId: string) {
  return call<{ patterns: ApprovalPatternView[] }>(`${base(workspaceId)}/patterns`);
}

export function revokePattern(workspaceId: string, patternId: string, expectedRevision: number) {
  return call<ApprovalPatternView>(`${base(workspaceId)}/patterns/${encodeURIComponent(patternId)}/revoke`, { method: "POST", body: JSON.stringify({ expectedRevision }) });
}

export function newIdempotencyKey(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
