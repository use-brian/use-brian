"use client";

/**
 * Deal board — the pipeline flavour of the CRM operator surface and its
 * DEFAULT view (crm-operator-surface §1.4: pipeline-at-a-glance IS the CRM
 * job). One column per open stage with a live count + amount sum in the
 * header; won/lost fold into a collapsed closed rail so the board stays a
 * working pipeline, not an archive — the rail chips are drop targets, so
 * dragging a card onto "Won" closes the deal without revealing the columns.
 * Drag between columns raises `onStageDrop`; the surface owns the commit
 * (the same adjust wire the table's stage cell rides, `setDealStage`
 * server-side).
 *
 * [COMP:app-web/crm-board]
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  type CrmDealRow,
  type CrmPipeline,
  type CrmPipelineStage,
} from "@/lib/api/crm";
import {
  formatAmount,
  formatCurrencyTotals,
  groupDealsByPipelineStage,
  localDateStr,
  resolveDealPipelineStage,
} from "@/lib/crm-view";
import { PipelineStageCell, PIPELINE_CATEGORY_DOT } from "./crm-cells";

export function CrmBoard({
  rows,
  pipeline,
  companyNames,
  contactNames,
  showClosed,
  onToggleClosed,
  onStageDrop,
  onOpenRecord,
}: {
  /** Filtered deals — open AND closed (the board owns the fold). */
  rows: CrmDealRow[];
  pipeline: CrmPipeline;
  companyNames: Map<string, string>;
  contactNames: Map<string, string>;
  /** Reveal the won/lost columns (else they fold into the rail). */
  showClosed: boolean;
  onToggleClosed: () => void;
  onStageDrop: (row: CrmDealRow, stage: CrmPipelineStage) => Promise<{ ok: boolean; error?: string }>;
  onOpenRecord: (row: CrmDealRow) => void;
}) {
  const t = useT().crmPage;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const openStages = pipeline.stages.filter((stage) => stage.category === "open");
  const closedStages = pipeline.stages.filter((stage) => stage.category !== "open");
  const columns = showClosed ? pipeline.stages : openStages;
  const summaries = groupDealsByPipelineStage(rows, pipeline, columns);
  const closedSummaries = groupDealsByPipelineStage(rows, pipeline, closedStages);
  const today = localDateStr(new Date());

  function dropHandlers(stage: CrmPipelineStage) {
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setOverColumn(stage.id);
      },
      onDragLeave: () =>
        setOverColumn((current) => (current === stage.id ? null : current)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setOverColumn(null);
        const id = e.dataTransfer.getData("text/deal-id") || dragId;
        setDragId(null);
        const row = rows.find((r) => r.id === id);
        if (row && resolveDealPipelineStage(row, pipeline)?.id !== stage.id) {
          void onStageDrop(row, stage);
        }
      },
    };
  }

  return (
    <div className="flex h-full min-w-max flex-col gap-3 p-4">
      <div className="flex min-h-0 flex-1 gap-3">
        {summaries.map(({ stage, rows: cards, currencyTotals }) => (
          <div
            key={stage.id}
            {...dropHandlers(stage)}
            className={cn(
              "flex w-72 shrink-0 flex-col rounded-2xl bg-muted/30 transition-shadow",
              overColumn === stage.id && "ring-2 ring-primary/40",
            )}
          >
            <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2.5">
              <span
                className={cn("size-2 shrink-0 rounded-full", PIPELINE_CATEGORY_DOT[stage.category])}
                aria-hidden
              />
              <span className="text-[12.5px] font-semibold text-foreground/80">
                {stage.name}
              </span>
              <span className="tabular-nums text-[12px] text-muted-foreground">
                {cards.length}
              </span>
              {Object.keys(currencyTotals).length > 0 && (
                <span className="ml-auto tabular-nums text-[11.5px] font-medium text-muted-foreground/80">
                  {formatCurrencyTotals(currencyTotals, true)}
                </span>
              )}
            </div>
            <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-1">
              {cards.length === 0 && (
                <div className="rounded-xl border border-dashed border-border/60 px-3 py-5 text-center text-[12px] text-muted-foreground/50">
                  {t.boardEmptyColumn}
                </div>
              )}
              {cards.map((row) => {
                const company = row.companyId
                  ? companyNames.get(row.companyId)
                  : null;
                const contact = row.contactId
                  ? contactNames.get(row.contactId)
                  : null;
                const overdue =
                  row.closeDate !== null &&
                  row.closeDate < today &&
                  stage.category === "open";
                const resolvedStage = resolveDealPipelineStage(row, pipeline);
                return (
                  <div
                    key={row.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(row.id);
                      e.dataTransfer.setData("text/deal-id", row.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragId(null)}
                    className={cn(
                      "cursor-grab rounded-xl border border-border/60 bg-card p-3 shadow-xs transition-all hover:-translate-y-px hover:shadow-md active:cursor-grabbing",
                      dragId === row.id && "opacity-50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRecord(row)}
                      className="block w-full text-left text-[13px] font-medium leading-snug text-foreground hover:underline"
                      draggable={false}
                    >
                      {row.name}
                    </button>
                    {(company || contact) && (
                      <div className="mt-1 truncate text-[11.5px] text-muted-foreground">
                        {company}
                        {company && contact && " · "}
                        {contact}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      {row.amount !== null && (
                        <span className="text-[11.5px] font-medium tabular-nums text-foreground/80">
                          {formatAmount(row.amount, row.currencyCode)}
                        </span>
                      )}
                      {row.closeDate && (
                        <span
                          className={cn(
                            "ml-auto text-[11px] tabular-nums text-muted-foreground",
                            overdue && "text-red-500",
                          )}
                        >
                          {new Date(`${row.closeDate}T00:00:00`).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </span>
                      )}
                    </div>
                    <div
                      className="mt-1.5 border-t border-border/40 pt-1"
                      draggable={false}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <PipelineStageCell
                        compact
                        stageId={resolvedStage?.id ?? null}
                        stages={pipeline.stages}
                        onCommit={(stageId) => {
                          const next = pipeline.stages.find((candidate) => candidate.id === stageId);
                          return next ? onStageDrop(row, next) : Promise.resolve({ ok: false });
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Closed rail — collapsed won/lost summaries. Chips are DROP TARGETS
          (drag a card here to close the deal) and a click reveals/hides the
          full columns. Hidden while the columns are showing. */}
      {!showClosed && (
        <div className="flex items-center gap-2">
          {closedSummaries.map(({ stage, rows: cards, currencyTotals }) => (
            <button
              key={stage.id}
              type="button"
              onClick={onToggleClosed}
              {...dropHandlers(stage)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full bg-muted/40 px-3.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
                overColumn === stage.id && "ring-2 ring-primary/40",
              )}
            >
              <ChevronRight className="size-3.5" aria-hidden />
              <span
                className={cn("size-2 rounded-full", PIPELINE_CATEGORY_DOT[stage.category])}
                aria-hidden
              />
              {stage.name}
              <span className="tabular-nums">{cards.length}</span>
              {stage.category === "won" && Object.keys(currencyTotals).length > 0 && (
                <span className="tabular-nums text-muted-foreground/70">
                  {formatCurrencyTotals(currencyTotals, true)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
