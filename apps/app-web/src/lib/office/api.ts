import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/** Client-safe Office REST SDK. [COMP:app-web/office-home] */
import { authFetch } from "@/lib/auth-fetch";
import type { OfficeArtifactSnapshot, OfficeCommand, OfficeResourceRef, OfficeTemplateRoutingDraft, OfficeTemplateSlideRole } from "@use-brian/office-model";

import { getUserInfo } from "@/lib/user";
import { attachOfficeMetadata, type OfficeMetadata } from "./metadata";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type OfficeFamily = "document" | "presentation" | "spreadsheet" | "pdf";
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
  importState?: { jobId: string; status: OfficeJob["status"]; fileId: string; diagnostics: OfficeImportDiagnostic[] } | null;
};
export type OfficeArtifact = {
  artifactId: string;
  family: OfficeFamily;
  mode?: "artifact" | "template" | "session";
  title: string;
  version: number;
  lifecycleState: "active" | "archived" | "trash" | "retained" | "purged";
  role: "view" | "comment" | "edit";
  expiresAt?: string;
  job?: { id: string; status: string; stage: string; errorCode: string | null };
};

export function isOfficeStartFailed(artifact: OfficeArtifact): boolean {
  return artifact.lifecycleState === "active"
    && artifact.mode !== "template"
    && Number(artifact.version) === 0
    && !artifact.job;
}

