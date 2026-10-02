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
 * GET restores both running and completed jobs after navigation/reopen. */
export function LiveInteractionJobs({ workspaceId, sessionId, messageIds, onCanonical }: {
  workspaceId: string; sessionId: string | null; messageIds: Set<string>;
  onCanonical: (sessionId: string, rows: DocSessionMessage[], ids: Set<string>) => void;
}) {
  const t = useT().liveInteraction;
  const [state, setState] = useState<{ sessionId: string; jobs: InteractionJob[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const callback = useRef(onCanonical); callback.current = onCanonical;
  const knownIds = useRef(messageIds); knownIds.current = messageIds;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let unavailable = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { jobs, captureErrors } = await interactionRequest<{ jobs: InteractionJob[]; captureErrors?: Array<{captureId: string; error: string}> }>(`/jobs?${new URLSearchParams({ workspaceId, chatSessionId: sessionId })}`);
        if (cancelled) return;
        const scoped = jobs.filter((job) => job.chatSessionId === sessionId);
        setState({ sessionId, jobs: scoped }); setFailed(Boolean(captureErrors?.length));
        const ids = new Set(scoped.filter((job) => job.status === "completed" && (!job.userMessageId || !job.assistantMessageId || !knownIds.current.has(job.userMessageId) || !knownIds.current.has(job.assistantMessageId))).flatMap((job) => [job.userMessageId, job.assistantMessageId].filter((id): id is string => !!id)));
        if (ids.size) {
          const rows = await fetchSessionMessages(sessionId);
          if (!cancelled) {
            // Publish a pair together; a delayed canonical write must not
            // display half a pair alongside its provisional job bubble.
            const present = new Set(rows.map((row) => row.id));
            const ready = new Set(scoped.filter((job) => job.status === "completed" && job.userMessageId && job.assistantMessageId && present.has(job.userMessageId) && present.has(job.assistantMessageId)).flatMap((job) => [job.userMessageId!, job.assistantMessageId!]));
            callback.current(sessionId, rows, ready);
          }
        }
      } catch (error) {
        unavailable = error instanceof InteractionRequestError && error.status === 404;
        if (!cancelled) setFailed(!unavailable);
      }
      finally { if (!cancelled && !unavailable) timer = setTimeout(poll, 1500); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspaceId, sessionId]);
  const act = async (job: InteractionJob, action: "cancel" | "retry") => {
    try { await interactionRequest(`/jobs/${job.id}/${action}`, {}); }
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
      setFailed(false);
    } catch { setFailed(true); }
    finally { setEditing(false); }
  };
  return <div className="space-y-3">
    {failed && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
    {state?.sessionId === sessionId && state.jobs.filter((job) => !(job.status === "completed" && job.userMessageId && job.assistantMessageId && messageIds.has(job.userMessageId) && messageIds.has(job.assistantMessageId))).map((job) => <article key={job.id} className="rounded-xl border p-3 space-y-2" aria-label={t.title}>
      <a className="text-xs underline" href={docPagePath(workspaceId, job.pageId)}>{t.recording}</a>
      {(!job.userMessageId || !messageIds.has(job.userMessageId)) && <p className="text-sm font-medium whitespace-pre-wrap">{job.question}</p>}
      <p role="status" className="text-xs text-muted-foreground">{t[job.status]}</p>
      {(!job.assistantMessageId || !messageIds.has(job.assistantMessageId)) && <p className="text-sm whitespace-pre-wrap break-words">{job.answer}</p>}
      {job.error && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
      {(job.status === "queued" || job.status === "running") && <Button className="min-h-11" variant="outline" onClick={() => void act(job, "cancel")}>{t.cancel}</Button>}
      {(job.status === "failed" || job.status === "cancelled") && <Button className="min-h-11" variant="outline" onClick={() => void act(job, "retry")}>{t.retry}</Button>}
      <Button className="min-h-11" variant="outline" disabled={editing} onClick={() => void edit(job)}>{t.editQuestion}</Button>
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
    <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => void act("submit")}>{t.askNow}</Button>
    <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => void act("cancel")}>{t.cancelPending}</Button>
    {failed && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
  </div>;
}
