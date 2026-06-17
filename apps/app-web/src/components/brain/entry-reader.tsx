"use client";

// [COMP:app-web/entry-reader]
/**
 * Entry reader shell — the generic **document + rail** reading surface
 * for brain entries (`/w/[workspaceId]/brain/entry/[kind]/[id]`).
 *
 * Kind-agnostic by design: the page composes a per-kind document column
 * (rendered markdown for knowledge, memory detail, …) and a per-kind
 * rail (connections graph, metadata, actions) into this one layout, so
 * reviewing any brain entry feels like reading a doc page — the same
 * grammar as the skill editor (`brain/skills/[skillRowId]`): shared
 * `BrainTopbar` (breadcrumb tail = entry title, section = Entries),
 * `max-w-6xl` grid with a 300px rail, borderless tinted-wash rail cards.
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Reader surface".
 */

import { cn } from "@/lib/utils";
import { BrainTopbar } from "@/components/brain/brain-topbar";

type Props = {
  workspaceId: string;
  /** Breadcrumb tail — usually the entry title (+ a badge). */
  tail: React.ReactNode;
  /** Right topbar cluster (quiet actions). */
  topbarRight?: React.ReactNode;
  /**
   * Remount key for the content grid. Entry-to-entry navigation
   * (wikilinks, related list, connections graph) changes the key once
   * the NEXT entry has loaded, replaying the entrance animation — the
   * topbar above stays put, only the document + rail transition.
   */
  contentKey?: string;
  /**
   * True while the next entry is in flight. The CURRENT content stays
   * rendered but dims and stops accepting clicks — a crossfade instead
   * of a blank loading flash between entries.
   */
  stale?: boolean;
  /** The document column. */
  children: React.ReactNode;
  /** The properties rail. */
  rail: React.ReactNode;
};

export function EntryReader({
  workspaceId,
  tail,
  topbarRight,
  contentKey,
  stale = false,
  children,
  rail,
}: Props) {
  return (
    <>
      <BrainTopbar
        workspaceId={workspaceId}
        tail={tail}
        tailSection="entries"
        right={topbarRight}
      />
      <div
        key={contentKey}
        className={cn(
          "mx-auto w-full max-w-6xl px-6 py-8 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10",
          // Entrance — same animate-in family as the detail drawer.
          "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out",
          "transition-opacity",
          stale && "pointer-events-none opacity-40",
        )}
      >
        <main className="min-w-0">{children}</main>
        <aside className="mt-10 flex flex-col gap-4 text-sm lg:mt-0">{rail}</aside>
      </div>
    </>
  );
}

/** Borderless tinted-wash rail card — same family as the skill editor's
 *  rail (the wash IS the card boundary, no border). */
export function ReaderRailCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg bg-muted/40 px-3 py-2.5">
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** One compact label/value property row for the rail's details list. */
export function ReaderPropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-foreground">{children}</dd>
    </div>
  );
}

/** Sensitivity chip — mirrors the detail drawer's tier colouring. */
export function SensitivityBadge({ tier }: { tier: string }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
        tier === "confidential" &&
          "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400",
        tier === "restricted" &&
          "border-red-700/30 bg-red-700/10 text-red-800 dark:text-red-300",
        tier === "internal" &&
          "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tier === "public" &&
          "border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-400",
      )}
    >
      {tier}
    </span>
  );
}