export type OfficeImportDiagnostic = { reason: "conditional_format" | "workbook_protection" | "worksheet_protection" | "unsupported_content" | "invalid_file"; part?: string };
export type OfficeJob = {
  id: string;
  workspaceId: string;
  artifactId: string;
  status: "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
  stage: string;
  errorCode: string | null;
  importDiagnostics?: OfficeImportDiagnostic[];
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
  anchor: { kind: string; targetIds: string[]; range?: { from: number; to: number }; relative?: { from: Record<string, unknown>; to: Record<string, unknown> }; geometry?: { x: number; y: number; width?: number; height?: number } };
  status: "open" | "resolved" | "detached";
  assignedUserId?: string | null;
  assignedToBrian?: boolean;
  dueAt?: string | null;
  messages: Array<{ id: string; authorType: string; body: string; mentions?: string[]; reactions?: Record<string, string[]>; brianRunStatus?: string; createdAt: string }>;
};
export type OfficeSuggestion = { id: string; artifactId: string; threadId?: string | null; baseVersionId: string; proposedByType: "user" | "assistant"; proposedByUserId?: string | null; proposedByAssistantId?: string | null; commandBatch: OfficeCommand; affectedObjectIds: string[]; status: "open" | "accepted" | "rejected" | "superseded" | "conflicted"; createdAt: string };
export type OfficeVersion = { id: string; version: number; parentVersionId: string | null; snapshotHash: string; origin: string; authorType: string; summary: string; checkpointKind: string | null; createdAt: string };
export type OfficeSharing = {
  defaultWorkspaceRole: "view" | "comment" | "edit";
  canManage: boolean;
  grants: Array<{ userId: string; role: "view" | "comment" | "edit" | "deny"; revokedAt: string | null }>;
  members: Array<{ userId: string; userName?: string | null; email?: string | null; isOwner: boolean }>;
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

/** SQL GET metadata is bounded independently of the HTTP cache. */
async function metadata<T extends object, B = T>(path: string, fallback: string, select: (body: B) => T = value => value as unknown as T,init?:RequestInit): Promise<OfficeMetadata<T>> {
  const started = performance.now(), viewerId = getUserInfo()?.id;
  const response = await authFetch(`${API_URL}/api/office/${path}`, {...init,cache:"no-store"});
  const body = await json<B>(response, fallback);
  const header = response.headers.get("X-Brian-Projection-Valid-For-Ms");
  try {
    if (!viewerId || getUserInfo()?.id !== viewerId) throw new Error("office_viewer_changed");
    return attachOfficeMetadata(select(body), header === null ? NaN : Number(header), started, viewerId);
  }
  catch { throw new OfficeApiError("office_projection_expired", 409); }
}

async function protectedMediaJson<T extends object, B = T>(response: Response, fallback: string, started: number, viewerId: string | undefined, select: (body: B) => T = value => value as unknown as T): Promise<OfficeMetadata<T>> {
  const body = await json<B>(response, fallback);
  const header = response.headers.get("X-Brian-Media-Valid-For-Ms");
  try {
    if (!viewerId || getUserInfo()?.id !== viewerId) throw new Error("office_viewer_changed");
    return attachOfficeMetadata(select(body), header === null ? NaN : Number(header), started, viewerId);
  } catch { throw new OfficeApiError("office_projection_expired", 409); }
}

export async function listOfficeArtifacts(
  workspaceId: string,
  view: "active" | "archived" | "trash" | "retained" = "active",
): Promise<OfficeArtifact[]> {
  const query = new URLSearchParams({ workspaceId, view });
  return metadata<OfficeArtifact[], {artifacts: OfficeArtifact[]}>(`artifacts?${query}`, "office_list_failed", body => body.artifacts);
}

export async function createOfficeArtifact(input: {
  workspaceId: string;
  assistantId: string;
  family: OfficeFamily;
  outcome: string;
  audience: string;
  additionalContext?: string;
  sensitivity?: "public" | "internal" | "confidential";
  destination?: {kind: "department"; departmentId: string} | {kind: "general"};
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
  return metadata<OfficeArtifact, {artifact: OfficeArtifact}>(`artifacts/${encodeURIComponent(artifactId)}`, "office_get_failed", body => body.artifact);
}

export async function getOfficeSnapshot(artifactId: string): Promise<OfficeLiveSnapshot> {
  return metadata<OfficeLiveSnapshot>(`artifacts/${encodeURIComponent(artifactId)}/snapshot`, "office_snapshot_failed");
}

export async function admitOfficeImageResource(artifactId: string, workspaceId: string, file: File): Promise<{ resource: OfficeResourceRef; widthPx: number; heightPx: number }> {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('office_image_invalid');
  const form = new FormData();
  form.append('files', file);
  const upload = await json<{ files: Array<{ id?: string; error?: string }> }>(await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/upload`, { method: 'POST', body: form }), 'office_image_upload_failed');
  const source = upload.files[0];
  if (!source?.id || source.error) throw new Error(source?.error ?? 'office_image_upload_failed');
  const started = performance.now(), viewerId = getUserInfo()?.id;
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/resources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: source.id, kind: 'image' }) });
  return protectedMediaJson(response, 'office_image_admission_failed', started, viewerId);
}

export async function submitOfficeCommand(artifactId: string, expectedSeq: number, command: OfficeCommand, mode: "apply" | "suggest"): Promise<OfficeLiveSnapshot | { mode: "suggestion" }> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedSeq, command, mode }),
  }), "office_command_failed");
}

export async function listOfficeComments(artifactId: string): Promise<OfficeCommentThread[]> {
  return metadata<OfficeCommentThread[], {threads: OfficeCommentThread[]}>(`artifacts/${encodeURIComponent(artifactId)}/comments`, "office_comments_failed", body => body.threads);
}

export async function detachMissingOfficeComments(artifactId: string): Promise<number> {
  const body = await json<{ detached: number }>(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/comments/detach-missing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }), "office_comments_detach_failed");
  return body.detached;
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

export async function replyOfficeComment(threadId: string, body: string, mentions: string[] = []): Promise<void> {
  await json(await authFetch(`${API_URL}/api/office/comment-threads/${encodeURIComponent(threadId)}/replies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, mentions }) }), "office_comment_reply_failed");
}

export async function updateOfficeCommentThread(threadId: string, input: { assignedUserId: string | null; assignedToBrian: boolean; dueAt: string | null }): Promise<void> {
  await json(await authFetch(`${API_URL}/api/office/comment-threads/${encodeURIComponent(threadId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }), "office_comment_update_failed");
}

export async function reactOfficeComment(messageId: string, reaction: "thumbs_up" | "heart" | "check", active: boolean): Promise<void> {
  await json(await authFetch(`${API_URL}/api/office/comment-messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reaction, active }) }), "office_comment_reaction_failed");
}

export async function listOfficeSuggestions(artifactId: string): Promise<OfficeSuggestion[]> {
  return metadata<OfficeSuggestion[], {suggestions: OfficeSuggestion[]}>(`artifacts/${encodeURIComponent(artifactId)}/suggestions`, "office_suggestions_failed", body => body.suggestions);
}

