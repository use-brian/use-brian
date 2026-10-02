"use client";

/**
 * Status-row chip + tray for the workspace brain-intake queue. Renders in the
 * workspace status row (the left sidebar's last row; it floats in the
 * bottom-left corner while the sidebar is collapsed), beside the connectivity
 * indicator and OUTSIDE its
 * live region (a progress tick must never re-announce "Online"), and renders
 * nothing while the workspace queue is empty. The chip summarises the queue
 * in one phrase; clicking it toggles a non-modal panel anchored above the bar
 * with one row per file. Ready-to-review recordings open the ordinary z-50
 * cost + blueprint confirm from their Review button - nothing here is modal,
 * and the panel sits at z-40, below every dialog.
 *
 * Spec: docs/architecture/features/files.md -> "The intake queue and the
 * bottom-bar tray". [COMP:app-web/brain-intake-tray]
 */

import { useId } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock,
  FileUp,
  Loader2,
  MessageSquareWarning,
  X,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { totalAdded } from "@/lib/api/ingest";
import {
  canReviewIntakeItem,
  clearFinishedIntake,
  dismissIntakeItem,
  isTerminal,
  reviewIntakeItem,
  setIntakeTrayExpanded,
  useIntakeQueue,
  type IntakeItem,
} from "@/lib/brain-intake/intake-queue";
import { Button } from "@/components/ui/button";

type Tone = "neutral" | "review" | "failed" | "done";

/**
 * One phrase for the chip, in priority order: something the user must act on
 * beats something in flight, which beats a failure, which beats a success.
 */
export function summarizeIntake(
  items: IntakeItem[],
  t: ReturnType<typeof useT>["intakeTray"],
): { label: string; tone: Tone; busy: boolean } {
  const review = items.filter((i) => i.status === "awaiting_review").length;
  const inFlight = items.filter((i) => !isTerminal(i) && i.status !== "awaiting_review");
  const failed = items.filter((i) => i.status === "error").length;
  const done = items.filter((i) => i.status === "done").length;
  if (review > 0) {
    return {
      label: review === 1 ? t.chipReviewOne : format(t.chipReview, { count: review }),
      tone: "review",
      busy: false,
    };
  }
  if (inFlight.length > 0) {
    const uploading = inFlight.find((i) => i.status === "uploading" && i.progress !== null);
    const base =
      inFlight.length === 1 ? t.chipAddingOne : format(t.chipAdding, { count: inFlight.length });
    const label = uploading
      ? `${base} ${Math.round((uploading.progress ?? 0) * 100)}%`
      : base;
    return { label, tone: "neutral", busy: true };
  }
  if (failed > 0) {
    return {
      label: failed === 1 ? t.chipFailedOne : format(t.chipFailed, { count: failed }),
      tone: "failed",
      busy: false,
    };
  }
  return {
    label: done === 1 ? t.chipDoneOne : format(t.chipDone, { count: done }),
    tone: "done",
    busy: false,
  };
}

