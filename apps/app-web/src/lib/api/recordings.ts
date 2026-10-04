import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Recordings SDK (app-web) — the 3-step long-recording upload flow
 * (recording-to-brain). Mirrors the backend route `routes/recordings.ts`:
 *
 *   1. POST /api/recordings/upload-url  → admit a chunked upload (no recording yet).
 *   2. PUT exact parts, then POST /api/recordings/complete-upload for a recording.
 *   3. POST /api/recordings/:id/estimate → server-probed duration + surcharge.
 *   4. POST /api/recordings/:id/process  → transcribe + segment + ingest + bill.
 *
 * An explicit processing surface shows the estimate (step 3) in a confirm
 * dialog before step 4. A chat attachment deliberately stops after step 3 and
 * carries the staged recording id into conversation first. See
 * `lib/recordings/use-recording-upload.ts` for both flows.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/**
 * Browsers normally provide a media MIME for picked recordings, but desktop
 * file drags and a few platform bridges can leave `File.type` empty. The
 * recording route requires an audio/video MIME, so infer common recording
 * extensions here rather than mislabelling every empty type as MP3.
 */
const RECORDING_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  amr: "audio/amr",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
};

export function recordingMimeForFile(file: Pick<File, "name" | "type">): string | null {
  const declared = file.type.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (declared.startsWith("audio/") || declared.startsWith("video/")) return declared;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return RECORDING_MIME_BY_EXTENSION[extension] ?? null;
}

export function isRecordingFile(file: Pick<File, "name" | "type">): boolean {
  return recordingMimeForFile(file) !== null;
}

export type RecordingEstimate = {
  recordingId: string;
  durationMs: number;
  durationSeconds: number;
  surchargeCredits: number;
};

export type LiveRecordingPage = {
  /** Validated server capture; absent until interaction /start succeeds. */
  interactionCaptureId?: string;
  onInteractionGap?: () => void;
  pageId: string;
  title: string;
  /** The capture session — keys the server-side transcript windows + assembly. */
  sessionId: string;
  /** Stable anchor above the rolling notes region. */
  notesHeadingId: string;
  /** The `live:`-prefixed caption block closing the notes region. */
  markerBlockId: string;
};

export type LiveTranscriptLine = {
  speaker: string | null;
  text: string;
};

export type LiveTranscriptWindowRow = {
  chunkId: string;
  offsetMs: number;
  durationMs: number;
  missedBefore: number;
  lines: LiveTranscriptLine[];
};

