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

export type RecordingResult = {
  utteranceCount: number;
  segmentsInserted: number;
  truncated: boolean;
  surchargeCredits: number;
  surcharged: boolean;
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
 * Transcribe + segment + ingest + charge-on-success. `blueprintSlug` (optional)
 * selects the synthesis blueprint the engine fills from the transcript (a
 * workspace blueprint template id) to author a brief page. Omit it (the default)
 * and the recording is ingested into the brain only, with no page.
 * See structural-synthesis.md -> "The first source".
 */
export async function processRecording(
  recordingId: string,
  blueprintSlug?: string,
): Promise<RecordingResult> {
  const res = await authFetch(`${API_URL}/api/recordings/${recordingId}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(blueprintSlug ? { blueprintSlug } : {}),
  });
  if (!res.ok) throw await asError(res, "Transcription failed");
  return res.json();
}
