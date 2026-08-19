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

import { createElement, useState, useCallback } from "react";
import { MEETING_NOTES_STARTER } from "@use-brian/doc-model";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  startRecordingUpload,
  estimateRecording,
  processRecording,
  linkLiveRecordingPage,
  finalizeLiveRecording,
  RecordingApiError,
  type RecordingQueued,
} from "@/lib/api/recordings";
import { listCustomPageTemplates, createCustomPageTemplate, listViews, setPageLinkedRecording } from "@/lib/api/views";
import { getWorkspaceDefaultBlueprint } from "@/lib/api/workspaces";
import {
  buildBlueprintPickerItems,
  hasNoBlueprints,
  recordingBlueprintToSlug,
  seedRecordingBlueprint,
  starterInstallInput,
  RECORDING_INGEST_ONLY,
  RECORDING_INSTALL_STARTER,
} from "@/lib/blueprints";
import {
  RecordingConfirmPicker,
  DESTINATION_ROOT,
} from "@/components/recordings/recording-confirm-picker";
import type { SearchableSelectItem } from "@/components/ui/searchable-select";

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

  /**
   * Install the meeting starter and return its new blueprint id, or undefined
   * if the install failed — non-fatal by design: the user already accepted the
   * cost, so a template-write outage must degrade to ingest-only rather than
   * cost them the recording.
   */
  const installStarter = useCallback(async (): Promise<string | undefined> => {
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
      return undefined;
    }
  }, [workspaceId, t]);

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
        // Blueprint roster + workspace default ride the upload in parallel so
        // the confirm dialog opens with the picker ready. Either fetch failing
        // degrades to an ingest-only-capable picker — never blocks the upload.
        const rosterPromise = listCustomPageTemplates(workspaceId).catch(() => []);
        const defaultPromise = getWorkspaceDefaultBlueprint(workspaceId)
          .then((ws) => ws?.defaultRecordingBlueprintId ?? null)
          .catch(() => null);
        // Candidate destinations for the brief page. Saved pages only — a
        // draft parent would drag the brief into the prune sweep with it. A
        // failed fetch degrades to root-only, never blocks the upload.
        const pagesPromise = listViews({ workspaceId, state: "saved" }).catch(() => []);
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

        // Server-authoritative duration + surcharge → confirm before any model call.
        stage = "estimate";
        const est = await estimateRecording(recordingId);
        const [roster, workspaceDefault, pages] = await Promise.all([
          rosterPromise,
          defaultPromise,
          pagesPromise,
        ]);
        const rosterItems = buildBlueprintPickerItems(roster);
        const items: SearchableSelectItem[] = [
          { value: RECORDING_INGEST_ONLY, label: t.recordings.blueprintAuto },
          ...rosterItems,
          // Only when the workspace has authored nothing: alongside a real
          // roster the starter is just one more template competing with the
          // user's own, and the gap it exists to close is not there.
          ...(hasNoBlueprints(roster)
            ? [{ value: RECORDING_INSTALL_STARTER, label: t.recordings.starterName }]
            : []),
        ];
        const destinationItems: SearchableSelectItem[] = [
          { value: DESTINATION_ROOT, label: t.recordings.destinationRoot },
          ...pages.map((p) => ({ value: p.id, label: p.name })),
        ];
        // The user's live in-dialog selections. The picker component owns the
        // rendered state; these slots are what the hook reads after confirm.
        let chosen = seedRecordingBlueprint(workspaceDefault);
        let destination = DESTINATION_ROOT;
        const minutes = Math.max(1, Math.round(est.durationSeconds / 60));
        const pinnedPage = !!opts?.existingPageId;
        const ok = await confirmDialog({
          title: t.recordings.confirmTitle,
          description:
            pinnedPage
              ? ((est.surchargeCredits > 0
                  ? t.recorder.liveFinalizeBody
                      .replace("{minutes}", String(minutes))
                      .replace("{credits}", String(est.surchargeCredits))
                  : t.recorder.liveFinalizeFree) +
                  (assembled ? ` ${t.recorder.liveAssembledNote}` : ""))
              : est.surchargeCredits > 0
              ? t.recordings.confirmBody
                  .replace("{minutes}", String(minutes))
                  .replace("{credits}", String(est.surchargeCredits))
              : t.recordings.confirmFree,
          confirmLabel: t.recordings.confirmAction,
          // The blueprint + destination half of the pre-flight confirm (the
          // hook is a .ts file, so the node is built with createElement, not
          // JSX).
          content: pinnedPage
            ? undefined
            : createElement(RecordingConfirmPicker, {
                items,
                initial: chosen,
                onChange: (v: string) => {
                  chosen = v;
                },
                destinationItems,
                initialDestination: destination,
                onDestinationChange: (v: string) => {
                  destination = v;
                },
              }),
        });
        if (!ok) {
          setStatus("idle");
          return { outcome: "cancelled" };
        }

        setStatus("processing");
        // The starter is a sentinel, not an id — install it and submit the id
        // it returns. Installing AFTER confirm ties the template write to
        // demonstrated intent; a failed install falls through to ingest-only.
        const slug = pinnedPage
          ? undefined
          : chosen === RECORDING_INSTALL_STARTER
            ? await installStarter()
            : recordingBlueprintToSlug(chosen);
        // The root sentinel is a UI value, not a page id — send null so the
        // server files at the workspace root.
        stage = "process";
        const res = await processRecording(
          recordingId,
          slug,
          destination === DESTINATION_ROOT ? null : destination,
        );
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
    [workspaceId, assistantId, t, installStarter],
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