/** Prepare the collaborative page before opening the microphone. */
export async function startLiveRecordingPage(params: {
  workspaceId: string;
  destination: "existing" | "new" | "meeting-notes";
  pageId?: string;
  parentPageId?: string | null;
  title?: string;
  folderName?: string;
}): Promise<LiveRecordingPage> {
  const res = await authFetch(`${API_URL}/api/recordings/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw await asError(res, "Could not prepare the live meeting page");
  return res.json();
}

/** Upload one complete, independently decodable live-audio window. */
export async function streamLiveRecordingWindow(params: {
  workspaceId: string;
  assistantId: string;
  page: LiveRecordingPage;
  chunkId: string;
  blob: Blob;
  mime: string;
  startMs: number;
  endMs: number;
  missedWindows?: number;
  microphone?: { blob: Blob; mime: string };
  interactionSource?: "microphone" | "mixed";
  discontinuity?: boolean;
}): Promise<{ ok: boolean; transcript?: string; lines?: LiveTranscriptLine[]; notes?: string; duplicate?: boolean; interactionError?: boolean }> {
  const body = new FormData();
  body.set("workspaceId", params.workspaceId);
  body.set("assistantId", params.assistantId);
  body.set("pageId", params.page.pageId);
  body.set("sessionId", params.page.sessionId);
  if (params.page.interactionCaptureId) {
    body.set("interactionCaptureId", params.page.interactionCaptureId);
    // Source identity comes from acquisition, never ASR speaker labels.
    if (params.interactionSource) body.set("interactionSource", params.interactionSource);
    if (params.interactionSource === "mixed" && params.microphone) {
      body.set("microphone", params.microphone.blob, `microphone-${params.chunkId}.webm`);
    }
  }
  if (params.discontinuity) body.set("discontinuity", "true");
  body.set("notesHeadingId", params.page.notesHeadingId);
  body.set("markerBlockId", params.page.markerBlockId);
  body.set("chunkId", params.chunkId);
  body.set("offsetMs", String(params.startMs));
  body.set("durationMs", String(params.endMs - params.startMs));
  if (params.missedWindows) body.set("missedWindows", String(params.missedWindows));
  body.set("audio", params.blob, `live-${params.chunkId}.webm`);
  const res = await authFetch(`${API_URL}/api/recordings/live/chunk`, {
    method: "POST",
    body,
  });
  if (!res.ok) throw await asError(res, "Could not process this live transcript window");
  return res.json();
}

/** The live transcript pane's read: one page's provisional windows, capture order. */
export async function listLiveTranscriptWindows(
  workspaceId: string,
  pageId: string,
): Promise<LiveTranscriptWindowRow[]> {
  const res = await authFetch(
    `${API_URL}/api/recordings/live/windows?workspaceId=${encodeURIComponent(workspaceId)}&pageId=${encodeURIComponent(pageId)}`,
  );
  if (!res.ok) throw await asError(res, "Could not load the live transcript");
  const body = (await res.json()) as { windows: LiveTranscriptWindowRow[] };
  return body.windows;
}

/**
 * Link a recording to a page the moment its id exists — the live meeting
 * page must carry its recording even when the upload or processing later
 * fails, so the page can state that status honestly instead of losing the
 * recording entirely. Callers treat failure as non-fatal.
 */
export async function linkLiveRecordingPage(pageId: string, recordingId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/recordings/live/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, recordingId }),
  });
  if (!res.ok) throw await asError(res, "Could not link the recording to the page");
}

/**
 * Assemble the server-persisted live windows into a usable recording — the
 * fallback when the lossless full upload cannot complete (offline stop,
 * failed storage PUT). Returns the new recording id; the normal
 * estimate → confirm → process flow continues on it.
 */
export async function finalizeLiveRecording(params: {
  workspaceId: string;
  assistantId: string;
  sessionId: string;
  pageId?: string;
}): Promise<{ recordingId: string; windowCount: number; coverageMs: number }> {
  const res = await authFetch(`${API_URL}/api/recordings/live/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw await asError(res, "Could not assemble the live recording");
  return res.json();
}

/** Bind diarized speaker labels to display names on the final transcript. */
export async function updateRecordingParticipants(
  recordingId: string,
  participants: Array<{ speaker: string; name?: string }>,
): Promise<void> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/participants`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participants }),
  });
  if (!res.ok) throw await asError(res, "Could not save the speaker names");
}

/**
 * The `/process` 202 body — the job is QUEUED for the worker service, not
 * done. (The old synchronous shape with `utteranceCount`/`truncated` died
 * with the worker offload; the client must not claim "transcribed" here.)
 */
export type RecordingQueued = {
  recordingId: string;
  status: "queued";
  jobId: string | null;
};

/** Error carrying the backend's machine code (`too_long`, `could_not_read_duration`, ...). */
export class RecordingApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RecordingApiError";
    this.status = status;
    this.code = code;
  }
}

async function asError(res: Response, fallback: string): Promise<RecordingApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  return new RecordingApiError(body.detail ?? body.error ?? fallback, res.status, body.error);
}

async function putWithUploadProgress(input: {
  uploadUrl: string;
  body: Blob;
  mime: string;
  /** Backend-mandated headers (Azure Blob: `x-ms-blob-type`). */
  uploadHeaders?: Record<string, string>;
  onProgress: (loadedBytes: number) => void;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", input.uploadUrl);
    xhr.setRequestHeader("Content-Type", input.mime);
    for (const [name, value] of Object.entries(input.uploadHeaders ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(Math.min(input.body.size, event.loaded));
      }
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new RecordingApiError("Upload to storage failed (network error)", 0));
    xhr.onabort = () => reject(new RecordingApiError("Upload to storage was cancelled", 0));
    xhr.send(input.body);
  });
}

/** Upload admitted chunks before creating the canonical recording. */
export async function startRecordingUpload(params: {
  workspaceId: string;
  assistantId: string;
  file: File;
  onProgress?: (progress: number) => void;
  kind?: "memo" | "meeting";
}): Promise<{ recordingId: string }> {
  const prepareCode = "recording_upload_prepare_failed";
  const completeCode = "recording_upload_complete_failed";
  const storageCode = "recording_upload_storage_failed";
  async function post(path: string, body: unknown, code: string): Promise<Response> {
    try {
      const res = await authFetch(`${API_URL}/api/recordings/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await asError(res, "Recording upload failed");
        throw new RecordingApiError(error.message, error.status,
          error.code === "recording_media_tools_unavailable" || error.code === "recording_intake_provenance_required"
            ? error.code : code);
      }
      return res;
    } catch (error) {
      if (error instanceof RecordingApiError) throw error;
      throw new RecordingApiError("Recording upload API unavailable", 0, code);
    }
  }
  const mime = recordingMimeForFile(params.file);
  if (!mime) throw new RecordingApiError("Only audio/video recordings are supported", 400, prepareCode);
  const scope = {
    workspaceId: params.workspaceId,
    assistantId: params.assistantId,
    ...(params.kind ? { kind: params.kind } : {}),
  };
  const mint = await post("upload-url", {
    ...scope, fileName: params.file.name, mime, sizeBytes: params.file.size,
  }, prepareCode);
  const start = await mint.json().catch(() => null) as {
    uploadId: string;
    fileId: string;
    chunkSizeBytes: number;
    expiresAt: string;
    parts: Array<{ index: number; offset: number; sizeBytes: number; url: string }>;
    uploadHeaders?: Record<string, string>;
  } | null;
  // Reject incomplete plans before sending any bytes or asking for adoption.
  let plannedBytes = 0;
  if (!start?.uploadId || !Array.isArray(start.parts) || !start.parts.length ||
      !start.parts.every((part) => {
        const valid = Number.isSafeInteger(part.sizeBytes) && part.sizeBytes > 0 &&
          part.offset === plannedBytes && typeof part.url === "string" && !!part.url;
        plannedBytes += part.sizeBytes;
        return valid;
      }) || plannedBytes !== params.file.size) {
    throw new RecordingApiError("Invalid recording upload plan", 502, prepareCode);
  }
  let progress = 0;
  const report = (bytes: number) => {
    progress = Math.max(progress, Math.min(1, bytes / params.file.size));
    params.onProgress?.(progress);
  };
  for (const part of start.parts) {
    const body = params.file.slice(part.offset, part.offset + part.sizeBytes);
    for (let attempt = 0; ; attempt += 1) {
      try {
        // Parts are independent signed objects, including on local storage.
        // The canonical chunk uploader signs application/octet-stream.
        const status = params.onProgress && typeof XMLHttpRequest !== "undefined"
          ? await putWithUploadProgress({
              uploadUrl: part.url, body, mime: "application/octet-stream",
              uploadHeaders: start.uploadHeaders,
              onProgress: (loaded) => report(part.offset + loaded),
            })
          : (await fetch(part.url, {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream", ...start.uploadHeaders },
              body,
            })).status;
        if (status < 200 || status >= 300) {
          throw new RecordingApiError(`Upload to storage failed (${status})`, status, storageCode);
        }
        break;
      } catch (error) {
        const status = error instanceof RecordingApiError ? error.status : 0;
        if (attempt >= 2 || (status >= 400 && status < 500)) {
          throw new RecordingApiError("Upload to storage failed", status, storageCode);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, (attempt + 1) * 250));
      }
    }
    report(part.offset + part.sizeBytes);
  }
  const completion = await post("complete-upload", { ...scope, uploadId: start.uploadId }, completeCode);
  const result = await completion.json().catch(() => null) as { recordingId?: string } | null;
  if (!result?.recordingId) throw new RecordingApiError("Invalid recording completion", 502, completeCode);
  return { recordingId: result.recordingId };
}

