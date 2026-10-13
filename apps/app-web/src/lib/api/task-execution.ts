/**
 * Task execution client: read a task's execution and send a control
 * (pause / steer / continue). Mirrors `routes/task-execution.ts`; actor,
 * origin and renewal are always derived by the server.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Task execution workbench".
 * [COMP:app-web/task-execution-workbench]
 */
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type ExecutionPhase = "planning" | "ready" | "running" | "waiting" | "paused" | "blocked" | "done" | "retired";
type ReadinessReason = { kind: string; subject: string; detail?: string };
type ExternalFreshness = "live" | "stale" | "disconnected" | "never_reported";

export type TaskExecution = {
  id: string;
  taskId: string | null;
  goalId: string | null;
  phase: ExecutionPhase;
  controlRevision: number;
  executor: { kind: "assistant" | "person"; id: string } | null;
  plan: {
    outcome?: string;
    steps?: { title: string; contribution: string }[];
    completionEvidence?: string[];
    nextStep?: string | null;
    readiness?: { state: string; reasons: ReadinessReason[] };
    sourceBasis?: { kind: string; id: string; label?: string; version?: string | null }[];
  };
  blocker: { reason: string; detail?: string } | null;
  checkpoint: {
    summary: string;
    artifacts: { kind: string; ref: string; version?: string | null }[];
    uncertainEffects: { operation: string; ref: string }[];
    checkedResults: string[];
    nextStep: string | null;
    questions: string[];
  } | null;
  steering: { instruction: string; byUserId: string; at: string }[];
  canControl: boolean;
  allowance: {
    maxSpend: number | null;
    maxIterations: number | null;
    activeSegment: number;
    segment: { spent: number; iterations: number; reservedSpend: number; reservedIterations: number } | null;
    lifetime: { spent: number; iterations: number };
  };
  children: { id: string; childKey: string | null; phase: ExecutionPhase; nextStep: string | null; questions: string[]; blocker: { reason: string } | null }[];
  external: { id: string; externalExecutionId: string; harness: string | null; phase: string; freshness: ExternalFreshness; lastReportedAt: string | null }[];
  lastControl: { kind: string; actorId: string | null; revision: number | null; at: string } | null;
};

export type ControlAction = "pause" | "steer" | "continue";
type ControlReceipt = {
  outcome: "applied" | "stale" | "blocked" | "duplicate";
  receipt: { reason: string | null; resultRevision: number | null; renewedSegment: number | null };
  execution: TaskExecution;
};

export class TaskExecutionError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new TaskExecutionError(body.error ?? "execution_unavailable", res.status);
  return body as T;
}

export async function fetchTaskExecution(workspaceId: string, taskId: string): Promise<TaskExecution> {
  return (await call<{ execution: TaskExecution }>(`/workspaces/${workspaceId}/tasks/${taskId}/execution`)).execution;
}

export async function controlTaskExecution(
  workspaceId: string,
  executionId: string,
  body: { action: ControlAction; expectedRevision: number; interventionId: string; instruction?: string },
): Promise<ControlReceipt> {
  return call<ControlReceipt>(`/workspaces/${workspaceId}/work/executions/${executionId}/control`, {
    method: "POST", body: JSON.stringify(body),
  });
}

/** Remaining allowance in the active segment, or null when unbounded. */
export function remainingAllowance(a: TaskExecution["allowance"]): { iterations: number | null; spend: number | null } {
  const seg = a.segment;
  return {
    iterations: a.maxIterations === null || !seg ? null : Math.max(0, a.maxIterations - seg.iterations - seg.reservedIterations),
    spend: a.maxSpend === null || !seg ? null : Math.max(0, a.maxSpend - seg.spent - seg.reservedSpend),
  };
}
