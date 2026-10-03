"use client";

/**
 * Shared "Add files to your brain" intake for Home, Brain, and the workspace
 * fallback dialog. Drag files onto it (or pick them), then "Add to brain"
 * hands the batch to the workspace intake queue and the review empties: the
 * modal is for choosing, never for waiting. Progress lives in the bottom-bar
 * intake tray (`[COMP:app-web/brain-intake-tray]`), so the user keeps
 * navigating while a large recording uploads.
 * Ordinary files use Pipeline B; audio/video uses the recording pipeline and
 * stops at Ready to review, where the required cost + blueprint confirmation
 * opens on click; a single LinkedIn ZIP uses the dedicated lossless queue.
 * Only drop-time validation failures (size cap, batch cap, ZIP mixed with
 * other files) stay here as error chips: they are decided before anything is
 * sent.
 *
 * Reuses `useFileDrop` for drag state; the queue is `lib/brain-intake/`.
 * It lives under the Home build bar and in the workspace intake dialog.
 *
 * Spec: docs/architecture/features/files.md -> "Direct ingest".
 * [COMP:app-web/home-file-drop]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FileUp, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { useFileDrop } from "@/lib/use-file-drop";
import {
  LARGE_FILE_CONFIRM_BYTES,
  MAX_STORED_FILE_BYTES,
  formatFileSize,
  partitionByIngestSize,
} from "@/lib/api/ingest";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { isRecordingFile } from "@/lib/api/recordings";
import { enqueueIntake, type IntakeKind } from "@/lib/brain-intake/intake-queue";

/** Match the server's per-request cap (MAX_INGEST_FILES in routes/files.ts). */
const MAX_FILES = 5;

/**
 * `pending` = staged, nothing sent. `error` = refused at drop or at Add, before
 * any request (size cap, batch cap, ZIP mixed with other files, no assistant
 * for media). Everything in flight lives in the intake queue, not here.
 */
type ItemStatus = "pending" | "error";

type StagedItem = {
  localId: string;
  file: File;
  status: ItemStatus;
  error?: string;
};

function intakeKindFor(file: File): IntakeKind {
  if (isRecordingFile(file)) return "media";
  if (file.name.toLowerCase().endsWith(".zip")) return "linkedin";
  return "file";
}

export type IngestFileBatch = {
  id: number;
  files: File[];
};

