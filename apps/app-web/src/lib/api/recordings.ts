import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Recordings SDK (app-web) — the 3-step long-recording upload flow
 * (recording-to-brain). Mirrors the backend route `routes/recordings.ts`:
 *
 *   1. Publish the capture as a workspace file (chunked direct-to-storage
 *      upload) and resolve the recording derived from it -
 *      `startRecordingUpload`. The recording can only be born after its bytes.
 *   2. POST /api/recordings/:id/estimate → server-probed duration + surcharge.
 *   3. POST /api/recordings/:id/process  → transcribe + segment + ingest + bill.
 *
 * An explicit processing surface shows the estimate (step 2) in a confirm
 * dialog before step 3. A chat attachment deliberately stops after step 2 and
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
}): Promise<{ recordingId: string; windowCount: number; coverageMs: number | null }> {
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

/**
 * The capture IS stored as a workspace file, but its recording could not be
 * resolved from it. Distinct from an upload failure: the bytes left the
 * device, so a retry must not re-upload them (a duplicate "Name (2)" file) and
 * the live fallback must not assemble a second recording from the windows.
 * The stored media stays reachable from Files, where re-ingesting it resolves
 * the same recording.
 */
export class RecordingResolveError extends RecordingApiError {
  readonly fileId: string;
  constructor(cause: RecordingApiError, fileId: string) {
    super(cause.message, cause.status, cause.code);
    this.name = "RecordingResolveError";
    this.fileId = fileId;
  }
}

async function asError(res: Response, fallback: string): Promise<RecordingApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  return new RecordingApiError(body.detail ?? body.error ?? fallback, res.status, body.error);
}

const PART_UPLOAD_ATTEMPTS = 3;
/** Requests that are idempotent server-side (complete, resolve) retry this often. */
const IDEMPOTENT_ATTEMPTS = 3;
/** "Recording.webm", "Recording (2).webm", ... before giving up on a name. */
const MAX_FILE_NAME_ATTEMPTS = 5;

type ChunkedUploadStart = {
  uploadId: string;
  fileId: string;
  parts: Array<{ index: number; offset: number; sizeBytes: number; url: string }>;
  /** Backend-mandated headers on every part PUT (Azure Blob: `x-ms-blob-type`). */
  uploadHeaders?: Record<string, string>;
};

