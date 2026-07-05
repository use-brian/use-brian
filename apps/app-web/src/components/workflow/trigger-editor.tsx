"use client";

/**
 * Trigger configuration UI (app-web) — a card picker across the four kinds
 * (Manual / Schedule / Webhook / Event) with the selected kind's authoring
 * panel below, in the builder's document + soft-card design language
 * (matching the redesigned step editor; see `field.tsx`). Replaced the old
 * radio-stack, which buried the four options and their config in one long
 * column of text.
 *
 * The kind cards re-shape the `trigger` discriminated union and the parent
 * persists via `PATCH /api/workflows/:id`. Per-kind panels live in adjacent
 * files for readability:
 *   - ManualTriggerPanel  → manual-trigger-panel.tsx
 *   - ScheduleFields      → schedule-trigger-fields.tsx
 *   - WebhookFields       → webhook-trigger-fields.tsx
 *   - EventTriggerFields  → event-trigger-fields.tsx
 *
 * Spec: docs/architecture/features/workflow.md.
 * [COMP:app-web/workflow]
 */

import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { WorkflowTrigger } from "@/lib/api/workflow";
import { ManualTriggerPanel } from "./manual-trigger-panel";
import { ScheduleTriggerFields } from "./schedule-trigger-fields";
import { WebhookTriggerFields } from "./webhook-trigger-fields";
import { EventTriggerFields } from "./event-trigger-fields";

type Props = {
  workflowId: string;
  workspaceId: string | null;
  trigger: WorkflowTrigger;
  webhookSlug: string | null;
  webhookSecret: string | null;
  onChange: (next: WorkflowTrigger) => void;
  onRotateWebhook: () => void | Promise<void>;
  disabled?: boolean;
};

type TriggerKind = WorkflowTrigger["kind"];

export function TriggerEditor({
  workflowId,
  workspaceId,
  trigger,
  webhookSlug,
  webhookSecret,
  onChange,
  onRotateWebhook,
  disabled,
}: Props) {
  const t = useT();
  const b = t.workflowPage.builder;

  const kinds: Array<{ kind: TriggerKind; label: string; hint: string }> = [
    { kind: "manual", label: b.triggerManual, hint: b.triggerManualHint },
    { kind: "schedule", label: b.triggerSchedule, hint: b.triggerScheduleHint },
    { kind: "webhook", label: b.triggerWebhook, hint: b.triggerWebhookHint },
    { kind: "event", label: b.triggerEvent, hint: b.triggerEventHint },
  ];

  const select = (kind: TriggerKind) => {
    if (kind === trigger.kind) return;
    switch (kind) {
      case "manual":
        onChange({ kind: "manual" });
        return;
      case "schedule":
        onChange({
          kind: "schedule",
          schedule: { type: "daily", time: "09:00" },
        });
        return;
      case "webhook":
        onChange({ kind: "webhook" });
        return;
      case "event":
        onChange({ kind: "event", event: { sources: [] } });
        return;
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 flex flex-col gap-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {b.triggerHeading}
      </div>

      {/* Kind picker — four compact cards instead of a radio stack. */}
      <div
        role="radiogroup"
        aria-label={b.triggerHeading}
        className="grid grid-cols-2 gap-2 lg:grid-cols-4"
      >
        {kinds.map(({ kind, label, hint }) => {
          const selected = trigger.kind === kind;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => select(kind)}
              disabled={disabled}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition",
                selected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/25"
                  : "border-border hover:border-primary/40 hover:bg-muted/40",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-md",
                  selected
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <KindIcon kind={kind} />
              </span>
              <span className="text-sm font-medium leading-tight">{label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground line-clamp-2">
                {hint}
              </span>
            </button>
          );
        })}
      </div>

      {/* The selected kind's panel. */}
      <div className="border-t border-border/60 pt-4">
        {trigger.kind === "manual" && (
          <ManualTriggerPanel workflowId={workflowId} disabled={disabled} />
        )}
        {trigger.kind === "schedule" && (
          <ScheduleTriggerFields
            trigger={trigger}
            onChange={onChange}
            disabled={disabled}
          />
        )}
        {trigger.kind === "webhook" && (
          <WebhookTriggerFields
            trigger={trigger}
            onChange={onChange}
            slug={webhookSlug}
            secret={webhookSecret}
            onRotate={onRotateWebhook}
            disabled={disabled}
          />
        )}
        {trigger.kind === "event" && (
          <EventTriggerFields
            workspaceId={workspaceId}
            trigger={trigger}
            onChange={onChange}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: TriggerKind }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "manual":
      return (
        <svg {...common}>
          <path d="M6 4.5 19 12 6 19.5Z" />
        </svg>
      );
    case "schedule":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "webhook":
      return (
        <svg {...common}>
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
      );
    case "event":
      return (
        <svg {...common}>
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
        </svg>
      );
  }
}
