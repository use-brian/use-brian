"use client";

/**
 * Workspace-wide fallback for files dropped outside an explicit contextual
 * drop surface. The drop only stages files; the shared intake panel owns the
 * deliberate Add to brain action and media pre-flight confirmation.
 *
 * Spec: docs/architecture/features/files.md -> "Direct ingest".
 * [COMP:app-web/workspace-file-drop]
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FileUp, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useFileDrop } from "@/lib/use-file-drop";
import { requestSidebarClose } from "@/lib/sidebar-close";
import {
  SuggestedFileDrop,
  type IngestFileBatch,
} from "@/components/doc/suggested-file-drop";

export function WorkspaceFileDropBoundary({
  workspaceId,
  assistantId,
  offline = false,
  className,
  children,
}: {
  workspaceId: string;
  assistantId?: string | null;
  offline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const t = useT().docPage.suggested;
  const batchId = useRef(0);
  const [batch, setBatch] = useState<IngestFileBatch | null>(null);
  const [open, setOpen] = useState(false);

  const stageFiles = useCallback((files: FileList) => {
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) return;
    batchId.current += 1;
    setBatch({ id: batchId.current, files: nextFiles });
    requestSidebarClose();
    setOpen(true);
  }, []);

  const drop = useFileDrop(stageFiles, { fallback: true });

  // Always closable: the review never owns an in-flight request. "Add to
  // brain" hands the batch to the intake queue and the tray in the bottom bar
  // carries the wait, so the modal is for choosing, not waiting.
  const onOpenChange = (next: boolean) => {
    if (next) requestSidebarClose();
    setOpen(next);
    if (!next) setBatch(null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <div {...drop.dropProps} className={cn(className)}>
        {children}

        {drop.isDragging && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-background/75 px-6 backdrop-blur-sm"
          >
            <div className="flex max-w-sm items-center gap-3 rounded-2xl border border-primary/30 bg-card px-5 py-4 text-primary shadow-xl ring-1 ring-primary/10">
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10">
                <FileUp className="size-5" aria-hidden />
              </span>
              <span className="text-sm font-semibold">{t.ingestDrop}</span>
            </div>
          </div>
        )}

        <Dialog.Portal>
          {/* The review dialog stays on the shared z-50 modal layer: the recording
              cost + blueprint confirm is the global confirmDialog, a body-portaled
              z-50 AlertDialog that lands above its caller by DOM order alone. At
              z-[70] this backdrop covered that confirm, so every audio/video drop
              sat on "Checking recording..." with nothing to click. Only the
              transient, pointer-events-none drag overlay above may go higher. */}
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl ring-1 ring-foreground/5 transition-all duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
            <Dialog.Title className="sr-only">{t.ingestTitle}</Dialog.Title>
            <Dialog.Description className="sr-only">{t.ingestCaption}</Dialog.Description>
            <button
              type="button"
              aria-label={t.ingestDialogClose}
              onClick={() => onOpenChange(false)}
              className="absolute right-3 top-3 z-10 grid size-11 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:size-8"
            >
              <X className="size-4" aria-hidden />
            </button>
            <SuggestedFileDrop
              key={batch?.id ?? "picker"}
              workspaceId={workspaceId}
              assistantId={assistantId}
              incomingBatch={batch}
              offline={offline}
              appearance="dialog"
              onQueued={() => onOpenChange(false)}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </div>
    </Dialog.Root>
  );
}

/** Compact entry point to the same review dialog as a workspace file drop. */
export function WorkspaceFileIntakeButton({ disabled = false }: { disabled?: boolean }) {
  const t = useT().docPage.suggested;
  return (
    <Dialog.Trigger
      disabled={disabled}
      aria-label={t.ingestOpen}
      title={t.ingestOpen}
      className="inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 md:h-7 md:w-auto md:px-2.5"
    >
      <FileUp className="size-4 md:size-3.5" aria-hidden />
      <span className="hidden md:inline">{t.ingestOpen}</span>
    </Dialog.Trigger>
  );
}
