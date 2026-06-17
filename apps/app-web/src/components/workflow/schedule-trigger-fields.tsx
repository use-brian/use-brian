"use client";

/**
 * Schedule trigger fields (app-web) — picker for daily / weekly /
 * monthly / one-off / cron cadences with a live "next fires" preview +
 * cron validator.
 *
 * Ported from `apps/web/src/components/workflow/schedule-trigger-fields.tsx`
 * (app consolidation §5a). The schedule shape is the legacy `ScheduleConfig`
 * (matches the persisted `workflows.trigger.schedule` JSONB column and the
 * Zod schema in `packages/core/src/workflow/schemas.ts`). The conceptual
 * `StructuredSchedule` (`cron|every|at`) in `packages/core/src/scheduling`
 * is the runtime representation a `scheduled_jobs` row carries; this editor
 * authors the human-facing declarative summary, which the route keeps in
 * sync with the underlying scheduled-jobs row.
 *
 * Spec: docs/architecture/features/workflow.md → Schedule trigger UI.
 * [COMP:app-web/workflow]
 */

import { useMemo } from "react";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import type {
  ScheduleConfig,
  WorkflowTrigger,
} from "@/lib/api/workflow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  nextFireTimes,
  validateCron,
} from "@/lib/workflow-cron";
import { cn } from "@/lib/utils";

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

type Props = {
  trigger: Extract<WorkflowTrigger, { kind: "schedule" }>;
  onChange: (next: WorkflowTrigger) => void;
  disabled?: boolean;
};

