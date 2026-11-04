"use client";

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { recoverRecording, type RecordingRecovery } from "@/lib/api/recordings";
import { confirmAndProcessRecording } from "@/lib/recordings/confirm-and-process";
import { dispatchRecordingParticipantsUpdated } from "@/lib/recordings/recording-events";
import { Button } from "@/components/ui/button";

/** [COMP:app-web/recording-chrome] Preparation never substitutes for cost confirmation. */
export function RecordingProcessAction({ workspaceId, recordingId, mime, retry = false, recovery }: {
  workspaceId: string; recordingId: string; mime: string; retry?: boolean;
  recovery?: RecordingRecovery | null;
}) {
  const t = useT();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [queued, setQueued] = useState(false);
  async function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setMessage(null); setFailed(false);
    try {
      const prepared = recovery ? await recoverRecording(workspaceId, recordingId) : null;
      const target = prepared?.replacementId ?? recordingId;
      const result = await confirmAndProcessRecording({ workspaceId, recordingId: target, t, isVideo: mime.startsWith("video/") });
      if (result.outcome === "queued") { setQueued(true); setMessage(t.recordings.processQueued); }
      // A cancellation still leaves a valid prepared replacement, never a job.
      dispatchRecordingParticipantsUpdated({ recordingId });
      if (target !== recordingId) dispatchRecordingParticipantsUpdated({ recordingId: target });
    } catch {
      setFailed(true); setMessage(t.recordings.processActionFailed);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <div className="flex flex-col items-start gap-2">
    {recovery ? <p className="text-sm text-muted-foreground">{t.recordings.recoveryBody}</p> : null}
    <Button type="button" variant="outline" className="max-sm:min-h-11" disabled={busy || queued} onClick={() => void start()}>
      {busy ? t.recordings.processPreparing : retry || recovery ? t.recordings.processRetry : t.recordings.processTranscribe}
    </Button>
    {message ? <p role={failed ? "alert" : "status"} className="text-sm text-muted-foreground">{message}</p> : null}
  </div>;
}
