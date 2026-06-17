"use client";

/**
 * Home "Add files to your brain" drop block. Drag files onto it (or pick them),
 * then "Add to brain" runs the deterministic ingest: POST /api/files/ingest
 * stores each file's raw bytes AND decomposes its content into entities /
 * memories / tasks (no chat turn). Per-file status renders inline.
 *
 * Reuses `useFileDrop` for drag state; the ingest SDK is `lib/api/ingest.ts`.
 * Lives on the Suggested-for-you surface, under the build bar.
 *
 * Spec: docs/architecture/features/files.md -> "Direct ingest".
 * [COMP:app-web/home-file-drop]
 */

import { useCallback, useRef, useState } from "react";
import { AlertCircle, Check, FileUp, Loader2, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useFileDrop } from "@/lib/use-file-drop";
import { ingestFiles, totalAdded, type IngestFileResult } from "@/lib/api/ingest";

/** Match the server's per-request cap (MAX_INGEST_FILES in routes/files.ts). */
const MAX_FILES = 5;

type ItemStatus = "pending" | "ingesting" | "done" | "error";

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

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;
    setItems((prev) => {
      // Keep only unresolved (pending) items plus the new batch, capped.
      const pending = prev.filter((i) => i.status === "pending");
      const staged = incoming.map((file) => ({
        localId: crypto.randomUUID(),
        file,
        status: "pending" as const,
      }));
      return [...pending, ...staged].slice(0, MAX_FILES);
    });
  }, []);

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

  const addToBrain = useCallback(async () => {
    const pending = items.filter((i) => i.status === "pending");
    if (pending.length === 0 || busy) return;
    setBusy(true);
    const pendingIds = new Set(pending.map((p) => p.localId));
    setItems((prev) =>
      prev.map((i) => (pendingIds.has(i.localId) ? { ...i, status: "ingesting" } : i)),
    );
    try {
      const results = await ingestFiles(workspaceId, pending.map((p) => p.file));
      setItems((prev) => {
        let idx = 0;
        return prev.map((i) => {
          if (!pendingIds.has(i.localId)) return i;
          const r = results[idx++];
          if (!r) return { ...i, status: "error", error: t.ingestFailed };
          return r.ok
            ? { ...i, status: "done", result: r }
            : { ...i, status: "error", error: r.error ?? t.ingestFailed };
        });
      });
    } catch (err) {
      setItems((prev) =>
        prev.map((i) =>
          pendingIds.has(i.localId)
            ? { ...i, status: "error", error: (err as Error).message }
            : i,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [items, busy, workspaceId, t.ingestFailed]);

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
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
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
  if (status === "ingesting")
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
  if (item.status === "error") return <span className="text-rose-600 dark:text-rose-400">{item.error ?? t.ingestFailed}</span>;
  const n = totalAdded(item.result?.counts);
  return n > 0 ? (
    <span className="text-emerald-600 dark:text-emerald-400">{`${n} ${t.ingestAdded}`}</span>
  ) : (
    <span className="text-emerald-600 dark:text-emerald-400">{t.ingestStored}</span>
  );
}