export function ScheduleTriggerFields({ trigger, onChange, disabled }: Props) {
  const t = useT();
  const s = trigger.schedule;
  const setSchedule = (sched: ScheduleConfig) =>
    onChange({ ...trigger, schedule: sched });

  // Map the human-friendly daily/weekly/monthly/once shape to a cron-ish
  // string just for the preview computation. The persisted shape stays
  // legacy; `cron` is the only mode that goes through the editor's text
  // field, so cron-validation only kicks in there.
  const cronEquivalent = scheduleToCronPreview(s);
  const cronValidation =
    s.type === "cron"
      ? validateCron(s.expression)
      : ({ valid: true } as const);
  const previewFires = useMemo(() => {
    if (!cronEquivalent) return [];
    return nextFireTimes(cronEquivalent, new Date(), 3);
  }, [cronEquivalent]);

  return (
    <div className="ml-6 pl-3 border-l border-border flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.scheduleType}
        </label>
        <Select
          value={s.type}
          onValueChange={(v) => {
            if (v) setSchedule(defaultScheduleOf(v as ScheduleConfig["type"]));
          }}
          disabled={disabled}
        >
          <SelectTrigger className="w-full max-w-xs text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">{t.workflowPage.builder.scheduleTypeDaily}</SelectItem>
            <SelectItem value="weekly">{t.workflowPage.builder.scheduleTypeWeekly}</SelectItem>
            <SelectItem value="monthly">{t.workflowPage.builder.scheduleTypeMonthly}</SelectItem>
            <SelectItem value="once">{t.workflowPage.builder.scheduleTypeOnce}</SelectItem>
            <SelectItem value="cron">{t.workflowPage.builder.scheduleTypeCron}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {s.type === "daily" && (
        <TimeField
          label={t.workflowPage.builder.scheduleTimeLabel}
          value={s.time}
          disabled={disabled}
          onChange={(time) => setSchedule({ type: "daily", time })}
        />
      )}

      {s.type === "weekly" && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t.workflowPage.builder.scheduleDaysLabel}
            </label>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d) => {
                const on = s.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      const next = on
                        ? s.days.filter((x) => x !== d)
                        : [...s.days, d];
                      setSchedule({ ...s, days: next });
                    }}
                    className={cn(
                      "text-xs px-2 py-1 rounded border capitalize",
                      on
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    {d.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>
          <TimeField
            label={t.workflowPage.builder.scheduleTimeLabel}
            value={s.time}
            disabled={disabled}
            onChange={(time) => setSchedule({ ...s, time })}
          />
        </>
      )}

      {s.type === "monthly" && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t.workflowPage.builder.scheduleDomLabel}
            </label>
            <input
              type="number"
              min={1}
              max={31}
              value={s.dayOfMonth}
              onChange={(e) =>
                setSchedule({
                  ...s,
                  dayOfMonth: Math.min(
                    31,
                    Math.max(1, parseInt(e.target.value, 10) || 1),
                  ),
                })
              }
              disabled={disabled}
              className="px-3 py-2 bg-background border border-border rounded-md text-sm max-w-[6rem] outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <TimeField
            label={t.workflowPage.builder.scheduleTimeLabel}
            value={s.time}
            disabled={disabled}
            onChange={(time) => setSchedule({ ...s, time })}
          />
        </>
      )}

      {s.type === "once" && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.scheduleDatetimeLabel}
          </label>
          <input
            type="datetime-local"
            value={s.datetime}
            onChange={(e) =>
              setSchedule({ type: "once", datetime: e.target.value })
            }
            disabled={disabled}
            className="px-3 py-2 bg-background border border-border rounded-md text-sm max-w-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {s.type === "cron" && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.scheduleCronLabel}
          </label>
          <input
            type="text"
            value={s.expression}
            onChange={(e) =>
              setSchedule({ type: "cron", expression: e.target.value })
            }
            disabled={disabled}
            placeholder="0 9 * * MON-FRI"
            className={cn(
              "px-3 py-2 bg-background border rounded-md text-sm font-mono outline-none max-w-md",
              cronValidation.valid
                ? "border-border focus:ring-2 focus:ring-ring"
                : "border-red-500/50 focus:ring-2 focus:ring-red-500/30",
            )}
          />
          {!cronValidation.valid && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {t.workflowPage.builder.scheduleCronInvalid}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.timezonePickerLabel}
        </label>
        <input
          type="text"
          value={trigger.timezone ?? ""}
          onChange={(e) =>
            onChange({ ...trigger, timezone: e.target.value || undefined })
          }
          disabled={disabled}
          placeholder="Asia/Hong_Kong"
          list="iana-timezones"
          className="px-3 py-2 bg-background border border-border rounded-md text-sm max-w-xs outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          {t.workflowPage.builder.timezonePickerHint}
        </p>
        <TimezoneDataList />
      </div>

      {/* Timezone ownership (mode) */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.scheduleModeLabel}
        </label>
        <Select
          value={trigger.mode ?? "local"}
          onValueChange={(v) => {
            if (v) onChange({ ...trigger, mode: v as "local" | "user" });
          }}
          disabled={disabled}
        >
          <SelectTrigger className="w-full max-w-xs text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">{t.workflowPage.builder.scheduleModeLocal}</SelectItem>
            <SelectItem value="user">{t.workflowPage.builder.scheduleModeUser}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t.workflowPage.builder.scheduleModeHint}
        </p>
      </div>

      {/* Delivery channel — type-only sugar; the server resolves the chat +
          Telegram topic and stamps it onto the terminal assistant_call step. */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.scheduleDeliveryLabel}
        </label>
        <Select
          value={trigger.delivery?.channel ?? "none"}
          onValueChange={(v) => {
            if (!v) return;
            onChange(
              v === "none"
                ? { ...trigger, delivery: undefined }
                : { ...trigger, delivery: { channel: v as "telegram" | "slack" | "whatsapp" } },
            );
          }}
          disabled={disabled}
        >
          <SelectTrigger className="w-full max-w-xs text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t.workflowPage.builder.scheduleDeliveryNone}</SelectItem>
            <SelectItem value="telegram">Telegram</SelectItem>
            <SelectItem value="slack">Slack</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t.workflowPage.builder.scheduleDeliveryHint}
        </p>
      </div>

      {/* Reminder behavior — silent-until-fire + nag policy (trigger-row). */}
      <div className="flex flex-col gap-2 pt-1 border-t border-border/60">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.schedulePolicyHeading}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={trigger.policy?.silentUntilFire ?? false}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...trigger,
                policy: { ...trigger.policy, silentUntilFire: e.target.checked || undefined },
              })
            }
          />
          {t.workflowPage.builder.schedulePolicySilentLabel}
        </label>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t.workflowPage.builder.scheduleNagIntervalLabel}
            </label>
            <input
              type="number"
              min={1}
              max={1440}
              value={trigger.policy?.nagIntervalMins ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({
                  ...trigger,
                  policy: {
                    ...trigger.policy,
                    nagIntervalMins: Number.isFinite(n) && n > 0 ? Math.min(1440, n) : undefined,
                  },
                });
              }}
              className="px-3 py-2 bg-background border border-border rounded-md text-sm max-w-[8rem] outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t.workflowPage.builder.scheduleNagKeywordLabel}
            </label>
            <input
              type="text"
              value={trigger.policy?.nagUntilKeyword ?? ""}
              disabled={disabled}
              placeholder="done"
              onChange={(e) =>
                onChange({
                  ...trigger,
                  policy: { ...trigger.policy, nagUntilKeyword: e.target.value || undefined },
                })
              }
              className="px-3 py-2 bg-background border border-border rounded-md text-sm max-w-[10rem] outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t.workflowPage.builder.scheduleNagHint}
        </p>
      </div>

      {/* Next-fire preview — once + cron we compute live; once is just the
          datetime echo. Skipped when the inputs aren't satisfiable yet
          (e.g. weekly with no days picked, or cron in an invalid state). */}
      <SchedulePreview
        schedule={s}
        cronValid={cronValidation.valid}
        previewFires={previewFires}
        t={t}
      />
    </div>
  );
}

