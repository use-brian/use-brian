import { publicRuntimeConfig } from "@/lib/runtime-public-config";
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
import { z } from "zod";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type PendingQuestion = {
  approvalId: string;
  question: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  action: PendingQuestionAction | null;
  /** Single-choice suggestions (2 to 8 distinct labels), when the model sent them. */
  options?: string[];
  /** Whether a typed answer outside the options is allowed; absent means true. */
  allowCustom?: boolean;
  /** Authored context for the question; never execution authority. */
  context?: string;
  actionId?: string;
  version?: string | number;
};

/**
 * The served question payload (askquestion-suspend-resume.md → "Question
 * payload contract"), validated field by field at the client boundary the way
 * the server's read projection does: an invalid field is omitted, so a broken
 * `options` list never becomes a set of actionable choices.
 */
const questionFields = {
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(8)
    .refine((labels) => new Set(labels).size === labels.length),
  allowCustom: z.boolean(),
  context: z.string().max(8000),
  actionId: z.string().min(1).max(256),
  version: z.union([z.string().max(256), z.number().int()]),
};

function parsePendingQuestion(raw: unknown): PendingQuestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.approvalId !== "string" || !row.approvalId) return null;
  const optional: Partial<PendingQuestion> = {};
  for (const [key, schema] of Object.entries(questionFields)) {
    if (row[key] === undefined) continue;
    const parsed = (schema as z.ZodTypeAny).safeParse(row[key]);
    if (parsed.success) (optional as Record<string, unknown>)[key] = parsed.data;
  }
  return {
    approvalId: row.approvalId,
    question: typeof row.question === "string" ? row.question : null,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    action: (row.action ?? null) as PendingQuestionAction | null,
    ...optional,
  };
}

export type PendingQuestionAction = {
  kind: "connector_authorization";
  provider: string;
  label: string;
  connectPath: string;
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

export type ExternalActionConfirmation = {
  method?: "question";
  allowCustom?: boolean;
  approvalId: string;
  title: string;
  message?: string;
  options?: string[];
  expiresAt: string;
};

export type PendingSessionInput = {
  pending: PendingQuestion | null;
  toolConfirmation: PendingToolConfirmation | null;
  /** Independent human requests; never suspend or resume a Brian turn. */
  externalConfirmations?: ExternalActionConfirmation[];
};

export function toRestoredConfirmation(
  row: PendingToolConfirmation,
  sessionId: string,
): PendingConfirmation {
  return {
    toolCallId: `approval:${row.approvalId}`,
    approvalId: row.approvalId,
    restored: true,
    allowPersistentApproval: row.allowPersistentApproval === true,
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
  if (!res.ok) return {
    pending: null,
    toolConfirmation: null,
    ...([401, 403, 404].includes(res.status) ? { externalConfirmations: [] } : {}),
  };
  const body = (await res.json()) as Partial<PendingSessionInput>;
  return {
    pending: parsePendingQuestion(body.pending),
    toolConfirmation: body.toolConfirmation ?? null,
    externalConfirmations: body.externalConfirmations ?? [],
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
