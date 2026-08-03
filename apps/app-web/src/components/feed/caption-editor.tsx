"use client";

/**
 * The caption editor (feed-revamp.md §8a, D16).
 *
 * A borderless, auto-growing body in the doc type scale with idle autosave and
 * a per-platform character counter. Deliberately NOT the doc block editor: a
 * caption is one text block, and slash commands, headings, and block chrome
 * would both mislead (no platform renders them) and clutter a pane that also
 * carries the refine chat.
 *
 * Autosave is idle-debounced rather than per-keystroke so a long caption is
 * one write, not eighty, and it flushes on blur and on unmount so a
 * navigation mid-sentence never loses the edit.
 *
 * [COMP:app-web/caption-editor]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { counterState } from "@/lib/feed-post-versions";

/** Idle window before an edit is written. Long enough to batch a sentence. */
const AUTOSAVE_IDLE_MS = 900;

export type CaptionSaveState = "idle" | "saving" | "saved" | "error";

export function CaptionEditor({
  value,
  platform,
  readOnly,
  placeholder,
  deferSave = false,
  onChange,
  onSave,
}: {
  value: string;
  platform: string;
  readOnly?: boolean;
  placeholder?: string;
  /** Keep edits local until the parent commits the complete format payload. */
  deferSave?: boolean;
  /** Every keystroke; the parent owns the text. */
  onChange: (next: string) => void;
  /** Debounced commit. Returns false to surface a save error. */
  onSave: (text: string) => Promise<boolean>;
}) {
  const t = useT().feedPage.postEditor;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<CaptionSaveState>("idle");

  // The last text actually committed, so an idle tick with no net change is a
  // no-op rather than a redundant write.
  const savedRef = useRef(value);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (deferSave) return;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next === null || next === savedRef.current) return;
    setState("saving");
    const ok = await onSave(next);
    if (ok) {
      savedRef.current = next;
      setState("saved");
    } else {
      setState("error");
    }
  }, [deferSave, onSave]);

  // Flush on unmount: navigating away mid-sentence must not drop the edit.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void flush();
    };
  }, [flush]);

  // A version switch replaces the text from OUTSIDE; re-baseline so the new
  // text is not immediately re-saved as if the operator had typed it.
  //
  // But `value` is controlled, so it also changes on every keystroke as our
  // own `onChange` echoes back. Re-baselining on that echo cancelled the
  // pending write, and nothing ever saved. Compare against the last value we
  // emitted to tell the two apart.
  const emittedRef = useRef(value);
  useEffect(() => {
    if (value === emittedRef.current) return;
    emittedRef.current = value;
    savedRef.current = value;
    pendingRef.current = null;
    setState("idle");
  }, [value]);

  // Auto-grow. Reset to `auto` first or the box can only ever get taller.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  function handleChange(next: string) {
    emittedRef.current = next;
    onChange(next);
    if (deferSave) {
      pendingRef.current = null;
      setState("idle");
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    pendingRef.current = next;
    setState("idle");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), AUTOSAVE_IDLE_MS);
  }

  const counter = counterState(value, platform);

  return (
    <div className="space-y-2">
      <textarea
        ref={areaRef}
        value={value}
        readOnly={readOnly}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => {
          if (deferSave) return;
          if (timerRef.current) clearTimeout(timerRef.current);
          void flush();
        }}
        placeholder={placeholder ?? t.captionPlaceholder}
        rows={4}
        className={cn(
          "w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-relaxed",
          "placeholder:text-muted-foreground/50 focus:outline-none focus-visible:shadow-none",
          readOnly && "cursor-default opacity-80",
        )}
      />
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span
          className={cn(
            "tabular-nums",
            counter.over && "font-medium text-destructive",
            counter.near && "text-amber-700 dark:text-amber-300",
          )}
        >
          {counter.limit === null
            ? format(t.charCount, { count: String(counter.count) })
            : `${counter.count}/${counter.limit}`}
        </span>
        {counter.over ? (
          <span className="text-destructive">{t.overLimit}</span>
        ) : null}
        <span aria-hidden>·</span>
        <span aria-live="polite">
          {state === "saving"
            ? t.saving
            : state === "saved"
              ? t.saved
              : state === "error"
                ? t.saveFailed
                : deferSave
                  ? t.saveWithVersion
                  : t.autosaveHint}
        </span>
      </div>
    </div>
  );
}