/** Server-authoritative duration + surcharge estimate. Throws `too_long` / `could_not_read_duration`. */
export async function estimateRecording(recordingId: string): Promise<RecordingEstimate> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/estimate`, { method: "POST" });
  if (!res.ok) throw await asError(res, "Could not read the recording");
  return res.json();
}

/**
 * ENQUEUE transcribe + segment + ingest + charge-on-success (202; the worker
 * service drains the job off the request thread, so success here means
 * "queued", NOT "transcribed"). `blueprintSlug` (optional) selects the
 * synthesis blueprint the engine fills from the transcript (a workspace
 * blueprint template id) to author a brief page. Omit it (the default) and
 * the recording is ingested into the brain only, with no page.
 * See structural-synthesis.md -> "The first source" and transcription.md.
 */
export async function processRecording(
  recordingId: string,
  blueprintSlug?: string,
  /**
   * Where to file the synthesized brief (`nest_parent_id`). Omitted → the
   * workspace root, the behaviour before the pre-flight destination picker.
   * The server re-checks it under the caller's RLS and 400s an id they cannot
   * see, so this is a convenience, never the access boundary.
   */
  parentPageId?: string | null,
  /**
   * `confirm: true` clears the server's already-processed guard (409
   * `requiresConfirmation`). Send it ONLY from a surface whose own dialog told
   * the user that a re-run re-transcribes and can duplicate extracted memories;
   * a first-time run neither needs it nor should send it.
   */
  opts?: { confirm?: boolean },
): Promise<RecordingQueued> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(blueprintSlug ? { blueprintSlug } : {}),
      ...(parentPageId ? { parentPageId } : {}),
      ...(opts?.confirm ? { confirm: true } : {}),
    }),
  });
  if (!res.ok) throw await asError(res, "Transcription failed");
  return res.json();
}

// ── The read surface ────────────────────────────────────────────────
//
// Until these routes existed the recordings router was write-only: a recording
// could be uploaded and transcribed but never listed, and the audio was never
// handed back to the browser at all — a player had no possible `src`.

export type RecordingKind = "memo" | "meeting";
export type RecordingStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "processed"
  | "failed";

export type RecordingSummary = {
  recordingId: string;
  title: string | null;
  fileName: string | null;
  kind: RecordingKind;
  status: RecordingStatus;
  mime: string;
  durationMs: number | null;
  bytes: number | null;
  occurredAt: string;
  truncated: boolean;
  lastError: string | null;
  hasTranscript: boolean;
  transcriptFileId: string | null;
  participants: Array<{ speaker: string; name?: string; contactId?: string; email?: string }>;
};

export type TranscriptSegment = {
  segment_index: number;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  segment_text: string;
  /** 'visual' = a video keyframe description (migration 480); absent/'speech' = transcription. */
  kind?: "speech" | "visual";
};

/**
 * The workspace's recordings, newest first — the panel's read.
 *
 * Server-filtered rather than fetch-all-and-filter-in-React: `status` and `q`
 * ride the store's indexed predicates, and a workspace with hundreds of
 * hour-long meetings should not ship them all to the browser to hide most.
 */
export async function listRecordings(
  workspaceId: string,
  filters: { kind?: RecordingKind; status?: RecordingStatus; q?: string; limit?: number } = {},
): Promise<RecordingSummary[]> {
  const params = new URLSearchParams({ workspaceId });
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.status) params.set("status", filters.status);
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.limit) params.set("limit", String(filters.limit));
  const res = await authFetch(`${API_URL}/api/recordings?${params.toString()}`);
  if (!res.ok) throw await asError(res, "Could not load recordings");
  const body = (await res.json()) as { recordings: RecordingSummary[] };
  return body.recordings;
}

export async function getRecording(recordingId: string): Promise<RecordingSummary> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}`);
  if (!res.ok) throw await asError(res, "Could not load the recording");
  return (await res.json()) as RecordingSummary;
}