function numberedFileName(name: string, attempt: number): string {
  if (attempt === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${attempt})${name.slice(dot)}`
    : `${name} (${attempt})`;
}

async function putWithUploadProgress(input: {
  uploadUrl: string;
  body: Blob;
  mime: string;
  /** Backend-mandated headers (Azure Blob: `x-ms-blob-type`). */
  uploadHeaders?: Record<string, string>;
  onProgress: (loadedBytes: number) => void;
}): Promise<number> {
  // `fetch` has no request-body progress, so browsers use XHR; non-browser
  // and test callers keep fetch.
  if (typeof XMLHttpRequest === "undefined") {
    const put = await fetch(input.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": input.mime, ...(input.uploadHeaders ?? {}) },
      body: input.body,
    });
    if (put.ok) input.onProgress(input.body.size);
    return put.status;
  }
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

const isRetryable = (status: number, code?: string) =>
  status === 0 || status >= 500 || code === "busy";

/**
 * POST a request the server makes idempotent (`/complete` repairs or resumes,
 * `/:fileId/recording` adopts), retrying a network drop, a 5xx, or `busy`.
 * `/complete` assembles the object inside the request, so a proxy timeout on a
 * large capture is not proof it failed — asking again is the recovery.
 */
async function postIdempotent(url: string, body: unknown, fallback: string): Promise<Response> {
  let lastError: RecordingApiError | null = null;
  for (let attempt = 1; attempt <= IDEMPOTENT_ATTEMPTS; attempt += 1) {
    try {
      const res = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      lastError = await asError(res, fallback);
      if (!isRetryable(lastError.status, lastError.code)) throw lastError;
    } catch (error) {
      if (error instanceof RecordingApiError && !isRetryable(error.status, error.code)) throw error;
      lastError = error instanceof RecordingApiError ? error : new RecordingApiError(fallback, 0);
    }
    if (attempt < IDEMPOTENT_ATTEMPTS) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError ?? new RecordingApiError(fallback, 0);
}

/** One bounded part PUT, retried on network and 5xx failures; a 4xx is final. */
async function putPart(input: {
  uploadUrl: string;
  body: Blob;
  uploadHeaders?: Record<string, string>;
  onProgress: (loadedBytes: number) => void;
}): Promise<void> {
  let lastError: RecordingApiError | null = null;
  for (let attempt = 1; attempt <= PART_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      // Parts are signed as opaque bytes; the file row carries the real MIME.
      const status = await putWithUploadProgress({ ...input, mime: "application/octet-stream" });
      if (status >= 200 && status < 300) return;
      lastError = new RecordingApiError(`Upload to storage failed (${status})`, status);
      if (status >= 400 && status < 500) throw lastError;
    } catch (error) {
      lastError = error instanceof RecordingApiError
        ? error
        : new RecordingApiError("Upload to storage failed (network error)", 0);
      if (lastError.status >= 400 && lastError.status < 500) throw lastError;
    }
    if (attempt < PART_UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError ?? new RecordingApiError("Upload to storage failed", 0);
}

/**
 * Publish the capture as a workspace file, then resolve the recording derived
 * from it. A recording is born from an admitted file (the canonical intake
 * contract), so the bytes go first: a chunked direct-to-storage upload
 * (`/api/files/uploads/start` → PUT each bounded part → `/complete`), then
 * `POST /api/files/:fileId/recording`, which creates the Episode + recording
 * from that file. Resolves the `recordingId` for the estimate/process steps.
 * `onProgress` (0..1) tracks the storage upload. Bounded parts also keep any
 * one request short behind a reverse proxy's origin-response timeout.
 */
export async function startRecordingUpload(params: {
  workspaceId: string;
  /** Retained for callers; the recording inherits its scope from the file. */
  assistantId: string;
  file: File;
  /** Fraction of the upload transferred, from 0 through 1. */
  onProgress?: (progress: number) => void;
  /**
   * Caller-declared recording kind — routes the transcriber ladder
   * (`recordings.kind`, default 'memo'). The dock live recorder passes
   * 'meeting' for its long captures; picked-file uploads omit it.
   */
  kind?: "memo" | "meeting";
}): Promise<{ recordingId: string }> {
  const { workspaceId, file } = params;
  const mime = recordingMimeForFile(file);
  if (!mime) {
    throw new RecordingApiError("Only audio/video recordings are supported", 400);
  }

  // Stored files are unique by path, so a capture whose name is taken (an
  // earlier upload of the same file, a retried save) takes the next free
  // numbered name rather than failing.
  let start: ChunkedUploadStart | null = null;
  for (let attempt = 1; attempt <= MAX_FILE_NAME_ATTEMPTS && !start; attempt += 1) {
    const res = await authFetch(`${API_URL}/api/files/uploads/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        fileName: numberedFileName(file.name || "Recording", attempt),
        mime,
        sizeBytes: file.size,
      }),
    });
    if (res.status === 409) {
      const err = await asError(res, "A file with that name already exists");
      if (err.code === "conflict") continue;
      throw err;
    }
    if (!res.ok) throw await asError(res, "Could not start the upload");
    start = (await res.json()) as ChunkedUploadStart;
  }
  if (!start) {
    throw new RecordingApiError("A file with that name already exists", 409, "conflict");
  }

  // Abort (which deletes the staged parts) only while the parts are still
  // ours alone: once `/complete` may be assembling them, deleting would break
  // an assembly that is about to succeed. A definitive 4xx from it still aborts.
  let completed = false;
  let mayBeAssembling = false;
  try {
    let doneBytes = 0;
    for (const part of start.parts) {
      const body = file.slice(part.offset, part.offset + part.sizeBytes);
      await putPart({
        uploadUrl: part.url,
        body,
        uploadHeaders: start.uploadHeaders,
        onProgress: (loaded) => {
          if (file.size > 0) params.onProgress?.(Math.min(1, (doneBytes + loaded) / file.size));
        },
      });
      doneBytes += part.sizeBytes;
      if (file.size > 0) params.onProgress?.(Math.min(1, doneBytes / file.size));
    }
    mayBeAssembling = true;
    try {
      await postIdempotent(
        `${API_URL}/api/files/uploads/${encodeURIComponent(start.uploadId)}/complete`,
        { workspaceId },
        "Could not finish the upload",
      );
    } catch (error) {
      if (error instanceof RecordingApiError && !isRetryable(error.status, error.code)) mayBeAssembling = false;
      throw error;
    }
    completed = true;
  } finally {
    if (!completed && !mayBeAssembling) {
      await authFetch(`${API_URL}/api/files/uploads/${encodeURIComponent(start.uploadId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      }).catch(() => undefined);
    }
  }
  params.onProgress?.(1);

  let resolved: Response;
  try {
    resolved = await postIdempotent(
      `${API_URL}/api/files/${encodeURIComponent(start.fileId)}/recording`,
      { workspaceId, ...(params.kind ? { kind: params.kind } : {}) },
      "Could not start the recording",
    );
  } catch (error) {
    const cause = error instanceof RecordingApiError ? error : new RecordingApiError("Could not start the recording", 0);
    throw new RecordingResolveError(cause, start.fileId);
  }
  const { recordingId } = (await resolved.json()) as { recordingId: string };
  return { recordingId };
}

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
