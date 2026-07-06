"use client";

/**
 * Per-step editor (app-web) — the step as a **document + properties rail**,
 * the skill editor's design language (`brain/skills/[skillRowId]/page.tsx`):
 * the step's name (its `description`) is a borderless title; directly under
 * it an **identity strip** (a compact grid: type / assistant / page anchor /
 * blueprint — what runs, who runs it, what it works on) balances the two
 * columns; the instruction is a borderless auto-growing body under a quiet
 * divider. The rail keeps only the tuning knobs — soft cards Execution +
 * Output — with long-form hints tucked into InfoTips instead of stacked
 * helper paragraphs. Non-assistant step types keep the plain-language
 * summary + raw-JSON disclosure as the document body; a `branch` step has
 * no rail at all (its whole config is the strip + raw JSON).
 *
 * The wire shape is unchanged — this is presentation only; the parent still
 * owns the draft and persists via `PATCH /api/workflows/:id`. The model
 * option labels (Standard / Pro / Max) stay on the self-contained
 * `workflowPage.builder.stepModel*` keys.
 *
 * Spec: docs/architecture/features/workflow.md → "Web builder UI".
 * [COMP:app-web/workflow]
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { ViewListRow } from "@/lib/api/views";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import type { WorkspaceSkillSummary } from "@/lib/api/skills";
import { buildBlueprintPickerItems } from "@/lib/blueprints";
import type {
  ChannelDestination,
  SlackChannelOption,
  DeliverChannelType,
  PageAnchor,
  WorkflowModelAlias,
  WorkflowStep,
} from "@/lib/api/workflow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import {
  FieldLabel,
  RailCard,
  SwitchRow,
} from "@/components/workflow/field";
import {
  fieldUnderlineCls,
  quietFieldCls,
} from "@/components/brain/skill-document";
import { cn } from "@/lib/utils";

const MODEL_ALIASES: WorkflowModelAlias[] = ["standard", "pro", "max"];

/** Sentinel value used by the destinations dropdown to reveal a custom-ID input. */
const CUSTOM_DESTINATION_VALUE = "__custom__";

/** Compact input matching the rail's `size="sm"` selects. */
const RAIL_INPUT_CLS =
  "w-full h-8 px-2.5 bg-background border border-input rounded-md text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";

const PROMPT_MAX = 8000;
const PROMPT_WARN_AT = 7200;