export function SuggestedFileDrop({
  workspaceId,
  assistantId,
  incomingBatch,
  offline = false,
  appearance = "card",
  onQueued,
}: {
  workspaceId: string;
  assistantId?: string | null;
  incomingBatch?: IngestFileBatch | null;
  offline?: boolean;
  appearance?: "card" | "dialog";
  /** The batch left for the intake queue; a hosting dialog closes on this. */
  onQueued?: () => void;
}) {
  const copy = useT();
  const t = copy.docPage.suggested;
  const pins = copy.chatApp.pins;
  const [items, setItems] = useState<StagedItem[]>([]);
  const incomingBatchId = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;
      // Size is checked at DROP time, not at "Add to brain": an oversized body
      // is dropped by the edge before any handler runs, so the request would
      // reject with a bare `TypeError: Failed to fetch` that names neither the
      // size nor the limit. Telling the user here also costs them nothing.
      // The ceiling is the durable chunked lane's 1 GiB: the intake queue
      // routes anything past the 30 MiB multipart ceiling through signed
      // 8 MiB parts and the stored-file ingest route, so a 60 MB deck is not
      // refused here any more. Explicit Brain intake treats every audio/video
      // file as a recording, including a short voice memo; media goes direct
      // to signed storage and has no ordinary-file ceiling at all.
      const media = incoming.filter(isRecordingFile);
      const ordinary = incoming.filter((file) => !isRecordingFile(file));
      const { accepted, tooLarge } = partitionByIngestSize(ordinary, MAX_STORED_FILE_BYTES);
      const acceptedSet = new Set([...media, ...accepted]);
      const acceptedInOrder = incoming.filter((file) => acceptedSet.has(file));
      const limit = formatFileSize(MAX_STORED_FILE_BYTES);
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
        const staged = acceptedInOrder.slice(0, room).map((file) => ({
          localId: crypto.randomUUID(),
          file,
          status: "pending" as const,
        }));
        const rejected = [
          ...tooLarge.map((file) => ({
            file,
            error: format(t.ingestTooLarge, { size: formatFileSize(file.size), limit }),
          })),
          ...acceptedInOrder.slice(room).map((file) => ({
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

  useEffect(() => {
    if (!incomingBatch || incomingBatchId.current === incomingBatch.id) return;
    incomingBatchId.current = incomingBatch.id;
    addFiles(incomingBatch.files);
  }, [addFiles, incomingBatch]);

  const drop = useFileDrop(addFiles, { disabled: offline });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = ""; // allow re-picking the same file
  };

  const remove = (localId: string) =>
    setItems((prev) => prev.filter((i) => i.localId !== localId));

  const clearResolved = () =>
    setItems((prev) => prev.filter((i) => i.status === "pending"));

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const hasResolved = items.some((i) => i.status === "error");

  /**
   * Validate, hand off, empty. The queue owns every request from here on; the
   * only failures this surface can still report are the ones decided before
   * anything is sent.
   */
  const addToBrain = useCallback(async () => {
    const pending = items.filter((i) => i.status === "pending");
    if (pending.length === 0 || offline) return;
    const zipItems = pending.filter((item) => intakeKindFor(item.file) === "linkedin");
    if (zipItems.length > 0 && pending.length !== 1) {
      const zipIds = new Set(zipItems.map((z) => z.localId));
      setItems((prev) =>
        prev.map((i) =>
          zipIds.has(i.localId) ? { ...i, status: "error", error: t.linkedinArchiveAlone } : i,
        ),
      );
      return;
    }
    const needsAssistant = !assistantId
      ? pending.filter((item) => intakeKindFor(item.file) === "media")
      : [];
    const refused = new Set(needsAssistant.map((m) => m.localId));
    // A file above 100 MiB is a long transfer: the cheap `File.size` probe
    // confirms it before anything is sent (the Work Bench's own sentence). A
    // declined file stays staged; nothing about it is refused.
    const declined = new Set<string>();
    for (const item of pending) {
      if (refused.has(item.localId) || item.file.size <= LARGE_FILE_CONFIRM_BYTES) continue;
      const ok = await confirmDialog({
        title: pins.largeFileTitle,
        description: format(pins.largeFileDescription, {
          fileName: item.file.name,
          size: formatFileSize(item.file.size),
        }),
        confirmLabel: pins.largeFileConfirm,
        cancelLabel: pins.largeFileCancel,
      });
      if (!ok) declined.add(item.localId);
    }
    const accepted = pending.filter(
      (item) => !refused.has(item.localId) && !declined.has(item.localId),
    );
    setItems((prev) =>
      prev
        .filter((i) => !accepted.some((a) => a.localId === i.localId))
        .map((i) =>
          refused.has(i.localId)
            ? { ...i, status: "error", error: t.ingestMediaNeedsAssistant }
            : i,
        ),
    );
    if (accepted.length === 0) return;
    enqueueIntake({
      workspaceId,
      assistantId: assistantId ?? null,
      files: accepted.map((a) => a.file),
      kind: intakeKindFor,
      t: copy,
    });
    if (refused.size === 0 && declined.size === 0) onQueued?.();
  }, [
    items,
    offline,
    workspaceId,
    assistantId,
    copy,
    pins,
    onQueued,
    t.ingestMediaNeedsAssistant,
    t.linkedinArchiveAlone,
  ]);

  return (
    <section
      {...drop.dropProps}
      className={cn(
        "relative rounded-2xl transition-colors",
        appearance === "card" ? "mt-4 border bg-card p-4" : "bg-transparent",
        drop.isDragging ? "border-primary/60 bg-primary/[0.04]" : "border-border",
      )}
    >
      <div className={cn("flex flex-wrap items-start gap-3", appearance === "dialog" && "pr-10")}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
          <FileUp className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="text-[14px] font-semibold text-foreground">{t.ingestTitle}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.ingestCaption}</p>
        </div>
        {appearance === "card" && <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={offline}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60 md:min-h-0"
        >
          {t.ingestCta}
        </button>}
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={offline}
          onChange={onPick}
          className="hidden"
          aria-hidden
        />
      </div>

      {appearance === "dialog" && (
        <button
          type="button"
          aria-label={t.ingestCta}
          onClick={() => inputRef.current?.click()}
          disabled={offline}
          className={cn(
            "mt-5 flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-4 text-sm transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            items.length > 0 ? "max-sm:min-h-11 py-3" : "min-h-40 py-6",
          )}
        >
          {items.length === 0 && <FileUp className="size-6 text-muted-foreground" aria-hidden />}
          {items.length === 0 && <span className="font-medium text-foreground">{t.ingestDropHint}</span>}
          <span className="text-primary underline underline-offset-4">{t.ingestCta}</span>
        </button>
      )}

      {offline && (
        <p
          role="status"
          className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100"
        >
          {t.ingestOffline}
        </p>
      )}

      {items.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border/70">
          {items.map((i) => (
            <li
              key={i.localId}
              className="flex items-center gap-2.5 py-1.5"
            >
              <StatusIcon status={i.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-foreground" title={i.file.name}>
                  {i.file.name}
                </div>
                <div className="break-words text-[11.5px] text-muted-foreground" role="status">
                  {i.status === "error" ? (
                    <span className="text-rose-600 dark:text-rose-400">{i.error ?? t.ingestFailed}</span>
                  ) : (
                    t.ingestReady
                  )}
                </div>
              </div>
              {i.status === "pending" && (
                <button
                  type="button"
                  aria-label={t.ingestRemove}
                  onClick={() => remove(i.localId)}
                  className="grid size-11 shrink-0 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground md:size-7"
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
          {hasResolved && (
            <button
              type="button"
              onClick={clearResolved}
              className="min-h-11 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground md:min-h-0"
            >
              {t.ingestClear}
            </button>
          )}
          <button
            type="button"
            onClick={() => void addToBrain()}
            disabled={pendingCount === 0 || offline}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-action px-3 py-1.5 text-[12.5px] font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:bg-foreground/10 disabled:text-muted-foreground md:min-h-0"
          >
            {t.ingestAdd}
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
  if (status === "error")
    return <AlertCircle className="size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />;
  return <FileUp className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />;
}
