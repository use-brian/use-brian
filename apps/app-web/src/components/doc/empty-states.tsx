"use client";

/**
 * Phase 4 — Bundle of "empty" placeholders for the Doc surface.
 *
 * Each export is a stateless centred card with:
 *   • a lucide icon in a tinted square
 *   • a title + description
 *   • an optional CTA button (when the caller wires one)
 *
 * The earlier `empty-page-state.tsx` covered just the "no view selected"
 * / "empty draft" pair. This module fills in the rest of the spec:
 *
 *   • `EmptyPagePlaceholder`     — generic "type or use chat" prompt
 *   • `EmptyDbPlaceholder`       — database with zero rows (CTA: + New row)
 *   • `EmptyDraftsSidebar`       — Drafts column when no drafts exist
 *   • `EmptySearchResults`       — no matches in search (CTA: open Cmd-K)
 *
 * All copy flows through `useT()`; English keys land in `en.ts` first
 * and are mirrored to `ja.ts` + `zh.ts` in the same commit (the
 * `Dictionary` type makes a missing key a compile error — that's the
 * gate, lean on it).
 *
 * Theme tokens only — never raw light/dark classes. Icons use the
 * `text-primary` token so the tint follows the active theme.
 *
 * [COMP:app-web/empty-states]
 */

import { Database, FileText, FolderOpen, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type CardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  cta?: { label: string; onClick: () => void } | undefined;
  className?: string;
};

/**
 * Shared chrome. Centred card with a tinted icon square, two text rows,
 * and an optional CTA button. Sizing is constrained so the card looks
 * the same whether it lands inside a flex pane or a fixed-height
 * sidebar column.
 */
function EmptyCard({ icon, title, description, cta, className }: CardProps) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-sm flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card/40 px-6 py-8 text-center",
        className,
      )}
    >
      <div
        aria-hidden
        className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
      >
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {cta ? (
        <button
          type="button"
          onClick={cta.onClick}
          className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {cta.label}
        </button>
      ) : null}
    </div>
  );
}

/** "Type to start, or use chat to fill this page" — generic page placeholder. */
export function EmptyPagePlaceholder() {
  const t = useT().docPage.empty;
  return (
    <EmptyCard
      icon={<FileText className="size-5" aria-hidden />}
      title={t.pageTitle}
      description={t.pageDesc}
    />
  );
}

/**
 * "This database has no rows yet" — surfaces inside a `block-data` when
 * the resolved A2UI payload comes back with zero rows. Optional CTA
 * fires the host's row-add handler.
 */
export function EmptyDbPlaceholder({
  onAddRow,
}: {
  onAddRow?: () => void;
}) {
  const t = useT().docPage.empty;
  return (
    <EmptyCard
      icon={<Database className="size-5" aria-hidden />}
      title={t.dbTitle}
      description={t.dbDesc}
      cta={onAddRow ? { label: t.dbCta, onClick: onAddRow } : undefined}
    />
  );
}

/** "Drafts you create with chat appear here" — Drafts column zero-state. */
export function EmptyDraftsSidebar() {
  const t = useT().docPage.empty;
  return (
    <EmptyCard
      icon={<FolderOpen className="size-5" aria-hidden />}
      title={t.draftsTitle}
      description={t.draftsDesc}
      className="px-4 py-6"
    />
  );
}

/**
 * "No pages match" — surfaces under a sidebar search input when the
 * fuzzy filter returns nothing. CTA opens the Cmd-K assistant panel.
 */
export function EmptySearchResults({
  onOpenCommandK,
}: {
  onOpenCommandK?: () => void;
}) {
  const t = useT().docPage.empty;
  return (
    <EmptyCard
      icon={<Search className="size-5" aria-hidden />}
      title={t.searchTitle}
      description={t.searchDesc}
      cta={
        onOpenCommandK
          ? { label: t.searchCta, onClick: onOpenCommandK }
          : undefined
      }
    />
  );
}
