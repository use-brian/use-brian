"use client";

/** Compact Brian-first iteration rail. [COMP:app-web/office-iteration-panel] */

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, Sparkles } from "lucide-react";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { useT } from "@/lib/i18n/client";
import { getOfficeJob, listOfficeJobEvents, officeJobFailureKind, steerOfficeJob, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export type OfficeBrianScope =
  | { kind: "none" }
  | { kind: "slide"; slide: number }
  | { kind: "slides"; count: number }
  | { kind: "object"; slide: number }
  | { kind: "objects"; slide: number; count: number }
  | { kind: "objects_across_slides"; count: number; slides: number }
  | { kind: "targets"; count: number };

export type OfficeBrianRevisionRequest = { jobId: string; mode: "direct" | "proposal" } | "version_conflict" | null;

type RequestFeedback = "idle" | "queued" | "proposal" | "applied" | "failed" | "conflict";

export function officeBrianScope(snapshot: OfficeArtifactSnapshot | undefined, targetIds: string[]): OfficeBrianScope {
  if (!snapshot || targetIds.length === 0) return { kind: "none" };
  if (snapshot.family !== "presentation") return { kind: "targets", count: targetIds.length };
  const targetSet = new Set(targetIds);
  const selectedSlides = snapshot.slides.flatMap((slide, index) => targetSet.has(slide.id) ? [{ slide: index + 1, id: slide.id }] : []);
  if (selectedSlides.length === targetSet.size) {
    return selectedSlides.length === 1 ? { kind: "slide", slide: selectedSlides[0]!.slide } : { kind: "slides", count: selectedSlides.length };
  }
  const selectedObjects = snapshot.slides.flatMap((slide, index) => slide.objects.flatMap((object) => targetSet.has(object.id) ? [{ slide: index + 1, id: object.id }] : []));
  if (selectedObjects.length !== targetSet.size) return { kind: "targets", count: targetIds.length };
  const slides = new Set(selectedObjects.map((object) => object.slide));
  if (slides.size !== 1) return { kind: "objects_across_slides", count: selectedObjects.length, slides: slides.size };
  const slide = selectedObjects[0]!.slide;
  return selectedObjects.length === 1 ? { kind: "object", slide } : { kind: "objects", slide, count: selectedObjects.length };
}

export function OfficeJobActivity({
  jobId,
  snapshot,
  targetIds,
  canRequestRevision,
  requestDisabledReason,
  onRequestRevision,
  onRevisionCompleted,
}: {
  jobId?: string;
  snapshot?: OfficeArtifactSnapshot;
  targetIds: string[];
  canRequestRevision: boolean;
  requestDisabledReason?: string;
  onRequestRevision(instruction: string): Promise<OfficeBrianRevisionRequest>;
  onRevisionCompleted(): void | Promise<void>;
}) {
  const [trackedJobId, setTrackedJobId] = useState(jobId);
  const [revisionJobId, setRevisionJobId] = useState<string | null>(null);
  const [job, setJob] = useState<OfficeJob | null>(null);
  const [events, setEvents] = useState<OfficeJobEvent[]>([]);
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<RequestFeedback>("idle");
  const completedRevisionIds = useRef(new Set<string>());
  const onRevisionCompletedRef = useRef(onRevisionCompleted);
  onRevisionCompletedRef.current = onRevisionCompleted;

  useEffect(() => {
    if (!revisionJobId) setTrackedJobId(jobId);
  }, [jobId, revisionJobId]);

  useEffect(() => {
    if (!trackedJobId) { setJob(null); setEvents([]); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const nextJob = await getOfficeJob(trackedJobId);
        const nextEvents = await listOfficeJobEvents(trackedJobId, 0);
        if (!live) return;
        setJob(nextJob);
        setEvents(nextEvents);
        if (!TERMINAL.has(nextJob.status)) {
          timer = setTimeout(poll, 1500);
          return;
        }
        if (trackedJobId === revisionJobId && !completedRevisionIds.current.has(trackedJobId)) {
          completedRevisionIds.current.add(trackedJobId);
          if (nextJob.status === "completed") {
            const proposed = nextEvents.some((event) => event.code === "office.job.completed" && event.params.proposal === true);
            setFeedback(proposed ? "proposal" : "applied");
            await onRevisionCompletedRef.current();
          } else setFeedback("failed");
        }
      } catch {
        if (live) timer = setTimeout(poll, 3000);
      }
    };
    setJob(null);
    setEvents([]);
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [revisionJobId, trackedJobId]);

  const active = Boolean(job && !TERMINAL.has(job.status));
  const revisionActive = active && trackedJobId === revisionJobId;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = instruction.trim();
    if (!value || submitting || revisionActive) return;
    setSubmitting(true);
    try {
      if (active && trackedJobId && trackedJobId !== revisionJobId) {
        await steerOfficeJob(trackedJobId, value);
        setInstruction("");
        return;
      }
      if (!canRequestRevision) return;
      const result = await onRequestRevision(value);
      if (result === "version_conflict") {
        setFeedback("conflict");
        return;
      }
      if (!result) {
        setFeedback("failed");
        return;
      }
      setFeedback(result.mode === "proposal" ? "proposal" : "queued");
      setRevisionJobId(result.jobId);
      setTrackedJobId(result.jobId);
      setInstruction("");
    } catch {
      setFeedback("failed");
    } finally {
      setSubmitting(false);
    }
  }

  return <OfficeJobActivityView
    job={job}
    events={events}
    loading={Boolean(trackedJobId && !job)}
    instruction={instruction}
    scope={officeBrianScope(snapshot, targetIds)}
    canRequestRevision={canRequestRevision}
    requestDisabledReason={requestDisabledReason}
    revisionActive={revisionActive}
    submitting={submitting}
    feedback={feedback}
    onInstructionChange={setInstruction}
    onSubmit={submit}
  />;
}

