/**
 * Office job state copy: the persisted status plus the latest persisted event,
 * never a generic in-progress label (office.md -> "Live job progress", "No
 * generic Working"). An unmapped event code renders the server's
 * `safeNarration`; with neither, the caller omits the row.
 * [COMP:app-web/office-job-stream]
 */
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

type OfficeCopy = Dictionary["office"];
type EventLike = { code: string; safeNarration?: string | null };

export function officeEventLabel(t: OfficeCopy, event: EventLike): string | null {
  const mapped: Record<string, string> = {
    "office.job.queued": t.eventQueued,
    "office.job.started": t.eventStarted,
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
    "office.job.input_received": t.eventInputReceived,
    "office.job.failed": t.eventFailed,
    "office.job.cancelled": t.eventCancelled,
    "office.job.steering_applied": t.eventSteering,
    "office.job.template_resumed": t.templateGenerationResumed,
    "office.job.revision_drafted": t.eventRevisionDrafted,
    "office.job.import_parsed": t.eventImportParsed,
    "office.job.template_parsed": t.eventTemplateParsed,
  };
  return mapped[event.code] ?? (event.safeNarration?.trim() || null);
}

/**
 * The one-line state for a job: a settled status names itself, an in-flight one
 * names its latest persisted stage. `null` means there is nothing persisted to
 * show yet, which callers render as a skeleton, never as text.
 */
export function officeJobStateLabel(t: OfficeCopy, status: string | undefined, latest: EventLike | null | undefined): string | null {
  if (status === "completed") return t.completed;
  if (status === "failed") return t.failed;
  if (status === "cancelled") return t.cancelled;
  if (status === "needs_input") return t.eventNeedsInput;
  if (latest) return officeEventLabel(t, latest);
  return status === "queued" ? t.queued : null;
}
