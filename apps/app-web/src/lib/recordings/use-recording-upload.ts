"use client";

/**
 * Recording-to-brain intake: `stage` uploads and estimates a chat attachment;
 * `run` also queues transcription. Recorder Stop / recovery Save sets
 * `automatic` to queue without another cost/blueprint/destination popup.
 * Other run callers use the shared confirmation picker. A live meeting page
 * pins ingest-only output; automatic captures otherwise use the workspace
 * default blueprint or ingest-only. Success here means queued, not transcribed.
 * Upload, estimate and queue failures remain localized inline, and the recorder
 * retains its local spool until the queue hand-off succeeds.
 */

import { useState, useCallback, useRef } from "react";
import { useT } from "@/lib/i18n/client";
import {
  startRecordingUpload,
  estimateRecording,
  linkLiveRecordingPage,
  finalizeLiveRecording,
  RecordingApiError,
  recordingMimeForFile,
  type RecordingQueued,
} from "@/lib/api/recordings";
import { setPageLinkedRecording } from "@/lib/api/views";
import { confirmAndProcessRecording } from "@/lib/recordings/confirm-and-process";
import { recordingFailureMessage } from "@/lib/recordings/failure-copy";

export type RecordingUploadStatus =
  | "idle"
  | "uploading"
  | "estimating"
  | "processing"
  | "done"
  | "error";

export type StagedRecording = {
  recordingId: string;
  title: string;
  durationSeconds: number;
  surchargeCredits: number;
};

/**
 * What `run` resolved to. A `null` return used to stand for BOTH "the user
 * closed the cost confirm" and "the upload / estimate / queue call failed",
 * so the dock recorder could only ever say "kept on this device" - true, but
 * it read as a deferral after a failure, and the step-aware reason rendered
 * into the expanded composer, a slot a collapsed meeting capture never shows.
 * The outcome names the branch and carries the same localized `message` the
 * hook sets inline, so the recorder's own notice (which renders in every
 * dock mode) can say what happened.
 */
export type RecordingRunOutcome =
  | { outcome: "queued"; recording: RecordingQueued; message: string }
  | { outcome: "cancelled" }
  | { outcome: "failed"; message: string };

