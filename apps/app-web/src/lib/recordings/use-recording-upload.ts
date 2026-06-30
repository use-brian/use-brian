"use client";

/**
 * Recording upload flow hook (recording-to-brain). Drives: pick file → upload
 * (direct-to-GCS) → server estimate → confirm-dialog cost preview → process
 * (transcribe + segment + ingest + charge-on-success). Returns inline status +
 * message (app-web has no global toast; feedback renders inline). All strings
 * come from `useT()`.
 */

import { useState, useCallback } from "react";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  startRecordingUpload,
  estimateRecording,
  processRecording,
  RecordingApiError,
  type RecordingResult,
} from "@/lib/api/recordings";

export type RecordingUploadStatus = "idle" | "uploading" | "processing" | "done" | "error";

export function useRecordingUpload(workspaceId: string, assistantId: string) {
  const t = useT();
  const [status, setStatus] = useState<RecordingUploadStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<RecordingResult | null>(null);

  const run = useCallback(
    async (file: File, blueprintSlug?: string) => {
      setResult(null);
      setMessage("");
      try {
        setStatus("uploading");
        const { recordingId } = await startRecordingUpload({ workspaceId, assistantId, file });

        // Server-authoritative duration + surcharge → confirm before any model call.
        const est = await estimateRecording(recordingId);
        const minutes = Math.max(1, Math.round(est.durationSeconds / 60));
        const ok = await confirmDialog({
          title: t.recordings.confirmTitle,
          description:
            est.surchargeCredits > 0
              ? t.recordings.confirmBody
                  .replace("{minutes}", String(minutes))
                  .replace("{credits}", String(est.surchargeCredits))
              : t.recordings.confirmFree,
          confirmLabel: t.recordings.confirmAction,
        });
        if (!ok) {
          setStatus("idle");
          return;
        }

        setStatus("processing");
        const res = await processRecording(recordingId, blueprintSlug);
        setResult(res);
        setStatus("done");
        setMessage(res.truncated ? t.recordings.partialDone : t.recordings.done);
      } catch (e) {
        setStatus("error");
        const code = e instanceof RecordingApiError ? e.code : undefined;
        setMessage(
          code === "too_long"
            ? t.recordings.tooLong
            : code === "could_not_read_duration"
              ? t.recordings.cannotReadDuration
              : t.recordings.failed,
        );
      }
    },
    [workspaceId, assistantId, t],
  );

  return { run, status, message, result };
}
