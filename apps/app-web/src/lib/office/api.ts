/** Client-safe Office REST SDK. [COMP:app-web/office-home] */
import { authFetch } from "@/lib/auth-fetch";
import type { OfficeArtifactSnapshot, OfficeCommand } from "@use-brian/office-model";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type OfficeFamily = "document" | "presentation";
export type OfficeArtifact = {
  artifactId: string;
  family: OfficeFamily;
  mode?: "artifact" | "template";
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

export type OfficeLiveSnapshot = { snapshot: OfficeArtifactSnapshot; seq: number; baseVersion: number };
export type OfficeCommentThread = {
  id: string;
  artifactVersionId: string;
  anchorKind: string;
  anchor: { kind: string; targetIds: string[]; range?: { from: number; to: number }; geometry?: { x: number; y: number; width?: number; height?: number } };
  status: "open" | "resolved" | "detached";
  messages: Array<{ id: string; authorType: string; body: string; brianRunStatus?: string; createdAt: string }>;
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

export async function getOfficeSnapshot(artifactId: string): Promise<OfficeLiveSnapshot> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/snapshot`), "office_snapshot_failed");
}

export async function listOfficeVersions(artifactId: string): Promise<Array<{ id: string; version: number; summary: string; origin: string; createdAt: string }>> {
  const body = await json<{ versions: Array<{ id: string; version: number; summary: string; origin: string; createdAt: string }> }>(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/versions`), "office_versions_failed");
  return body.versions;
}

export async function submitOfficeCommand(artifactId: string, expectedSeq: number, command: OfficeCommand, mode: "apply" | "suggest"): Promise<OfficeLiveSnapshot | { mode: "suggestion" }> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedSeq, command, mode }),
  }), "office_command_failed");
}

export async function listOfficeComments(artifactId: string): Promise<OfficeCommentThread[]> {
  const body = await json<{ threads: OfficeCommentThread[] }>(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/comments`), "office_comments_failed");
  return body.threads;
}

export async function createOfficeComment(input: { artifactId: string; anchor: OfficeCommentThread["anchor"]; body: string; mentions?: string[]; invokeBrian?: { assistantId: string; expectedVersion: number; idempotencyKey: string } }): Promise<void> {
  await json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(input.artifactId)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anchor: input.anchor, body: input.body, mentions: input.mentions ?? [], invokeBrian: input.invokeBrian }),
  }), "office_comment_failed");
}

export async function resolveOfficeComment(threadId: string, resolved: boolean): Promise<void> {
  await json(await authFetch(`${API_URL}/api/office/comment-threads/${encodeURIComponent(threadId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolved }),
  }), "office_comment_resolve_failed");
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

export async function createOfficeTemplate(input: { workspaceId: string; family: OfficeFamily; name: string; description: string }): Promise<{ id: string; draftArtifactId: string }> {
  return json(await authFetch(`${API_URL}/api/office/templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, sensitivity: "internal" }) }), "office_template_create_failed");
}

export async function compileOfficeTemplateDraft(input: { templateId: string; workspaceId: string; draftArtifactId: string }): Promise<{ jobId: string }> {
  return json(await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(input.templateId)}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: input.workspaceId, draftArtifactId: input.draftArtifactId, assistantId: null, source: { kind: "scratch" }, idempotencyKey: crypto.randomUUID() }),
  }), "office_template_compile_failed");
}

export async function uploadOfficeSource(workspaceId: string, file: File): Promise<{ fileId: string; family: OfficeFamily }> {
  const family: OfficeFamily = file.name.toLowerCase().endsWith(".docx") ? "document" : file.name.toLowerCase().endsWith(".pptx") ? "presentation" : (() => { throw new Error("office_file_type"); })();
  const form = new FormData();
  form.append("files", file);
  const body = await json<{ files: Array<{ id?: string; error?: string }> }>(await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/upload`, { method: "POST", body: form }), "office_upload_failed");
  const first = body.files[0];
  if (!first?.id || first.error) throw new Error(first?.error ?? "office_upload_failed");
  return { fileId: first.id, family };
}

export async function startOfficeImport(input: { workspaceId: string; assistantId: string; family: OfficeFamily; sourceFileId: string; title: string; templateVersionId: string }): Promise<{ artifactId: string; jobId: string }> {
  return json(await authFetch(`${API_URL}/api/office/imports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, sensitivity: "internal", idempotencyKey: crypto.randomUUID() }) }), "office_import_failed");
}