export function useRecordingUpload(workspaceId: string, assistantId: string) {
  const t = useT();
  const [status, setStatus] = useState<RecordingUploadStatus>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<RecordingQueued | null>(null);
  // React state cannot close the same-tick gap between two file-pick/drop
  // callbacks. Keep ownership synchronous so a second operation cannot reset
  // the first operation's progress, status, or result while it is in flight.
  const operationActiveRef = useRef(false);

  /**
   * Store a chat attachment and prove its duration, but do not ask for a
   * blueprint or start transcription. The returned id rides the user's next
   * chat turn so purpose can be clarified before any semantic work begins.
   */
  const stage = useCallback(
    async (
      file: File,
      opts?: { kind?: "memo" | "meeting" },
    ): Promise<StagedRecording | null> => {
      if (operationActiveRef.current) return null;
      operationActiveRef.current = true;
      setResult(null);
      setMessage("");
      setUploadProgress(0);
      let failureStage: "upload" | "estimate" = "upload";
      try {
        setStatus("uploading");
        const { recordingId } = await startRecordingUpload({
          workspaceId,
          assistantId,
          file,
          onProgress: (progress) => {
            setUploadProgress((current) => Math.max(current, progress));
          },
          ...(opts?.kind ? { kind: opts.kind } : {}),
        });
        setUploadProgress(1);
        setStatus("estimating");
        failureStage = "estimate";
        const estimate = await estimateRecording(recordingId);
        const staged = {
          recordingId,
          title: file.name,
          durationSeconds: estimate.durationSeconds,
          surchargeCredits: estimate.surchargeCredits,
        };
        setStatus("done");
        setMessage(t.recordings.staged);
        return staged;
      } catch (e) {
        setStatus("error");
        setMessage(recordingFailureMessage(e, failureStage, t));
        return null;
      } finally {
        operationActiveRef.current = false;
      }
    },
    [workspaceId, assistantId, t],
  );

  const run = useCallback(
    /**
     * @param opts.kind Recording kind for the transcriber-ladder routing.
     *   The dock live recorder passes 'meeting'; omitted → the server's
     *   'memo' column default.
     * @param opts.automatic Recorder Stop / recovery Save authorizes queueing without a popup.
     * @returns `queued` with the recording (`recordingId`) on success,
     *   `cancelled` when the user closed the cost confirm, `failed` with the
     *   step-aware reason otherwise. The dock recorder forks its retention +
     *   notice on this; state-only callers ignore it.
     */
    async (
      file: File,
      opts?: { kind?: "memo" | "meeting"; existingPageId?: string; liveSessionId?: string; liveWindowsDone?: Promise<void>; automatic?: boolean },
    ): Promise<RecordingRunOutcome> => {
      if (operationActiveRef.current) {
        return { outcome: "failed", message: t.recordings.uploadInProgress };
      }
      operationActiveRef.current = true;
      setResult(null);
      setMessage("");
      setUploadProgress(0);
      // Which boundary failed decides the copy: a storage-upload failure and a
      // queue failure call for different user action, and the old single
      // generic message ("We could not process that recording") hid which of
      // four steps actually broke.
      let stage: "upload" | "estimate" | "process" = "upload";
      // Set when the lossless upload failed but the live session's
      // server-persisted windows were assembled instead.
      let assembled = false;
      try {
        setStatus("uploading");
        let recordingId: string;
        try {
          ({ recordingId } = await startRecordingUpload({
            workspaceId,
            assistantId,
            file,
            onProgress: (progress) => {
              setUploadProgress((current) => Math.max(current, progress));
            },
            ...(opts?.kind ? { kind: opts.kind } : {}),
          }));
          // A live meeting page is linked the moment the recording id exists —
          // not after processing succeeds — so a later failure leaves the page
          // carrying its recording (and its honest status) instead of nothing.
          if (opts?.existingPageId) {
            await linkLiveRecordingPage(opts.existingPageId, recordingId).catch(() => {});
          }
        } catch (uploadError) {
          // The lossless upload could not complete. A live session's ~30s
          // windows already reached the server for transcription, so assemble
          // those into a usable (re-encoded, small-seam) recording rather
          // than losing the meeting — the spool still keeps the lossless copy
          // for a later retry.
          if (!opts?.liveSessionId) throw uploadError;
          // Only assembly depends on provisional uploads. Never hold the full
          // recording upload behind slow live transcription or rolling notes.
          await opts.liveWindowsDone;
          const fallback = await finalizeLiveRecording({
            workspaceId,
            assistantId,
            sessionId: opts.liveSessionId,
            ...(opts.existingPageId ? { pageId: opts.existingPageId } : {}),
          }).catch((error: unknown) => {
            if (error instanceof RecordingApiError && error.code === "recording_media_tools_unavailable") throw error;
            return null;
          });
          if (!fallback) throw uploadError;
          recordingId = fallback.recordingId;
          assembled = true;
        }
        setUploadProgress(1);
        setStatus("estimating");

        // The pre-flight itself lives in `confirm-and-process.ts` so this hook
        // and the brain drawer's stored-media button cannot drift apart on what
        // a transcription costs or which blueprint it uses.
        const confirmed = await confirmAndProcessRecording({
          workspaceId,
          recordingId,
          t,
          automatic: opts?.automatic,
          isVideo: recordingMimeForFile(file)?.startsWith("video/") ?? false,
          ...(opts?.existingPageId ? { pinnedPage: true } : {}),
          ...(assembled ? { assembled: true } : {}),
          onStage: (s) => {
            stage = s;
            // The enqueue is the moment the wording stops being about the
            // upload, so the inline status turns over with it rather than
            // after the request settles.
            if (s === "process") setStatus("processing");
          },
        });
        if (confirmed.outcome === "cancelled") {
          setStatus("idle");
          return { outcome: "cancelled" };
        }
        const res = confirmed.result;
        let liveLinkFailed = false;
        if (opts?.existingPageId) {
          try {
            await setPageLinkedRecording(opts.existingPageId, res.recordingId);
          } catch {
            // The 202 queue hand-off already succeeded, so never report the
            // whole capture as failed (and retain/re-upload its spool) merely
            // because the lightweight page link missed. The recording board
            // remains its recovery surface and the user can link it manually.
            liveLinkFailed = true;
          }
        }
        setResult(res);
        setStatus("done");
        // The 202 means QUEUED — the worker transcribes in the background.
        // Claiming "transcribed and filed" here was the 2026-07-10 honesty
        // bug: the message showed before (or instead of) the actual work.
        const message = liveLinkFailed ? t.recorder.liveLinkFailed : t.recordings.queued;
        setMessage(message);
        return { outcome: "queued", recording: res, message };
      } catch (e) {
        setStatus("error");
        const message = recordingFailureMessage(e, stage, t);
        setMessage(message);
        return { outcome: "failed", message };
      } finally {
        operationActiveRef.current = false;
      }
    },
    [workspaceId, assistantId, t],
  );

  /**
   * Clear the inline status. A caller that reports the outcome on a surface
   * of its own (the dock recorder's notice, which renders collapsed and
   * expanded alike) calls this after `run` so the composer's inline line does
   * not say the same thing a second time.
   */
  const dismiss = useCallback(() => {
    if (operationActiveRef.current) return;
    setStatus("idle");
    setUploadProgress(0);
    setMessage("");
    setResult(null);
  }, []);

  const busy = status === "uploading" || status === "estimating" || status === "processing";
  return { stage, run, dismiss, status, busy, uploadProgress, message, result };
}
