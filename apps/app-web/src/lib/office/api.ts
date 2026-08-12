/** Client-safe Office REST SDK. [COMP:app-web/office-home] */
import { authFetch } from "@/lib/auth-fetch";
import type { OfficeArtifactSnapshot, OfficeCommand, OfficeTemplateRoutingDraft, OfficeTemplateSlideRole } from "@use-brian/office-model";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const officeResourceObjectUrls = new Map<string, Promise<string>>();

export type OfficeFamily = "document" | "presentation" | "spreadsheet";
export type { OfficeTemplateRoutingDraft, OfficeTemplateSlideRole };
export type OfficeTemplate = {
  id: string;
  family: OfficeFamily;
  name: string;
  description: string;
  lifecycleState: "draft" | "admitted" | "deprecated" | "trash" | "retained";
  currentVersionId: string | null;
  draftArtifactId: string | null;
  sensitivity: "public" | "internal" | "confidential";
  updatedAt: string;
};
export type OfficeArtifact = {
  artifactId: string;
  family: OfficeFamily;
  mode?: "artifact" | "template";
  title: string;
  version: number;
  lifecycleState: "active" | "archived" | "trash" | "retained" | "purged";
  role: "view" | "comment" | "edit";
  job?: { id: string; status: string; stage: string; errorCode: string | null };
};

export function isOfficeStartFailed(artifact: OfficeArtifact): boolean {
  return artifact.lifecycleState === "active"
    && artifact.mode !== "template"
    && Number(artifact.version) === 0
    && !artifact.job;
}

export type OfficeJob = {
  id: string;
  workspaceId: string;
  artifactId: string;
  status: "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
  stage: string;
  errorCode: string | null;
};

export type OfficeJobFailureKind = "presentation_fit" | "presentation_plan" | "fit" | "unexpected";

export function officeJobFailureKind(errorCode: string | null | undefined): OfficeJobFailureKind {
  if (errorCode === "presentation_fit_failed") return "presentation_fit";
  if (errorCode === "presentation_plan_failed") return "presentation_plan";
  if (errorCode === "fit_failed") return "fit";
  return "unexpected";
}

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

export class OfficeApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : fallback;
    throw new OfficeApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export async function listOfficeArtifacts(
  workspaceId: string,
  view: "active" | "archived" | "trash" | "retained" = "active",
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
  additionalContext?: string;
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

export async function getOfficeCapabilities(): Promise<{ generationAvailable: boolean; generationFamilies: OfficeFamily[] }> {
  return json(
    await authFetch(`${API_URL}/api/office/capabilities`),
    "office_capabilities_failed",
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

export function getOfficeResourceObjectUrl(artifactId: string, resourceId: string): Promise<string> {
  const key = `${artifactId}:${resourceId}`;
  const cached = officeResourceObjectUrls.get(key);
  if (cached) return cached;
  const pending = authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/resources/${encodeURIComponent(resourceId)}`)
    .then(async (response) => {
      if (!response.ok) {
        const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
        throw new OfficeApiError(typeof body?.error === "string" ? body.error : "office_resource_failed", response.status);
      }
      return URL.createObjectURL(await response.blob());
    })
    .catch((error) => {
      officeResourceObjectUrls.delete(key);
      throw error;
    });
  officeResourceObjectUrls.set(key, pending);
  return pending;
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

export async function createOfficeComment(input: { artifactId: string; anchor: OfficeCommentThread["anchor"]; body: string; mentions?: string[]; invokeBrian?: { assistantId: string; expectedVersion: number; idempotencyKey: string } }): Promise<{ revision?: { jobId: string; mode: "direct" | "proposal" } | "version_conflict" | null }> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(input.artifactId)}/comments`, {
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

export async function waitForOfficeJob(jobId: string, timeoutMs = 180_000): Promise<OfficeJob> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await getOfficeJob(jobId);
    if (["completed", "failed", "cancelled", "needs_input"].includes(job.status)) return job;
    if (Date.now() >= deadline) throw new Error("office_job_timeout");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
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

export async function listOfficeTemplates(workspaceId: string): Promise<OfficeTemplate[]> {
  const body = await json<{ templates: OfficeTemplate[] }>(
    await authFetch(`${API_URL}/api/office/templates?workspaceId=${encodeURIComponent(workspaceId)}`),
    "office_templates_failed",
  );
  return body.templates;
}

export async function createOfficeTemplate(input: { workspaceId: string; family: OfficeFamily; name: string; description: string; creationMethod: "guided" | "upload"; canonicalWebsite?: string; companyHasNoWebsite?: boolean }): Promise<{ id: string; draftArtifactId: string }> {
  return json(await authFetch(`${API_URL}/api/office/templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, sensitivity: "internal" }) }), "office_template_create_failed");
}

export async function initializeOfficeTemplateDraft(input: { templateId: string; workspaceId: string; draftArtifactId: string }): Promise<OfficeLiveSnapshot> {
  return json(await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(input.templateId)}/draft/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: input.workspaceId, draftArtifactId: input.draftArtifactId }),
  }), "office_template_initialize_failed");
}

export async function getOfficeTemplateRouting(templateId: string): Promise<OfficeTemplateRoutingDraft> {
  const body = await json<{ routing: OfficeTemplateRoutingDraft }>(
    await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(templateId)}/routing`),
    "office_template_routing_failed",
  );
  return body.routing;
}

export async function saveOfficeTemplateRouting(templateId: string, routing: OfficeTemplateRoutingDraft): Promise<OfficeTemplateRoutingDraft> {
  const body = await json<{ routing: OfficeTemplateRoutingDraft }>(
    await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(templateId)}/routing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routing }),
    }),
    "office_template_routing_save_failed",
  );
  return body.routing;
}