function SchedulePreview({
  schedule,
  cronValid,
  previewFires,
  t,
}: {
  schedule: ScheduleConfig;
  cronValid: boolean;
  previewFires: Date[];
  t: ReturnType<typeof useT>;
}) {
  const list = previewFires;
  if (schedule.type === "cron" && !cronValid) return null;
  if (schedule.type === "weekly" && schedule.days.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 pt-1 border-t border-border/60">
      <label className="text-xs font-medium text-muted-foreground">
        {t.workflowPage.builder.schedulePreviewHeading}
      </label>
      {list.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          {t.workflowPage.builder.schedulePreviewNone}
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5 text-xs">
          {list.map((d, i) => (
            <li key={i} className="font-mono text-muted-foreground">
              {fmt("{when}", { when: d.toLocaleString() })}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-muted-foreground/80">
        {t.workflowPage.builder.schedulePreviewLocalNote}
      </p>
    </div>
  );
}

function TimeField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="px-3 py-2 bg-background border border-border rounded-md text-sm max-w-[10rem] outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

/**
 * Datalist of IANA timezones for the timezone input's typeahead. Reads
 * `Intl.supportedValuesOf('timeZone')` when available (modern browsers);
 * falls back to a compact list of the most commonly used zones so the
 * field still autocompletes in older environments.
 */
function TimezoneDataList() {
  const zones = useMemo(() => {
    const fn = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf;
    if (typeof fn === "function") {
      try {
        return fn("timeZone");
      } catch {
        // ignore — fall through to defaults
      }
    }
    return TIMEZONE_FALLBACK;
  }, []);
  return (
    <datalist id="iana-timezones">
      {zones.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}

const TIMEZONE_FALLBACK = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

function defaultScheduleOf(type: ScheduleConfig["type"]): ScheduleConfig {
  switch (type) {
    case "daily":
      return { type: "daily", time: "09:00" };
    case "weekly":
      return { type: "weekly", days: ["monday"], time: "09:00" };
    case "monthly":
      return { type: "monthly", dayOfMonth: 1, time: "09:00" };
    case "once":
      return {
        type: "once",
        datetime: new Date().toISOString().slice(0, 16),
      };
    case "cron":
      return { type: "cron", expression: "0 9 * * MON-FRI" };
  }
}

/**
 * Translate the legacy schedule shape into a cron string for the
 * next-fire preview. The runtime executor doesn't care — it consumes
 * the legacy shape directly — but for the preview we want one code
 * path. Returns null when there's nothing to compute (e.g. once, or
 * weekly with no days).
 */
function scheduleToCronPreview(s: ScheduleConfig): string | null {
  switch (s.type) {
    case "daily": {
      const [h, m] = s.time.split(":").map((x) => parseInt(x, 10) || 0);
      return `${m} ${h} * * *`;
    }
    case "weekly": {
      if (s.days.length === 0) return null;
      const [h, m] = s.time.split(":").map((x) => parseInt(x, 10) || 0);
      const dows = s.days
        .map((d) => DAY_TO_DOW[d.toLowerCase()])
        .filter((n): n is number => n !== undefined)
        .sort((a, b) => a - b);
      if (dows.length === 0) return null;
      return `${m} ${h} * * ${dows.join(",")}`;
    }
    case "monthly": {
      const [h, m] = s.time.split(":").map((x) => parseInt(x, 10) || 0);
      return `${m} ${h} ${s.dayOfMonth} * *`;
    }
    case "once":
      return null;
    case "cron":
      return s.expression;
  }
}

const DAY_TO_DOW: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