/**
 * Mint a playback URL. It points straight at GCS (which honors Range, so the
 * browser seeks against storage rather than through our API) and is a
 * time-limited bearer token — `expiresAt` is why the player refreshes
 * proactively instead of discovering expiry as a playback failure.
 */
export async function getRecordingMediaUrl(
  recordingId: string,
): Promise<{ url: string; expiresAt: string; mime: string; durationMs: number | null }> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/media-url`);
  if (!res.ok) throw await asError(res, "Could not load the audio");
  return (await res.json()) as {
    url: string;
    expiresAt: string;
    mime: string;
    durationMs: number | null;
  };
}

/** One page of transcript. The server bounds the window regardless of `toIndex`. */
export async function getRecordingTranscript(
  recordingId: string,
  fromIndex = 0,
): Promise<{ segments: TranscriptSegment[]; hasMore: boolean; toIndex: number }> {
  const res = await authFetch(
    `${API_URL}/api/recordings/${recordingId}/transcript?fromIndex=${fromIndex}`,
  );
  if (!res.ok) throw await asError(res, "Could not load the transcript");
  return (await res.json()) as {
    segments: TranscriptSegment[];
    hasMore: boolean;
    toIndex: number;
  };
}

/** Task lifecycle status, mirroring the brain's `kind:'tasks'` rows. */
type RecordingTaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "archived";

/**
 * An action item captured from a recording. `sourceStartMs` is the moment it
 * was committed to (migration 334) - the rail turns it into a seek link.
 * `assigneeId` is a `workspace_members` row id, not a user id, so the caller
 * resolves it against the roster.
 */
export type RecordingTask = {
  id: string;
  title: string;
  status: RecordingTaskStatus;
  assigneeId: string | null;
  sourceStartMs: number | null;
  /**
   * False until a human confirms the model heard this right. Synthesis writes
   * every captured task unverified, and the brain inbox excludes extracted
   * rows, so this rail is the only place they are ever reviewed.
   */
  verified: boolean;
};

/** The action items captured from one recording, oldest moment first. */
export async function listRecordingTasks(
  recordingId: string,
): Promise<RecordingTask[]> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/tasks`);
  if (!res.ok) throw await asError(res, "Could not load the action items");
  const body = (await res.json()) as { tasks: RecordingTask[] };
  return body.tasks;
}
