"use client";

/** Controlled presentation only. Callers own validation, transport and authority.
 * [COMP:app-web/question-answer-form]
 */
import { useId, useRef, type ReactNode } from "react";
import type { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { isPhoneViewport } from "@/lib/viewport";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";

type QuestionCopy = Pick<ReturnType<typeof useT>["chat"]["pendingQuestion"], "heading" | "placeholder" | "submit" | "submitting">;

type AnswerInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus: boolean;
  label: string;
  placeholder: string;
};

function AnswerInput({ value, onChange, onSubmit, disabled, autoFocus, label, placeholder }: AnswerInputProps) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrowTextarea(ref, value);
  return <>
    <label htmlFor={id} className="sr-only">{label}</label>
    <textarea
      id={id} ref={ref} value={value} onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!disabled) onSubmit();
        }
      }}
      placeholder={placeholder} rows={2} autoFocus={autoFocus && !isPhoneViewport()} disabled={disabled}
      className={cn(
        "w-full min-h-[3.25rem] max-h-40 resize-none overflow-y-auto rounded-md border border-border bg-background",
        "px-2.5 py-1.5 text-[16px] leading-relaxed outline-none md:text-[13px]",
        "placeholder:text-muted-foreground disabled:opacity-60",
      )}
    />
  </>;
}

export function QuestionAnswerForm({
  dict, value, onChange, onSubmit, canSubmit, disabled = false, submitting = false,
  autoFocus = false, ready = true, showInput = true, selectionControls, answerLabel,
  cancel, error, ariaLabel,
}: {
  dict: QuestionCopy;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  disabled?: boolean;
  submitting?: boolean;
  autoFocus?: boolean;
  ready?: boolean;
  showInput?: boolean;
  selectionControls?: ReactNode;
  answerLabel?: string;
  cancel?: { label: string; onClick: () => void };
  error?: string | null;
  ariaLabel?: string;
}) {
  const locked = disabled || submitting;
  const send = () => { if (ready && !locked && canSubmit) onSubmit(); };
  return <form className="space-y-2" aria-label={ariaLabel ?? dict.heading} onSubmit={(event) => { event.preventDefault(); send(); }}>
    <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">{dict.heading}</div>
    {ready && <>
      {selectionControls}
      {showInput && <AnswerInput value={value} onChange={onChange} onSubmit={send} disabled={locked}
        autoFocus={autoFocus} label={answerLabel ?? dict.placeholder} placeholder={dict.placeholder} />}
    </>}
    {error && <div className="text-xs text-destructive">{error}</div>}
    {ready && <div className="flex items-center justify-between gap-2">
      {cancel && <button type="button" onClick={cancel.onClick} disabled={locked}
        className="min-h-8 max-sm:min-h-11 rounded-md px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed">
        {cancel.label}
      </button>}
      <button type="submit" disabled={locked || !canSubmit}
        className="ml-auto min-h-8 max-sm:min-h-11 rounded-md bg-action px-3 py-1 text-[12px] font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:opacity-50 disabled:cursor-not-allowed">
        {submitting ? dict.submitting : dict.submit}
      </button>
    </div>}
  </form>;
}