export async function decideOfficeSuggestion(suggestionId: string, decision: "accepted" | "rejected"): Promise<void> {
  await json(await authFetch(`${API_URL}/api/office/suggestions/${encodeURIComponent(suggestionId)}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }), "office_suggestion_decision_failed");
}

export async function listOfficeVersions(artifactId: string): Promise<OfficeVersion[]> {
  return metadata<OfficeVersion[], {versions: OfficeVersion[]}>(`artifacts/${encodeURIComponent(artifactId)}/versions`, "office_versions_failed", body => body.versions);
}

export async function previewOfficeVersion(artifactId: string, versionId: string): Promise<OfficeArtifactSnapshot> {
  return metadata<OfficeArtifactSnapshot,{snapshot:OfficeArtifactSnapshot}>(`artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview`,"office_version_preview_failed",body=>body.snapshot)
}

export async function nameOfficeVersion(artifactId: string, versionId: string, summary: string): Promise<OfficeVersion[]> {
  return metadata<OfficeVersion[],{versions:OfficeVersion[]}>(`artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}`,"office_version_name_failed",body=>body.versions,{
    method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({summary})
  })
}

export async function copyOfficeVersion(artifactId: string, versionId: string, title: string): Promise<{ artifactId: string; version: number; artifact: OfficeArtifact }> {
  return metadata<{artifactId:string;version:number;artifact:OfficeArtifact}>(`artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/copy`,"office_version_copy_failed",value=>value,{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title})
  })
}

export async function restoreOfficeVersion(artifactId: string, targetVersionId: string, expectedVersion: number, summary: string): Promise<OfficeVersion[]> {
  return metadata<OfficeVersion[],{version:{id:string;version:number};versions:OfficeVersion[]}>(`artifacts/${encodeURIComponent(artifactId)}/restore`,"office_version_restore_failed",body=>body.versions,{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetVersionId,expectedVersion,summary})
  })
}

export async function getOfficeSharing(artifactId: string): Promise<OfficeSharing> {
  return metadata<OfficeSharing>(`artifacts/${encodeURIComponent(artifactId)}/sharing`,"office_sharing_failed")
}

export async function setOfficeGrant(artifactId: string, userId: string, role: "view" | "comment" | "edit"): Promise<OfficeSharing> {
  return metadata<OfficeSharing>(`artifacts/${encodeURIComponent(artifactId)}/sharing/${encodeURIComponent(userId)}`,"office_sharing_update_failed",value=>value,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({role})})
}

export async function revokeOfficeGrant(artifactId: string, userId: string): Promise<OfficeSharing> {
  return metadata<OfficeSharing>(`artifacts/${encodeURIComponent(artifactId)}/sharing/${encodeURIComponent(userId)}`,"office_sharing_revoke_failed",value=>value,{method:"DELETE"})
}

export async function setOfficeDefaultRole(artifactId: string, defaultWorkspaceRole: "view" | "comment" | "edit"): Promise<OfficeSharing> {
  return metadata<OfficeSharing>(`artifacts/${encodeURIComponent(artifactId)}/sharing`,"office_sharing_default_failed",value=>value,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({defaultWorkspaceRole})})
}

export async function getOfficeJob(jobId: string): Promise<OfficeJob> {
  return metadata<OfficeJob, {job: OfficeJob}>(`jobs/${encodeURIComponent(jobId)}`, "office_job_failed", body => body.job);
}

export async function waitForOfficeJob(jobId: string, timeoutMs = 180_000, isCurrent: () => boolean = () => true): Promise<OfficeJob> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!isCurrent()) throw new Error("office_job_owner_expired");
    const job = await getOfficeJob(jobId);
    if (!isCurrent()) throw new Error("office_job_owner_expired");
    if (["completed", "failed", "cancelled", "needs_input"].includes(job.status)) return job;
    if (Date.now() >= deadline) throw new Error("office_job_timeout");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

export async function listOfficeJobEvents(jobId: string, afterSeq = 0): Promise<OfficeJobEvent[]> {
  return metadata<OfficeJobEvent[], {events: OfficeJobEvent[]}>(`jobs/${encodeURIComponent(jobId)}/events?afterSeq=${afterSeq}`, "office_events_failed", body => body.events);
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
  return metadata<OfficeTemplate[], {templates: OfficeTemplate[]}>(`templates?workspaceId=${encodeURIComponent(workspaceId)}`, "office_templates_failed", body => body.templates);
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
  return metadata<OfficeTemplateRoutingDraft, {routing: OfficeTemplateRoutingDraft}>(`templates/${encodeURIComponent(templateId)}/routing`, "office_template_routing_failed", body => body.routing);
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

export async function retryOfficeTemplateImport(input: { templateId: string; workspaceId: string; artifactId: string; failedJobId: string; fileId?: string }): Promise<{ jobId: string }> {
  const { templateId, ...body } = input;
  return json(await authFetch(`${API_URL}/api/office/templates/${encodeURIComponent(templateId)}/import/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), "office_template_recovery_failed");
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
export type OfficeReleaseReceipt = { status: "blocked" | "needs_ack" | "ready"; version: number; action: string; blocks: Array<{ code: string; message: string; subjectId?: string }>; warnings: Array<{ code: string; message: string; subjectId?: string }>; acknowledgedCodes: string[]; spreadsheetPdf?: { sheetId: string; printArea: string; expectedPageCount: number; actualPageCount?: number; issues: Array<{ code: string; message: string; severity: "warning" | "error"; address?: string }> }; documentPdf?: { expectedPageCount: number; actualPageCount?: number; renderer: "libreoffice"; issues: Array<{ code: string; message: string; severity: "error" }> }; presentationPdf?: { expectedPageCount: number; actualPageCount?: number; renderer: "libreoffice"; issues: Array<{ code: string; message: string; severity: "error" }> }; pdf?: { sha256: string; pageCount: number } };
export type OfficeReleaseInput = { expectedVersion: number; action: "export" | "share" | "present" | "send" | "publish"; destination: { sensitivity: "public" | "internal" | "confidential"; external: boolean; disclosureSatisfied?: boolean }; format?: "native" | "pdf"; spreadsheetPdf?: SpreadsheetPdfRequest; acknowledgement?: { version: number; action: "export" | "share" | "present" | "send" | "publish"; codes: string[] } };

