"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { getOfficeJob, listOfficeJobEvents, steerOfficeJob, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function OfficeJobActivity({ jobId }: { jobId: string }) {
  const t = useT().office;
  const [job, setJob] = useState<OfficeJob | null>(null);
  const [events, setEvents] = useState<OfficeJobEvent[]>([]);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
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
    if (!value) return;
    await steerOfficeJob(jobId, value);
    setInstruction("");
  }

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

  return (
    <aside className="w-full border-t bg-muted/20 p-4 lg:w-80 lg:border-l lg:border-t-0">
      <h2 className="text-sm font-semibold">{t.activity}</h2>
      {job ? <p className="mt-1 text-xs text-muted-foreground">{job.stage}</p> : null}
      <ol className="mt-4 space-y-3">
        {events.map((event) => <li key={event.id} className="border-l-2 pl-3 text-sm"><p>{eventLabel(event.code)}</p><time className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</time></li>)}
      </ol>
      {job && !TERMINAL.has(job.status) ? (
        <form onSubmit={steer} className="mt-6">
          <label className="text-xs font-medium">{t.steer}<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t.steerPlaceholder} className="mt-2 min-h-20 w-full rounded-md border bg-background p-2 text-sm font-normal" /></label>
          <button type="submit" disabled={!instruction.trim()} className="mt-2 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">{t.sendSteering}</button>
        </form>
      ) : null}
    </aside>
  );
}
