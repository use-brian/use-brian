"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { BrainRow } from "@/lib/api/brain";
import { useWorkspaces } from "@/contexts/workspace-context";
import { UnverifiedNudge } from "@/components/brain/unverified-nudge";
import type { BrainPrimitive as InboxPrimitive } from "@/lib/api/brain-inbox";

type Props = {
  row: BrainRow;
  /** When true (and the row is unverified), the nudge expands inline
   *  below the row. */
  showNudge?: boolean;
  /** Row click opens the in-page detail drawer. Owned by the parent
   *  list — the row is always a button now (no per-primitive route). */
  onSelect?: (row: BrainRow) => void;
};

/** Map a brain-list row kind to the brain-inbox primitive discriminator
 *  used by verify / delete / explain routes. Returns null for kinds
 *  that aren't primitives (e.g. `sessions`) — those don't get a nudge. */
function brainKindToInboxPrimitive(kind: BrainRow["kind"]): InboxPrimitive | null {
  switch (kind) {
    case "memories":
      return "memory";
    case "tasks":
      return "task";
    case "files":
      return "workspace_file";
    case "people":
    case "person":
      return "contact";
    case "companies":
    case "company":
      return "company";
    case "deals":
    case "deal":
      return "deal";
    case "knowledge":
      // KB chunks aren't user-verifiable through this route — they sync
      // from external sources. Skip nudge.
      return null;
    case "sessions":
      return null;
    default:
      // Unknown entity kinds (project, product) map to the generic
      // `entity` primitive.
      return "entity";
  }
}

/**
 * Inline SVG indicator per row kind. Kept tiny + monochrome so the row
 * list reads as a quiet uniform stack rather than an emoji parade.
 */
function KindIcon({ kind }: { kind: BrainRow["kind"] }) {
  const props = {
    width: 16,
    height: 16,
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
    case "person":
    case "people":
      return (
        <svg {...props}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
        </svg>
      );
    case "company":
    case "companies":
      return (
        <svg {...props}>
          <rect x="4" y="4" width="16" height="16" rx="1" />
          <path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1" />
        </svg>
      );
    case "deal":
    case "deals":
      return (
        <svg {...props}>
          <rect x="3" y="7" width="18" height="13" rx="1.5" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M3 13h18" />
        </svg>
      );
    case "knowledge":
      return (
        <svg {...props}>
          <path d="M4 4h12a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H4z" />
          <path d="M4 4v16" />
        </svg>
      );
    case "memories":
      return (
        <svg {...props}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
        </svg>
      );
    case "files":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "sessions":
      return (
        <svg {...props}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "tasks":
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M8 9l2 2 4-4M8 15l2 2 4-4" />
        </svg>
      );
    case "repository":
      return (
        <svg {...props}>
          <path d="M4 4a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" />
          <path d="M4 18a2 2 0 0 1 2-2h12" />
          <path d="M9 7h5" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
  }
}

export function EntityRow({ row, showNudge = true, onSelect }: Props) {
  // Local "this row has been resolved by the user" state — when set,
  // hides the nudge and dims the row to give visual confirmation.
  // (We don't refetch the parent list here; the parent owns that.)
  const [resolved, setResolved] = useState<"verified" | "deleted" | null>(null);
  const { activeId } = useWorkspaces();
  const primitive = brainKindToInboxPrimitive(row.kind);
  const nudgeEligible =
    showNudge && row.hasPending && primitive !== null && activeId && !resolved;
  const isInteractive = Boolean(onSelect);

  const rowBodyClass = cn(
    "flex items-center gap-3 px-4 py-3 transition-colors w-full text-left",
    isInteractive && "hover:bg-muted/40",
    resolved && "opacity-50",
  );

  const rowBody = (
    <>
      <KindIcon kind={row.kind} />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{row.name}</div>
        {row.summary && (
          <div className="text-xs text-muted-foreground truncate">{row.summary}</div>
        )}
      </div>
      {row.hasPending && !resolved && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
          aria-label="Pending review"
        >
          Pending
        </span>
      )}
      {resolved === "verified" && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium bg-green-500/10 text-green-700 dark:text-green-400 border border-green-500/20"
          aria-label="Confirmed"
        >
          Confirmed
        </span>
      )}
      {resolved === "deleted" && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium bg-muted text-muted-foreground border border-border"
          aria-label="Deleted"
        >
          Deleted
        </span>
      )}
      {row.sensitivity && (
        <span
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border",
            row.sensitivity === "confidential" &&
              "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
            row.sensitivity === "restricted" &&
              "bg-red-700/10 text-red-800 dark:text-red-300 border-red-700/30",
            row.sensitivity === "internal" &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
            row.sensitivity === "public" &&
              "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
          )}
        >
          {row.sensitivity}
        </span>
      )}
    </>
  );

  return (
    <div className="border-b border-border">
      {onSelect ? (
        <button type="button" onClick={() => onSelect(row)} className={rowBodyClass}>
          {rowBody}
        </button>
      ) : (
        <div className={rowBodyClass}>{rowBody}</div>
      )}

      {/* Inline nudge — review actions without leaving the brain
          list. Wrapped in mx-4 mb-3 so it indents under the row,
          giving the visual cue "this belongs to the row above". */}
      {nudgeEligible && primitive && activeId && (
        <div className="mx-4 mb-3">
          <UnverifiedNudge
            workspaceId={activeId}
            primitive={primitive}
            rowId={row.id}
            rowLabel={row.name}
            rowDetail={row.summary ?? null}
            savingAssistantName={null}
            variant="row"
            onResolved={(action) => setResolved(action)}
          />
        </div>
      )}
    </div>
  );
}