export function BrainIntakeTray({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.intakeTray;
  const { items, expanded } = useIntakeQueue(workspaceId);
  const panelId = useId();
  if (items.length === 0) return null;

  const summary = summarizeIntake(items, t);
  const anyFinished = items.some(isTerminal);

  return (
    <>
      <button
        type="button"
        data-brain-intake-chip
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={expanded ? t.hideTray : t.showTray}
        onClick={() => setIntakeTrayExpanded(workspaceId, !expanded)}
        className={cn(
          // The status row is 28px tall; the pseudo-element extends the hit area
          // to a 44px touch target without growing the row.
          "relative inline-flex h-full min-w-0 items-center gap-1.5 rounded px-1.5 text-[11px] font-medium transition-colors",
          "after:absolute after:inset-x-0 after:-top-2 after:-bottom-2 after:content-['']",
          "hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          summary.tone === "review" && "text-amber-700 dark:text-amber-300",
          summary.tone === "failed" && "text-rose-700 dark:text-rose-300",
          summary.tone === "done" && "text-emerald-700 dark:text-emerald-300",
          summary.tone === "neutral" && "text-foreground/80",
        )}
      >
        {summary.busy ? (
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        ) : summary.tone === "review" ? (
          <MessageSquareWarning className="size-3 shrink-0" aria-hidden />
        ) : summary.tone === "failed" ? (
          <AlertCircle className="size-3 shrink-0" aria-hidden />
        ) : (
          <Check className="size-3 shrink-0" aria-hidden />
        )}
        <span className="truncate">{summary.label}</span>
        <ChevronDown
          className={cn("size-3 shrink-0 transition-transform", expanded ? "rotate-0" : "rotate-180")}
          aria-hidden
        />
      </button>

      {expanded && (
        <section
          id={panelId}
          role="region"
          aria-label={t.region}
          data-brain-intake-tray
          className={cn(
            "absolute bottom-full left-2 z-40 mb-2 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/5",
            "w-[min(24rem,calc(var(--native-app-width,100vw)-1rem))]",
          )}
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <h2 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{t.title}</h2>
            {anyFinished && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => clearFinishedIntake(workspaceId)}
                className="text-muted-foreground"
              >
                {t.clearFinished}
              </Button>
            )}
            <button
              type="button"
              aria-label={t.hideTray}
              onClick={() => setIntakeTrayExpanded(workspaceId, false)}
              className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:size-7"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </header>
          <ul className="flex max-h-[min(50dvh,20rem)] flex-col gap-1 overflow-y-auto p-2">
            {items.map((item) => (
              <IntakeRow key={item.id} item={item} copy={copy} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function IntakeRow({ item, copy }: { item: IntakeItem; copy: ReturnType<typeof useT> }) {
  const t = copy.intakeTray;
  const reviewable = canReviewIntakeItem(item);
  const showBar = item.status === "uploading" && item.progress !== null;
  return (
    <li
      data-intake-status={item.status}
      className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-2.5 py-1.5"
    >
      <RowIcon item={item} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-foreground" title={item.file.name}>
          {item.file.name}
        </div>
        <div className="break-words text-[11.5px] text-muted-foreground">
          <RowStatus item={item} copy={copy} />
        </div>
        {showBar && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((item.progress ?? 0) * 100)}
            className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }}
            />
          </div>
        )}
      </div>
      {reviewable && (
        <Button
          type="button"
          size="sm"
          variant={item.status === "awaiting_review" ? "default" : "outline"}
          onClick={() => void reviewIntakeItem(item.id, copy)}
        >
          {item.status === "awaiting_review" ? t.review : t.reviewAgain}
        </Button>
      )}
      {isTerminal(item) && (
        <button
          type="button"
          aria-label={t.dismiss}
          onClick={() => dismissIntakeItem(item.id)}
          className="grid size-11 shrink-0 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground md:size-7"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

function RowIcon({ item }: { item: IntakeItem }) {
  switch (item.status) {
    case "queued":
      return <Clock className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />;
    case "uploading":
    case "checking":
    case "reviewing":
    case "analyzing":
      return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
    case "awaiting_review":
      return (
        <MessageSquareWarning
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
      );
    case "done":
      return <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
    case "error":
      return <AlertCircle className="size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />;
    default:
      return <FileUp className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />;
  }
}

function RowStatus({ item, copy }: { item: IntakeItem; copy: ReturnType<typeof useT> }) {
  const t = copy.intakeTray;
  const ingest = copy.docPage.suggested;
  const recordings = copy.recordings;
  switch (item.status) {
    case "queued":
      return <>{t.statusQueued}</>;
    case "uploading":
      return item.progress === null ? (
        <>{ingest.ingestAdding}</>
      ) : (
        <>{recordings.uploadingProgress.replace("{percent}", String(Math.round(item.progress * 100)))}</>
      );
    case "checking":
      return <>{recordings.estimating}</>;
    case "awaiting_review":
      return (
        <span className="text-amber-700 dark:text-amber-300">
          {format(t.statusReadyToReview, {
            minutes: Math.max(1, Math.round((item.durationSeconds ?? 0) / 60)),
          })}
        </span>
      );
    case "reviewing":
      return <>{t.statusReviewing}</>;
    case "analyzing":
      return <>{ingest.ingestAnalyzing}</>;
    case "error":
      return (
        <span className="text-rose-600 dark:text-rose-400">{item.error ?? ingest.ingestFailed}</span>
      );
    case "done":
      break;
  }
  const success = "text-emerald-600 dark:text-emerald-400";
  if (item.storedOnly) {
    return <span className="text-amber-700 dark:text-amber-300">{t.statusStoredOnly}</span>;
  }
  if (item.kind === "media") return <span className={success}>{t.statusQueuedTranscription}</span>;
  const imported = item.result?.linkedinImport;
  if (imported) {
    return imported.status === "completed" ? (
      <span className={success}>{`${imported.rows} ${ingest.linkedinRowsImported}`}</span>
    ) : (
      <span className={success}>{ingest.linkedinImportQueued}</span>
    );
  }
  const n = totalAdded(item.result?.counts);
  if (n > 0) return <span className={success}>{`${n} ${ingest.ingestAdded}`}</span>;
  // A queued ingest carries no counts in its reply: the extraction happened on
  // the worker, long after the upload answered.
  if (item.result?.status === "queued") return <span className={success}>{ingest.ingestAddedToBrain}</span>;
  return <span className={success}>{ingest.ingestStored}</span>;
}
