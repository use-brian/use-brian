"use client";

/**
 * UnverifiedNudge — inline review affordance for brain rows that
 * haven't been confirmed by the user yet (`verified_by_user_id IS NULL`).
 *
 * Surfaces wherever the brain view renders unconfirmed entries:
 * - Brain list page (each row)
 * - Brain entity detail page (banner at top of the panel)
 *
 * Wraps the same routes the Brain inbox uses — verify / delete /
 * explain / inspection-session — so the actions taken here are
 * indistinguishable from acting on the inbox surface. Goal: a user
 * who lands on an entity from search or follow-up doesn't have to
 * detour through the inbox to confirm it.
 *
 * Spec: docs/architecture/brain/corrections.md.
 *
 * Ported verbatim from apps/web (docs/plans/doc-web-app-consolidation.md
 * §5a — brain surface migration). Dependencies (brain-inbox SDK,
 * brain-events, InspectionDrawer) all resolve in app-web unchanged.
 *
 * [COMP:app-web/unverified-nudge]
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { requestBrainRefresh } from "@/lib/brain-events";
import {
  deleteBrainRow,
  explainBrainRow,
  verifyBrainRow,
  type BrainPrimitive,
  type ExplainContext,
} from "@/lib/api/brain-inbox";
import { InspectionDrawer } from "@/components/memories/inspection-drawer";

type Variant = "row" | "banner";

type Props = {
  workspaceId: string;
  /** Primitive kind for the row being nudged. */
  primitive: BrainPrimitive;
  rowId: string;
  /** Short label rendered in the inspection drawer header (memory summary, entity name, etc.). */
  rowLabel: string;
  /** Optional second line for the drawer (memory detail, entity attribute summary). */
  rowDetail?: string | null;
  /** Saving assistant name for the drawer (falls back to "Assistant"). */
  savingAssistantName?: string | null;
  /** Compact `row` variant for use inside list rows; spacious `banner`
   *  variant for use atop a detail page. */
  variant?: Variant;
  /** Called after a successful resolve so the parent can drop/update
   *  the row from the local list. */
  onResolved?: (action: "verified" | "deleted") => void;
  /** Optional className for layout overrides. */
  className?: string;
};

export function UnverifiedNudge({
  workspaceId,
  primitive,
  rowId,
  rowLabel,
  rowDetail,
  savingAssistantName,
  variant = "row",
  onResolved,
  className,
}: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "confirm-delete">("view");
  const [whyOpen, setWhyOpen] = useState(false);
  const [whyLoading, setWhyLoading] = useState(false);
  const [whyContext, setWhyContext] = useState<ExplainContext | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function handleConfirm(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    const result = await verifyBrainRow(workspaceId, primitive, rowId);
    setBusy(false);
    if (result.ok) {
      onResolved?.("verified");
      // Keep the rest of the brain page (list row, facets, graph,
      // unconfirmed count) in sync — the local `setResolved` dim is just
      // instant feedback on this nudge.
      requestBrainRefresh(workspaceId);
    } else {
      setError(result.error);
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    const result = await deleteBrainRow(workspaceId, primitive, rowId);
    setBusy(false);
    if (result.ok) {
      onResolved?.("deleted");
      // Keep the rest of the brain page (list row, facets, graph,
      // unconfirmed count) in sync — the local `setResolved` dim is just
      // instant feedback on this nudge.
      requestBrainRefresh(workspaceId);
    } else {
      setError(result.error);
    }
  }

  async function handleOpenWhy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setWhyOpen((open) => !open);
    if (!whyContext && !whyLoading) {
      setWhyLoading(true);
      const ctx = await explainBrainRow(workspaceId, primitive, rowId);
      setWhyContext(ctx);
      setWhyLoading(false);
    }
  }

  const isBanner = variant === "banner";

  return (
    <>
      <div
        className={cn(
          isBanner
            ? "flex flex-col gap-3 p-4 rounded-md border border-amber-500/30 bg-amber-500/5"
            : "flex flex-col gap-2 px-3 py-2 border-l-2 border-amber-500/40 bg-amber-500/5",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Lead line — explains why the nudge is here */}
        <div className={cn("flex items-start gap-2", isBanner ? "text-sm" : "text-xs")}>
          <svg
            width={isBanner ? 16 : 14}
            height={isBanner ? 16 : 14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
            className="text-amber-600 dark:text-amber-400 shrink-0 mt-[2px]"
          >
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">
              {isBanner ? t.brainNudge.bannerHeading : t.brainNudge.rowHeading}
            </div>
            {isBanner && (
              <p className="text-xs text-muted-foreground mt-0.5">{t.brainNudge.bannerBody}</p>
            )}
          </div>
        </div>

        {/* Inline confirm-delete state */}
        {mode === "confirm-delete" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-red-600 dark:text-red-400">{t.brainNudge.deleteConfirmBody}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={handleDelete}
                className="text-xs px-3 py-1.5 rounded-md bg-red-500 text-white hover:opacity-90 disabled:opacity-50"
              >
                {t.brainNudge.deleteConfirmAction}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMode("view");
                  setError(null);
                }}
                className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
              >
                {t.brainNudge.cancel}
              </button>
            </div>
          </div>
        )}

        {/* Action row */}
        {mode === "view" && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleConfirm}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {t.brainNudge.confirm}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setError(null);
                setMode("confirm-delete");
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              {t.brainNudge.delete}
            </button>
            <button
              type="button"
              onClick={handleOpenWhy}
              aria-expanded={whyOpen}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
              </svg>
              {whyOpen ? t.brainNudge.hideWhy : t.brainNudge.why}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDrawerOpen(true);
              }}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {t.brainNudge.ask}
            </button>
          </div>
        )}

        {whyOpen && (
          <div className="flex flex-col gap-1 border-l-2 border-border pl-3 text-xs">
            {whyLoading && <div className="text-muted-foreground">{t.brainNudge.loading}</div>}
            {!whyLoading && !whyContext && (
              <div className="text-muted-foreground">{t.brainNudge.whyUnavailable}</div>
            )}
            {!whyLoading && whyContext && whyContext.messages.length > 0 && (
              <>
                <div className="text-muted-foreground italic">
                  {whyContext.savedByAssistantName
                    ? `Saved by ${whyContext.savedByAssistantName}.`
                    : t.brainNudge.savedByAssistant}
                </div>
                {whyContext.messages.slice(0, 3).map((m) => (
                  <div key={m.id} className="text-foreground">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
                      {m.role}
                    </span>
                    {typeof m.content === "string"
                      ? m.content.slice(0, 180)
                      : JSON.stringify(m.content).slice(0, 180)}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>

      {drawerOpen && (
        <InspectionDrawer
          workspaceId={workspaceId}
          primitive={primitive}
          rowId={rowId}
          memorySummary={rowLabel}
          memoryDetail={rowDetail ?? null}
          savingAssistantName={savingAssistantName ?? t.brainNudge.savedByAssistant}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}
