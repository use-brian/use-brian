"use client";

/**
 * Shared micro-primitives for the workflow builder's editors, in the skill
 * editor's design language (document + properties rail, soft cards, quiet
 * hairlines — see `app/w/[workspaceId]/brain/skills/[skillRowId]/page.tsx`):
 *
 *   - `RailCard` — one soft properties group (`bg-muted/40`, tiny uppercase
 *     header inside), same face as the skill editor's rail cards.
 *   - `FieldLabel` — compact field label with an optional InfoTip carrying
 *     the long-form hint, so helper paragraphs stop stacking into a wall.
 *   - `InfoTip` — a small ⓘ that reveals its hint on hover/focus.
 *   - `Disclosure` — a stateful collapsed section for advanced options
 *     (native `<details>` fights React-controlled open state).
 *
 * Spec: docs/architecture/features/workflow.md → "Web builder UI".
 * [COMP:app-web/workflow]
 */

import { useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function RailCard({
  title,
  action,
  children,
  className,
}: {
  title: string;
  /** Optional right-aligned header affordance (e.g. an InfoTip). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg bg-muted/40 px-3 py-2.5", className)}>
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip
      label={
        <span className="block max-w-64 whitespace-normal text-left leading-snug">
          {text}
        </span>
      }
      side="top"
    >
      <button
        type="button"
        aria-label={text}
        tabIndex={-1}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8v.5" />
        </svg>
      </button>
    </Tooltip>
  );
}

/** Label row for a rail/panel field. The hint rides an InfoTip, not a
 *  paragraph — that is the whole point of the redesign. */
export function FieldLabel({
  label,
  hint,
  htmlFor,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </label>
      {hint && <InfoTip text={hint} />}
    </span>
  );
}

/** A labelled on/off row (Switch on the right) — the skill editor's
 *  assistant-toggle rhythm. */
export function SwitchRow({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <FieldLabel label={label} hint={hint} />
      {control}
    </div>
  );
}

/**
 * Collapsed-by-default section for advanced options. `defaultOpen` lets a
 * caller open it when any advanced value is already set, so a configured
 * option is never hidden behind the fold.
 */
export function Disclosure({
  label,
  summary,
  defaultOpen = false,
  children,
}: {
  label: string;
  /** Compact preview of the collapsed content (e.g. active option chips). */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("transition-transform", open && "rotate-90")}
          aria-hidden
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {label}
        {!open && summary && (
          <span className="ml-1 flex min-w-0 flex-wrap items-center gap-1 font-normal">
            {summary}
          </span>
        )}
      </button>
      {open && <div className="pt-2">{children}</div>}
    </div>
  );
}

/** Tiny neutral chip used in disclosure summaries ("Pro", "Research"). */
export function SummaryChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}
