"use client";

/**
 * Recording upload flow hook (recording-to-brain). Drives: pick file → upload
 * (direct-to-GCS) → server estimate → confirm-dialog preview → process
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
 * When the roster is EMPTY the picker also offers the meeting starter
 * (`RECORDING_INSTALL_STARTER`): otherwise a workspace that has authored no
 * blueprint can only pick ingest-only, and the recording lands with no brief
 * page — no citations, no player. The starter installs on confirm, at the one
 * moment the user has demonstrated intent, so no workspace accumulates an
 * unowned default nobody edits. See structural-synthesis.md → "Starter
 * blueprints".
 */

import { createElement, useState, useCallback } from "react";
import { MEETING_NOTES_STARTER } from "@sidanclaw/doc-model";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  startRecordingUpload,
  estimateRecording,
  processRecording,
  RecordingApiError,
  type RecordingQueued,
} from "@/lib/api/recordings";
import { listCustomPageTemplates, createCustomPageTemplate } from "@/lib/api/views";
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
import { BlueprintConfirmPicker } from "@/components/recordings/blueprint-confirm-picker";
import type { SearchableSelectItem } from "@/components/ui/searchable-select";

export type RecordingUploadStatus = "idle" | "uploading" | "processing" | "done" | "error";

export function useRecordingUpload(workspaceId: string, assistantId: string) {
  const t = useT();
  const [status, setStatus] = useState<RecordingUploadStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<RecordingQueued | null>(null);

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
     * @param blueprintSelection The calling surface's RAW picker selection
     *   (a blueprint id, `RECORDING_INGEST_ONLY`, or `RECORDING_UNSET`) —
     *   NOT the submitted slug. It seeds the dialog picker; the user's final
     *   in-dialog choice is what submits. Omit when the surface has no picker
     *   (chat dock, landing) — the seed falls to the workspace default.
     */
    async (file: File, blueprintSelection?: string) => {
      setResult(null);
      setMessage("");
      try {
        setStatus("uploading");
        // Blueprint roster + workspace default ride the upload in parallel so
        // the confirm dialog opens with the picker ready. Either fetch failing
        // degrades to an ingest-only-capable picker — never blocks the upload.
        const rosterPromise = listCustomPageTemplates(workspaceId).catch(() => []);
        const defaultPromise = getWorkspaceDefaultBlueprint(workspaceId)
          .then((ws) => ws?.defaultRecordingBlueprintId ?? null)
          .catch(() => null);
        const { recordingId } = await startRecordingUpload({ workspaceId, assistantId, file });

        // Server-authoritative duration + surcharge → confirm before any model call.
        const est = await estimateRecording(recordingId);
        const [roster, workspaceDefault] = await Promise.all([rosterPromise, defaultPromise]);
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
        // The user's live in-dialog selection. The picker component owns the
        // rendered state; this slot is what the hook reads after confirm.
        let chosen = seedRecordingBlueprint(blueprintSelection, workspaceDefault);
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
          // The blueprint half of the pre-flight confirm (the hook is a .ts
          // file, so the node is built with createElement, not JSX).
          content: createElement(BlueprintConfirmPicker, {
            items,
            initial: chosen,
            onChange: (v: string) => {
              chosen = v;
            },
          }),
        });
        if (!ok) {
          setStatus("idle");
          return;
        }

        setStatus("processing");
        // The starter is a sentinel, not an id — install it and submit the id
        // it returns. Installing AFTER confirm ties the template write to
        // demonstrated intent; a failed install falls through to ingest-only.
        const slug =
          chosen === RECORDING_INSTALL_STARTER
            ? await installStarter()
            : recordingBlueprintToSlug(chosen);
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
    [workspaceId, assistantId, t, installStarter],
  );

  return { run, status, message, result };
}
