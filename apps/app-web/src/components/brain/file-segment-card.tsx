"use client";

/**
 * Brain fallback card (app-web) — graceful rendering for retrieval-search
 * primitives the grouped view has no first-class single-line row for.
 *
 * The Brain grouped view (`grouped-view.tsx`) renders each `/api/brain/list`
 * row as a single-line entity/content button keyed by its primitive `kind`,
 * which assumes a meaningful `name`. The general brain `search()` surface can
 * return primitives that predate this build:
 *   - `file_segment` — a chunk of an ingested document
 *     (docs/architecture/brain/file-artifacts.md §Phase 1.4), whose content is a
 *     file name + heading breadcrumb + snippet, not a `name`.
 *   - any FUTURE primitive a newer server ships before app-web learns it.
 *
 * `BrainFallbackCard` is the one defensive renderer for that class (the
 * "unknown primitive" default of the grouped view's row switch):
 *   - `file_segment` → the document-excerpt card (file name, heading
 *     breadcrumb, snippet). Inert on click — there is no per-segment detail
 *     surface, and the detail drawer can't resolve a segment to an inbox row.
 *   - anything else → a generic card showing the row's name (or an
 *     "Untitled item" fallback) + summary, so a primitive this build predates
 *     still renders something, never a blank row or a crash.
 *
 * Matches the grey card language of the grouped view rows (no blue chrome;
 * `bg-card` + `border-border`, sensitivity tints copied from the same rows).
 *
 * [COMP:app-web/brain-fallback-card]
 */

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import type { BrainRow, Sensitivity } from "@/lib/api/brain";

/** Heading-path breadcrumb separator — a glyph, not translatable copy (the
 *  same treatment the grouped view gives its dot separators). */
const HEADING_SEP = " › ";

/** Sensitivity badge — the exact tints the grouped view's content rows use,
 *  so a fallback card sits visually beside them. */
function SensitivityBadge({ sensitivity }: { sensitivity: Sensitivity }) {
  return (
    <span
      className={cn(
        "shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border",
        sensitivity === "confidential" &&
          "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
        sensitivity === "restricted" &&
          "bg-red-700/10 text-red-800 dark:text-red-300 border-red-700/30",
        sensitivity === "internal" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
        sensitivity === "public" &&
          "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
      )}
    >
      {sensitivity}
    </span>
  );
}

export function BrainFallbackCard({ row }: { row: BrainRow }) {
  const t = useT();
  const copy = t.brainPage.fallbackCard;

  if (row.kind === "file_segment") {
    const fileName =
      row.fileName?.trim() || row.name?.trim() || copy.documentFallback;
    const breadcrumb = (row.headingPath ?? [])
      .map((h) => h.trim())
      .filter(Boolean)
      .join(HEADING_SEP);
    const snippet = row.snippet?.trim() || row.summary?.trim() || "";
    return (
      <div className="w-full flex flex-col gap-1 px-3 py-2 rounded-md border border-border bg-card">
        <div className="flex items-center gap-2">
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border bg-muted text-muted-foreground border-border">
            {copy.documentExcerpt}
          </span>
          <span className="flex-1 min-w-0 text-sm font-medium truncate">
            {fileName}
          </span>
          {row.sensitivity && (
            <SensitivityBadge sensitivity={row.sensitivity} />
          )}
        </div>
        {breadcrumb && (
          <div className="text-[11px] text-muted-foreground truncate">
            {breadcrumb}
          </div>
        )}
        {snippet && (
          <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
            {snippet}
          </p>
        )}
      </div>
    );
  }

  // Unknown / future primitive — generic defensive card. Inert (no drawer:
  // the detail drawer can't resolve a primitive this build doesn't model), and
  // never blank: the row name or an "Untitled item" fallback always renders.
  const label = row.name?.trim() || copy.untitled;
  const summary = row.summary?.trim() || "";
  return (
    <div className="w-full flex flex-col gap-0.5 px-3 py-2 rounded-md border border-border bg-card">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 text-sm font-medium truncate">
          {label}
        </span>
        {row.sensitivity && <SensitivityBadge sensitivity={row.sensitivity} />}
      </div>
      {summary && (
        <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
          {summary}
        </p>
      )}
    </div>
  );
}