export async function compileOfficeTemplateDraft(input: { templateId: string; workspaceId: string; draftArtifactId: string }): Promise<{ jobId: string }> {
  return json(await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(input.templateId)}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: input.workspaceId, draftArtifactId: input.draftArtifactId, assistantId: null, source: { kind: "scratch" }, idempotencyKey: crypto.randomUUID() }),
  }), "office_template_compile_failed");
}

export async function importOfficeTemplateDraft(input: { templateId: string; workspaceId: string; draftArtifactId: string; fileId: string }): Promise<{ jobId: string }> {
  return json(await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(input.templateId)}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: input.workspaceId, draftArtifactId: input.draftArtifactId, assistantId: null, source: { kind: "upload", fileId: input.fileId }, idempotencyKey: crypto.randomUUID() }),
  }), "office_template_import_failed");
}

export async function transitionOfficeTemplateLifecycle(templateId: string, action: "deprecate" | "restore" | "trash" | "purge", reason: string): Promise<Record<string, unknown>> {
  const body = await json<{ template: Record<string, unknown> }>(await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(templateId)}/lifecycle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, reason }) }), "office_template_lifecycle_failed");
  return body.template;
}

export async function uploadOfficeSource(workspaceId: string, file: File): Promise<{ fileId: string; family: OfficeFamily }> {
  const lowerName = file.name.toLowerCase();
  const family: OfficeFamily = lowerName.endsWith(".docx") ? "document" : lowerName.endsWith(".pptx") ? "presentation" : lowerName.endsWith(".xlsx") ? "spreadsheet" : (() => { throw new Error("office_file_type"); })();
  const form = new FormData();
  form.append("files", file);
  const body = await json<{ files: Array<{ id?: string; error?: string }> }>(await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/upload`, { method: "POST", body: form }), "office_upload_failed");
  const first = body.files[0];
  if (!first?.id || first.error) throw new Error(first?.error ?? "office_upload_failed");
  return { fileId: first.id, family };
}

type SpreadsheetPdfRequest = { sheetId: string; printArea: string; calculationMode: "automatic" | "stored"; expectedPageCount: number; preset: "invoice" | "worksheet" };
export type OfficeReleaseReceipt = { status: "blocked" | "needs_ack" | "ready"; version: number; action: string; blocks: Array<{ code: string; message: string; subjectId?: string }>; warnings: Array<{ code: string; message: string; subjectId?: string }>; acknowledgedCodes: string[]; spreadsheetPdf?: { sheetId: string; printArea: string; expectedPageCount: number; actualPageCount?: number; issues: Array<{ code: string; message: string; severity: "warning" | "error"; address?: string }> } };
export type OfficeReleaseInput = { expectedVersion: number; action: "export" | "share" | "present" | "send" | "publish"; destination: { sensitivity: "public" | "internal" | "confidential"; external: boolean; disclosureSatisfied?: boolean }; format?: "native" | "pdf"; spreadsheetPdf?: SpreadsheetPdfRequest; acknowledgement?: { version: number; action: "export" | "share" | "present" | "send" | "publish"; codes: string[] } };

export async function reviewOfficeRelease(artifactId: string, input: OfficeReleaseInput): Promise<OfficeReleaseReceipt> {
  const body = await json<{ receipt: OfficeReleaseReceipt }>(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/releases/preflight`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }), "office_release_review_failed");
  return body.receipt;
}

export async function releaseOfficeArtifact(artifactId: string, input: OfficeReleaseInput): Promise<{ releaseId: string; fileId: string; receipt: OfficeReleaseReceipt }> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/releases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }), "office_release_failed");
}

export async function readOfficeReleasedFile(workspaceId: string, fileId: string): Promise<Blob> {
  const response = await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}`);
  if (!response.ok) throw new OfficeApiError("office_release_download_failed", response.status);
  return response.blob();
}

export async function transitionOfficeLifecycle(artifactId: string, action: "archive" | "unarchive" | "trash" | "restore" | "purge", reason: string): Promise<OfficeArtifact> {
  const body = await json<{ artifact: OfficeArtifact }>(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/lifecycle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, reason }) }), "office_lifecycle_failed");
  return body.artifact;
}

export async function syncOfficeOfflineCommands(artifactId: string, expectedSeq: number, commands: OfficeCommand[]): Promise<{ status: string; reason?: string; quarantine?: boolean; seq?: number; snapshot?: OfficeArtifactSnapshot }> {
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/offline-sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSeq, commands }) });
  const body = await response.json() as { status: string; reason?: string; quarantine?: boolean; seq?: number; snapshot?: OfficeArtifactSnapshot };
  if (!response.ok && response.status !== 409) throw new Error("office_offline_sync_failed");
  return body;
}
