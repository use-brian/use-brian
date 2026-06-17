"use client";

/**
 * Trigger configuration UI (app-web) — radio across all four kinds
 * (Manual / Schedule / Webhook / Event), with per-kind authoring panels.
 *
 * Ported from `apps/web/src/components/workflow/trigger-editor.tsx` (app
 * consolidation §5a). This is the unified editor consumed by the workflow
 * board's detail page — the kind toggle re-shapes the `trigger`
 * discriminated union and the parent persists via `PATCH /api/workflows/:id`.
 *
 * Per-kind panels live in adjacent files for readability:
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

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t.workflowPage.builder.triggerHeading}
      </div>
      <div className="p-4 flex flex-col gap-3">
        <RadioOption
          name="trigger"
          value="manual"
          checked={trigger.kind === "manual"}
          onSelect={() => onChange({ kind: "manual" })}
          disabled={disabled}
          label={t.workflowPage.builder.triggerManual}
          hint={t.workflowPage.builder.triggerManualHint}
        />
        {trigger.kind === "manual" && (
          <ManualTriggerPanel workflowId={workflowId} disabled={disabled} />
        )}

        <RadioOption
          name="trigger"
          value="schedule"
          checked={trigger.kind === "schedule"}
          onSelect={() =>
            onChange({
              kind: "schedule",
              schedule: { type: "daily", time: "09:00" },
            })
          }
          disabled={disabled}
          label={t.workflowPage.builder.triggerSchedule}
          hint={t.workflowPage.builder.triggerScheduleHint}
        />
        {trigger.kind === "schedule" && (
          <ScheduleTriggerFields
            trigger={trigger}
            onChange={onChange}
            disabled={disabled}
          />
        )}

        <RadioOption
          name="trigger"
          value="webhook"
          checked={trigger.kind === "webhook"}
          onSelect={() => onChange({ kind: "webhook" })}
          disabled={disabled}
          label={t.workflowPage.builder.triggerWebhook}
          hint={t.workflowPage.builder.triggerWebhookHint}
        />
        {trigger.kind === "webhook" && (
          <WebhookTriggerFields
            slug={webhookSlug}
            secret={webhookSecret}
            onRotate={onRotateWebhook}
            disabled={disabled}
          />
        )}

        <RadioOption
          name="trigger"
          value="event"
          checked={trigger.kind === "event"}
          onSelect={() =>
            onChange({
              kind: "event",
              event: { sources: [] },
            })
          }
          disabled={disabled}
          label={t.workflowPage.builder.triggerEvent}
          hint={t.workflowPage.builder.triggerEventHint}
        />
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

function RadioOption({
  name,
  value,
  checked,
  onSelect,
  disabled,
  label,
  hint,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 cursor-pointer rounded-md px-2 py-1.5 -mx-2",
        checked && "bg-muted/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        className="mt-1 accent-primary"
      />
      <div className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
    </label>
  );
}
