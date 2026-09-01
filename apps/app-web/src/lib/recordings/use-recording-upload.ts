"use client";

/**
 * Recording upload flow hook (recording-to-brain). It exposes two boundaries:
 * `stage` drives pick file → direct-to-GCS upload → server estimate and stops;
 * `run` continues through confirm-dialog preview → process
 * (ENQUEUE: the worker service transcribes + segments + ingests + charges in
 * the background, so terminal success here means "queued", never
 * "transcribed"). Returns inline status + message (app-web has no global
 * toast; feedback renders inline). All strings come from `useT()`.
 *
 * The confirm dialog carries BOTH halves of the pre-flight-confirm invariant
 * (docs/architecture/engine/preflight-confirmation.md): the cost quote AND the
 * blueprint picker. Every surface that routes a recording here (the Studio
 * upload button, the chat dock, the new-page landing) gets the same dialog —
 * a surface that made an explicit pick seeds the picker with it; one that
 * didn't seeds from the workspace default (else UNSET, prompting a choice).
 * The blueprint roster + workspace default are fetched in parallel with the
 * upload so the dialog never waits on them.
 *
 * The dialog also carries the brief's DESTINATION (migration 353) — which page
 * it is filed under. Saved pages are fetched alongside the roster; the row only
 * renders once a blueprint is picked, since ingest-only authors no page. The
 * choice rides `recording_jobs.parent_page_id` to the worker and lands as the
 * brief page's `nest_parent_id`; the root sentinel submits null. Before this,
 * every brief was created at the workspace root with no way to say otherwise.
 *
 * When the roster is EMPTY the picker also offers the meeting starter
 * (`RECORDING_INSTALL_STARTER`): otherwise a workspace that has authored no
 * blueprint can only pick ingest-only, and the recording lands with no brief
 * page — no citations, no player. The starter installs on confirm, at the one
 * moment the user has demonstrated intent, so no workspace accumulates an
 * unowned default nobody edits. See structural-synthesis.md → "Starter
 * blueprints".
 */

import { useState, useCallback } from "react";
import { useT } from "@/lib/i18n/client";
import {
  startRecordingUpload,
  estimateRecording,
  linkLiveRecordingPage,
  finalizeLiveRecording,
  RecordingApiError,
  type RecordingQueued,
} from "@/lib/api/recordings";
import { setPageLinkedRecording } from "@/lib/api/views";
import { confirmAndProcessRecording } from "@/lib/recordings/confirm-and-process";

export type RecordingUploadStatus = "idle" | "uploading" | "processing" | "done" | "error";

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
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<RecordingQueued | null>(null);

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
      setResult(null);
      setMessage("");
      try {
        setStatus("uploading");
        const { recordingId } = await startRecordingUpload({
          workspaceId,
          assistantId,
          file,
          ...(opts?.kind ? { kind: opts.kind } : {}),
        });
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
        const code = e instanceof RecordingApiError ? e.code : undefined;
        setMessage(
          code === "too_long"
            ? t.recordings.tooLong
            : code === "could_not_read_duration"
              ? t.recordings.cannotReadDuration
              : t.recordings.failed,
        );
        return null;
      }
    },
    [workspaceId, assistantId, t],
  );

  const run = useCallback(
    /**
     * @param opts.kind Recording kind for the transcriber-ladder routing.
     *   The dock live recorder passes 'meeting'; omitted → the server's
     *   'memo' column default.
     * @returns `queued` with the recording (`recordingId`) on success,
     *   `cancelled` when the user closed the cost confirm, `failed` with the
     *   step-aware reason otherwise. The dock recorder forks its retention +
     *   notice on this; state-only callers ignore it.
     */
    async (
      file: File,
      opts?: { kind?: "memo" | "meeting"; existingPageId?: string; liveSessionId?: string },
    ): Promise<RecordingRunOutcome> => {
      setResult(null);
      setMessage("");
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
          const fallback = await finalizeLiveRecording({
            workspaceId,
            assistantId,
            sessionId: opts.liveSessionId,
            ...(opts.existingPageId ? { pageId: opts.existingPageId } : {}),
          }).catch(() => null);
          if (!fallback) throw uploadError;
          recordingId = fallback.recordingId;
          assembled = true;
        }

        // The pre-flight itself lives in `confirm-and-process.ts` so this hook
        // and the brain drawer's stored-media button cannot drift apart on what
        // a transcription costs or which blueprint it uses.
        const confirmed = await confirmAndProcessRecording({
          workspaceId,
          recordingId,
          t,
          isVideo: file.type.startsWith("video/"),
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
        const code = e instanceof RecordingApiError ? e.code : undefined;
        const detail =
          e instanceof RecordingApiError && e.message && e.status !== 0 ? e.message : null;
        const message =
          code === "too_long"
            ? t.recordings.tooLong
            : code === "could_not_read_duration"
              ? t.recordings.cannotReadDuration
              : stage === "upload"
                ? t.recordings.uploadFailed
                : stage === "estimate"
                  ? t.recordings.estimateFailed
                  : detail
                    ? `${t.recordings.processFailed} (${detail})`
                    : t.recordings.processFailed;
        setMessage(message);
        return { outcome: "failed", message };
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
    setStatus("idle");
    setMessage("");
    setResult(null);
  }, []);

  return { stage, run, dismiss, status, message, result };
}
