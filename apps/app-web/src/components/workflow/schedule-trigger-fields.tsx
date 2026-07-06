"use client";

/**
 * Schedule trigger fields (app-web) — picker for daily / weekly / monthly /
 * one-off / cron cadences with a live "next fires" preview + cron validator.
 *
 * Reorganized in the builder redesign: the core cadence (type / params /
 * timezone) sits in one compact grid, the next-fires preview is a prominent
 * chip strip directly under it, and the power-user options (timezone
 * ownership, delivery sugar, reminder policy) collapse into an Advanced
 * disclosure that auto-opens when any of them is already set. Long-form
 * explanations ride InfoTips instead of stacked helper paragraphs.
 *
 * The schedule shape is the legacy `ScheduleConfig` (matches the persisted
 * `workflows.trigger.schedule` JSONB column and the Zod schema in
 * `packages/core/src/workflow/schemas.ts`). The conceptual
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
import { Switch } from "@/components/ui/switch";
import {
  Disclosure,
  FieldLabel,
  SummaryChip,
  SwitchRow,
} from "@/components/workflow/field";
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

/** Compact input matching the panel's `size="sm"` selects. */
const INPUT_CLS =
  "w-full h-8 px-2.5 bg-background border border-input rounded-md text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";

type Props = {
  trigger: Extract<WorkflowTrigger, { kind: "schedule" }>;
  onChange: (next: WorkflowTrigger) => void;
  disabled?: boolean;
};

