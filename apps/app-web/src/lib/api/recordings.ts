/**
 * Recordings SDK (app-web) — the 3-step long-recording upload flow
 * (recording-to-brain). Mirrors the backend route `routes/recordings.ts`:
 *
 *   1. POST /api/recordings/upload-url  → mint a signed PUT URL + Episode anchor.
 *   2. PUT the bytes DIRECT to GCS (never through the API).
 *   3. POST /api/recordings/:id/estimate → server-probed duration + surcharge.
 *   4. POST /api/recordings/:id/process  → transcribe + segment + ingest + bill.
 *
 * The estimate (step 3) is shown in a confirm dialog before process (step 4) so
 * the duration surcharge is accepted before any model call. See
 * `lib/recordings/use-recording-upload.ts` for the UI flow.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type RecordingEstimate = {
  recordingId: string;
  durationMs: number;
  durationSeconds: number;
  surchargeCredits: number;
};

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

/**
 * Create the recording, then PUT the file straight to GCS via the signed URL.
 * Resolves the `recordingId` for the estimate/process steps. `onProgress` (0..1)
 * tracks the GCS upload.
 */
export async function startRecordingUpload(params: {
  workspaceId: string;
  assistantId: string;
  file: File;
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

  // PUT bytes direct to GCS. The Content-Type must match what the signed URL was
  // minted with. (Not authFetch — this goes to GCS, not our API.)
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mime },
    body: params.file,
  });
  if (!put.ok) throw new RecordingApiError(`Upload to storage failed (${put.status})`, put.status);

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
): Promise<RecordingQueued> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(blueprintSlug ? { blueprintSlug } : {}),
      ...(parentPageId ? { parentPageId } : {}),
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
