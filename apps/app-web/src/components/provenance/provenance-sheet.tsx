"use client";

/**
 * Right-sliding provenance side-sheet for the company-brain UI revamp.
 *
 * One reusable sheet, many entry points: chat citation pills, Brain row
 * clicks, Workflow approval banners, pending-change badges. Body is
 * kind-polymorphic (memory / kb / contact / company / deal / file / task)
 * sharing a common shell.
 *
 * Spec: docs/plans/company-brain/ui.md → §Named UI patterns → Provenance
 * side-sheet + §J3 deep walk.
 *
 * Drill-down rules:
 *   - Inline-expand for one level: memory → its source episodes
 *   - Navigate-replace for deeper drill: episode → other derived rows
 *   - Never stacked sheets
 *
 * v1 SCOPE NOTE: the verb action panel (retract / edit / mark-wrong /
 * jump-to-entity) is rendered conditionally based on the row's source.
 * The full verb-availability matrix from `ui.md` is centralized in
 * `availableActions()` below.
 */

import { useEffect } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import type { ProvenanceRow, Episode } from "@/lib/api/provenance";

type Props = {
  /**
   * The row whose provenance is being inspected. Null = sheet closed.
   * Callers control open state by setting/clearing this prop.
   */
  row: ProvenanceRow | null;
  /**
   * Source episode (if available). Loaded lazily by the parent — the
   * sheet renders a collapsible card if present.
   */
  episode?: Episode | null;
  onClose: () => void;
  onRetract?: (row: ProvenanceRow) => void;
  onEdit?: (row: ProvenanceRow) => void;
  onMarkWrong?: (row: ProvenanceRow) => void;
  onJumpToEntity?: (row: ProvenanceRow) => void;
};

function availableActions(row: ProvenanceRow): {
  retract: boolean;
  edit: boolean;
  markWrong: boolean;
  jumpToEntity: boolean;
} {
  // Mirrors the verb-availability matrix in ui.md.
  // Synced KB entries are read-only; everything else allows the standard
  // verb set. The "synced" determination is approximated here via
  // `derivedFromEpisodeIds` absence + kind — refine when the backend
  // surfaces a `source` discriminator on the row.
  const isSyncedKb = row.kind === "kb_entry" || row.kind === "kb_chunk";
  return {
    retract: !isSyncedKb,
    edit: !isSyncedKb,
    markWrong: true,
    jumpToEntity: ["contact", "company", "deal", "entity"].includes(row.kind),
  };
}

