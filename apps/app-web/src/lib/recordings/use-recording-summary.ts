"use client";

/** Shared lifecycle read for the page chrome and standalone recording view.
 * [COMP:app-web/recording-chrome]
 */
import { useEffect } from "react";
import { getRecording, getRecordingRecovery, type RecordingRecovery, type RecordingSummary } from "@/lib/api/recordings";
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
  const resource = useLeasedResource<RecordingSummary | { recovery: RecordingRecovery }>(
    key,
    async () => {
      try { return await getRecording(recordingId); }
      catch (error) {
        if (!(error instanceof Error) || !("status" in error) || error.status !== 404) throw error;
        const recovery = await getRecordingRecovery(workspaceId, recordingId);
        return recovery.replacementId ? getRecording(recovery.replacementId) : { recovery };
      }
    },
  );

  const summary = resource.data && !("recovery" in resource.data) ? resource.data : null;
  const recovery = resource.data && "recovery" in resource.data ? resource.data.recovery : null;
  useEffect(() => {
    const inFlight =
      summary?.status === "queued" || summary?.status === "processing" ||
      (summary?.status === "awaiting_upload" &&
        (options?.trackProcessing === true || (summary.durationMs ?? 0) <= 0));
    const retryColdFailure =
      options?.trackProcessing === true &&
      resource.data === undefined &&
      resource.error !== undefined;
    if (!inFlight && !retryColdFailure) return;
    const timer = setTimeout(() => void resource.refresh(), STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [options?.trackProcessing, summary, resource.data, resource.error, resource.attemptedAt, resource.refresh]);

  useEffect(() => {
    const onParticipantsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<RecordingParticipantsUpdatedDetail>).detail;
      if (detail?.recordingId === recordingId || detail?.recordingId === summary?.recordingId) void resource.refresh();
    };
    window.addEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    return () => {
      window.removeEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    };
  }, [recordingId, summary?.recordingId, resource.refresh]);

  return {
    recordingId,
    summary, recovery, refresh: resource.refresh,
    error: resource.data === undefined && resource.error !== undefined,
  };
}
