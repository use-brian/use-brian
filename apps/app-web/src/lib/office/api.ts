/** Client-safe Office REST SDK. [COMP:app-web/office-home] */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type OfficeFamily = "document" | "presentation";
export type OfficeArtifact = {
  artifactId: string;
  family: OfficeFamily;
  title: string;
  version: number;
  lifecycleState: "active" | "archived" | "trash" | "retained";
  role: "view" | "comment" | "edit";
  job?: { id: string; status: string; stage: string };
};

export type OfficeJob = {
  id: string;
  workspaceId: string;
  artifactId: string;
  status: "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
  stage: string;
};

export type OfficeJobEvent = {
  id: string;
  seq: number;
  code: string;
  params: Record<string, string | number | boolean>;
  safeNarration: string | null;
  createdAt: string;
};

async function json<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(fallback);
  return response.json() as Promise<T>;
}

export async function listOfficeArtifacts(
  workspaceId: string,
  view: "active" | "archived" | "trash" = "active",
): Promise<OfficeArtifact[]> {
  const query = new URLSearchParams({ workspaceId, view });
  const body = await json<{ artifacts: OfficeArtifact[] }>(
    await authFetch(`${API_URL}/api/office/artifacts?${query}`),
    "office_list_failed",
  );
  return body.artifacts;
}

export async function createOfficeArtifact(input: {
  workspaceId: string;
  assistantId: string;
  family: OfficeFamily;
  outcome: string;
  audience: string;
  canonicalWebsite?: string;
  companyHasNoWebsite: boolean;
  sourceHandles?: string[];
  templateId?: string;
  idempotencyKey: string;
}): Promise<{ artifactId: string; jobId: string }> {
  return json(
    await authFetch(`${API_URL}/api/office/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, sourceHandles: input.sourceHandles ?? [] }),
    }),
    "office_create_failed",
  );
}

export async function getOfficeArtifact(artifactId: string): Promise<OfficeArtifact> {
  const body = await json<{ artifact: OfficeArtifact }>(
    await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}`),
    "office_get_failed",
  );
  return body.artifact;
}

export async function getOfficeJob(jobId: string): Promise<OfficeJob> {
  const body = await json<{ job: OfficeJob }>(
    await authFetch(`${API_URL}/api/office/jobs/${encodeURIComponent(jobId)}`),
    "office_job_failed",
  );
  return body.job;
}

export async function listOfficeJobEvents(jobId: string, afterSeq = 0): Promise<OfficeJobEvent[]> {
  const body = await json<{ events: OfficeJobEvent[] }>(
    await authFetch(`${API_URL}/api/office/jobs/${encodeURIComponent(jobId)}/events?afterSeq=${afterSeq}`),
    "office_events_failed",
  );
  return body.events;
}

export async function steerOfficeJob(jobId: string, instruction: string): Promise<void> {
  await json(
    await authFetch(`${API_URL}/api/office/jobs/${encodeURIComponent(jobId)}/steering`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    }),
    "office_steering_failed",
  );
}

export async function listOfficeTemplates(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const body = await json<{ templates: Array<Record<string, unknown>> }>(
    await authFetch(`${API_URL}/api/office/templates?workspaceId=${encodeURIComponent(workspaceId)}`),
    "office_templates_failed",
  );
  return body.templates;
}