type Props = {
  index: number;
  total: number;
  step: WorkflowStep;
  assistants: StudioAssistantSummary[];
  /**
   * Recent chat destinations for the workspace — backs the per-step
   * `deliver.channelId` dropdown so users don't paste raw platform IDs.
   */
  destinations: ChannelDestination[];
  /**
   * Workspace Slack channels (by name, from `conversations.list`) — backs the
   * deliver picker when the channel type is Slack, so authors pick `#name`
   * instead of a raw id. Empty when Slack isn't connected or the fetch failed.
   */
  slackChannels: SlackChannelOption[];
  /**
   * Workspace page roster (saved + drafts) — backs the page-anchor picker
   * (`PageAnchorField`). Empty when the roster fetch failed; the field
   * degrades gracefully.
   */
  pages: ViewListRow[];
  /**
   * Workspace blueprints (page templates carrying an extraction spec) — backs
   * the per-step blueprint picker (`BlueprintField`). Empty when the fetch
   * failed; the field degrades to just the built-ins.
   */
  blueprints: CustomPageTemplateSummary[];
  /**
   * Workspace brain skills — backs the per-step skills allow-list picker
   * (`SkillsField`). Empty when the fetch failed or none exist; the field
   * hides itself and any already-selected slugs are preserved.
   */
  skills: WorkspaceSkillSummary[];
  /**
   * All steps in the draft definition — backs the page-anchor "from
   * earlier step" picker (steps with `page.create` other than this one).
   */
  steps: WorkflowStep[];
  onChange: (next: WorkflowStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  disabled?: boolean;
};

export function StepEditor({
  index,
  total,
  step,
  assistants,
  destinations,
  slackChannels,
  pages,
  blueprints,
  skills,
  steps,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  disabled,
}: Props) {
  const t = useT();
  const b = t.workflowPage.builder;
  const isAssistant = step.type === "assistant_call";
  // A branch step's whole config is the identity strip + raw JSON — no
  // Execution (assistant-only) and no Output (branch stores nothing).
  const hasRail = step.type !== "branch";

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      {/* Toolbar — position + type readout left, reorder/remove right. */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {format(b.stepOfTotal, { n: String(index + 1), total: String(total) })}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground/40">
            {stepTypeLabel(step.type, t)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label={b.moveStepUp}
            onClick={onMoveUp}
            disabled={disabled || index === 0}
          >
            <ArrowIcon dir="up" />
          </IconButton>
          <IconButton
            label={b.moveStepDown}
            onClick={onMoveDown}
            disabled={disabled || index === total - 1}
          >
            <ArrowIcon dir="down" />
          </IconButton>
          <IconButton
            label={b.removeStepBtn}
            onClick={onRemove}
            disabled={disabled || total === 1}
            danger
          >
            <XIcon />
          </IconButton>
        </div>
      </div>

      <div
        className={cn(
          "px-5 pb-5 pt-3",
          hasRail && "lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8",
        )}
      >
        {/* ── Document column — name, identity strip, the instruction ───── */}
        <div className="min-w-0 flex flex-col">
          <div className={fieldUnderlineCls}>
            <input
              type="text"
              value={step.description ?? ""}
              onChange={(e) =>
                onChange({
                  ...step,
                  description: e.target.value || undefined,
                } as WorkflowStep)
              }
              disabled={disabled}
              maxLength={200}
              placeholder={b.stepTitlePlaceholder}
              aria-label={b.stepTitlePlaceholder}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              className={cn(
                "w-full border-0 bg-transparent p-0 text-xl font-semibold leading-tight text-foreground placeholder:text-muted-foreground/40",
                quietFieldCls,
              )}
            />
          </div>

          {/* Identity strip — what runs, who runs it, what it works on.
              Lives in the document column so a short instruction doesn't
              leave it empty while the rail stacks four cards deep. */}
          <div className="mt-3 grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <FieldLabel label={b.stepTypeLabel} />
              <Select
                value={step.type}
                onValueChange={(v) => {
                  if (v) onChange(convertStep(step, v as WorkflowStep["type"]));
                }}
                disabled={disabled}
                // Base UI's <SelectValue> shows the raw value unless the Root
                // gets an items label-map - without this it reads "tool_call".
                items={{
                  assistant_call: b.stepTypeAssistantCall,
                  tool_call: b.stepTypeToolCall,
                  branch: b.stepTypeBranch,
                  wait: b.stepTypeWait,
                }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="assistant_call">
                    {b.stepTypeAssistantCall}
                  </SelectItem>
                  <SelectItem value="tool_call">{b.stepTypeToolCall}</SelectItem>
                  <SelectItem value="branch">{b.stepTypeBranch}</SelectItem>
                  <SelectItem value="wait">{b.stepTypeWait}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isAssistant && (
              <>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel label={b.assistantPickerLabel} />
                  <Select
                    value={step.target.assistantId}
                    onValueChange={(v) => {
                      if (v)
                        onChange({
                          ...step,
                          target: { ...step.target, assistantId: v },
                        });
                    }}
                    disabled={disabled}
                    // Label-map so the trigger shows the name, not a UUID.
                    items={{
                      primary: b.assistantPickerPrimary,
                      ...Object.fromEntries(
                        assistants.map((a) => [a.id, a.name]),
                      ),
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="primary">
                        {b.assistantPickerPrimary}
                      </SelectItem>
                      {assistants.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <PageAnchorField
                  step={step}
                  pages={pages}
                  steps={steps}
                  onChange={onChange}
                  disabled={disabled}
                  t={t}
                />
                <BlueprintField
                  step={step}
                  blueprints={blueprints}
                  onChange={onChange}
                  disabled={disabled}
                  t={t}
                />
                <SkillsField
                  step={step}
                  skills={skills}
                  onChange={onChange}
                  disabled={disabled}
                  t={t}
                />
              </>
            )}
          </div>

          {isAssistant ? (
            <InstructionBody
              step={step}
              onChange={onChange}
              disabled={disabled}
              t={t}
            />
          ) : (
            <RawJsonFields
              step={step}
              onChange={onChange}
              disabled={disabled}
              t={t}
            />
          )}
        </div>

        {/* ── Properties rail — tuning only (Execution + Output) ────────── */}
        {hasRail && (
          <aside className="mt-6 flex flex-col gap-3 text-sm lg:mt-0">
            {isAssistant && (
              <RailCard title={b.stepRailExecutionHeading}>
                <ExecutionFields
                  step={step}
                  onChange={onChange}
                  disabled={disabled}
                  t={t}
                />
              </RailCard>
            )}

            <RailCard title={b.stepRailOutputHeading}>
              <div className="flex flex-col gap-2.5">
                {step.type === "assistant_call" && (
                  <DeliverField
                    step={step}
                    destinations={destinations}
                    slackChannels={slackChannels}
                    onChange={onChange}
                    disabled={disabled}
                    t={t}
                  />
                )}
                <div className="flex flex-col gap-1.5">
                  <FieldLabel
                    label={b.storeOutputAsLabel}
                    hint={b.storeOutputAsHint}
                  />
                  <input
                    type="text"
                    value={step.storeOutputAs ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...step,
                        storeOutputAs: e.target.value || undefined,
                      } as WorkflowStep)
                    }
                    disabled={disabled}
                    placeholder="result"
                    maxLength={64}
                    className={RAIL_INPUT_CLS}
                  />
                </div>
              </div>
            </RailCard>
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Document body — the instruction as borderless prose ──────────────────

function InstructionBody({
  step,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const b = t.workflowPage.builder;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Grow to fit (document feel — the page scrolls, not the field). Same
  // affordance as the skill document's when-to-use textarea.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [step.prompt]);

  return (
    <>
      <div className="mt-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">
          {b.promptLabel}
        </span>
      </div>
      <div className={cn(fieldUnderlineCls, "mt-2")}>
        <textarea
          ref={ref}
          value={step.prompt}
          onChange={(e) => onChange({ ...step, prompt: e.target.value })}
          placeholder={b.promptPlaceholder}
          disabled={disabled}
          rows={5}
          maxLength={PROMPT_MAX}
          aria-label={b.promptLabel}
          className={cn(
            "min-h-32 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50",
            quietFieldCls,
          )}
        />
      </div>
      {/* Quiet budget counter — appears near the 8000-char schema cap. */}
      {step.prompt.length > PROMPT_WARN_AT && (
        <p className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
          {format(b.promptCharCount, {
            count: String(step.prompt.length),
            max: String(PROMPT_MAX),
          })}
        </p>
      )}
    </>
  );
}

// ── Execution — model / budget / continuity, compact rail rows ───────────

function ExecutionFields({
  step,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const b = t.workflowPage.builder;
  const toolsCsv = (step.tools ?? []).join(", ");
  const [maxTurnsDraft, setMaxTurnsDraft] = useState<string>(
    step.maxTurns == null ? "" : String(step.maxTurns),
  );
  // Keep the local draft in sync if the step changes externally (e.g. type
  // switch or workspace switch). Only resets on identity-changing edits.
  useEffect(() => {
    setMaxTurnsDraft(step.maxTurns == null ? "" : String(step.maxTurns));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  function commitMaxTurns() {
    const trimmed = maxTurnsDraft.trim();
    if (trimmed === "") {
      if (step.maxTurns != null) onChange({ ...step, maxTurns: null });
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      setMaxTurnsDraft(step.maxTurns == null ? "" : String(step.maxTurns));
      return;
    }
    const clamped = Math.min(Math.max(parsed, 1), 60);
    if (clamped !== parsed) setMaxTurnsDraft(String(clamped));
    if (clamped !== step.maxTurns) onChange({ ...step, maxTurns: clamped });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <FieldLabel label={b.stepModelLabel} hint={b.stepModelHint} />
        <Select
          value={step.modelAlias ?? "pro"}
          onValueChange={(v) => {
            if (!v) return;
            if (!MODEL_ALIASES.includes(v as WorkflowModelAlias)) return;
            onChange({ ...step, modelAlias: v as WorkflowModelAlias });
          }}
          disabled={disabled}
          items={{
            standard: b.stepModelStandard,
            pro: b.stepModelPro,
            max: b.stepModelMax,
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">{b.stepModelStandard}</SelectItem>
            <SelectItem value="pro">{b.stepModelPro}</SelectItem>
            <SelectItem value="max">{b.stepModelMax}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <SwitchRow
        label={b.stepResearchLabel}
        hint={b.stepResearchHint}
        control={
          <Switch
            checked={!!step.researchMode}
            onCheckedChange={(checked) =>
              onChange({ ...step, researchMode: checked })
            }
            disabled={disabled}
            aria-label={b.stepResearchLabel}
          />
        }
      />

      <div className="flex items-center justify-between gap-3">
        <FieldLabel label={b.stepMaxTurnsLabel} hint={b.stepMaxTurnsHint} />
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={60}
          value={maxTurnsDraft}
          onChange={(e) => setMaxTurnsDraft(e.target.value)}
          onBlur={commitMaxTurns}
          disabled={disabled}
          placeholder="-"
          aria-label={b.stepMaxTurnsLabel}
          className={cn(RAIL_INPUT_CLS, "w-20 text-right")}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel label={b.sessionLabel} hint={b.sessionHint} />
        <Select
          value={step.session ?? "per_run"}
          onValueChange={(v) => {
            if (!v) return;
            onChange({
              ...step,
              session: v === "persistent" ? "persistent" : undefined,
            });
          }}
          disabled={disabled}
          items={{
            per_run: b.sessionPerRun,
            persistent: b.sessionPersistent,
          }}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="per_run">{b.sessionPerRun}</SelectItem>
            <SelectItem value="persistent">{b.sessionPersistent}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel label={b.toolsFilterLabel} hint={b.toolsFilterHint} />
        <input
          type="text"
          value={toolsCsv}
          onChange={(e) => {
            const tools = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            onChange({ ...step, tools: tools.length > 0 ? tools : undefined });
          }}
          disabled={disabled}
          placeholder="webFetch, gmailSendMessage"
          className={RAIL_INPUT_CLS}
        />
      </div>
    </div>
  );
}

/** Page-anchor mode discriminator for the UI select. */
type PageAnchorMode = "none" | "edit" | "create" | "fromStep";

function pageAnchorMode(page: PageAnchor | undefined): PageAnchorMode {
  if (!page) return "none";
  if ("id" in page) return "edit";
  if ("create" in page) return "create";
  return "fromStep";
}

/**
 * "Page" subform — the bounded edit-page / create-page configuration on an
 * assistant_call step (`step.page`). Mode select (none / edit existing /
 * create new / from earlier step); edit mode picks from the workspace page
 * roster (saved pages first, drafts badged with the auto-prune caveat);
 * create mode takes a title (interpolatable) + optional nest-under parent;
 * fromStep picks among other steps that create a page. An empty pick is
 * never persisted - the detail page's save handler scrubs `page: {id: ""}`
 * back to no anchor (and the REST 400 on the uuid check backstops it).
 * Spec: docs/architecture/features/workflow.md -> "assistant_call page anchor".
 */
function PageAnchorField({
  step,
  pages,
  steps,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  pages: ViewListRow[];
  steps: WorkflowStep[];
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const b = t.workflowPage.builder;
  const mode = pageAnchorMode(step.page);

  // Saved pages first, then drafts (badged) — mirrors the sidebar split.
  const sortedPages = [...pages].sort((a, z) =>
    a.state === z.state ? a.name.localeCompare(z.name) : a.state === "saved" ? -1 : 1,
  );
  const pageItems: SearchableSelectItem[] = sortedPages.map((p) => ({
    value: p.id,
    label: p.icon ? `${p.icon} ${p.name}` : p.name,
    hint: p.state === "draft" ? b.pageAnchorDraftBadge : undefined,
  }));

  // Other assistant_call steps that create a page — fromStep candidates.
  const createSteps = steps.filter(
    (s): s is Extract<WorkflowStep, { type: "assistant_call" }> =>
      s.type === "assistant_call" && s.id !== step.id && !!s.page && "create" in s.page,
  );

  const selectedPage =
    step.page && "id" in step.page
      ? pages.find((p) => p.id === (step.page as { id: string }).id)
      : undefined;
  const nestUnderId =
    step.page && "create" in step.page ? step.page.nestUnder ?? "" : "";

  function setMode(next: PageAnchorMode) {
    if (next === mode) return;
    switch (next) {
      case "none":
        onChange({ ...step, page: undefined });
        return;
      case "edit":
        onChange({ ...step, page: { id: "" } });
        return;
      case "create":
        onChange({ ...step, page: { create: true } });
        return;
      case "fromStep":
        onChange({ ...step, page: { fromStep: createSteps[0]?.id ?? "" } });
        return;
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={b.pageAnchorLabel} hint={b.pageAnchorHint} />
      <Select
        value={mode}
        onValueChange={(v) => {
          if (v) setMode(v as PageAnchorMode);
        }}
        disabled={disabled}
        items={{
          none: b.pageAnchorModeNone,
          edit: b.pageAnchorModeEdit,
          create: b.pageAnchorModeCreate,
          fromStep: b.pageAnchorModeFromStep,
        }}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{b.pageAnchorModeNone}</SelectItem>
          <SelectItem value="edit">{b.pageAnchorModeEdit}</SelectItem>
          <SelectItem value="create">{b.pageAnchorModeCreate}</SelectItem>
          {createSteps.length > 0 && (
            <SelectItem value="fromStep">{b.pageAnchorModeFromStep}</SelectItem>
          )}
        </SelectContent>
      </Select>

      {mode === "edit" && (
        <>
          <SearchableSelect
            value={step.page && "id" in step.page ? step.page.id : ""}
            onValueChange={(v) => onChange({ ...step, page: { id: v } })}
            items={pageItems}
            placeholder={b.pageAnchorPlaceholder}
            emptyMessage={b.pageAnchorEmpty}
            disabled={disabled}
          />
          {selectedPage?.state === "draft" && (
            <div className="text-[11px] text-muted-foreground/80">
              {b.pageAnchorDraftHint}
            </div>
          )}
        </>
      )}

      {mode === "create" && (
        <>
          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.pageAnchorTitleLabel} />
            <input
              type="text"
              value={step.page && "create" in step.page ? step.page.title ?? "" : ""}
              onChange={(e) =>
                onChange({
                  ...step,
                  page: {
                    create: true,
                    ...(e.target.value ? { title: e.target.value } : {}),
                    ...(nestUnderId ? { nestUnder: nestUnderId } : {}),
                  },
                })
              }
              disabled={disabled}
              placeholder={b.pageAnchorTitlePlaceholder}
              maxLength={256}
              className={RAIL_INPUT_CLS}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.pageAnchorNestUnderLabel} />
            <SearchableSelect
              value={nestUnderId}
              onValueChange={(v) => {
                const title =
                  step.page && "create" in step.page ? step.page.title : undefined;
                onChange({
                  ...step,
                  page: {
                    create: true,
                    ...(title ? { title } : {}),
                    ...(v ? { nestUnder: v } : {}),
                  },
                });
              }}
              items={pageItems}
              placeholder={b.pageAnchorPlaceholder}
              emptyMessage={b.pageAnchorEmpty}
              disabled={disabled}
            />
          </div>
        </>
      )}

      {mode === "fromStep" && (
        <Select
          value={step.page && "fromStep" in step.page ? step.page.fromStep : ""}
          onValueChange={(v) => {
            if (v) onChange({ ...step, page: { fromStep: v } });
          }}
          disabled={disabled}
          items={Object.fromEntries(
            createSteps.map((s) => [s.id, s.description || s.id]),
          )}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={b.pageAnchorFromStepPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {createSteps.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.description || s.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** Sentinel for "no blueprint" — the default; persisted as `blueprintId: undefined`. */
const NO_BLUEPRINT_VALUE = "__none__";

/**
 * "Blueprint" subform — picks the synthesis blueprint this step fills (a
 * workspace blueprint template id). Mirrors `PageAnchorField`
 * (one `SearchableSelect` over the same blueprint items). Default = none (the
 * step runs with no blueprint). The executor wiring is built separately; this
 * only threads `blueprintId` into the saved step config.
 * Spec: docs/architecture/brain/structural-synthesis.md -> "The three fill modes".
 */
function BlueprintField({
  step,
  blueprints,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  blueprints: CustomPageTemplateSummary[];
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const b = t.workflowPage.builder;
  const items: SearchableSelectItem[] = [
    { value: NO_BLUEPRINT_VALUE, label: b.blueprintNone },
    ...buildBlueprintPickerItems(blueprints),
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={b.blueprintLabel} hint={b.blueprintHint} />
      <SearchableSelect
        value={step.blueprintId ?? NO_BLUEPRINT_VALUE}
        onValueChange={(v) =>
          onChange({
            ...step,
            blueprintId: !v || v === NO_BLUEPRINT_VALUE ? undefined : v,
          })
        }
        items={items}
        placeholder={b.blueprintPlaceholder}
        searchPlaceholder={b.blueprintSearchPlaceholder}
        emptyMessage={b.blueprintEmpty}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * "Skills" subform - the per-step brain-skill allow-list. A multi-select over
 * the workspace's skills: checking a skill adds its slug to `step.skills`, so
 * the callee is offered the `useSkill` tool over exactly those skills at run
 * time (each still gated by the assistant's own enablement + clearance in the
 * backend). Default = none selected (`skills: undefined`), which keeps the
 * historical no-skill behavior. Slugs already on the step but absent from the
 * fetched list (a built-in, or a deleted workspace skill) are preserved as
 * read-only chips so editing never silently drops them.
 * Spec: docs/architecture/features/workflow.md -> "assistant_call skills".
 */
function SkillsField({
  step,
  skills,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  skills: WorkspaceSkillSummary[];
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const b = t.workflowPage.builder;
  const selected = step.skills ?? [];
  const selectedSet = new Set(selected);
  const knownSlugs = new Set(skills.map((s) => s.slug));
  const extraSelected = selected.filter((slug) => !knownSlugs.has(slug));

  function toggle(slug: string, on: boolean) {
    const next = on ? [...selected, slug] : selected.filter((s) => s !== slug);
    onChange({ ...step, skills: next.length > 0 ? next : undefined });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={b.skillsLabel} hint={b.skillsHint} />
      {skills.length === 0 && extraSelected.length === 0 ? (
        <div className="text-xs text-muted-foreground">{b.skillsEmpty}</div>
      ) : (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-background p-2 max-h-56 overflow-y-auto">
          {skills.map((s) => {
            const checked = selectedSet.has(s.slug);
            return (
              <label
                key={s.rowId}
                className={cn(
                  "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/50",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => toggle(s.slug, e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium leading-tight">{s.name}</span>
                  {s.description ? (
                    <span className="text-xs text-muted-foreground leading-tight">
                      {s.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {extraSelected.map((slug) => (
            <label
              key={slug}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                checked
                disabled={disabled}
                onChange={(e) => toggle(slug, e.target.checked)}
                className="size-4 shrink-0 accent-primary"
              />
              <span className="font-mono text-xs text-muted-foreground">
                {slug}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Send output to a channel" subform. A Switch reveals the channel-type +
 * destination pickers: a dropdown of known destinations plus a "Custom ID..."
 * escape hatch for platform IDs the bot hasn't talked in yet. Slack options
 * come live from the workspace's real channels (by `#name`); the other types
 * are sessions-derived recent chats, shape-filtered and (for Telegram)
 * resolved to display names server-side — see
 * docs/architecture/features/workflow.md → "Deliver destination picker
 * (web builder)".
 */
function DeliverField({
  step,
  destinations,
  slackChannels,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  destinations: ChannelDestination[];
  slackChannels: SlackChannelOption[];
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const b = t.workflowPage.builder;
  const channelType = step.deliver?.channelType ?? "telegram";
  const channelId = step.deliver?.channelId ?? "";

  // Known destinations for the picked channel type. Slack is sourced live from
  // the workspace's real channels by NAME (`#dev-work`), so authors never see
  // a raw id and a non-Slack id (a Telegram chat id, an internal channels.id)
  // can never appear — it just isn't a real Slack channel. Other types fall
  // back to the sessions-derived recent chats, which the server shape-filters
  // per type and (for Telegram) names via Bot API `getChat` — `title` carries
  // the chat/person name, so the label is human-readable with the raw id as
  // hint. 'web' has no destination surface — the custom-ID input takes over.
  const isSlack = channelType === "slack";
  const relevant = destinations.filter((d) => d.channelType === channelType);
  const known: SearchableSelectItem[] = isSlack
    ? slackChannels.map((c) => ({ value: c.id, label: `#${c.name}`, hint: c.id }))
    : relevant.map((d) => ({
        value: d.channelId,
        label: d.title || d.channelId,
        hint: d.title ? d.channelId : undefined,
      }));
  const matchesKnown = known.some((k) => k.value === channelId);

  // Custom-mode is sticky once toggled (so the input stays visible while
  // empty) — derived from data otherwise.
  const [stickyCustom, setStickyCustom] = useState(false);
  const showCustom = stickyCustom || (!matchesKnown && channelId !== "");

  const items: SearchableSelectItem[] = [
    ...known,
    {
      value: CUSTOM_DESTINATION_VALUE,
      label: b.deliverDestinationCustomOption,
    },
  ];

  const selectValue = matchesKnown
    ? channelId
    : showCustom
      ? CUSTOM_DESTINATION_VALUE
      : "";

  return (
    <div className="flex flex-col gap-2">
      <SwitchRow
        label={b.deliverLabel}
        hint={b.deliverHint}
        control={
          <Switch
            checked={!!step.deliver}
            onCheckedChange={(checked) => {
              setStickyCustom(false);
              onChange({
                ...step,
                deliver: checked
                  ? { channelType: "telegram", channelId: "" }
                  : undefined,
              });
            }}
            disabled={disabled}
            aria-label={b.deliverLabel}
          />
        }
      />
      {step.deliver && (
        <div className="flex flex-col gap-2">
          <Select
            value={channelType}
            onValueChange={(v) => {
              if (!v) return;
              setStickyCustom(false);
              onChange({
                ...step,
                deliver: { channelType: v as DeliverChannelType, channelId: "" },
              });
            }}
            disabled={disabled}
            items={{
              telegram: b.deliverChannelTelegram,
              slack: b.deliverChannelSlack,
              whatsapp: b.deliverChannelWhatsApp,
              web: b.deliverChannelWeb,
            }}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="telegram">{b.deliverChannelTelegram}</SelectItem>
              <SelectItem value="slack">{b.deliverChannelSlack}</SelectItem>
              <SelectItem value="whatsapp">{b.deliverChannelWhatsApp}</SelectItem>
              <SelectItem value="web">{b.deliverChannelWeb}</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex flex-col gap-1.5">
            <FieldLabel label={b.deliverDestinationLabel} />
            <SearchableSelect
              value={selectValue}
              onValueChange={(v) => {
                if (v === CUSTOM_DESTINATION_VALUE) {
                  setStickyCustom(true);
                  onChange({
                    ...step,
                    deliver: { channelType, channelId: "" },
                  });
                  return;
                }
                setStickyCustom(false);
                onChange({
                  ...step,
                  deliver: { channelType, channelId: v },
                });
              }}
              items={items}
              placeholder={
                isSlack
                  ? b.deliverDestinationSlackPlaceholder
                  : b.deliverDestinationPlaceholder
              }
              emptyMessage={
                isSlack
                  ? b.deliverDestinationSlackEmpty
                  : b.deliverDestinationEmpty
              }
              disabled={disabled || channelType === "web"}
            />
            {known.length === 0 && channelType !== "web" && (
              <div className="text-[11px] text-muted-foreground/80">
                {isSlack
                  ? b.deliverDestinationSlackEmpty
                  : b.deliverDestinationEmpty}
              </div>
            )}
          </div>

          {(showCustom || channelType === "web") && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                label={b.deliverDestinationCustomLabel}
                hint={b.deliverDestinationCustomHint}
              />
              <input
                type="text"
                value={channelId}
                onChange={(e) =>
                  onChange({
                    ...step,
                    deliver: { channelType, channelId: e.target.value },
                  })
                }
                disabled={disabled}
                placeholder={b.deliverChannelIdPlaceholder}
                maxLength={256}
                className={RAIL_INPUT_CLS}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RawJsonFields({
  step,
  onChange,
  disabled,
  t,
}: {
  step: WorkflowStep;
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const [text, setText] = useState(() => JSON.stringify(step, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Reset textarea state when step type / id changes externally (type switch).
  useEffect(() => {
    setText(JSON.stringify(step, null, 2));
    setError(null);
    // We only want this when the type/id flips; deep-watching `step` would
    // re-stringify on every keystroke and clobber user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.type, step.id]);

  const summary = stepSummary(step, t);
  return (
    <div className="mt-3 flex flex-col gap-2">
      {/* Plain-language summary first, so a non-technical reader understands the
          step without parsing JSON. The raw config moves into the Advanced
          disclosure below (collapsed by default - one click, nothing removed). */}
      {summary && <p className="text-sm text-muted-foreground">{summary}</p>}

      <details className="rounded-md bg-muted/40 px-3 py-2 [&[open]]:pb-3">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground marker:text-muted-foreground">
          {t.workflowPage.builder.stepAdvancedLabel}
        </summary>
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              try {
                const parsed = JSON.parse(v);
                if (parsed && typeof parsed === "object" && parsed.id) {
                  setError(null);
                  onChange(parsed as WorkflowStep);
                }
              } catch {
                setError(t.workflowPage.builder.stepJsonInvalid);
              }
            }}
            disabled={disabled}
            // A typical tool_call step serializes to ~11+ lines; default taller
            // (still resize-y) so the whole step JSON is visible once expanded.
            rows={14}
            spellCheck={false}
            className="px-3 py-2 bg-background border border-border rounded-md text-xs font-mono outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          <div className="text-[11px] text-muted-foreground/80">
            {t.workflowPage.builder.stepRawJsonHint}
          </div>
        </div>
      </details>

      {/* Validation errors stay outside the disclosure so they're never hidden. */}
      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

/**
 * Plain-language one-liner for a non-assistant step, shown above the Advanced
 * JSON so the editor reads for non-technical users. Falls back to a per-type
 * sentence (the author's `description` is the document title now).
 */
function stepSummary(step: WorkflowStep, t: Dictionary): string {
  const b = t.workflowPage.builder;
  switch (step.type) {
    case "tool_call":
      return step.toolName
        ? format(b.stepSummaryToolCall, { tool: step.toolName })
        : b.stepSummaryToolCallGeneric;
    case "branch":
      return b.stepSummaryBranch;
    case "wait":
      return b.stepSummaryWait;
    default:
      return "";
  }
}

function stepTypeLabel(type: WorkflowStep["type"], t: Dictionary): string {
  const b = t.workflowPage.builder;
  switch (type) {
    case "assistant_call":
      return b.stepTypeAssistantCall;
    case "tool_call":
      return b.stepTypeToolCall;
    case "wait":
      return b.stepTypeWait;
    case "branch":
      return b.stepTypeBranch;
  }
}

function convertStep(prev: WorkflowStep, type: WorkflowStep["type"]): WorkflowStep {
  if (prev.type === type) return prev;
  const common = {
    id: prev.id,
    description: "description" in prev ? prev.description : undefined,
  };
  switch (type) {
    case "assistant_call":
      return {
        ...common,
        type: "assistant_call",
        target: { assistantId: "primary" },
        prompt: "",
      };
    case "tool_call":
      return {
        ...common,
        type: "tool_call",
        toolName: "",
        arguments: {},
      };
    case "wait":
      return {
        ...common,
        type: "wait",
        until: { duration: { minutes: 5 } },
      };
    case "branch":
      return {
        ...common,
        type: "branch",
        condition: true,
        nextStepIdIfTrue: null,
        nextStepIdIfFalse: null,
      };
  }
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent",
        danger && "hover:text-red-600 dark:hover:text-red-400",
      )}
    >
      {children}
    </button>
  );
}

function ArrowIcon({ dir }: { dir: "up" | "down" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {dir === "up" ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M5 12l7 7 7-7" />}
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function format(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
