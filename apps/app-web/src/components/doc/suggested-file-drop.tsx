"use client";

/**
 * Home "Add files to your brain" drop block. Drag files onto it (or pick them),
 * then "Add to brain" runs deterministic ingest. Ordinary files use Pipeline B;
 * a single LinkedIn ZIP uses the dedicated lossless queue. Per-file status
 * renders inline.
 *
 * Reuses `useFileDrop` for drag state; the ingest SDK is `lib/api/ingest.ts`.
 * Lives on the Suggested-for-you surface, under the build bar.
 *
 * Spec: docs/architecture/features/files.md -> "Direct ingest".
 * [COMP:app-web/home-file-drop]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, FileUp, Loader2, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { useFileDrop } from "@/lib/use-file-drop";
import {
  MAX_INGEST_FILE_BYTES,
  formatFileSize,
  getIngestJobStatus,
  ingestFiles,
  ingestLinkedInArchive,
  partitionByIngestSize,
  totalAdded,
  type IngestFileResult,
} from "@/lib/api/ingest";

/** Match the server's per-request cap (MAX_INGEST_FILES in routes/files.ts). */
const MAX_FILES = 5;

/**
 * `analyzing` = the bytes are filed and the brain ingest is on the worker queue.
 * The upload request returns as soon as the file is stored (it must: knowledge
 * extraction on a large document runs for minutes, far past the CDN's
 * origin-response timeout), so the completion signal is a poll, not the reply.
 */
type ItemStatus = "pending" | "ingesting" | "analyzing" | "done" | "error";

const POLL_INTERVAL_MS = 3_000;
/** Give up watching (not the job — the job is durable) after this long. */
const POLL_TIMEOUT_MS = 15 * 60_000;

/**
 * What one upload result means for the chip. Exported because this is the
 * decision the 2026-08-05 incident got wrong in the other direction: a file
 * that had been fully ingested was labelled "Failed". The rule is that only the
 * server saying so makes a chip red.
 */
export function statusForIngestResult(result: IngestFileResult | undefined): ItemStatus {
  if (!result || !result.ok) return "error";
  // Stored, but the brain ingest is still on the queue — not done yet, and
  // emphatically not failed.
  if (result.status === "queued" && result.jobId) return "analyzing";
  return "done";
}

type StagedItem = {
  localId: string;
  file: File;
  status: ItemStatus;
  result?: IngestFileResult;
  error?: string;
};

