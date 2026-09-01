"use client";

/**
 * The caption editor (feed-revamp.md §8a, D16).
 *
 * A borderless, auto-growing body in the doc type scale with idle autosave, a
 * per-platform character counter, and a small portable formatting toolbar.
 * Formatting is stored as Markdown-compatible text rather than opaque editor
 * JSON, so old drafts, assistant proposals, provider delivery, and plain-text
 * clipboard fallbacks all keep one canonical body.
 *
 * Autosave is idle-debounced rather than per-keystroke so a long caption is
 * one write, not eighty, and it flushes on blur and on unmount so a
 * navigation mid-sentence never loses the edit.
 *
 * [COMP:app-web/caption-editor]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bold, Italic, List, ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { counterState } from "@/lib/feed-post-versions";

/** Idle window before an edit is written. Long enough to batch a sentence. */
const AUTOSAVE_IDLE_MS = 900;

export type CaptionSaveState = "idle" | "saving" | "saved" | "error";

export type CaptionFormatting = "bold" | "italic" | "bullet" | "numbered";

export type CaptionFormattingResult = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

/**
 * Apply the toolbar's portable Markdown shape to the current selection.
 * Inline controls wrap the selection (or place the caret between markers),
 * while list controls operate on every touched line and toggle off when the
 * complete selection already uses that list kind.
 */
export function applyCaptionFormatting(
  value: string,
  rawStart: number,
  rawEnd: number,
  formatting: CaptionFormatting,
): CaptionFormattingResult {
  const start = Math.max(0, Math.min(rawStart, value.length));
  const end = Math.max(start, Math.min(rawEnd, value.length));

  if (formatting === "bold" || formatting === "italic") {
    const marker = formatting === "bold" ? "**" : "*";
    const selected = value.slice(start, end);
    const replacement = `${marker}${selected}${marker}`;
    return {
      text: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
      selectionStart: start + marker.length,
      selectionEnd: start + marker.length + selected.length,
    };
  }

  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const targetPattern = formatting === "bullet"
    ? /^(\s*)[-*]\s+/
    : /^(\s*)\d+\.\s+/;
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const remove = nonEmpty.length > 0 && nonEmpty.every((line) => targetPattern.test(line));
  let number = 1;
  const transformed = lines.map((line) => {
    if (!line.trim()) return line;
    if (remove) return line.replace(targetPattern, "$1");
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const body = line.slice(indent.length).replace(/^(?:[-*]|\d+\.)\s+/, "");
    const prefix = formatting === "bullet" ? "- " : `${number++}. `;
    return `${indent}${prefix}${body}`;
  }).join("\n");

  return {
    text: `${value.slice(0, lineStart)}${transformed}${value.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + transformed.length,
  };
}

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

  function applyFormatting(formatting: CaptionFormatting) {
    const area = areaRef.current;
    if (!area || readOnly) return;
    const result = applyCaptionFormatting(
      value,
      area.selectionStart,
      area.selectionEnd,
      formatting,
    );
    handleChange(result.text);
    requestAnimationFrame(() => {
      const current = areaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }

  const counter = counterState(value, platform);

  return (
    <div className="space-y-2">
      {!readOnly ? (
        <div
          role="toolbar"
          aria-label={t.formattingToolbar}
          className="flex items-center gap-1 border-b border-border/60 pb-3"
        >
          {([
            ["bold", t.formatBold, Bold],
            ["italic", t.formatItalic, Italic],
            ["bullet", t.formatBulletedList, List],
            ["numbered", t.formatNumberedList, ListOrdered],
          ] as const).map(([formatting, label, Icon]) => (
            <button
              key={formatting}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFormatting(formatting)}
              aria-label={label}
              title={label}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={areaRef}
        value={value}
        readOnly={readOnly}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(event) => {
          if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key !== "b" && key !== "i") return;
          event.preventDefault();
          applyFormatting(key === "b" ? "bold" : "italic");
        }}
        onBlur={() => {
          if (deferSave) return;
          if (timerRef.current) clearTimeout(timerRef.current);
          void flush();
        }}
        placeholder={placeholder ?? t.captionPlaceholder}
        rows={4}
        className={cn(
          "w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-relaxed",
          !readOnly && "pt-3",
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