export function ProvenanceSheet({
  row,
  episode,
  onClose,
  onRetract,
  onEdit,
  onMarkWrong,
  onJumpToEntity,
}: Props) {
  const t = useT();

  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, onClose]);

  if (!row) return null;

  const actions = availableActions(row);

  const authorshipLine = (() => {
    const a = row.authorship;
    const dateStr = new Date(a.createdAt).toLocaleDateString();
    if (a.createdByAssistantId) {
      return format(t.chrome.provenanceSheet.createdByAssistant, {
        assistantName: a.createdByAssistantId,
      }) + " " + format(t.chrome.provenanceSheet.createdAt, { date: dateStr });
    }
    return t.chrome.provenanceSheet.createdByUser + " " + format(t.chrome.provenanceSheet.createdAt, { date: dateStr });
  })();

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-background/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      {/* Sheet */}
      <aside
        role="dialog"
        aria-label={t.chrome.provenanceSheet.title}
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50",
          "w-full sm:w-[420px] bg-popover border-l border-border shadow-2xl",
          "flex flex-col overflow-hidden",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <KindIcon kind={row.kind} />
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">{row.title}</div>
              <div className="text-xs text-muted-foreground">
                {t.chrome.provenanceSheet.source}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.chrome.settingsModal.close}
            className="h-7 w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {/* Authorship */}
          <div className="text-xs text-muted-foreground">{authorshipLine}</div>

          {/* Sensitivity + valid window */}
          <div className="flex flex-wrap gap-2 text-xs">
            <SensitivityBadge sensitivity={row.sensitivity} />
            {row.validFrom && (
              <span className="text-muted-foreground">
                {t.chrome.provenanceSheet.validFrom} {new Date(row.validFrom).toLocaleDateString()}
              </span>
            )}
            {row.validTo && (
              <span className="text-muted-foreground">
                {t.chrome.provenanceSheet.validTo}{" "}
                {row.validTo ? new Date(row.validTo).toLocaleDateString() : t.chrome.provenanceSheet.validOpen}
              </span>
            )}
          </div>

          {/* Body content */}
          {row.body && (
            <div className="text-sm whitespace-pre-wrap">{row.body}</div>
          )}

          {/* Source episode */}
          {episode && (
            <details className="rounded-md border border-border bg-card/50 p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {t.chrome.provenanceSheet.viewEpisode}
              </summary>
              <div className="mt-2 text-xs text-muted-foreground space-y-1">
                <div>{episode.summary ?? "—"}</div>
                <div>
                  {new Date(episode.occurredAt).toLocaleString()} · {episode.sourceKind}
                </div>
              </div>
            </details>
          )}

          {/* Aggregated grounding */}
          {row.derivedFromEpisodeIds && row.derivedFromEpisodeIds.length > 0 && (
            <details className="rounded-md border border-border bg-card/50 p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {format(t.chrome.provenanceSheet.basedOnObservations, {
                  count: row.derivedFromEpisodeIds.length,
                })}
              </summary>
              <ul className="mt-2 text-xs text-muted-foreground space-y-1">
                {row.derivedFromEpisodeIds.map((id) => (
                  <li key={id} className="font-mono">{id}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        {/* Action bar */}
        <div className="border-t border-border p-3 flex flex-wrap gap-2">
          {actions.retract && onRetract && (
            <button
              type="button"
              onClick={() => onRetract(row)}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted transition-colors"
            >
              {t.chrome.provenanceSheet.actions.retract}
            </button>
          )}
          {actions.edit && onEdit && (
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted transition-colors"
            >
              {t.chrome.provenanceSheet.actions.edit}
            </button>
          )}
          {actions.markWrong && onMarkWrong && (
            <button
              type="button"
              onClick={() => onMarkWrong(row)}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted transition-colors"
            >
              {t.chrome.provenanceSheet.actions.markWrong}
            </button>
          )}
          {actions.jumpToEntity && onJumpToEntity && (
            <button
              type="button"
              onClick={() => onJumpToEntity(row)}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted transition-colors ml-auto"
            >
              {t.chrome.provenanceSheet.actions.jumpToEntity}
            </button>
          )}
          {!actions.retract && (
            <span className="text-xs text-muted-foreground">
              {t.chrome.provenanceSheet.retractUnavailable}
            </span>
          )}
        </div>
      </aside>
    </>
  );
}

function KindIcon({ kind }: { kind: ProvenanceRow["kind"] }) {
  const baseProps = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "text-muted-foreground shrink-0",
  };
  switch (kind) {
    case "memory":
      return (
        <svg {...baseProps}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
        </svg>
      );
    case "kb_chunk":
    case "kb_entry":
      return (
        <svg {...baseProps}>
          <path d="M4 4h12a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H4z" />
          <path d="M4 4v16" />
        </svg>
      );
    case "entity":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="3" />
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="5" cy="18" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" />
        </svg>
      );
    case "task":
      return (
        <svg {...baseProps}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M8 9l2 2 4-4M8 15l2 2 4-4" />
        </svg>
      );
    case "file":
      return (
        <svg {...baseProps}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "deal":
      return (
        <svg {...baseProps}>
          <rect x="3" y="7" width="18" height="13" rx="1.5" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      );
    case "contact":
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
        </svg>
      );
    case "company":
      return (
        <svg {...baseProps}>
          <rect x="4" y="4" width="16" height="16" rx="1" />
          <path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1" />
        </svg>
      );
    default:
      return (
        <svg {...baseProps}>
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
  }
}

function SensitivityBadge({ sensitivity }: { sensitivity: ProvenanceRow["sensitivity"] }) {
  const color = {
    public: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
    internal: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    confidential: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
    restricted: "bg-red-700/10 text-red-800 dark:text-red-300 border-red-700/30",
  }[sensitivity];
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border", color)}>
      {sensitivity}
    </span>
  );
}
