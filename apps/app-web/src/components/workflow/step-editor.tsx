"use client";

/**
 * Per-step editor card (app-web). Specializes for `assistant_call` with
 * assistant picker + prompt + tools filter + storeOutputAs. Other step types
 * fall through to a raw-JSON editor (advanced).
 *
 * Ported from `apps/web/src/components/workflow/step-editor.tsx` (app
 * consolidation §5a). The model option labels (Standard / Pro / Max) come
 * from the `workflowPage.builder.stepModel*` keys here rather than the
 * `assistant.modelSelector.*` subtree the web app shares — app-web does
 * not host the assistant-config surface, so the workflow subtree carries its
 * own model labels to stay self-contained.
 *
 * Spec: docs/architecture/features/workflow.md.
 * [COMP:app-web/workflow]
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { ViewListRow } from "@/lib/api/views";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import { buildBlueprintPickerItems } from "@/lib/blueprints";
import type {
  ChannelDestination,
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
import { cn } from "@/lib/utils";

const SELECT_TRIGGER_CLASS = "w-full max-w-xs text-sm";

const MODEL_ALIASES: WorkflowModelAlias[] = ["standard", "pro", "max"];

/** Sentinel value used by the destinations dropdown to reveal a custom-ID input. */
const CUSTOM_DESTINATION_VALUE = "__custom__";

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
   * Workspace page roster (saved + drafts) — backs the page-anchor picker
   * (`PageAnchorField`). Empty when the roster fetch failed; the field
   * degrades gracefully.
   */
  pages: ViewListRow[];
  /**
   * Workspace blueprints (page templates carrying an extraction spec) — backs
   * the per-step blueprint picker (`BlueprintField`). Empty when the fetch
   * failed; the field degrades to just the two built-ins.
   */
  blueprints: CustomPageTemplateSummary[];
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
  pages,
  blueprints,
  steps,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  disabled,
}: Props) {
  const t = useT();
  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-muted/30">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {format(t.workflowPage.builder.stepNumber, { n: String(index + 1) })}
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label={t.workflowPage.builder.moveStepUp}
            onClick={onMoveUp}
            disabled={disabled || index === 0}
          >
            <ArrowIcon dir="up" />
          </IconButton>
          <IconButton
            label={t.workflowPage.builder.moveStepDown}
            onClick={onMoveDown}
            disabled={disabled || index === total - 1}
          >
            <ArrowIcon dir="down" />
          </IconButton>
          <IconButton
            label={t.workflowPage.builder.removeStepBtn}
            onClick={onRemove}
            disabled={disabled || total === 1}
            danger
          >
            <XIcon />
          </IconButton>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.stepTypeLabel}
          </label>
          <Select
            value={step.type}
            onValueChange={(v) => {
              if (v) onChange(convertStep(step, v as WorkflowStep["type"]));
            }}
            disabled={disabled}
            // Base UI's <SelectValue> shows the raw value unless the Root gets
            // an items label-map - without this the trigger reads "tool_call".
            items={{
              assistant_call: t.workflowPage.builder.stepTypeAssistantCall,
              tool_call: t.workflowPage.builder.stepTypeToolCall,
              branch: t.workflowPage.builder.stepTypeBranch,
              wait: t.workflowPage.builder.stepTypeWait,
            }}
          >
            <SelectTrigger className={SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="assistant_call">
                {t.workflowPage.builder.stepTypeAssistantCall}
              </SelectItem>
              <SelectItem value="tool_call">
                {t.workflowPage.builder.stepTypeToolCall}
              </SelectItem>
              <SelectItem value="branch">{t.workflowPage.builder.stepTypeBranch}</SelectItem>
              <SelectItem value="wait">{t.workflowPage.builder.stepTypeWait}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {step.type === "assistant_call" ? (
          <AssistantCallFields
            step={step}
            assistants={assistants}
            destinations={destinations}
            pages={pages}
            blueprints={blueprints}
            steps={steps}
            onChange={onChange}
            disabled={disabled}
            t={t}
          />
        ) : (
          <RawJsonFields step={step} onChange={onChange} disabled={disabled} t={t} />
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.storeOutputAsLabel}
          </label>
          <input
            type="text"
            value={step.type !== "branch" ? step.storeOutputAs ?? "" : ""}
            onChange={(e) =>
              onChange(
                step.type === "branch"
                  ? step
                  : ({ ...step, storeOutputAs: e.target.value || undefined } as WorkflowStep),
              )
            }
            disabled={disabled || step.type === "branch"}
            placeholder="result"
            maxLength={64}
            className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring max-w-xs"
          />
          <div className="text-xs text-muted-foreground">
            {t.workflowPage.builder.storeOutputAsHint}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantCallFields({
  step,
  assistants,
  destinations,
  pages,
  blueprints,
  steps,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  assistants: StudioAssistantSummary[];
  destinations: ChannelDestination[];
  pages: ViewListRow[];
  blueprints: CustomPageTemplateSummary[];
  steps: WorkflowStep[];
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
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
    <>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.assistantPickerLabel}
        </label>
        <Select
          value={step.target.assistantId}
          onValueChange={(v) => {
            if (v) onChange({ ...step, target: { ...step.target, assistantId: v } });
          }}
          disabled={disabled}
          // Label-map so the trigger shows the assistant's name, not its UUID.
          items={{
            primary: t.workflowPage.builder.assistantPickerPrimary,
            ...Object.fromEntries(assistants.map((a) => [a.id, a.name])),
          }}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="primary">
              {t.workflowPage.builder.assistantPickerPrimary}
            </SelectItem>
            {assistants.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.promptLabel}
        </label>
        <textarea
          value={step.prompt}
          onChange={(e) => onChange({ ...step, prompt: e.target.value })}
          placeholder={t.workflowPage.builder.promptPlaceholder}
          disabled={disabled}
          rows={4}
          maxLength={8000}
          className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
        />
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

      {/* Per-step run settings: model + research mode + max turns. Replaces
          the workflow-global RUN SETTINGS panel — each step now picks its
          own budget. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.stepModelLabel}
          </label>
          <Select
            value={step.modelAlias ?? "pro"}
            onValueChange={(v) => {
              if (!v) return;
              if (!MODEL_ALIASES.includes(v as WorkflowModelAlias)) return;
              onChange({ ...step, modelAlias: v as WorkflowModelAlias });
            }}
            disabled={disabled}
            items={{
              standard: t.workflowPage.builder.stepModelStandard,
              pro: t.workflowPage.builder.stepModelPro,
              max: t.workflowPage.builder.stepModelMax,
            }}
          >
            <SelectTrigger className="w-full text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">
                {t.workflowPage.builder.stepModelStandard}
              </SelectItem>
              <SelectItem value="pro">
                {t.workflowPage.builder.stepModelPro}
              </SelectItem>
              <SelectItem value="max">
                {t.workflowPage.builder.stepModelMax}
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground">
            {t.workflowPage.builder.stepModelHint}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.stepMaxTurnsLabel}
          </label>
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
            className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="text-xs text-muted-foreground">
            {t.workflowPage.builder.stepMaxTurnsHint}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t.workflowPage.builder.stepResearchLabel}
          </label>
          <button
            type="button"
            role="switch"
            aria-checked={!!step.researchMode}
            disabled={disabled}
            onClick={() => onChange({ ...step, researchMode: !step.researchMode })}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50",
              step.researchMode ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                step.researchMode ? "translate-x-6" : "translate-x-1",
              )}
            />
          </button>
          <div className="text-xs text-muted-foreground">
            {t.workflowPage.builder.stepResearchHint}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.toolsFilterLabel}
        </label>
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
          className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="text-xs text-muted-foreground">
          {t.workflowPage.builder.toolsFilterHint}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.sessionLabel}
        </label>
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
            per_run: t.workflowPage.builder.sessionPerRun,
            persistent: t.workflowPage.builder.sessionPersistent,
          }}
        >
          <SelectTrigger className={SELECT_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="per_run">{t.workflowPage.builder.sessionPerRun}</SelectItem>
            <SelectItem value="persistent">{t.workflowPage.builder.sessionPersistent}</SelectItem>
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-foreground">
          {t.workflowPage.builder.sessionHint}
        </div>
      </div>

      <DeliverField
        step={step}
        destinations={destinations}
        onChange={onChange}
        disabled={disabled}
        t={t}
      />
    </>
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
      <label className="text-xs font-medium text-muted-foreground">
        {b.pageAnchorLabel}
      </label>
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
        <SelectTrigger className={SELECT_TRIGGER_CLASS}>
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
        <div className="flex flex-col gap-1.5 pl-6">
          <SearchableSelect
            value={step.page && "id" in step.page ? step.page.id : ""}
            onValueChange={(v) => onChange({ ...step, page: { id: v } })}
            items={pageItems}
            placeholder={b.pageAnchorPlaceholder}
            emptyMessage={b.pageAnchorEmpty}
            disabled={disabled}
          />
          {selectedPage?.state === "draft" && (
            <div className="text-xs text-muted-foreground">
              {b.pageAnchorDraftHint}
            </div>
          )}
        </div>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-2 pl-6">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {b.pageAnchorTitleLabel}
            </label>
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
              className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {b.pageAnchorNestUnderLabel}
            </label>
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
        </div>
      )}

      {mode === "fromStep" && (
        <div className="flex flex-col gap-1.5 pl-6">
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
            <SelectTrigger className={SELECT_TRIGGER_CLASS}>
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
        </div>
      )}

      <div className="text-xs text-muted-foreground">{b.pageAnchorHint}</div>
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
      <label className="text-xs font-medium text-muted-foreground">
        {b.blueprintLabel}
      </label>
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
        className={SELECT_TRIGGER_CLASS}
      />
      <div className="text-xs text-muted-foreground">{b.blueprintHint}</div>
    </div>
  );
}

/**
 * "Send output to a channel" subform. Replaces the old free-text channel ID
 * input with a dropdown of recent chat destinations (sessions-derived) plus
 * a "Custom ID..." escape hatch for platform IDs the bot hasn't talked in yet.
 */
function DeliverField({
  step,
  destinations,
  onChange,
  disabled,
  t,
}: {
  step: Extract<WorkflowStep, { type: "assistant_call" }>;
  destinations: ChannelDestination[];
  onChange: (s: WorkflowStep) => void;
  disabled?: boolean;
  t: Dictionary;
}) {
  const channelType = step.deliver?.channelType ?? "telegram";
  const channelId = step.deliver?.channelId ?? "";

  // Destinations relevant to the picked channel type. 'web' has no sessions
  // surface — destinations stays empty and the custom-ID input takes over.
  const relevant = destinations.filter((d) => d.channelType === channelType);
  const matchesKnown = relevant.some((d) => d.channelId === channelId);

  // Custom-mode is sticky once toggled (so the input stays visible while
  // empty) — derived from data otherwise.
  const [stickyCustom, setStickyCustom] = useState(false);
  const showCustom = stickyCustom || (!matchesKnown && channelId !== "");

  const items: SearchableSelectItem[] = [
    ...relevant.map((d) => ({
      value: d.channelId,
      label: d.title || d.channelId,
      hint: d.title ? d.channelId : undefined,
    })),
    {
      value: CUSTOM_DESTINATION_VALUE,
      label: t.workflowPage.builder.deliverDestinationCustomOption,
    },
  ];

  const selectValue = matchesKnown
    ? channelId
    : showCustom
      ? CUSTOM_DESTINATION_VALUE
      : "";

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <input
          type="checkbox"
          checked={!!step.deliver}
          onChange={(e) => {
            setStickyCustom(false);
            onChange({
              ...step,
              deliver: e.target.checked
                ? { channelType: "telegram", channelId: "" }
                : undefined,
            });
          }}
          disabled={disabled}
          className="h-3.5 w-3.5 rounded border-border"
        />
        {t.workflowPage.builder.deliverLabel}
      </label>
      {step.deliver && (
        <div className="flex flex-col gap-2 pl-6">
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
              telegram: t.workflowPage.builder.deliverChannelTelegram,
              slack: t.workflowPage.builder.deliverChannelSlack,
              web: t.workflowPage.builder.deliverChannelWeb,
            }}
          >
            <SelectTrigger className={SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="telegram">
                {t.workflowPage.builder.deliverChannelTelegram}
              </SelectItem>
              <SelectItem value="slack">
                {t.workflowPage.builder.deliverChannelSlack}
              </SelectItem>
              <SelectItem value="web">
                {t.workflowPage.builder.deliverChannelWeb}
              </SelectItem>
            </SelectContent>
          </Select>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t.workflowPage.builder.deliverDestinationLabel}
            </label>
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
              placeholder={t.workflowPage.builder.deliverDestinationPlaceholder}
              emptyMessage={t.workflowPage.builder.deliverDestinationEmpty}
              disabled={disabled || channelType === "web"}
            />
            {relevant.length === 0 && channelType !== "web" && (
              <div className="text-xs text-muted-foreground">
                {t.workflowPage.builder.deliverDestinationEmpty}
              </div>
            )}
          </div>

          {(showCustom || channelType === "web") && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t.workflowPage.builder.deliverDestinationCustomLabel}
              </label>
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
                placeholder={t.workflowPage.builder.deliverChannelIdPlaceholder}
                maxLength={256}
                className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="text-xs text-muted-foreground">
                {t.workflowPage.builder.deliverDestinationCustomHint}
              </div>
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            {t.workflowPage.builder.deliverHint}
          </div>
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
    <div className="flex flex-col gap-2">
      {/* Plain-language summary first, so a non-technical reader understands the
          step without parsing JSON. The raw config moves into the Advanced
          disclosure below (collapsed by default - one click, nothing removed). */}
      {summary && <p className="text-sm text-foreground">{summary}</p>}

      <details className="rounded-md border border-border bg-muted/20 px-3 py-2 [&[open]]:pb-3">
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
          <div className="text-xs text-muted-foreground">
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
 * JSON so the editor reads for non-technical users. Prefers the author's
 * `description`; falls back to a per-type sentence.
 */
function stepSummary(step: WorkflowStep, t: Dictionary): string {
  const b = t.workflowPage.builder;
  const desc = step.description?.trim();
  if (desc) return desc;
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
