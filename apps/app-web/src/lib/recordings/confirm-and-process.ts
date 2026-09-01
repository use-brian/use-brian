"use client";

/**
 * The recording pre-flight, in one place: estimate → cost + blueprint +
 * destination confirmation → process. [COMP:recordings/confirm-and-process]
 *
 * Every surface that spends a transcription runs THIS, so the pre-flight
 * invariant (docs/architecture/engine/preflight-confirmation.md) has exactly
 * one implementation to be right. Two callers today: `useRecordingUpload.run`,
 * which uploads bytes first, and the brain drawer's "Re-ingest to brain" on a
 * stored audio/video file, which has no upload to do because the bytes are
 * already filed. Writing the dialog a second time for the second caller is how
 * a cost quote and a blueprint picker drift apart.
 *
 * It deliberately does not own the upload, the page link, or the inline status
 * copy - those differ per surface. It owns the part that must not differ.
 */

import { createElement } from "react";
import { MEETING_NOTES_STARTER } from "@use-brian/doc-model";
import type { Dictionary } from "@/lib/i18n";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  estimateRecording,
  processRecording,
  type RecordingQueued,
} from "@/lib/api/recordings";
import { listCustomPageTemplates, createCustomPageTemplate, listViews } from "@/lib/api/views";
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

/** Which boundary the caller is on, so its failure copy can name the step. */
type ConfirmProcessStage = "estimate" | "process";

export type ConfirmProcessResult =
  | { outcome: "queued"; result: RecordingQueued }
  | { outcome: "cancelled" };

export type ConfirmProcessInput = {
  workspaceId: string;
  recordingId: string;
  t: Dictionary;
  /** Video processing also samples frames; the confirm says so. */
  isVideo?: boolean;
  /** A live meeting page owns the brief: no picker, file it there. */
  pinnedPage?: boolean;
  /** Live-capture fell back to assembling its persisted windows. */
  assembled?: boolean;
  /**
   * A processing run already COMPLETED. The confirm then has to say that a
   * re-run re-transcribes and can duplicate extracted memories, and only then
   * may `confirm: true` clear the server's guard. Sending that flag without
   * having shown the warning would turn a guard into a formality.
   */
  alreadyProcessed?: boolean;
  onStage?: (stage: ConfirmProcessStage) => void;
};

/**
 * Install the meeting starter and return its new blueprint id, or undefined if
 * the install failed - non-fatal by design: the user already accepted the cost,
 * so a template-write outage must degrade to ingest-only rather than cost them
 * the recording.
 */
async function installStarter(workspaceId: string, t: Dictionary): Promise<string | undefined> {
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
}

export async function confirmAndProcessRecording(
  input: ConfirmProcessInput,
): Promise<ConfirmProcessResult> {
  const { workspaceId, recordingId, t } = input;

  // The roster, the workspace default, and the destination pages ride alongside
  // the estimate so the dialog opens with its picker ready. Any of the three
  // failing degrades to an ingest-only-capable picker; none of them blocks.
  const rosterPromise = listCustomPageTemplates(workspaceId).catch(() => []);
  const defaultPromise = getWorkspaceDefaultBlueprint(workspaceId)
    .then((ws) => ws?.defaultRecordingBlueprintId ?? null)
    .catch(() => null);
  const pagesPromise = listViews({ workspaceId, state: "saved" }).catch(() => []);

  // Server-authoritative duration + surcharge → confirm before any model call.
  input.onStage?.("estimate");
  const est = await estimateRecording(recordingId);
  const [roster, workspaceDefault, pages] = await Promise.all([
    rosterPromise,
    defaultPromise,
    pagesPromise,
  ]);
  const items: SearchableSelectItem[] = [
    { value: RECORDING_INGEST_ONLY, label: t.recordings.blueprintAuto },
    ...buildBlueprintPickerItems(roster),
    // Only when the workspace has authored nothing: alongside a real roster the
    // starter is just one more template competing with the user's own.
    ...(hasNoBlueprints(roster)
      ? [{ value: RECORDING_INSTALL_STARTER, label: t.recordings.starterName }]
      : []),
  ];
  const destinationItems: SearchableSelectItem[] = [
    { value: DESTINATION_ROOT, label: t.recordings.destinationRoot },
    ...pages.map((p) => ({ value: p.id, label: p.name })),
  ];
  // The user's live in-dialog selections. The picker component owns the
  // rendered state; these slots are what this function reads after confirm.
  let chosen = seedRecordingBlueprint(workspaceDefault);
  let destination = DESTINATION_ROOT;
  const minutes = Math.max(1, Math.round(est.durationSeconds / 60));
  const pinnedPage = !!input.pinnedPage;
  const videoNote = input.isVideo ? ` ${t.recordings.confirmVideoNote}` : "";
  const repeatNote = input.alreadyProcessed ? ` ${t.recordings.confirmAlreadyProcessed}` : "";

  const ok = await confirmDialog({
    title: t.recordings.confirmTitle,
    description:
      (pinnedPage
        ? (est.surchargeCredits > 0
            ? t.recorder.liveFinalizeBody
                .replace("{minutes}", String(minutes))
                .replace("{credits}", String(est.surchargeCredits))
            : t.recorder.liveFinalizeFree) +
          (input.assembled ? ` ${t.recorder.liveAssembledNote}` : "")
        : est.surchargeCredits > 0
          ? t.recordings.confirmBody
              .replace("{minutes}", String(minutes))
              .replace("{credits}", String(est.surchargeCredits))
          : t.recordings.confirmFree) +
      videoNote +
      repeatNote,
    confirmLabel: t.recordings.confirmAction,
    // The blueprint + destination half of the pre-flight confirm (this is a .ts
    // file, so the node is built with createElement, not JSX).
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
  if (!ok) return { outcome: "cancelled" };

  // The starter is a sentinel, not an id - install it and submit the id it
  // returns. Installing AFTER confirm ties the template write to demonstrated
  // intent; a failed install falls through to ingest-only.
  const slug = pinnedPage
    ? undefined
    : chosen === RECORDING_INSTALL_STARTER
      ? await installStarter(workspaceId, t)
      : recordingBlueprintToSlug(chosen);
  input.onStage?.("process");
  const result = await processRecording(
    recordingId,
    slug,
    // The root sentinel is a UI value, not a page id - send null so the server
    // files at the workspace root.
    destination === DESTINATION_ROOT ? null : destination,
    // The dialog above carried the duplicate-memory warning; this is what the
    // user agreed to.
    input.alreadyProcessed ? { confirm: true } : undefined,
  );
  return { outcome: "queued", result };
}