export function OfficeJobActivityView({
  job,
  events,
  loading = false,
  instruction,
  scope,
  canRequestRevision,
  requestDisabledReason,
  revisionActive = false,
  submitting = false,
  feedback = "idle",
  onInstructionChange,
  onSubmit,
}: {
  job: OfficeJob | null;
  events: OfficeJobEvent[];
  loading?: boolean;
  instruction: string;
  scope: OfficeBrianScope;
  canRequestRevision: boolean;
  requestDisabledReason?: string;
  revisionActive?: boolean;
  submitting?: boolean;
  feedback?: RequestFeedback;
  onInstructionChange(value: string): void;
  onSubmit(event: React.FormEvent): void;
}) {
  const t = useT().office;
  const active = Boolean(job && !TERMINAL.has(job.status));
  const failed = job?.status === "failed";
  const steering = active && !revisionActive;
  const failureKind = officeJobFailureKind(job?.errorCode);
  const failureTitle = failureKind === "presentation_fit" ? t.presentationFitFailed : failureKind === "presentation_plan" ? t.presentationPlanFailed : failureKind === "fit" ? t.fitFailed : t.failed;
  const failureBody = failureKind === "presentation_fit" ? t.presentationFitFailedBody : failureKind === "presentation_plan" ? t.presentationPlanFailedBody : failureKind === "fit" ? t.fitFailedBody : revisionActive || feedback === "failed" ? t.brianRevisionFailed : t.generationFailedBody;
  const scopeLabel = scope.kind === "slide" ? t.brianScopeSlide.replace("{slide}", String(scope.slide))
    : scope.kind === "slides" ? t.brianScopeSlides.replace("{count}", String(scope.count))
    : scope.kind === "object" ? t.brianScopeObject.replace("{slide}", String(scope.slide))
    : scope.kind === "objects" ? t.brianScopeObjects.replace("{slide}", String(scope.slide)).replace("{count}", String(scope.count))
    : scope.kind === "objects_across_slides" ? t.brianScopeObjectsAcrossSlides.replace("{count}", String(scope.count)).replace("{slides}", String(scope.slides))
    : scope.kind === "targets" ? t.brianScopeTargets.replace("{count}", String(scope.count))
    : t.brianScopeNone;
  const feedbackLabel = feedback === "queued" ? t.brianRevisionQueued
    : feedback === "proposal" ? t.brianRevisionProposalQueued
    : feedback === "applied" ? t.brianRevisionApplied
    : feedback === "failed" ? t.brianRevisionFailed
    : feedback === "conflict" ? t.brianRevisionConflict
    : null;
  const disabled = !instruction.trim() || submitting || revisionActive || !steering && !canRequestRevision;

  const eventLabel = (code: string): string => ({
    "office.job.queued": t.eventQueued,
    "office.job.authority_resolved": t.eventAuthority,
    "office.job.template_selected": t.eventTemplate,
    "office.job.grounding_started": t.eventGrounding,
    "office.job.reference_url_inspected": t.eventReferenceUrl,
    "office.job.context_grounded": t.eventContextGrounded,
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

  return <section className="flex min-h-0 flex-col" aria-label={t.editWithBrian}>
    <div className="p-3">
      <div className="flex items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Sparkles className="size-4" aria-hidden /></span>
        <div><h2 className="text-sm font-semibold">{t.editWithBrian}</h2><p role={failed ? "alert" : undefined} className={failed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{failed ? failureBody : active || loading ? revisionActive ? t.brianRevisionQueued : t.iterationActiveHint : t.brianEditHint}</p></div>
      </div>
      {!steering ? <div className="mt-3 rounded-lg border bg-muted/40 px-2.5 py-2" data-office-brian-scope={scope.kind}>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t.brianScope}</p>
        <p className="mt-0.5 text-xs font-medium">{scopeLabel}</p>
      </div> : null}
      <form onSubmit={onSubmit} className="mt-3">
        <label className="sr-only" htmlFor="office-brian-instruction">{t.editWithBrian}</label>
        <textarea id="office-brian-instruction" value={instruction} onChange={(event) => onInstructionChange(event.target.value)} disabled={revisionActive} placeholder={t.iterationPlaceholder} className="min-h-24 w-full resize-y rounded-lg border bg-background p-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-60" />
        <button type="submit" disabled={disabled} className="mt-2 h-8 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50">{submitting ? t.queued : t.askBrian}</button>
        {!steering && (revisionActive ? t.brianRevisionInFlight : !canRequestRevision ? requestDisabledReason : undefined) ? <p className="mt-2 text-xs text-muted-foreground">{revisionActive ? t.brianRevisionInFlight : requestDisabledReason}</p> : null}
        {feedbackLabel ? <p role={feedback === "failed" || feedback === "conflict" ? "alert" : "status"} className={feedback === "failed" || feedback === "conflict" ? "mt-2 text-xs text-destructive" : "mt-2 text-xs text-muted-foreground"}>{feedbackLabel}</p> : null}
      </form>
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
