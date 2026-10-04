/**
 * One sentence for a failed recording upload / estimate / process, shared by
 * the chat composer's `useRecordingUpload` and the brain intake queue so the
 * two surfaces cannot drift on what a failure is called. Which boundary broke
 * decides the copy: a storage-upload failure and a queue failure call for
 * different user action, and one generic "could not process" hid which of
 * the steps actually failed.
 *
 * Spec: docs/architecture/engine/preflight-confirmation.md.
 */

import type { Dictionary } from "@/lib/i18n/dictionaries";
import { RecordingApiError } from "@/lib/api/recordings";

export type RecordingFailureStage = "upload" | "estimate" | "process";

export function recordingFailureMessage(
  e: unknown,
  stage: RecordingFailureStage,
  t: Dictionary,
): string {
  const code = e instanceof RecordingApiError ? e.code : undefined;
  const detail =
    e instanceof RecordingApiError && e.message && e.status !== 0 ? e.message : null;
  if (code === "recording_media_tools_unavailable") return t.recordings.serverSetupRequired;
  if (code === "recording_upload_prepare_failed" || code === "recording_intake_provenance_required") return t.recordings.uploadPrepareFailed;
  if (code === "recording_upload_complete_failed") return t.recordings.uploadCompleteFailed;
  if (code === "too_long") return t.recordings.tooLong;
  if (code === "could_not_read_duration") return t.recordings.cannotReadDuration;
  if (stage === "upload") return t.recordings.uploadFailed;
  if (stage === "estimate") return t.recordings.estimateFailed;
  return detail ? `${t.recordings.processFailed} (${detail})` : t.recordings.processFailed;
}
