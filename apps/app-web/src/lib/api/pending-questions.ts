/**
 * SDK for the askQuestion suspend-resume routes — app-web port.
 *
 *   GET  /api/sessions/:sessionId/pending
 *   POST /api/sessions/:sessionId/answer/:approvalId
 *   POST /api/sessions/:sessionId/cancel/:approvalId
 *
 * Mirrors `apps/web/src/lib/api/pending-questions.ts` (kept as a
 * separate copy the same way the `/api/views/*` SDK is duplicated — see
 * apps/app-web/CLAUDE.md). The worker-summary fetcher is intentionally
 * dropped: the FloatingChat shows a plain "Working on it…" chip instead
 * of the multi-researcher histogram, since doc "ask for a view" turns
 * rarely fan out to background workers.
 *
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md.
 * [COMP:app-web/pending-questions]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type PendingQuestion = {
  approvalId: string;
  question: string | null;
  expiresAt: string | null;
  createdAt: string | null;
};

export async function fetchPendingQuestion(
  sessionId: string,
): Promise<PendingQuestion | null> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/pending`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { pending: PendingQuestion | null };
  return body.pending;
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
