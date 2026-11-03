"use client";
import { useEffect, useRef, useState } from "react";
import { InteractionRequestError, interactionRequest, type InteractionJob } from "@/lib/live-interaction/api";
import { fetchSessionMessages, type DocSessionMessage } from "@/lib/api/sessions";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { controlInteractionQuestion } from "@/lib/live-interaction/capture";
import { docPagePath } from "@/lib/doc-page-url";

/** Independent jobs never share the ordinary typed-turn streaming buffer.
 * Active captures start discovery; only their unfinished work keeps it alive after Stop. */
export function LiveInteractionJobs({ workspaceId, sessionId, recordingSessionId, recordingCaptureId, messageIds, onCanonical }: {
  workspaceId: string; sessionId: string | null; recordingSessionId: string | null | undefined; recordingCaptureId: string | null | undefined; messageIds: Set<string>;
  onCanonical: (sessionId: string, rows: DocSessionMessage[], ids: Set<string>) => void;
}) {
  const t = useT().liveInteraction;
  const [state, setState] = useState<{ sessionId: string; jobs: InteractionJob[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const tracked = useRef(new Map<string, Set<string>>());
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const scope = `${workspaceId}:${sessionId}`;
  const track = (captureId: string) => {
    const ids = tracked.current.get(scope) ?? new Set<string>();
    ids.add(captureId);
    // Keep the internal request bounded even across a long-lived chat tab.
    if (ids.size > 100) ids.delete(ids.values().next().value!);
    tracked.current.set(scope, ids);
  };
  const callback = useRef(onCanonical); callback.current = onCanonical;
  const knownIds = useRef(messageIds); knownIds.current = messageIds;
  useEffect(() => {
    setFailed(false);
    const recordingHere = !!sessionId && recordingSessionId === sessionId && !!recordingCaptureId;
    if (recordingHere) track(recordingCaptureId!);
    const captureIds = tracked.current.get(scope);
    if (!sessionId || !captureIds?.size) return;
    let cancelled = false;
    let keepPolling = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { jobs, processing } = await interactionRequest<{ jobs: InteractionJob[]; processing?: boolean }>(`/jobs?${new URLSearchParams({ workspaceId, chatSessionId: sessionId, captureIds: [...captureIds].join(",") })}`);
        if (cancelled) return;
        const scoped = jobs.filter((job) => job.chatSessionId === sessionId && captureIds.has(job.captureId));
        setState({ sessionId, jobs: scoped });
        const ids = new Set(scoped.filter((job) => job.status === "completed" && (!job.userMessageId || !job.assistantMessageId || !knownIds.current.has(job.userMessageId) || !knownIds.current.has(job.assistantMessageId))).flatMap((job) => [job.userMessageId, job.assistantMessageId].filter((id): id is string => !!id)));
        const handedOff = new Set(knownIds.current);
        if (ids.size) {
          const rows = await fetchSessionMessages(sessionId);
          if (!cancelled) {
            // Publish a pair together; a delayed canonical write must not
            // display half a pair alongside its provisional job bubble.
            const present = new Set(rows.map((row) => row.id));
            const ready = new Set(scoped.filter((job) => job.status === "completed" && job.userMessageId && job.assistantMessageId && present.has(job.userMessageId) && present.has(job.assistantMessageId)).flatMap((job) => [job.userMessageId!, job.assistantMessageId!]));
            callback.current(sessionId, rows, ready);
            for (const id of ready) handedOff.add(id);
          }
        }
        const pending = scoped.some(job => job.status === "queued" || job.status === "running" ||
          (job.status === "completed" && (!job.userMessageId || !job.assistantMessageId || !handedOff.has(job.userMessageId) || !handedOff.has(job.assistantMessageId))));
        keepPolling = recordingHere || processing === true || pending;
        if (!cancelled && !keepPolling) tracked.current.delete(scope);
      } catch (error) {
        const denied = error instanceof InteractionRequestError && [400, 401, 403, 404].includes(error.status);
        keepPolling = !denied;
        if (!cancelled && denied) {
          tracked.current.delete(scope);
          setState(null);
        }
        // A failed background read is not a failed question or lost speech.
      }
      finally { if (!cancelled && keepPolling) timer = setTimeout(poll, 1500); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspaceId, sessionId, recordingSessionId, recordingCaptureId, refreshEpoch]);
  const refreshJob = (job: InteractionJob) => {
    track(job.captureId);
    setRefreshEpoch(epoch => epoch + 1);
  };
  const act = async (job: InteractionJob, action: "cancel" | "retry") => {
    try { await interactionRequest(`/jobs/${job.id}/${action}`, {}); setFailed(false); refreshJob(job); }
    catch { setFailed(true); }
  };
  const edit = async (job: InteractionJob) => {
    setEditing(true);
    try {
      const text = await promptDialog({ title: t.editQuestion, defaultValue: job.question, multiline: true, confirmLabel: t.askNow });
      if (!text?.trim()) return;
      if (["queued", "running", "failed"].includes(job.status))
        await interactionRequest(`/jobs/${job.id}/cancel`, {});
      await controlInteractionQuestion(job.captureId, "submit", text.trim());
      setFailed(false); refreshJob(job);
    } catch { setFailed(true); }
    finally { setEditing(false); }
  };
  const visibleJobs = state?.sessionId === sessionId ? state.jobs.filter((job) => !(job.status === "completed" && job.userMessageId && job.assistantMessageId && messageIds.has(job.userMessageId) && messageIds.has(job.assistantMessageId))) : [];
  if (!sessionId || (!failed && visibleJobs.length === 0)) return null;
  return <div className="space-y-3">
    {failed && <p role="alert" className="text-sm text-destructive">{t.actionError}</p>}
    {visibleJobs.map((job) => <article key={job.id} className="rounded-xl border p-3 space-y-2" aria-label={t.title}>
      <a className="text-xs underline" href={docPagePath(workspaceId, job.pageId)}>{t.recording}</a>
      {(!job.userMessageId || !messageIds.has(job.userMessageId)) && <p className="text-sm font-medium whitespace-pre-wrap">{job.question}</p>}
      <p role="status" className="text-xs text-muted-foreground">{t[job.status]}</p>
      {(!job.assistantMessageId || !messageIds.has(job.assistantMessageId)) && <p className="text-sm whitespace-pre-wrap break-words">{job.answer}</p>}
      {job.error && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
      {(job.status === "queued" || job.status === "running") && <Button className="max-sm:min-h-11" variant="outline" onClick={() => void act(job, "cancel")}>{t.cancel}</Button>}
      {(job.status === "failed" || job.status === "cancelled") && <Button className="max-sm:min-h-11" variant="outline" onClick={() => void act(job, "retry")}>{t.retry}</Button>}
      <Button className="max-sm:min-h-11" variant="outline" disabled={editing} onClick={() => void edit(job)}>{t.editQuestion}</Button>
    </article>)}
  </div>;
}

/** Available while listening, even when the semantic detector has no pending match. */
export function LiveInteractionQuestionControls({ captureId }: { captureId: string }) {
  const t = useT().liveInteraction;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const act = async (action: "submit" | "cancel") => {
    setBusy(true);
    try {
      const text = action === "submit" ? await promptDialog({ title: t.askNow, multiline: true, confirmLabel: t.askNow }) : undefined;
      if (action === "submit" && !text?.trim()) return;
      await controlInteractionQuestion(captureId, action, text?.trim());
      setFailed(false);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-wrap gap-2">
    <Button className="max-sm:min-h-11" variant="outline" disabled={busy} onClick={() => void act("submit")}>{t.askNow}</Button>
    <Button className="max-sm:min-h-11" variant="outline" disabled={busy} onClick={() => void act("cancel")}>{t.cancelPending}</Button>
    {failed && <p role="alert" className="text-sm text-destructive">{t.actionError}</p>}
  </div>;
}
