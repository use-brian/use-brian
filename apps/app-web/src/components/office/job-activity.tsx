"use client";

/** Compact Brian-first iteration rail. [COMP:app-web/office-iteration-panel] */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, ChevronRight, CircleAlert, CircleDashed, Crosshair, Sparkles } from "lucide-react";
import { ChatComposer } from "@use-brian/chat-ui";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { getOfficeJob, listOfficeJobEvents, officeJobFailureKind, resumeOfficeGeneration, steerOfficeJob, OfficeApiError, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

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
  workspaceId?: string;
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

function OfficeJobActivityContent({workspaceId,jobId, snapshot, targetIds, canRequestRevision, requestDisabledReason, onRequestRevision, onRevisionCompleted, prefix, viewerId}: OfficeJobActivityProps & {prefix: string | null; viewerId: string}) {
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
  const [templateVersionId,setTemplateVersionId] = useState("");
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
      setTemplateVersionId("");
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
    if (!current() || !value || submitting || revisionActive || job?.status === "needs_input" && job.errorCode !== "material_fact_missing") return;
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

  async function resumeTemplate() {
    const started=owner.current;
    const current=()=>Boolean(started && started===owner.current && jobKey && eventKey
      && officeMetadataRemaining(readSurfaceCache(jobKey).data,viewerId)>0
      && officeMetadataRemaining(readSurfaceCache(eventKey).data,viewerId)>0);
    if(!current() || submitting || !job?.canResumeTemplate || !job.templateChoices?.some(choice=>choice.templateVersionId===templateVersionId))return;
    setSubmitting(true);
    try {
      await resumeOfficeGeneration({artifactId:job.artifactId,jobId:job.id,templateVersionId});
      if(!current())return;
      setFeedback("idle");setTemplateVersionId("");
      await Promise.all([jobRead.refresh(),eventRead.refresh()]);
      if(current())await onRevisionCompletedRef.current();
    } catch {
      if(current())setFeedback("failed");
    } finally {if(current())setSubmitting(false);}
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
    templatesHref={workspaceId ? `/w/${workspaceId}/office/templates` : undefined}
    templateVersionId={templateVersionId}
    onTemplateChange={setTemplateVersionId}
    onResumeTemplate={()=>void resumeTemplate()}
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
  templatesHref,
  templateVersionId="",
  onTemplateChange,
  onResumeTemplate,
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
  templatesHref?:string;
  templateVersionId?:string;
  onTemplateChange?(value:string):void;
  onResumeTemplate?():void;
}) {
  const t = useT().office;
  const formRef = useRef<HTMLFormElement>(null);
  const active = Boolean(job && !TERMINAL.has(job.status));
  const templateNeeded = job?.status === "needs_input" && job.errorCode === "template_ambiguous";
  const inputNeeded = job?.status === "needs_input";
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
  const disabled = !instruction.trim() || submitting || revisionActive || inputNeeded && job?.errorCode !== "material_fact_missing" || !steering && !canRequestRevision;

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
    "office.job.template_resumed": t.templateGenerationResumed,
  })[code] ?? t.running;

  const statusLabel = job?.status === "completed" ? t.completed : failed ? failureTitle : job?.status === "cancelled" ? t.cancelled : job?.status === "queued" ? t.queued : job?.status === "needs_input" ? t.eventNeedsInput : t.running;

  const question = templateNeeded ? t.templateSelectionQuestion : job?.inputQuestion ?? String([...events].reverse().find(event => event.code === "office.job.needs_input" && typeof event.params.question === "string")?.params.question ?? t.eventNeedsInput);
  const messageText = failed ? failureBody : inputNeeded ? templateNeeded ? t.templateSelectionHint : t.generationAnswerHint : active || loading ? revisionActive ? t.brianRevisionQueued : t.iterationActiveHint : t.brianEditHint;
  const showFeedback = Boolean(feedbackLabel) && feedbackLabel !== messageText && !(failed && feedback === "failed");
  const feedbackIsError = feedback === "failed" || feedback === "conflict";
  const footnote = !steering ? revisionActive ? t.brianRevisionInFlight : !canRequestRevision ? requestDisabledReason : undefined : undefined;
  const runIcon = job?.status === "completed" ? <CheckCircle2 className="size-3 shrink-0 text-emerald-600" aria-hidden />
    : failed ? <CircleAlert className="size-3 shrink-0 text-destructive" aria-hidden />
    : <CircleDashed className={cn("size-3 shrink-0", active && !inputNeeded && "animate-spin [animation-duration:3s]")} aria-hidden />;

  // Same chrome as the rest of the app's chat: an assistant message row
  // (avatar + prose, activity receipt above the text, as in the dock's
  // MessageBubble) over the Chat app's bordered composer box.
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t.editWithBrian}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
      <Sparkles className="size-3.5 text-primary" aria-hidden />
      <h2 className="text-sm font-medium">{t.editWithBrian}</h2>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="flex gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15"><Sparkles className="size-3.5" aria-hidden /></div>
        <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
          {job ? <details className="group/run min-w-0 text-xs">
            <summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 transition-transform group-open/run:rotate-90" aria-hidden />
              {runIcon}
              <span className="truncate">{t.runActivity}</span>
              <span aria-hidden>·</span>
              <span className={cn("truncate", failed && "text-destructive")}>{statusLabel}</span>
            </summary>
            {events.length ? <ol className="mt-1.5 flex flex-col gap-1.5 border-l border-border/60 pl-3">
              {events.map((event) => <li key={event.id} className="flex min-w-0 items-baseline justify-between gap-2 leading-snug text-muted-foreground">
                <span className="min-w-0 break-words">{eventLabel(event.code)}</span>
                <time className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{new Date(event.createdAt).toLocaleTimeString()}</time>
              </li>)}
            </ol> : null}
          </details> : null}
          <p role={failed ? "alert" : undefined} className={cn("break-words text-[14px] leading-[1.6]", failed ? "text-destructive" : "text-foreground")}>{messageText}</p>
          {inputNeeded ? <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3 text-sm">
            <p role="status" className="leading-relaxed">{question}</p>
            {templateNeeded ? job?.canResumeTemplate ? <>
              {job.templateChoices?.length ? <>
                <SearchableSelect value={templateVersionId} onValueChange={onTemplateChange ?? (()=>undefined)} items={job.templateChoices.map(choice=>({value:choice.templateVersionId,label:choice.name}))} placeholder={t.chooseTemplateTitle} searchPlaceholder={t.searchTemplates} emptyMessage={t.noMatchingTemplates} aria-label={t.chooseTemplateTitle} className="max-sm:min-h-11 w-full" disabled={submitting}/>
                <Button type="button" disabled={submitting || !job.templateChoices.some(choice=>choice.templateVersionId===templateVersionId)} onClick={onResumeTemplate} className="max-sm:min-h-11 w-full">{submitting ? t.queued : t.resumeGeneration}</Button>
              </> : <p className="text-muted-foreground">{t.noPublishedTemplateForDraft}</p>}
              {templatesHref ? <Link href={templatesHref} className="inline-flex min-h-8 max-sm:min-h-11 items-center underline">{t.openTemplates}</Link> : null}
            </> : <p className="text-muted-foreground">{t.templateRecoveryUnavailable}</p> : null}
          </div> : null}
          {showFeedback ? <p role={feedbackIsError ? "alert" : "status"} className={cn("break-words text-[14px] leading-[1.6]", feedbackIsError ? "text-destructive" : "text-muted-foreground")}>{feedbackLabel}</p> : null}
        </div>
      </div>
    </div>
    {!templateNeeded ? <form ref={formRef} onSubmit={onSubmit} className="shrink-0 px-3 pb-3 pt-1">
      <div className="rounded-xl border border-border bg-background shadow-sm focus-within:border-ring [&_:focus-visible]:shadow-none">
        <label className="sr-only" htmlFor="office-brian-instruction">{t.editWithBrian}</label>
        <ChatComposer
          textareaId="office-brian-instruction"
          value={instruction}
          onChange={onInstructionChange}
          onSend={() => formRef.current?.requestSubmit()}
          disabled={revisionActive}
          sendDisabled={disabled}
          placeholder={t.iterationPlaceholder}
          sendLabel={<><ArrowUp className="size-4" aria-hidden /><span className="sr-only">{submitting ? t.queued : t.askBrian}</span></>}
          rowClassName="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-1 px-2 pb-2"
          textareaClassName="order-1 col-span-2 w-full min-h-[44px] max-h-48 min-w-0 resize-none overflow-y-auto bg-transparent px-1.5 pt-2.5 pb-1 text-[16px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:shadow-none disabled:cursor-not-allowed disabled:opacity-60 md:text-sm"
          sendButtonClassName="order-3 ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-action text-action-foreground transition-colors hover:bg-action/90 focus-visible:shadow-none disabled:pointer-events-none disabled:opacity-40 sm:size-8"
          slotPreInput={<div className="order-2 min-w-0 px-1.5">
            {!steering ? <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" data-office-brian-scope={scope.kind}>
              <Crosshair className="size-3 shrink-0 text-primary/70" aria-hidden />
              <span className="shrink-0">{t.brianScope}:</span>
              <span className="truncate font-medium text-foreground">{scopeLabel}</span>
            </span> : null}
          </div>}
        />
      </div>
      {footnote ? <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">{footnote}</p> : null}
    </form> : null}
  </section>;
}
