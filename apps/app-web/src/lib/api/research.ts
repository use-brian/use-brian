/**
 * Saved research API (docs/architecture/features/research.md -> "Commands").
 * Every call goes through the same server command service Brian and the
 * brain MCP use; the actor is the signed-in member.
 */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type ResearchStatus = "running" | "saved" | "partial" | "failed";
export type ResearchFeedbackKind =
  | "correction"
  | "request_correction"
  | "missing_coverage"
  | "preference"
  | "deeper_exploration"
  | "changed_objective"
  | "satisfaction"
  | "uncertain";

export type ResearchActivityRow = {
  id: string;
  sessionId: string;
  outputMessageId: string | null;
  projectId: string | null;
  entry: "explicit" | "adaptive";
  status: ResearchStatus;
  sources: Array<{ kind: string; ref: string; title: string | null; readAt: string; inspected: boolean }>;
  gaps: string[];
  summary: string | null;
  saveError: string | null;
  createdAt: string;
};

export type ResearchArtifactRow = {
  id: string;
  kind: "page" | "document" | "file";
  artifactId: string;
  version: number | null;
  relation: "output" | "revision";
};

type ResearchFeedbackRow = {
  id: string;
  actorUserId: string;
  outputKey: string;
  association: string;
  kind: ResearchFeedbackKind;
  uncertain: boolean;
  origin: "machine" | "human";
  version: number;
  createdAt: string;
  revisions: Array<{ revision: number; kind: ResearchFeedbackKind; origin: string; stance: string; note: string | null }>;
};

export type ResearchLessonRow = {
  id: string;
  rule: string;
  scope: "user" | "project" | "workspace";
  status: "suggested" | "active" | "rejected" | "retired";
  evidenceCount: number;
  revision: number;
  supportCount?: number;
};

export type ResearchActivityDetail = {
  activity: ResearchActivityRow;
  artifacts: ResearchArtifactRow[];
  feedback: ResearchFeedbackRow[];
  lessons: ResearchLessonRow[];
};

/** Thrown with the server's typed code so the UI can tell stale from gone. */
export class ResearchApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const base = (workspaceId: string) => `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/research`;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ResearchApiError(body.error ?? `http_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

export function listResearchActivities(workspaceId: string, filter: { sessionId?: string } = {}) {
  const q = filter.sessionId ? `?sessionId=${encodeURIComponent(filter.sessionId)}` : "";
  return call<{ activities: ResearchActivityRow[] }>(`${base(workspaceId)}/activities${q}`);
}

export function getResearchActivity(workspaceId: string, activityId: string) {
  return call<ResearchActivityDetail>(`${base(workspaceId)}/activities/${encodeURIComponent(activityId)}`);
}

export function correctResearchFeedback(workspaceId: string, feedbackId: string, kind: ResearchFeedbackKind, expectedVersion: number) {
  return call<{ revision: number; stance: "interpretation" | "disagreement" }>(
    `${base(workspaceId)}/feedback/${encodeURIComponent(feedbackId)}/corrections`,
    post({ kind, expectedVersion, idempotencyKey: newKey() }),
  );
}

export function decideResearchLesson(workspaceId: string, lessonId: string, decision: "approve" | "reject" | "retire", expectedVersion: number) {
  return call<{ lesson: ResearchLessonRow }>(
    `${base(workspaceId)}/lessons/${encodeURIComponent(lessonId)}/decisions`,
    post({ decision, expectedVersion, idempotencyKey: newKey() }),
  );
}

export function nominateResearchImprovement(workspaceId: string, input: {
  title: string;
  pattern: string;
  desiredBehavior: string;
  feedbackIds: string[];
  activityIds: string[];
}) {
  return call<{ improvement: { id: string } }>(`${base(workspaceId)}/improvements`, post({ ...input, idempotencyKey: newKey() }));
}

/** Window signal that saved research changed (a new result, a correction, a decision). */
export const RESEARCH_CHANGED_EVENT = "research:changed";
