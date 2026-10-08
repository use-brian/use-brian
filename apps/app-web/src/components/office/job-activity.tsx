"use client";

/** Compact Brian-first iteration rail. [COMP:app-web/office-iteration-panel] */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, ChevronDown, CircleDashed, Sparkles } from "lucide-react";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { getOfficeJob, listOfficeJobEvents, officeJobFailureKind, steerOfficeJob, OfficeApiError, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

import { useOfficeMetadataResource, useOfficePanelIdentity } from "@/lib/office/surface-cache";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import { officePanelCacheKey } from "@/lib/surface-prefetch";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";

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

type OfficeJobActivityProps = {
  jobId?: string;
  snapshot?: OfficeArtifactSnapshot;
  targetIds: string[];
  canRequestRevision: boolean;
  requestDisabledReason?: string;
  onRequestRevision(instruction: string): Promise<OfficeBrianRevisionRequest>;
  onRevisionCompleted(): void | Promise<void>;
};

export function OfficeJobActivity(props: OfficeJobActivityProps) {
  const identity = useOfficePanelIdentity();
  return <OfficeJobActivityContent key={`${identity.prefix}:${props.snapshot?.artifactId ?? props.jobId ?? "new"}`} {...props} {...identity}/>;
}

function OfficeJobActivityContent({jobId, snapshot, targetIds, canRequestRevision, requestDisabledReason, onRequestRevision, onRevisionCompleted, prefix, viewerId}: OfficeJobActivityProps & {prefix: string | null; viewerId: string}) {
  const [trackedJobId, setTrackedJobId] = useState(jobId);
  const [revisionJobId, setRevisionJobId] = useState<string | null>(null);
  const jobKey = officePanelCacheKey(prefix, "job", trackedJobId);
  const eventKey = officePanelCacheKey(prefix, "job-events", trackedJobId);
  const jobRead = useOfficeMetadataResource(jobKey, viewerId, () => getOfficeJob(trackedJobId!));
  const eventRead = useOfficeMetadataResource(eventKey, viewerId, () => listOfficeJobEvents(trackedJobId!, 0));
  const job = jobRead.data ?? null;
  const events = eventRead.data ?? [];
  const available = Boolean(job && eventRead.data);
  const owner = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = {}; return () => { owner.current = null; }; }, [jobKey, available]);
  const hadProjection = useRef(false);
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<RequestFeedback>("idle");
  const completedRevisionIds = useRef(new Set<string>());
  const onRevisionCompletedRef = useRef(onRevisionCompleted);
  onRevisionCompletedRef.current = onRevisionCompleted;

  useEffect(() => {
    if (!revisionJobId) setTrackedJobId(jobId);
  }, [jobId, revisionJobId]);

  useLayoutEffect(() => {
    if (available) hadProjection.current = true;
    else if (hadProjection.current) {
      hadProjection.current = false;
      setInstruction("");
      setFeedback("idle");
      setSubmitting(false);
    }
  }, [available]);

  useEffect(() => {
    if (!trackedJobId || !prefix || job && TERMINAL.has(job.status)) return;
    const error = jobRead.error ?? eventRead.error;
    if (error instanceof OfficeApiError && ([401,403,404].includes(error.status) || error.message === "office_projection_changed")) return;
    const timer = setTimeout(() => { void Promise.all([jobRead.refresh(), eventRead.refresh()]); }, error ? 3000 : 1500);
    return () => clearTimeout(timer);
  }, [trackedJobId, prefix, job, jobRead.error, eventRead.error, jobRead.refresh, eventRead.refresh]);

  useEffect(() => {
    if (!available || !job || !trackedJobId || !TERMINAL.has(job.status) || trackedJobId !== revisionJobId || completedRevisionIds.current.has(trackedJobId)) return;
    if (!jobKey || !eventKey || readSurfaceCache(jobKey).data !== job || readSurfaceCache(eventKey).data !== eventRead.data || officeMetadataRemaining(job, viewerId) <= 0 || officeMetadataRemaining(eventRead.data, viewerId) <= 0) return;
    completedRevisionIds.current.add(trackedJobId);
    if (job.status === "completed") {
      const proposed = events.some(event => event.code === "office.job.completed" && event.params.proposal === true);
      setFeedback(proposed ? "proposal" : "applied");
      setInstruction("");
      void Promise.resolve(onRevisionCompletedRef.current()).catch(() => undefined);
    } else setFeedback("failed");
  }, [available, job, eventRead.data, trackedJobId, revisionJobId, jobKey, eventKey, viewerId]);

  const active = Boolean(job && !TERMINAL.has(job.status));
  const revisionActive = Boolean(revisionJobId && trackedJobId === revisionJobId && (!job || job.id !== trackedJobId || active));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = instruction.trim();
    const started = owner.current;
    const current = () => Boolean(started && started === owner.current && prefix && (!trackedJobId || jobKey && eventKey &&
      officeMetadataRemaining(readSurfaceCache(jobKey).data, viewerId) > 0 && officeMetadataRemaining(readSurfaceCache(eventKey).data, viewerId) > 0));
    if (!current() || !value || submitting || revisionActive) return;
    setSubmitting(true);
    try {
      if (active && trackedJobId && trackedJobId !== revisionJobId) {
        await steerOfficeJob(trackedJobId, value);
        if (current()) setInstruction("");
        return;
      }
      if (!canRequestRevision) return;
      const result = await onRequestRevision(value);
      if (!current()) return;
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
    } catch (error) {
      if (current()) {
        if (error instanceof OfficeApiError && [401,403,404].includes(error.status)) {
          if (jobKey) invalidateSurfaceCache(jobKey);
          if (eventKey) invalidateSurfaceCache(eventKey);
        }
        setFeedback("failed");
      }
    } finally {
      if (current()) setSubmitting(false);
    }
  }

  return <OfficeJobActivityView
    job={available ? job : null}
    events={available ? events : []}
    loading={Boolean(trackedJobId && !job)}
    instruction={instruction}
    scope={officeBrianScope(snapshot, targetIds)}
    canRequestRevision={Boolean(prefix) && canRequestRevision && (!trackedJobId || available)}
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
  const failureBody = failureKind === "presentation_fit" ? t.presentationFitFailedBody : failureKind === "presentation_plan" ? t.presentationPlanFailedBody : failureKind === "fit" ? t.fitFailedBody : job?.errorCode === "revision_failed" || revisionActive || feedback === "failed" ? t.brianRevisionFailed : t.generationFailedBody;
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

  const statusLabel = job?.status === "completed" ? t.completed : failed ? failureTitle : job?.status === "cancelled" ? t.cancelled : job?.status === "queued" ? t.queued : job?.status === "needs_input" ? t.eventNeedsInput : t.running;

  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t.editWithBrian}>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"><Sparkles className="size-4" aria-hidden /></span>
        <div className="min-w-0 pt-1"><h2 className="text-sm font-medium">{t.editWithBrian}</h2><p role={failed ? "alert" : undefined} className={failed ? "mt-1 text-sm leading-relaxed text-destructive" : `mt-1 text-sm leading-relaxed text-muted-foreground ${!active && !loading ? "max-lg:hidden" : ""}`}>{failed ? failureBody : active || loading ? revisionActive ? t.brianRevisionQueued : t.iterationActiveHint : t.brianEditHint}</p></div>
      </div>
      {job?.status === "needs_input" ? <p role="status" className="rounded-xl border p-3 text-sm">{String([...events].reverse().find(event => event.code === "office.job.needs_input" && typeof event.params.question === "string")?.params.question ?? t.eventNeedsInput)}</p> : null}
      {feedbackLabel && !(failed && feedback === "failed") ? <p role={feedback === "failed" || feedback === "conflict" ? "alert" : "status"} className={feedback === "failed" || feedback === "conflict" ? "text-sm text-destructive" : "rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground"}>{feedbackLabel}</p> : null}
      {job ? <details className="group rounded-xl border bg-muted/20 px-3 py-2.5">
        <summary className="flex min-h-6 cursor-pointer items-center justify-between gap-2 text-xs font-medium max-sm:min-h-11">
          <span className="inline-flex items-center gap-1.5"><ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />{t.runActivity}</span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">{job.status === "completed" ? <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden /> : <CircleDashed className="size-3.5" aria-hidden />}{statusLabel}</span>
        </summary>
        <ol className="mt-3 space-y-3 pb-1">
          {events.map((event) => <li key={event.id} className="border-l-2 pl-3 text-xs"><p>{eventLabel(event.code)}</p><time className="text-[11px] text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</time></li>)}
        </ol>
      </details> : null}
    </div>
    <form onSubmit={onSubmit} className="shrink-0 p-3 pt-2">
      <div className="overflow-hidden rounded-2xl border bg-background shadow-sm focus-within:border-ring [&_:focus-visible]:shadow-none">
        {!steering ? <div className="mx-3 mt-3 rounded-lg bg-muted/60 px-2.5 py-2 text-xs" data-office-brian-scope={scope.kind}>
          <span className="text-muted-foreground">{t.brianScope}: </span><span className="font-medium">{scopeLabel}</span>
        </div> : null}
        <label className="sr-only" htmlFor="office-brian-instruction">{t.editWithBrian}</label>
        <textarea id="office-brian-instruction" value={instruction} onChange={(event) => onInstructionChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (!disabled) event.currentTarget.form?.requestSubmit();
          }
        }} disabled={revisionActive} placeholder={t.iterationPlaceholder} rows={3} className="block max-h-48 min-h-20 w-full resize-none border-0 bg-transparent px-3 py-3 text-base leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60 md:text-sm" />
        <div className="flex justify-end px-2.5 pb-2.5">
          <Button type="submit" size="icon" disabled={disabled} aria-label={submitting ? t.queued : t.askBrian} title={submitting ? t.queued : t.askBrian} className="rounded-full max-sm:size-11"><ArrowUp className="size-4" aria-hidden /></Button>
        </div>
      </div>
      {!steering && (revisionActive ? t.brianRevisionInFlight : !canRequestRevision ? requestDisabledReason : undefined) ? <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">{revisionActive ? t.brianRevisionInFlight : requestDisabledReason}</p> : null}
    </form>
  </section>;
}
