"use client";

/**
 * Review panel — the DETAIL half of the Reviews master-detail.
 *
 * The sidebar's flat pending list (master) selects an inbox item via
 * `selectedReviewKey` in `brain-surface-context`; the Brain page resolves it
 * against its own `fetchReviewItems` queue (`lib/review-queue.ts`) and
 * renders this panel in the main pane. The panel:
 *
 *   - fetches the row detail (`fetchBrainRow`) and renders the content as a
 *     readable document: title + kind/sensitivity chips, the markdown body
 *     (`body.detail` when present, the projected summary otherwise), and a
 *     compact field list for the rest of the primitive body;
 *   - carries the three actions: Verify (`verifyBrainRow`), Delete
 *     (`deleteBrainRow` behind `confirmDialog`), and "More options" which
 *     opens the EXISTING `BrainDetailDrawer` (adjust / ask / why / change
 *     type live there — this panel stays a fast confirm surface);
 *   - reports a successful action via `onActed(key)` so the page can
 *     auto-advance the selection and refresh both queues;
 *   - shows a `<lg` position header ("2 of 7" + prev/next) — on mobile the
 *     sidebar master list isn't visible, so the panel is the whole queue UI.
 *
 * `ReviewAllClear` is the queue-empty state the page renders instead.
 *
 * [COMP:app-web/brain-review-panel]
 */

import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import {
  deleteBrainRow,
  fetchBrainRow,
  verifyBrainRow,
  type BrainInboxRowDetail,
} from "@/lib/api/brain-inbox";
import { reviewItemKey, type PendingReviewItem } from "@/lib/review-queue";
import { RelationshipReview } from "@/components/brain/relationship-review";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";

/** Body fields that should never reach the user — provenance plumbing, not
 *  entry content (mirrors the detail drawer's list, plus the CRM back-link). */
const HIDDEN_BODY_KEYS = new Set([
  "source_episode_id",
  "source_session_id",
  "assistant_id",
  "user_id",
  "verified_by_user_id",
  "verified_at",
  "original_scope",
  "original_sensitivity",
  "original_summary",
  "entity_id",
]);

function humaniseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type Props = {
  workspaceId: string;
  item: PendingReviewItem;
  /** Fired after a successful verify/delete — the page auto-advances the
   *  selection and refreshes both queues. */
  onActed: (actedKey: string) => void;
  /** Opens the existing BrainDetailDrawer on this item's projected row. */
  onMoreOptions: () => void;
};

export function ReviewPanel({ workspaceId, item, onActed, onMoreOptions }: Props) {
  const t = useT();
  const review = t.memoriesReview;
  const drawerLabels = t.brainPage.detailDrawer;
  const copy = t.brainPage.reviewPanel;
  // entity_link rows are graph edges — render them as a source → target
  // diagram (`RelationshipReview`) instead of the raw edge-field dump.
  const isRelationship = item.primitive === "entity_link";

  // undefined = loading, null = fetch failed / already gone.
  const [detail, setDetail] = useState<BrainInboxRowDetail | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = reviewItemKey(item);

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setError(null);
    void fetchBrainRow(workspaceId, item.primitive, item.id).then((result) => {
      if (!cancelled) setDetail(result);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, item.primitive, item.id]);

  async function handleVerify() {
    setBusy(true);
    setError(null);
    const result = await verifyBrainRow(workspaceId, item.primitive, item.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onActed(key);
  }

  async function handleDelete() {
    const ok = await confirmDialog({
      description: review.deleteConfirmBody,
      confirmLabel: review.deleteConfirmAction,
      cancelLabel: review.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await deleteBrainRow(workspaceId, item.primitive, item.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onActed(key);
  }

  // The markdown-worthy main text: the primitive's `detail` field when it
  // exists (memories), else the projected summary as plain prose.
  const bodyText =
    detail && typeof detail.body.detail === "string"
      ? detail.body.detail
      : (item.row.summary ?? null);

  // The remaining displayable body fields, plumbing + the main text removed.
  const fields = detail
    ? Object.entries(detail.body).filter(
        ([k, v]) =>
          !HIDDEN_BODY_KEYS.has(k) &&
          k !== "detail" &&
          k !== "summary" &&
          v != null &&
          v !== "" &&
          (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
      )
    : [];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* pb-28 clears the fixed chat dock floated over the surface bottom-right. */}
      <div className="max-w-3xl mx-auto w-full px-6 pt-6 pb-28 flex flex-col gap-5">
        <header className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border uppercase tracking-wide">
              {isRelationship ? copy.relationship.heading : item.row.kind}
            </span>
            {item.row.sensitivity && (
              <span
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide border",
                  item.row.sensitivity === "confidential" &&
                    "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
                  item.row.sensitivity === "restricted" &&
                    "bg-red-700/10 text-red-800 dark:text-red-300 border-red-700/30",
                  item.row.sensitivity === "internal" &&
                    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
                  item.row.sensitivity === "public" &&
                    "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
                )}
              >
                {item.row.sensitivity}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-semibold leading-snug break-words">
            {item.row.name}
          </h1>
        </header>

        {/* Action row — Verify is THE action; the drawer keeps the rest. */}
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void handleVerify()}>
            {review.confirm}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onMoreOptions}
          >
            {copy.moreOptions}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void handleDelete()}
            className="ml-auto text-red-500 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
          >
            {review.delete}
          </Button>
        </div>

        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}

        {detail === undefined ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : detail === null ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-card/50 p-3">
            <div className="text-sm font-medium">
              {drawerLabels.notFoundTitle}
            </div>
            <p className="text-xs text-muted-foreground">
              {drawerLabels.notFoundBody}
            </p>
          </div>
        ) : isRelationship ? (
          <RelationshipReview workspaceId={workspaceId} body={detail.body} />
        ) : (
          <>
            {/* Metadata on top: the scope / sensitivity / status fields read as
                context for the body below, so they sit above it (divided by a
                bottom border) rather than trailing after the content. */}
            {fields.length > 0 && (
              <section className="flex flex-col gap-2 border-b border-border pb-4">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                  {drawerLabels.detailsHeading}
                </h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
                  {fields.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-xs text-muted-foreground">
                        {humaniseKey(k)}
                      </dt>
                      <dd className="break-words">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {bodyText && bodyText.trim().length > 0 && (
              <div className="chat-markdown text-sm leading-relaxed break-words">
                <Markdown>{bodyText}</Markdown>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The queue-empty state — every pending item has been handled. */
export function ReviewAllClear() {
  const t = useT();
  const copy = t.brainPage.reviewPanel;
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <CheckCircle2
        aria-hidden
        className="size-8 text-emerald-600 dark:text-emerald-400"
      />
      <p className="text-sm font-medium text-foreground">{copy.allClearTitle}</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {copy.allClearBody}
      </p>
    </div>
  );
}