export async function reviewOfficeRelease(artifactId: string, input: OfficeReleaseInput): Promise<OfficeReleaseReceipt> {
  const started = performance.now(), viewerId = getUserInfo()?.id;
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/releases/preflight`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return protectedMediaJson<OfficeReleaseReceipt, { receipt: OfficeReleaseReceipt }>(response, "office_release_review_failed", started, viewerId, body => body.receipt);
}

export type OfficeReleaseResult = { releaseId?: string; fileId?: string; receipt: OfficeReleaseReceipt };

export async function releaseOfficeArtifact(artifactId: string, input: OfficeReleaseInput): Promise<OfficeReleaseResult> {
  const started = performance.now(), viewerId = getUserInfo()?.id;
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/releases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as { receipt?: OfficeReleaseReceipt } | null;
    if (body?.receipt) {
      const header = response.headers.get("X-Brian-Media-Valid-For-Ms");
      try {
        if (!viewerId || getUserInfo()?.id !== viewerId) throw new Error("office_viewer_changed");
        return attachOfficeMetadata({ receipt: body.receipt }, header === null ? NaN : Number(header), started, viewerId);
      } catch { throw new OfficeApiError("office_projection_expired", 409); }
    }
  }
  return protectedMediaJson<OfficeReleaseResult>(response, "office_release_failed", started, viewerId);
}

export async function readOfficeReleasedFile(workspaceId: string, fileId: string): Promise<Blob> {
  const started = performance.now(), viewerId = getUserInfo()?.id;
  const response = await authFetch(`${API_URL}/api/doc-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}`);
  if (!response.ok) throw new OfficeApiError("office_release_download_failed", response.status);
  const blob = await response.blob();
  const header = response.headers.get("X-Brian-Media-Valid-For-Ms");
  try {
    if (!viewerId || getUserInfo()?.id !== viewerId) throw new Error("office_viewer_changed");
    return attachOfficeMetadata(blob, header === null ? NaN : Number(header), started, viewerId);
  } catch { throw new OfficeApiError("office_projection_expired", 409); }
}

export type ProtectedPdfSource = { bytes: ArrayBuffer; validForMs: number };

export async function readOfficePdfSource(artifactId: string): Promise<ProtectedPdfSource> {
  const started = performance.now();
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/pdf/source`, { cache: "no-store" });
  if (!response.ok) throw new OfficeApiError("office_pdf_source_failed", response.status);
  const validForMs = Number(response.headers.get("X-Brian-Media-Valid-For-Ms"));
  const elapsed = performance.now() - started;
  if (!Number.isFinite(validForMs) || validForMs - elapsed <= 0) throw new OfficeApiError("office_projection_expired", 409);
  return { bytes: await response.arrayBuffer(), validForMs: Math.min(30_000, validForMs - elapsed) };
}

