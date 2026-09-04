/**
 * SDK for durable current-turn input recovery — app-web port.
 *
 *   GET  /api/sessions/:sessionId/pending
 *   POST /api/sessions/:sessionId/answer/:approvalId
 *   POST /api/sessions/:sessionId/cancel/:approvalId
 *
 * Mirrors `apps/web/src/lib/api/pending-questions.ts` (kept as a
 * separate copy the same way the `/api/views/*` SDK is duplicated — see
 * apps/app-web/CLAUDE.md). The floating doc chat remains visually compact;
 * Chat's shared-room Work Bench consumes the worker summary to show the
 * delegated assistants that are currently active. The additive
 * `toolConfirmation` response restores generic approval cards on re-entry.
 *
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md.
 * [COMP:app-web/pending-questions]
 */

import type { PendingConfirmation } from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type PendingQuestion = {
  approvalId: string;
  question: string | null;
  expiresAt: string | null;
  createdAt: string | null;
};

export type PendingToolConfirmation = {
  approvalId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string | null;
  displayLines: string[];
  allowPersistentApproval: boolean;
  expiresAt: string | null;
  createdAt: string | null;
};

export type PendingSessionInput = {
  pending: PendingQuestion | null;
  toolConfirmation: PendingToolConfirmation | null;
};

export function toRestoredConfirmation(
  row: PendingToolConfirmation,
  sessionId: string,
): PendingConfirmation {
  return {
    toolCallId: `approval:${row.approvalId}`,
    approvalId: row.approvalId,
    restored: true,
    toolName: row.toolName,
    input: row.input,
    description: row.description ?? undefined,
    displayLines: row.displayLines.length > 0 ? row.displayLines : undefined,
    sessionId,
    status: "pending",
  };
}

export type WorkerRunSummary = {
  total: number;
  running: number;
  completed: number;
  failed: number;
  stopped: number;
  active: Array<{ workerId: string; description: string }>;
};

export const EMPTY_WORKER_RUN_SUMMARY: WorkerRunSummary = {
  total: 0,
  running: 0,
  completed: 0,
  failed: 0,
  stopped: 0,
  active: [],
};

export async function fetchWorkerRunSummary(
  sessionId: string,
): Promise<WorkerRunSummary> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/worker-runs`,
  );
  if (!res.ok) return EMPTY_WORKER_RUN_SUMMARY;
  const body = (await res.json()) as { summary?: WorkerRunSummary };
  return body.summary ?? EMPTY_WORKER_RUN_SUMMARY;
}

export async function fetchPendingSessionInput(
  sessionId: string,
): Promise<PendingSessionInput> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/pending`,
  );
  if (!res.ok) return { pending: null, toolConfirmation: null };
  const body = (await res.json()) as Partial<PendingSessionInput>;
  return {
    pending: body.pending ?? null,
    toolConfirmation: body.toolConfirmation ?? null,
  };
}

export async function fetchPendingQuestion(
  sessionId: string,
): Promise<PendingQuestion | null> {
  return (await fetchPendingSessionInput(sessionId)).pending;
}

export type SubmitAnswerResult =
  | { ok: true; status: "approved" | string; resume: unknown }
  | {
      ok: false;
      httpStatus: number;
      error?: string;
      idempotent?: boolean;
      status?: string;
    };

export async function submitAnswer(
  sessionId: string,
  approvalId: string,
  answer: string,
): Promise<SubmitAnswerResult> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/answer/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    },
  );
  if (res.ok) {
    const body = (await res.json()) as { status: string; resume: unknown };
    return { ok: true, status: body.status, resume: body.resume };
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return {
    ok: false,
    httpStatus: res.status,
    error: typeof payload.error === "string" ? payload.error : undefined,
    idempotent:
      typeof payload.idempotent === "boolean" ? payload.idempotent : undefined,
    status: typeof payload.status === "string" ? payload.status : undefined,
  };
}

export async function cancelPendingQuestion(
  sessionId: string,
  approvalId: string,
): Promise<{ ok: boolean; status?: string }> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/cancel/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { status?: string };
  return { ok: true, status: body.status };
}
