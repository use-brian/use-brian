"use client";

/** Shared lifecycle read for the page chrome and standalone recording view.
 * [COMP:app-web/recording-chrome]
 */
import { useEffect } from "react";
import { getRecording, type RecordingSummary } from "@/lib/api/recordings";
import { useCachedResource } from "@/lib/surface-cache";
import { recordingDetailCacheKey } from "@/lib/surface-prefetch";
import {
  RECORDING_PARTICIPANTS_UPDATED_EVENT,
  type RecordingParticipantsUpdatedDetail,
} from "./recording-events";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

const STATUS_POLL_MS = 10_000;

export function useRecordingSummary(
  workspaceId: string,
  recordingId: string,
  options?: { trackProcessing?: boolean },
) {
  const key = recordingDetailCacheKey(workspaceId, recordingId);
  const resource = useLeasedResource<RecordingSummary>(
    key,
    () => getRecording(recordingId),
  );

  useEffect(() => {
    const summary = resource.data;
    const inFlight =
      summary?.status === "queued" || summary?.status === "processing" ||
      (summary?.status === "awaiting_upload" &&
        (options?.trackProcessing === true || (summary.durationMs ?? 0) <= 0));
    const retryColdFailure =
      options?.trackProcessing === true &&
      summary === undefined &&
      resource.error !== undefined;
    if (!inFlight && !retryColdFailure) return;
    const timer = setTimeout(() => void resource.refresh(), STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [options?.trackProcessing, resource.data, resource.error, resource.attemptedAt, resource.refresh]);

  useEffect(() => {
    const onParticipantsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<RecordingParticipantsUpdatedDetail>).detail;
      if (detail?.recordingId === recordingId) void resource.refresh();
    };
    window.addEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    return () => {
      window.removeEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    };
  }, [recordingId, resource.refresh]);

  return {
    recordingId,
    summary: resource.data ?? null,
    error: resource.data === undefined && resource.error !== undefined,
  };
}
