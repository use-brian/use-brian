/**
 * Recordings SDK (app-web) — the 3-step long-recording upload flow
 * (recording-to-brain). Mirrors the backend route `routes/recordings.ts`:
 *
 *   1. POST /api/recordings/upload-url  → mint a signed PUT URL + Episode anchor.
 *   2. PUT the bytes to the signed storage URL.
 *   3. POST /api/recordings/:id/estimate → server-probed duration + surcharge.
 *   4. POST /api/recordings/:id/process  → transcribe + segment + ingest + bill.
 *
 * An explicit processing surface shows the estimate (step 3) in a confirm
 * dialog before step 4. A chat attachment deliberately stops after step 3 and
 * carries the staged recording id into conversation first. See
 * `lib/recordings/use-recording-upload.ts` for both flows.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type RecordingEstimate = {
  recordingId: string;
  durationMs: number;
  durationSeconds: number;
  surchargeCredits: number;
};

export type LiveRecordingPage = {
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
  destination: "existing" | "new";
  pageId?: string;
  parentPageId?: string | null;
  title?: string;
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
}): Promise<{ ok: boolean; transcript?: string; lines?: LiveTranscriptLine[]; notes?: string; duplicate?: boolean }> {
  const body = new FormData();
  body.set("workspaceId", params.workspaceId);
  body.set("assistantId", params.assistantId);
  body.set("pageId", params.page.pageId);
  body.set("sessionId", params.page.sessionId);
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

const LOCAL_RECORDING_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const LOCAL_RECORDING_UPLOAD_ATTEMPTS = 3;

function isLocalFileTransferUrl(raw: string): boolean {
  try {
    return new URL(raw).pathname.endsWith("/api/local-files");
  } catch {
    return false;
  }
}

async function putWithUploadProgress(input: {
  uploadUrl: string;
  body: Blob;
  mime: string;
  contentRange?: string;
  onProgress: (loadedBytes: number) => void;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", input.uploadUrl);
    xhr.setRequestHeader("Content-Type", input.mime);
    if (input.contentRange) xhr.setRequestHeader("Content-Range", input.contentRange);
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

async function putLocalRecordingRange(input: {
  uploadUrl: string;
  body: Blob;
  mime: string;
  contentRange: string;
  onProgress: (loadedBytes: number) => void;
}): Promise<void> {
  let lastError: RecordingApiError | null = null;
  for (let attempt = 1; attempt <= LOCAL_RECORDING_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const status = await putWithUploadProgress(input);
      if (status >= 200 && status < 300) return;
      lastError = new RecordingApiError(`Upload to storage failed (${status})`, status);
      if (status >= 400 && status < 500) throw lastError;
    } catch (error) {
      lastError = error instanceof RecordingApiError
        ? error
        : new RecordingApiError("Upload to storage failed (network error)", 0);
      if (lastError.status >= 400 && lastError.status < 500) throw lastError;
    }
    if (attempt < LOCAL_RECORDING_UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError ?? new RecordingApiError("Upload to storage failed", 0);
}

/**
 * Create the recording, then PUT the file straight to storage via the signed URL.
 * Resolves the `recordingId` for the estimate/process steps. `onProgress` (0..1)
 * tracks the storage upload.
 */
export async function startRecordingUpload(params: {
  workspaceId: string;
  assistantId: string;
  file: File;
  /** Fraction of the signed PUT body transferred, from 0 through 1. */
  onProgress?: (progress: number) => void;
  /**
   * Caller-declared recording kind — routes the transcriber ladder
   * (`recordings.kind`, default 'memo'). The dock live recorder passes
   * 'meeting' for its long captures; picked-file uploads omit it.
   */
  kind?: "memo" | "meeting";
}): Promise<{ recordingId: string }> {
  const mime = params.file.type || "audio/mpeg";
  const mintRes = await authFetch(`${API_URL}/api/recordings/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: params.workspaceId,
      assistantId: params.assistantId,
      fileName: params.file.name,
      mime,
      ...(params.kind ? { kind: params.kind } : {}),
    }),
  });
  if (!mintRes.ok) throw await asError(mintRes, "Could not start the upload");
  const { recordingId, uploadUrl } = (await mintRes.json()) as {
    recordingId: string;
    uploadUrl: string;
  };

  // PUT bytes direct to storage. The Content-Type must match what the signed URL was
  // minted with. `fetch` has no request-body progress, so callers that surface
  // progress opt into XHR in the browser. Non-browser/test callers keep the
  // existing fetch transport.
  if (params.onProgress && typeof XMLHttpRequest !== "undefined") {
    // The local-disk self-host exposes this signed URL through its API origin.
    // One large PUT can outlive a reverse proxy's origin-response timeout,
    // because the transfer route correctly answers only after the whole body is
    // durable. Sequential ranges make each request bounded and resumable at the
    // last acknowledged byte. Real GCS/S3 signed URLs keep one direct PUT.
    if (isLocalFileTransferUrl(uploadUrl) && params.file.size > 0) {
      for (let offset = 0; offset < params.file.size; offset += LOCAL_RECORDING_UPLOAD_CHUNK_BYTES) {
        const end = Math.min(params.file.size, offset + LOCAL_RECORDING_UPLOAD_CHUNK_BYTES);
        const body = params.file.slice(offset, end, mime);
        await putLocalRecordingRange({
          uploadUrl,
          body,
          mime,
          contentRange: `bytes ${offset}-${end - 1}/${params.file.size}`,
          onProgress: (loadedBytes) => {
            params.onProgress?.(Math.min(1, (offset + loadedBytes) / params.file.size));
          },
        });
        params.onProgress(Math.min(1, end / params.file.size));
      }
    } else {
      const status = await putWithUploadProgress({
        uploadUrl,
        body: params.file,
        mime,
        onProgress: (loadedBytes) => {
          if (params.file.size > 0) {
            params.onProgress?.(Math.min(1, loadedBytes / params.file.size));
          }
        },
      });
      if (status < 200 || status >= 300) {
        throw new RecordingApiError(`Upload to storage failed (${status})`, status);
      }
    }
    params.onProgress(1);
  } else {
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: params.file,
    });
    if (!put.ok) {
      throw new RecordingApiError(`Upload to storage failed (${put.status})`, put.status);
    }
    params.onProgress?.(1);
  }

  return { recordingId };
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