export function ScheduleTriggerFields({ trigger, onChange, disabled }: Props) {
  const t = useT();
  const b = t.workflowPage.builder;
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
    if (s.type === "once") {
      // A one-off has exactly one fire — echo the picked datetime.
      const d = new Date(s.datetime);
      return Number.isNaN(d.getTime()) ? [] : [d];
    }
    if (!cronEquivalent) return [];
    return nextFireTimes(cronEquivalent, new Date(), 3);
  }, [s, cronEquivalent]);

  // Advanced options auto-open when any is already configured, so a set
  // option is never hidden behind the fold.
  const advancedActive =
    trigger.mode === "user" ||
    !!trigger.delivery ||
    !!trigger.policy?.silentUntilFire ||
    trigger.policy?.nagIntervalMins != null ||
    !!trigger.policy?.nagUntilKeyword;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Core cadence grid ─────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <FieldLabel label={b.scheduleType} />
          <Select
            value={s.type}
            onValueChange={(v) => {
              if (v) setSchedule(defaultScheduleOf(v as ScheduleConfig["type"]));
            }}
            disabled={disabled}
            items={{
              daily: b.scheduleTypeDaily,
              weekly: b.scheduleTypeWeekly,
              monthly: b.scheduleTypeMonthly,
              once: b.scheduleTypeOnce,
              cron: b.scheduleTypeCron,
            }}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{b.scheduleTypeDaily}</SelectItem>
              <SelectItem value="weekly">{b.scheduleTypeWeekly}</SelectItem>
              <SelectItem value="monthly">{b.scheduleTypeMonthly}</SelectItem>
              <SelectItem value="once">{b.scheduleTypeOnce}</SelectItem>
              <SelectItem value="cron">{b.scheduleTypeCron}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {s.type === "weekly" && (
          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.scheduleDaysLabel} />
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
        )}

        {s.type === "monthly" && (
          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.scheduleDomLabel} />
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
              className={INPUT_CLS}
            />
          </div>
        )}

        {(s.type === "daily" || s.type === "weekly" || s.type === "monthly") && (
          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.scheduleTimeLabel} />
            <input
              type="time"
              value={s.time}
              onChange={(e) => setSchedule({ ...s, time: e.target.value })}
              disabled={disabled}
              className={INPUT_CLS}
            />
          </div>
        )}

        {s.type === "once" && (
          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.scheduleDatetimeLabel} />
            <input
              type="datetime-local"
              value={s.datetime}
              onChange={(e) =>
                setSchedule({ type: "once", datetime: e.target.value })
              }
              disabled={disabled}
              className={INPUT_CLS}
            />
          </div>
        )}

        {s.type === "cron" && (
          <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
            <FieldLabel label={b.scheduleCronLabel} />
            <input
              type="text"
              value={s.expression}
              onChange={(e) =>
                setSchedule({ type: "cron", expression: e.target.value })
              }
              disabled={disabled}
              placeholder="0 9 * * MON-FRI"
              className={cn(
                INPUT_CLS,
                "font-mono",
                !cronValidation.valid &&
                  "border-red-500/50 focus:ring-red-500/30",
              )}
            />
            {!cronValidation.valid && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {b.scheduleCronInvalid}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <FieldLabel
            label={b.timezonePickerLabel}
            hint={b.timezonePickerHint}
          />
          <input
            type="text"
            value={trigger.timezone ?? ""}
            onChange={(e) =>
              onChange({ ...trigger, timezone: e.target.value || undefined })
            }
            disabled={disabled}
            placeholder="Asia/Hong_Kong"
            list="iana-timezones"
            className={INPUT_CLS}
          />
          <TimezoneDataList />
        </div>
      </div>

      {/* ── Next-fires preview — the loudest feedback in the panel ─────── */}
      <SchedulePreview
        schedule={s}
        cronValid={cronValidation.valid}
        previewFires={previewFires}
        t={t}
      />

      {/* ── Advanced — timezone ownership, delivery sugar, reminder policy */}
      <Disclosure
        label={b.scheduleAdvancedLabel}
        defaultOpen={advancedActive}
        summary={
          <>
            {trigger.mode === "user" && (
              <SummaryChip>{b.scheduleModeUser}</SummaryChip>
            )}
            {trigger.delivery && (
              <SummaryChip>
                {trigger.delivery.channel === "telegram"
                  ? b.deliverChannelTelegram
                  : trigger.delivery.channel === "slack"
                    ? b.deliverChannelSlack
                    : b.deliverChannelWhatsApp}
              </SummaryChip>
            )}
            {trigger.policy?.silentUntilFire && (
              <SummaryChip>{b.scheduleChipSilent}</SummaryChip>
            )}
            {(trigger.policy?.nagIntervalMins != null ||
              trigger.policy?.nagUntilKeyword) && (
              <SummaryChip>{b.scheduleChipNag}</SummaryChip>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                label={b.scheduleModeLabel}
                hint={b.scheduleModeHint}
              />
              <Select
                value={trigger.mode ?? "local"}
                onValueChange={(v) => {
                  if (v) onChange({ ...trigger, mode: v as "local" | "user" });
                }}
                disabled={disabled}
                items={{
                  local: b.scheduleModeLocal,
                  user: b.scheduleModeUser,
                }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{b.scheduleModeLocal}</SelectItem>
                  <SelectItem value="user">{b.scheduleModeUser}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Delivery channel — type-only sugar; the server resolves the
                chat + Telegram topic and stamps it onto the terminal
                assistant_call step. */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                label={b.scheduleDeliveryLabel}
                hint={b.scheduleDeliveryHint}
              />
              <Select
                value={trigger.delivery?.channel ?? "none"}
                onValueChange={(v) => {
                  if (!v) return;
                  onChange(
                    v === "none"
                      ? { ...trigger, delivery: undefined }
                      : {
                          ...trigger,
                          delivery: {
                            channel: v as "telegram" | "slack" | "whatsapp",
                          },
                        },
                  );
                }}
                disabled={disabled}
                items={{
                  none: b.scheduleDeliveryNone,
                  telegram: b.deliverChannelTelegram,
                  slack: b.deliverChannelSlack,
                  whatsapp: b.deliverChannelWhatsApp,
                }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{b.scheduleDeliveryNone}</SelectItem>
                  <SelectItem value="telegram">
                    {b.deliverChannelTelegram}
                  </SelectItem>
                  <SelectItem value="slack">{b.deliverChannelSlack}</SelectItem>
                  <SelectItem value="whatsapp">
                    {b.deliverChannelWhatsApp}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Reminder behavior — silent-until-fire + nag policy (trigger-row). */}
          <div className="rounded-lg bg-muted/40 px-3 py-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                {b.schedulePolicyHeading}
              </span>
            </div>
            <SwitchRow
              label={b.schedulePolicySilentLabel}
              control={
                <Switch
                  checked={trigger.policy?.silentUntilFire ?? false}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...trigger,
                      policy: {
                        ...trigger.policy,
                        silentUntilFire: checked || undefined,
                      },
                    })
                  }
                  disabled={disabled}
                  aria-label={b.schedulePolicySilentLabel}
                />
              }
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  label={b.scheduleNagIntervalLabel}
                  hint={b.scheduleNagHint}
                />
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
                        nagIntervalMins:
                          Number.isFinite(n) && n > 0
                            ? Math.min(1440, n)
                            : undefined,
                      },
                    });
                  }}
                  className={INPUT_CLS}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  label={b.scheduleNagKeywordLabel}
                  hint={b.scheduleNagHint}
                />
                <input
                  type="text"
                  value={trigger.policy?.nagUntilKeyword ?? ""}
                  disabled={disabled}
                  placeholder="done"
                  onChange={(e) =>
                    onChange({
                      ...trigger,
                      policy: {
                        ...trigger.policy,
                        nagUntilKeyword: e.target.value || undefined,
                      },
                    })
                  }
                  className={INPUT_CLS}
                />
              </div>
            </div>
          </div>
        </div>
      </Disclosure>
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
  const b = t.workflowPage.builder;
  if (schedule.type === "cron" && !cronValid) return null;
  if (schedule.type === "weekly" && schedule.days.length === 0) return null;

  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="text-muted-foreground/60"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          {b.schedulePreviewHeading}
        </span>
      </div>
      {previewFires.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          {b.schedulePreviewNone}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {previewFires.map((d, i) => (
            <span
              key={i}
              className={cn(
                "rounded-md border border-border bg-background px-2 py-1 text-xs tabular-nums",
                i === 0 ? "text-foreground font-medium" : "text-muted-foreground",
              )}
            >
              {d.toLocaleString()}
            </span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/80">
        {b.schedulePreviewLocalNote}
      </p>
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