export async function uploadPdfSessionImage(workspaceId: string, file: File): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('signature_image_invalid');
  const form = new FormData();
  form.append('files', file);
  form.append('workspaceId', workspaceId);
  form.append('appOrigin', 'doc');
  const body = await json<{ files: Array<{ id?: string; error?: string }> }>(await authFetch(`${API_URL}/api/files/upload`, { method: 'POST', body: form }), 'office_pdf_image_upload_failed');
  const uploaded = body.files[0];
  if (!uploaded?.id || uploaded.error) throw new Error(uploaded?.error ?? 'office_pdf_image_upload_failed');
  return uploaded.id;
}

export async function admitPdfSessionImage(artifactId: string, expectedSeq: number, sourceAttachmentId: string): Promise<{ signatureResourceId: string; seq: number }> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/pdf/signature-assets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { kind: 'file_cache', id: sourceAttachmentId }, expectedSeq }),
  }), 'office_pdf_image_admission_failed');
}

export async function saveOfficePdfToFiles(artifactId: string, input: { expectedSeq: number; releaseHash: string; path: string }): Promise<{ fileId: string }> {
  return json(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/pdf/save-to-files`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }), 'office_pdf_save_failed');
}

export async function transitionOfficeLifecycle(artifactId: string, action: "archive" | "unarchive" | "trash" | "restore" | "purge", reason: string): Promise<OfficeArtifact> {
  const body = await json<{ artifact: OfficeArtifact }>(await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/lifecycle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, reason }) }), "office_lifecycle_failed");
  return body.artifact;
}

export type OfficeOfflineSyncResult = { status: string; reason?: string; quarantine?: boolean; seq?: number; recoveryArtifactId?: string };

export async function syncOfficeOfflineCommands(input: { artifactId: string; expectedSeq: number; commands: OfficeCommand[]; deviceId: string; recoveryTitle: string; recoverySnapshot: OfficeArtifactSnapshot }): Promise<OfficeOfflineSyncResult> {
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(input.artifactId)}/offline-sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSeq: input.expectedSeq, commands: input.commands, deviceId: input.deviceId, recoveryTitle: input.recoveryTitle, recoverySnapshot: input.recoverySnapshot }) });
  const body = await response.json() as OfficeOfflineSyncResult;
  if (!response.ok && response.status !== 409) throw new Error("office_offline_sync_failed");
  return body;
}

export async function requestOfficeOfflinePackage(artifactId: string, deviceId: string, expectedVersion: number): Promise<{ manifest: Record<string, unknown>; signature: string; payload: unknown }> {
  const started = performance.now(), viewerId = getUserInfo()?.id;
  const response = await authFetch(`${API_URL}/api/office/artifacts/${encodeURIComponent(artifactId)}/offline-packages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, pinned: true, expectedVersion }) });
  return protectedMediaJson(response, "office_offline_package_failed", started, viewerId);
}

export type OfficeClassification = {
  departments?:Array<{id:string;name:string}>;
  workspaceId:string; revision:string; sensitivity:"public"|"internal"|"confidential"; compartments:string[]; canManage:boolean;
  history:Array<{id:string;createdAt:string;metadata:{before:{sensitivity:string;compartments:string[]};after:{sensitivity:string;compartments:string[]}}}>;
};
export function getOfficeClassification(artifactId:string):Promise<OfficeClassification> {
  return metadata<OfficeClassification>(`artifacts/${encodeURIComponent(artifactId)}/classification`,"office_classification_failed");
}
export function restrictOfficeClassification(artifactId:string,input:{expectedRevision:string;departmentId?:string;sensitivity:OfficeClassification["sensitivity"]}):Promise<OfficeClassification> {
  return metadata<OfficeClassification>(`artifacts/${encodeURIComponent(artifactId)}/classification`,"office_classification_failed",value=>value,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
}
