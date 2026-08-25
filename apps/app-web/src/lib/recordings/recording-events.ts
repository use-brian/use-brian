/**
 * Same-tab invalidation for participant metadata changed by a chat tool.
 * Payload is intentionally only identity: every recording surface re-fetches
 * the canonical summary instead of trusting model/tool output as UI state.
 *
 * [COMP:app-web/recording-chrome]
 */

export const RECORDING_PARTICIPANTS_UPDATED_EVENT =
  "sidan:recording-participants-updated";

export type RecordingParticipantsUpdatedDetail = {
  recordingId: string;
  pageId?: string;
};

export function dispatchRecordingParticipantsUpdated(
  detail: RecordingParticipantsUpdatedDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RecordingParticipantsUpdatedDetail>(
      RECORDING_PARTICIPANTS_UPDATED_EVENT,
      { detail },
    ),
  );
}
