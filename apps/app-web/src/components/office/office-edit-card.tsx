"use client";

/**
 * Office edit card: the outcome of a `reviseOfficeArtifact` call, rendered in
 * the assistant message that started it. The tool only queues a revision job
 * and never waits; this card follows the job on the shared per-job stream
 * (queued -> latest persisted stage -> applied / proposal ready / failed) and
 * refreshes the editor once the job settles. Every viewer of the thread sees
 * the same state because it is the job's state, not this tab's.
 *
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 * [COMP:app-web/office-edit-card]
 */
import { useEffect, useRef } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, FilePen } from "lucide-react";
import type { ToolUsed } from "@use-brian/chat-ui";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { useOfficeJobStream } from "@/lib/office/job-stream";
import { officeJobStateLabel } from "@/lib/office/job-labels";
import { cn } from "@/lib/utils";

export type OfficeEditResult = { jobId: string; mode: "direct" | "proposal" };

/** The revision a successful `reviseOfficeArtifact` call queued, from its result excerpt. */
export function officeEditResult(tool: Pick<ToolUsed, "name" | "status" | "output">): OfficeEditResult | null {
  if (tool.name !== "reviseOfficeArtifact" || tool.status !== "done" || !tool.output) return null;
  try {
    const value = JSON.parse(tool.output) as { jobId?: unknown; mode?: unknown };
    if (typeof value.jobId !== "string" || (value.mode !== "direct" && value.mode !== "proposal")) return null;
    return { jobId: value.jobId, mode: value.mode };
  } catch {
    return null;
  }
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function OfficeEditCard({
  jobId,
  mode,
  onSettled,
  onOpenHistory,
}: OfficeEditResult & {
  /** Re-read the canonical artifact; called once when the job settles. */
  onSettled?: () => void | Promise<void>;
  onOpenHistory?: () => void;
}) {
  const t = useT().office;
  const { job, events, connection, ended } = useOfficeJobStream(jobId);
  const settled = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const status = job?.status;
  const terminal = Boolean(status && TERMINAL.has(status)) || ended === "done";

  useEffect(() => {
    if (!terminal || settled.current) return;
    settled.current = true;
    void Promise.resolve(onSettledRef.current?.()).catch(() => undefined);
  }, [terminal]);

  if (ended === "revoked") return null;
  const proposal = mode === "proposal" || events.some((event) => event.code === "office.job.completed" && event.params.proposal === true);
  const failed = status === "failed";
  const message = status === "completed" ? proposal ? t.editCardProposal : t.editCardApplied
    : failed ? t.editCardFailed
    : officeJobStateLabel(t, status, events.at(-1) ?? job?.latestEvent ?? null);
  const live = connection === "live";
  const inFlight = status === "queued" || status === "running";
  const icon = status === "completed" ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
    : failed ? <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
    : <CircleDashed className={cn("size-3.5 shrink-0 text-muted-foreground", inFlight && live && "animate-spin [animation-duration:3s]")} aria-hidden />;

  return (
    <div data-office-edit-card={status ?? "pending"} className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <FilePen className="size-3.5 shrink-0" aria-hidden />
        <span>{t.editCardTitle}</span>
      </div>
      <div className="mt-2 flex items-start gap-2">
        {icon}
        {message
          ? <p role={failed ? "alert" : "status"} className={cn("min-w-0 break-words leading-snug", failed && "text-destructive")}>{message}</p>
          : <div aria-hidden data-office-job-skeleton="true" className="h-4 w-32 animate-pulse rounded bg-muted" />}
      </div>
      {job && !live && !terminal ? <p className="mt-1.5 text-xs text-muted-foreground">{connection === "offline" ? t.jobOffline : t.jobReconnecting}</p> : null}
      {status === "completed" && !proposal && onOpenHistory
        ? <Button type="button" variant="outline" size="sm" className="mt-2.5 max-sm:min-h-11" onClick={onOpenHistory}>{t.openHistory}</Button>
        : null}
    </div>
  );
}
