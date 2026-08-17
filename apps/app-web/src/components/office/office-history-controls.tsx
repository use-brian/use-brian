"use client";

/** Buttons over the editor shell's sole Yjs history manager. [COMP:app-web/office-history] */
import { Redo2, Undo2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";

export function OfficeHistoryControls({ canUndo, canRedo, onUndo, onRedo }: { canUndo: boolean; canRedo: boolean; onUndo(): void; onRedo(): void }) {
  const t = useT().office;
  return <div className="flex items-center gap-0.5" role="toolbar" aria-label={t.historyControls}>
    <button type="button" disabled={!canUndo} onClick={onUndo} aria-label={t.undo} title={`${t.undo} (${t.undoShortcut})`} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"><Undo2 className="size-4" /></button>
    <button type="button" disabled={!canRedo} onClick={onRedo} aria-label={t.redo} title={`${t.redo} (${t.redoShortcut})`} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"><Redo2 className="size-4" /></button>
  </div>;
}
