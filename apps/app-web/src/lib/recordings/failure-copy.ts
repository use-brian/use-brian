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
import { RecordingApiError, RecordingResolveError } from "@/lib/api/recordings";

export type RecordingFailureStage = "upload" | "estimate" | "process";

export function recordingFailureMessage(
  e: unknown,
  stage: RecordingFailureStage,
  t: Dictionary,
): string {
  const code = e instanceof RecordingApiError ? e.code : undefined;
  const detail =
    e instanceof RecordingApiError && e.message && e.status !== 0 ? e.message : null;
  if (code === "too_long") return t.recordings.tooLong;
  if (code === "could_not_read_duration") return t.recordings.cannotReadDuration;
  if (code === "quota_exceeded") return t.recordings.storageFull;
  // The bytes are stored; only deriving the recording from them failed, so
  // "could not reach storage" would be false.
  if (e instanceof RecordingResolveError) {
    return detail ? `${t.recordings.processFailed} (${detail})` : t.recordings.processFailed;
  }
  if (stage === "upload") return t.recordings.uploadFailed;
  if (stage === "estimate") return t.recordings.estimateFailed;
  return detail ? `${t.recordings.processFailed} (${detail})` : t.recordings.processFailed;
}
