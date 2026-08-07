"use client";

/** Compact Brian-first iteration rail. [COMP:app-web/office-iteration-panel] */

import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { getOfficeJob, listOfficeJobEvents, officeJobFailureKind, steerOfficeJob, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function OfficeJobActivity({ jobId, onOpenComments }: { jobId?: string; onOpenComments(): void }) {
  const [job, setJob] = useState<OfficeJob | null>(null);
  const [events, setEvents] = useState<OfficeJobEvent[]>([]);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const nextJob = await getOfficeJob(jobId);
        const nextEvents = await listOfficeJobEvents(jobId, 0);
        if (!live) return;
        setJob(nextJob);
        setEvents(nextEvents);
        if (!TERMINAL.has(nextJob.status)) timer = setTimeout(poll, 1500);
      } catch {
        if (live) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [jobId]);

  async function steer(event: React.FormEvent) {
    event.preventDefault();
    const value = instruction.trim();
    if (!jobId || !value) return;
    await steerOfficeJob(jobId, value);
    setInstruction("");
  }

  return <OfficeJobActivityView job={job} events={events} loading={Boolean(jobId && !job)} instruction={instruction} onInstructionChange={setInstruction} onSubmit={steer} onOpenComments={onOpenComments} />;
}

export function OfficeJobActivityView({ job, events, loading = false, instruction, onInstructionChange, onSubmit, onOpenComments }: { job: OfficeJob | null; events: OfficeJobEvent[]; loading?: boolean; instruction: string; onInstructionChange(value: string): void; onSubmit(event: React.FormEvent): void; onOpenComments(): void }) {
  const t = useT().office;
  const active = Boolean(job && !TERMINAL.has(job.status));
  const ready = job?.status === "completed" || job === null;
  const failed = job?.status === "failed";
  const failureKind = officeJobFailureKind(job?.errorCode);
  const failureTitle = failureKind === "presentation_fit" ? t.presentationFitFailed : failureKind === "fit" ? t.fitFailed : t.failed;
  const failureBody = failureKind === "presentation_fit" ? t.presentationFitFailedBody : failureKind === "fit" ? t.fitFailedBody : t.generationFailedBody;

  const eventLabel = (code: string): string => ({
    "office.job.queued": t.eventQueued,
    "office.job.authority_resolved": t.eventAuthority,
    "office.job.template_selected": t.eventTemplate,
    "office.job.grounding_started": t.eventGrounding,
    "office.job.website_inspected": t.eventWebsite,
    "office.job.claim_plan_ready": t.eventClaims,
    "office.job.objects_constructed": t.eventObjects,
    "office.job.media_processed": t.eventMedia,
    "office.job.fit_validated": t.eventFit,
    "office.job.candidate_validated": t.eventValidated,
    "office.job.export_reopened": t.eventExport,
    "office.job.completed": t.eventCompleted,
    "office.job.needs_input": t.eventNeedsInput,
    "office.job.failed": t.eventFailed,
    "office.job.cancelled": t.eventCancelled,
    "office.job.steering_applied": t.eventSteering,
  })[code] ?? t.running;

  const statusLabel = job?.status === "completed" ? t.completed : failed ? failureTitle : job?.status === "cancelled" ? t.cancelled : job?.status === "queued" ? t.queued : t.running;

  return <section className="flex min-h-0 flex-col" aria-label={t.iterateWithBrian}>
    <div className="p-3">
      <div className="flex items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Sparkles className="size-4" aria-hidden /></span>
        <div><h2 className="text-sm font-semibold">{t.iterateWithBrian}</h2><p role={failed ? "alert" : undefined} className={failed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{failed ? failureBody : active || loading ? t.iterationActiveHint : t.revisionReadyHint}</p></div>
      </div>
      {active ? <form onSubmit={onSubmit} className="mt-3">
        <label className="sr-only" htmlFor="office-brian-instruction">{t.iterateWithBrian}</label>
        <textarea id="office-brian-instruction" value={instruction} onChange={(event) => onInstructionChange(event.target.value)} placeholder={t.iterationPlaceholder} className="min-h-24 w-full resize-y rounded-lg border bg-background p-2.5 text-sm" />
        <button type="submit" disabled={!instruction.trim()} className="mt-2 h-8 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50">{t.askBrian}</button>
      </form> : ready ? <button type="button" onClick={onOpenComments} className="mt-3 h-8 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted">{t.openComments}</button> : null}
    </div>
    {job ? <details className="border-t px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium">
        <span>{t.runActivity}</span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">{job.status === "completed" ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <CircleDashed className="size-3.5" />}{statusLabel}</span>
      </summary>
      <ol className="mt-3 space-y-3 pb-1">
        {events.map((event) => <li key={event.id} className="border-l-2 pl-3 text-xs"><p>{eventLabel(event.code)}</p><time className="text-[11px] text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</time></li>)}
      </ol>
    </details> : null}
  </section>;
}