export function SuggestedFileDrop({ workspaceId }: { workspaceId: string }) {
  const t = useT().docPage.suggested;
  const [items, setItems] = useState<StagedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Polls outlive no unmount: this block sits on the Home surface, which is torn
  // down the moment the user navigates to Brain / Studio / anywhere else.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;
      // Size is checked at DROP time, not at "Add to brain": an oversized body
      // is dropped by the edge before any handler runs, so the request would
      // reject with a bare `TypeError: Failed to fetch` that names neither the
      // size nor the limit. Telling the user here also costs them nothing.
      const { accepted, tooLarge } = partitionByIngestSize(incoming);
      const limit = formatFileSize(MAX_INGEST_FILE_BYTES);
      setItems((prev) => {
        // Keep only unresolved (pending) items plus the new batch, capped.
        const pending = prev.filter((i) => i.status === "pending");
        // The cap bounds what will be UPLOADED, so it is applied to the
        // accepted files alone and the overflow is told about rather than
        // dropped. A plain `.slice(MAX_FILES)` over the whole list used to
        // discard the tail silently: drop eight files and three vanished with
        // no chip, no message, and nothing to click. Error chips are not
        // uploads and never evict a file that could still be sent.
        const room = Math.max(0, MAX_FILES - pending.length);
        const staged = accepted.slice(0, room).map((file) => ({
          localId: crypto.randomUUID(),
          file,
          status: "pending" as const,
        }));
        const rejected = [
          ...tooLarge.map((file) => ({
            file,
            error: format(t.ingestTooLarge, { size: formatFileSize(file.size), limit }),
          })),
          ...accepted.slice(room).map((file) => ({
            file,
            error: format(t.ingestTooManyFiles, { max: String(MAX_FILES) }),
          })),
        ].map(({ file, error }) => ({
          localId: crypto.randomUUID(),
          file,
          status: "error" as const,
          error,
        }));
        return [...pending, ...staged, ...rejected];
      });
    },
    [t.ingestTooLarge, t.ingestTooManyFiles],
  );

  const drop = useFileDrop(addFiles, { disabled: busy });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = ""; // allow re-picking the same file
  };

  const remove = (localId: string) =>
    setItems((prev) => prev.filter((i) => i.localId !== localId));

  const clearResolved = () =>
    setItems((prev) => prev.filter((i) => i.status === "pending"));

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const hasResolved = items.some((i) => i.status === "done" || i.status === "error");

  /**
   * Watch one queued job to a terminal state. An unreadable poll is NOT a
   * failure — the row is durable in `file_ingest_jobs` — so a null response
   * keeps the chip on "analyzing" and tries again. Only the server saying
   * `failed` turns the chip red.
   */
  const watchJob = useCallback(async (localId: string, jobId: string) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (!unmounted.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (unmounted.current) return;
      const state = await getIngestJobStatus(jobId);
      if (!state) continue;
      if (state.status === "done") {
        setItems((prev) =>
          prev.map((i) => (i.localId === localId ? { ...i, status: "done" } : i)),
        );
        return;
      }
      if (state.status === "failed") {
        setItems((prev) =>
          prev.map((i) =>
            i.localId === localId ? { ...i, status: "error", error: state.error } : i,
          ),
        );
        return;
      }
    }
  }, []);

  const addToBrain = useCallback(async () => {
    const pending = items.filter((i) => i.status === "pending");
    if (pending.length === 0 || busy) return;
    setBusy(true);
    const pendingIds = new Set(pending.map((p) => p.localId));
    setItems((prev) =>
      prev.map((i) => (pendingIds.has(i.localId) ? { ...i, status: "ingesting" } : i)),
    );
    try {
      const zipItems = pending.filter((item) => item.file.name.toLowerCase().endsWith(".zip"));
      if (zipItems.length > 0 && pending.length !== 1) {
        throw new Error(t.linkedinArchiveAlone);
      }
      const results = zipItems.length === 1
        ? [await ingestLinkedInArchive(workspaceId, zipItems[0].file)]
        : await ingestFiles(workspaceId, pending.map((p) => p.file));
      // `results` is positional over `pending`; pair them out here rather than
      // inside the updater, which React may run twice.
      const queued = pending.flatMap((p, idx) => {
        const r = results[idx];
        return r?.ok && r.status === "queued" && r.jobId
          ? [{ localId: p.localId, jobId: r.jobId }]
          : [];
      });
      setItems((prev) => {
        let idx = 0;
        return prev.map((i) => {
          if (!pendingIds.has(i.localId)) return i;
          const r = results[idx++];
          const status = statusForIngestResult(r);
          if (status === "error") {
            return { ...i, status, error: r?.error ?? t.ingestFailed };
          }
          return { ...i, status, result: r };
        });
      });
      for (const job of queued) void watchJob(job.localId, job.jobId);
    } catch (err) {
      // `fetch` rejects with a bare `TypeError` for anything that never reached
      // a handler: offline, DNS, CORS, or a body the edge refused. Its message
      // ("Failed to fetch", or "Load failed" on Safari) is not something to
      // show a user, so name the class of failure instead.
      const message =
        err instanceof TypeError ? t.ingestUnreachable : (err as Error).message;
      setItems((prev) =>
        prev.map((i) =>
          pendingIds.has(i.localId) ? { ...i, status: "error", error: message } : i,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [items, busy, workspaceId, watchJob, t.ingestFailed, t.ingestUnreachable, t.linkedinArchiveAlone]);

  return (
    <section
      {...drop.dropProps}
      className={cn(
        "relative mt-4 rounded-2xl border bg-card p-4 transition-colors",
        drop.isDragging ? "border-primary/60 bg-primary/[0.04]" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
          <FileUp className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{t.ingestTitle}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.ingestCaption}</p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          {t.ingestCta}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={onPick}
          className="hidden"
          aria-hidden
        />
      </div>

      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {items.map((i) => (
            <li
              key={i.localId}
              className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-2.5 py-1.5"
            >
              <StatusIcon status={i.status} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                {i.file.name}
              </span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">
                <StatusLabel item={i} t={t} />
              </span>
              {i.status === "pending" && (
                <button
                  type="button"
                  aria-label={t.ingestRemove}
                  onClick={() => remove(i.localId)}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {(pendingCount > 0 || hasResolved) && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {hasResolved && !busy && (
            <button
              type="button"
              onClick={clearResolved}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t.ingestClear}
            </button>
          )}
          <button
            type="button"
            onClick={addToBrain}
            disabled={pendingCount === 0 || busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-[12.5px] font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {busy ? t.ingestAdding : t.ingestAdd}
          </button>
        </div>
      )}

      {drop.isDragging && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-2xl bg-primary/[0.06] text-[13px] font-medium text-primary">
          {t.ingestDrop}
        </div>
      )}
    </section>
  );
}

function StatusIcon({ status }: { status: ItemStatus }) {
  if (status === "ingesting" || status === "analyzing")
    return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
  if (status === "done")
    return <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  if (status === "error")
    return <AlertCircle className="size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />;
  return <FileUp className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />;
}

function StatusLabel({
  item,
  t,
}: {
  item: StagedItem;
  t: ReturnType<typeof useT>["docPage"]["suggested"];
}) {
  if (item.status === "pending") return <>{t.ingestReady}</>;
  if (item.status === "ingesting") return <>{t.ingestAdding}</>;
  if (item.status === "analyzing") return <>{t.ingestAnalyzing}</>;
  if (item.status === "error") return <span className="text-rose-600 dark:text-rose-400">{item.error ?? t.ingestFailed}</span>;
  if (item.result?.linkedinImport) {
    const imported = item.result.linkedinImport;
    return imported.status === "completed" ? (
      <span className="text-emerald-600 dark:text-emerald-400">{`${imported.rows} ${t.linkedinRowsImported}`}</span>
    ) : (
      <span className="text-emerald-600 dark:text-emerald-400">{t.linkedinImportQueued}</span>
    );
  }
  const n = totalAdded(item.result?.counts);
  if (n > 0) {
    return <span className="text-emerald-600 dark:text-emerald-400">{`${n} ${t.ingestAdded}`}</span>;
  }
  // A queued ingest carries no counts in its reply — the extraction happened on
  // the worker, long after the upload answered.
  if (item.result?.status === "queued") {
    return <span className="text-emerald-600 dark:text-emerald-400">{t.ingestAddedToBrain}</span>;
  }
  return <span className="text-emerald-600 dark:text-emerald-400">{t.ingestStored}</span>;
}
