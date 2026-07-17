"use client";

/**
 * Recording upload flow hook (recording-to-brain). Drives: pick file → upload
 * (direct-to-GCS) → server estimate → confirm-dialog cost preview → process
 * (ENQUEUE: the worker service transcribes + segments + ingests + charges in
 * the background, so terminal success here means "queued", never
 * "transcribed"). Returns inline status + message (app-web has no global
 * toast; feedback renders inline). All strings come from `useT()`.
 */

import { useState, useCallback } from "react";
import { MEETING_NOTES_STARTER } from "@sidanclaw/doc-model";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { starterInstallInput } from "@/lib/blueprints";
import { createCustomPageTemplate } from "@/lib/api/views";
import {
  startRecordingUpload,
  estimateRecording,
  processRecording,
  RecordingApiError,
  type RecordingQueued,
} from "@/lib/api/recordings";

export type RecordingUploadStatus = "idle" | "uploading" | "processing" | "done" | "error";

export function useRecordingUpload(workspaceId: string, assistantId: string) {
  const t = useT();
  const [status, setStatus] = useState<RecordingUploadStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<RecordingQueued | null>(null);

  /**
   * Offer the meeting starter when the upload carries no blueprint and the
   * workspace has none to pick — otherwise the recording ingests with no brief
   * page, so no citations and no player. Returns the new blueprint's id, or
   * undefined if the user declined (or the install failed, which must not block
   * a recording the user already paid to process).
   */
  const offerStarter = useCallback(async (): Promise<string | undefined> => {
    const ok = await confirmDialog({
      title: t.recordings.starterTitle,
      description: t.recordings.starterBody,
      confirmLabel: t.recordings.starterAction,
      cancelLabel: t.recordings.starterSkip,
    });
    if (!ok) return undefined;
    try {
      const created = await createCustomPageTemplate(
        workspaceId,
        starterInstallInput(MEETING_NOTES_STARTER, {
          name: t.recordings.starterName,
          description: t.recordings.starterDescription,
        }),
      );
      return created.id;
    } catch {
      return undefined; // Non-fatal: fall through to ingest-only.
    }
  }, [workspaceId, t]);

  const run = useCallback(
    async (file: File, blueprintSlug?: string, offerStarterWhenNone = false) => {
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

        // Offered only AFTER the cost is accepted: the starter is about what
        // shape the output takes, and asking before the user has committed to
        // processing at all is a question about nothing.
        const slug =
          blueprintSlug ?? (offerStarterWhenNone ? await offerStarter() : undefined);

        setStatus("processing");
        const res = await processRecording(recordingId, slug);
        setResult(res);
        setStatus("done");
        // The 202 means QUEUED — the worker transcribes in the background.
        // Claiming "transcribed and filed" here was the 2026-07-10 honesty
        // bug: the message showed before (or instead of) the actual work.
        setMessage(t.recordings.queued);
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
    [workspaceId, assistantId, t, offerStarter],
  );

  return { run, status, message, result };
}
