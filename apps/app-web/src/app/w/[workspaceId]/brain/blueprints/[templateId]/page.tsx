"use client";

/**
 * Blueprint detail editor — `/w/[workspaceId]/brain/blueprints/[templateId]`.
 *
 * The full-page surface for ONE blueprint (a `workspace_page_templates` row
 * with an `extraction` contract). The v3 contract is the blueprint's identity,
 * so this page makes it visible and editable — the library row was previously
 * opaque (name + section count only). Document + properties rail in the skill
 * editor's design language, SINGLE MODE (no edit/view split):
 *
 *   Topbar — `BrainTopbar` (breadcrumb: Brain / Blueprints / name + badge);
 *     the right cluster carries the Unsaved dot and THE one Save button,
 *     disabled until `buildTemplatePatch` has a diff.
 *   Main column — borderless title + description (SkillDocument's field
 *     recipe), then the CONTRACT as one card per field: heading, type select,
 *     reorder/remove, instruction, per-type extras (enum options, entityRef
 *     kind, markdown output shape), the `key` as an editable mono chip, and a
 *     required switch. The records list renders under the contract (same row
 *     recipe as the library expander).
 *   Right rail — Actions (Generate from brain via the shared
 *     `useGenerateFromBrain` flow; destructive Delete behind `confirmDialog`)
 *     and About (section count, records, capture, dates).
 *
 * Key stability rule (structural-synthesis.md -> "The blueprint detail
 * editor"): an existing field's key never rederives from a heading edit; the
 * draft logic in `lib/blueprint-editor.ts` owns that plus validation + the
 * dirty diff, so it is unit-tested without a render harness.
 *
 * [COMP:web/blueprint-detail]
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useLocale, format } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { useBrainSurface } from "@/contexts/brain-surface-context";
import type {
  BlueprintCaptureKind,
  CustomPageTemplate,
  EntityRefKind,
  ExtractionFieldType,
} from "@sidanclaw/doc-model";
import {
  EXTRACTION_FIELD_TYPES,
  BLUEPRINT_CAPTURE_KINDS,
  ENTITY_REF_KINDS,
} from "@sidanclaw/doc-model";
import {
  deleteCustomPageTemplate,
  getCustomPageTemplate,
  listBlueprintRecords,
  openBlueprintRecordPage,
  updateCustomPageTemplate,
  type BlueprintRecordSummary,
} from "@/lib/api/views";
import {
  applyHeadingChange,
  applyKeyChange,
  buildTemplatePatch,
  draftFromTemplate,
  moveField,
  newDraftField,
  setCaptureInstruction,
  toggleCaptureKind,
  validateDraft,
  type BlueprintDraft,
  type DraftField,
  type DraftIssue,
} from "@/lib/blueprint-editor";
import { requestBrainRefresh } from "@/lib/brain-events";
import { docPagePath } from "@/lib/doc-page-url";
import { useGenerateFromBrain } from "@/components/brain/use-generate-from-brain";
import {
  createPageAction,
  deletePageAction,
  listBlueprintPageActions,
  updatePageAction,
  type PageActionRow,
} from "@/lib/api/page-actions";
import { listWorkflows, type WorkflowSummary } from "@/lib/api/workflow";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  fieldUnderlineCls,
  quietFieldCls,
} from "@/components/brain/skill-document";
import { BrainTopbar } from "@/components/brain/brain-topbar";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Grow a textarea to its content (document feel — the page scrolls, not the
 *  field). Local copy of SkillDocument's module-private hook. */
function useAutosize(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

function BlueprintEditorInner({ templateId }: { templateId: string }) {
  const t = useT();
  const { activeId } = useWorkspaces();
  const copy = t.brainPage.blueprintEditor;
  const backHref = activeId ? `/w/${activeId}/brain?view=blueprints` : "/";

  // A hard load on this route would otherwise leave the sidebar quick-panel
  // on its "entries" default — sync the surface to the section we live under.
  const { setSection } = useBrainSurface();
  useEffect(() => {
    setSection("blueprints");
  }, [setSection]);

  // undefined = loading, null = not found, value = loaded.
  const [template, setTemplate] = useState<CustomPageTemplate | null | undefined>(
    undefined,
  );

  const reload = useCallback(async () => {
    if (!activeId) return;
    try {
      setTemplate(await getCustomPageTemplate(activeId, templateId));
    } catch {
      setTemplate(null);
    }
  }, [activeId, templateId]);

  useEffect(() => {
    setTemplate(undefined);
    void reload();
  }, [reload]);

  if (template === undefined) {
    return (
      <>
        <BrainTopbar
          workspaceId={activeId ?? ""}
          tailSection="blueprints"
          tail={<span className="text-muted-foreground">…</span>}
        />
        <div className="mx-auto w-full max-w-3xl px-6 py-10 text-sm text-muted-foreground">
          …
        </div>
      </>
    );
  }

  if (template === null) {
    return (
      <>
        <BrainTopbar
          workspaceId={activeId ?? ""}
          tailSection="blueprints"
          tail={<span className="text-muted-foreground">{copy.notFoundTitle}</span>}
        />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-20 text-center">
          <div className="font-medium">{copy.notFoundTitle}</div>
          <p className="text-sm text-muted-foreground">{copy.notFoundBody}</p>
          <BackButton href={backHref} label={copy.back} className="mx-auto" />
        </div>
      </>
    );
  }

  return (
    <BlueprintEditor
      workspaceId={activeId!}
      template={template}
      backHref={backHref}
      onSaved={() => void reload()}
    />
  );
}

// ── The loaded editor — Brain topbar + document column + properties rail ──

function BlueprintEditor({
  workspaceId,
  template,
  backHref,
  onSaved,
}: {
  workspaceId: string;
  template: CustomPageTemplate;
  backHref: string;
  onSaved: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const copy = t.brainPage.blueprintEditor;
  const libraryCopy = t.brainPage.blueprints;

  const [draft, setDraft] = useState<BlueprintDraft>(() =>
    draftFromTemplate(template),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-field validation renders only after a failed save attempt, then
  // live-updates as the author fixes the contract.
  const [showIssues, setShowIssues] = useState(false);

  // Resync the draft when the loaded row changes (a reload after save).
  useEffect(() => {
    setDraft(draftFromTemplate(template));
    setError(null);
    setShowIssues(false);
  }, [template]);

  const patch = buildTemplatePatch(template, draft);
  const dirty = Object.keys(patch).length > 0;
  const issues = useMemo(() => validateDraft(draft), [draft]);

  // Capture-kind display labels (entityRef labels + the capture-only memory).
  const captureItems: Record<BlueprintCaptureKind, string> = {
    company: copy.entityKindCompany,
    contact: copy.entityKindContact,
    deal: copy.entityKindDeal,
    task: copy.entityKindTask,
    memory: copy.captureKindMemory,
  };

  const setField = (uid: string, next: DraftField) => {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.uid === uid ? next : f)),
    }));
  };

  async function save() {
    if (issues.length > 0) {
      setShowIssues(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateCustomPageTemplate(workspaceId, template.id, patch);
      requestBrainRefresh(workspaceId);
      onSaved();
    } catch {
      setError(copy.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const generate = useGenerateFromBrain(workspaceId);

  async function handleDelete() {
    const ok = await confirmDialog({
      title: libraryCopy.deleteTitle,
      description: format(libraryCopy.deleteBody, { name: template.name }),
      confirmLabel: libraryCopy.deleteConfirm,
      cancelLabel: libraryCopy.deleteCancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    await deleteCustomPageTemplate(workspaceId, template.id).catch(() => {});
    requestBrainRefresh(workspaceId);
    router.push(backHref);
  }

  const topIssues = showIssues
    ? issues.filter((i) => !i.fieldUid).map((i) => issueMessage(copy, i))
    : [];

  return (
    <>
      <BrainTopbar
        workspaceId={workspaceId}
        tailSection="blueprints"
        tail={
          <>
            <span className="min-w-0 truncate">{template.name}</span>
            <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {libraryCopy.badge}
            </span>
          </>
        }
        right={
          <>
            {dirty && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
                />
                {copy.unsaved}
              </span>
            )}
            <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
              {copy.save}
            </Button>
          </>
        }
      />

      <div className="mx-auto w-full max-w-6xl px-6 py-8 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10">
        {/* ── Main column — the blueprint as a document ─────────────────── */}
        <div className="flex min-w-0 flex-col">
          {(error || topIssues.length > 0) && (
            <div className="mb-4 flex flex-col gap-1" role="alert">
              {error && <p className="text-xs text-red-500">{error}</p>}
              {topIssues.map((msg) => (
                <p key={msg} className="text-xs text-red-500">
                  {msg}
                </p>
              ))}
            </div>
          )}

          <div className={fieldUnderlineCls}>
            <input
              type="text"
              value={draft.name}
              maxLength={100}
              placeholder={copy.titlePlaceholder}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              aria-label={copy.titlePlaceholder}
              className={cn(
                "doc-page-title w-full border-0 bg-transparent p-0 text-3xl font-bold leading-tight text-foreground placeholder:text-muted-foreground/40",
                quietFieldCls,
              )}
            />
          </div>
          <div className={cn(fieldUnderlineCls, "mt-1.5")}>
            <input
              type="text"
              value={draft.description}
              maxLength={250}
              placeholder={copy.descriptionPlaceholder}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
              aria-label={copy.descriptionPlaceholder}
              className={cn(
                "w-full border-0 bg-transparent p-0 text-base text-muted-foreground placeholder:text-muted-foreground/40",
                quietFieldCls,
              )}
            />
          </div>

          {/* Sections divider — the quiet uppercase rule the skill editor uses. */}
          <div className="mt-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border/60" aria-hidden />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">
              {copy.structureHeading}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {copy.structureHint}
          </p>

          <div className="mt-3 flex flex-col gap-3">
            {draft.fields.map((field, index) => (
              <FieldCard
                key={field.uid}
                field={field}
                index={index}
                total={draft.fields.length}
                issues={
                  showIssues
                    ? issues
                        .filter((i) => i.fieldUid === field.uid)
                        .map((i) => issueMessage(copy, i))
                    : []
                }
                onChange={(next) => setField(field.uid, next)}
                onMove={(dir) =>
                  setDraft((d) => ({ ...d, fields: moveField(d.fields, field.uid, dir) }))
                }
                onRemove={() =>
                  setDraft((d) => ({
                    ...d,
                    fields: d.fields.filter((f) => f.uid !== field.uid),
                  }))
                }
              />
            ))}
          </div>

          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((d) => ({ ...d, fields: [...d.fields, newDraftField()] }))
              }
            >
              <Plus className="size-3.5" aria-hidden />
              {copy.addField}
            </Button>
          </div>

          {/* Capture — which brain records a fill also writes, with optional
              per-kind guidance (how tasks break down, what a memory should
              hold). Default ingestion (Pipeline B) is untouched; this only
              adds blueprint-directed writes. */}
          <div className="mt-8 flex items-center gap-3">
            <div className="h-px flex-1 bg-border/60" aria-hidden />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">
              {copy.captureHeading}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {copy.captureHint}
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {BLUEPRINT_CAPTURE_KINDS.map((kind) => (
              <CaptureRow
                key={kind}
                label={captureItems[kind]}
                enabled={draft.capture.includes(kind)}
                instruction={draft.captureInstructions[kind] ?? ""}
                placeholder={copy.captureInstructionPlaceholder}
                onToggle={() => setDraft((d) => toggleCaptureKind(d, kind))}
                onInstruction={(text) =>
                  setDraft((d) => setCaptureInstruction(d, kind, text))
                }
              />
            ))}
          </div>

          <RecordsSection workspaceId={workspaceId} blueprintId={template.id} />

          <PageActionsSection workspaceId={workspaceId} blueprintId={template.id} />
        </div>

        {/* ── Right rail — actions + about ──────────────────────────────── */}
        <aside className="mt-10 flex flex-col gap-4 text-sm lg:mt-0">
          <section className="rounded-lg bg-muted/40 px-3 py-2.5">
            <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
              {copy.actionsHeading}
            </h3>
            <div className="flex flex-col gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void generate({ id: template.id, name: template.name })}
                className="w-full"
              >
                <Sparkles className="size-3.5" aria-hidden />
                {libraryCopy.generateTitle}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void handleDelete()}
                className="w-full text-red-500 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {copy.deleteAction}
              </Button>
            </div>
          </section>

          <AboutCard template={template} sectionCount={draft.fields.length} />
        </aside>
      </div>
    </>
  );
}

function issueMessage(
  copy: ReturnType<typeof useT>["brainPage"]["blueprintEditor"],
  issue: DraftIssue,
): string {
  switch (issue.code) {
    case "name-required":
      return copy.issueNameRequired;
    case "fields-required":
      return copy.issueFieldsRequired;
    case "heading-required":
      return copy.issueHeadingRequired;
    case "instruction-required":
      return copy.issueInstructionRequired;
    case "key-invalid":
      return copy.issueKeyInvalid;
    case "key-duplicate":
      return copy.issueKeyDuplicate;
    case "options-required":
      return copy.issueOptionsRequired;
    case "entity-kind-required":
      return copy.issueEntityKindRequired;
  }
}

// ── One contract field as an editable card ─────────────────────────────

function FieldCard({
  field,
  index,
  total,
  issues,
  onChange,
  onMove,
  onRemove,
}: {
  field: DraftField;
  index: number;
  total: number;
  issues: string[];
  onChange: (next: DraftField) => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const t = useT();
  const copy = t.brainPage.blueprintEditor;

  const instructionRef = useRef<HTMLTextAreaElement | null>(null);
  useAutosize(instructionRef, field.instruction);

  // Enum options edit as free text; the draft keeps the parsed list so
  // validation and the wire shape never see the raw string.
  const [optionsText, setOptionsText] = useState(field.options.join(", "));
  useEffect(() => {
    setOptionsText(field.options.join(", "));
    // Resync only when the card starts representing another field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.uid]);

  const typeItems: Record<ExtractionFieldType, string> = {
    markdown: copy.typeMarkdown,
    string: copy.typeString,
    number: copy.typeNumber,
    date: copy.typeDate,
    boolean: copy.typeBoolean,
    enum: copy.typeEnum,
    entityRef: copy.typeEntityRef,
  };
  const kindItems: Record<EntityRefKind, string> = {
    company: copy.entityKindCompany,
    contact: copy.entityKindContact,
    deal: copy.entityKindDeal,
    task: copy.entityKindTask,
  };

  const iconBtnCls =
    "rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-0";

  return (
    <div className="group rounded-lg bg-muted/40 px-4 py-3 transition-colors focus-within:bg-muted/60">
      {/* Row 1 — heading + type + quiet hover actions. */}
      <div className="flex items-center gap-2">
        <div className={cn(fieldUnderlineCls, "min-w-0 flex-1")}>
          <input
            type="text"
            value={field.heading}
            maxLength={200}
            placeholder={copy.fieldHeadingPlaceholder}
            aria-label={copy.fieldHeadingPlaceholder}
            onChange={(e) => onChange(applyHeadingChange(field, e.target.value))}
            className={cn(
              "w-full border-0 bg-transparent p-0 text-sm font-medium text-foreground placeholder:text-muted-foreground/40",
              quietFieldCls,
            )}
          />
        </div>
        <Select
          value={field.type}
          onValueChange={(v) => {
            if (v) onChange({ ...field, type: v as ExtractionFieldType });
          }}
          items={typeItems}
        >
          <SelectTrigger
            size="sm"
            aria-label={copy.typeLabel}
            className="shrink-0 border-transparent bg-transparent text-xs text-muted-foreground hover:text-foreground"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {EXTRACTION_FIELD_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {typeItems[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-label={copy.moveUpAria}
          title={copy.moveUpAria}
          disabled={index === 0}
          onClick={() => onMove("up")}
          className={iconBtnCls}
        >
          <ArrowUp className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={copy.moveDownAria}
          title={copy.moveDownAria}
          disabled={index === total - 1}
          onClick={() => onMove("down")}
          className={iconBtnCls}
        >
          <ArrowDown className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={copy.removeFieldAria}
          title={copy.removeFieldAria}
          onClick={onRemove}
          className={cn(
            iconBtnCls,
            "hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* Row 2 — the fill instruction (what the synthesis engine is told). */}
      <div className={cn(fieldUnderlineCls, "mt-1.5")}>
        <textarea
          ref={instructionRef}
          value={field.instruction}
          rows={1}
          maxLength={2000}
          placeholder={copy.fieldInstructionPlaceholder}
          aria-label={copy.fieldInstructionPlaceholder}
          onChange={(e) => onChange({ ...field, instruction: e.target.value })}
          className={cn(
            "w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50",
            quietFieldCls,
          )}
        />
      </div>

      {/* Per-type extras. */}
      {field.type === "enum" && (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {copy.optionsLabel}
          </label>
          <div className={fieldUnderlineCls}>
            <input
              type="text"
              value={optionsText}
              placeholder={copy.optionsPlaceholder}
              aria-label={copy.optionsLabel}
              onChange={(e) => {
                setOptionsText(e.target.value);
                onChange({
                  ...field,
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
              }}
              className={cn(
                "w-full border-0 bg-transparent p-0 text-xs text-foreground placeholder:text-muted-foreground/50",
                quietFieldCls,
              )}
            />
          </div>
        </div>
      )}
      {field.type === "entityRef" && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {copy.entityKindLabel}
          </span>
          <Select
            value={field.entityKind || undefined}
            onValueChange={(v) => {
              if (v) onChange({ ...field, entityKind: v as EntityRefKind });
            }}
            items={kindItems}
          >
            <SelectTrigger size="sm" aria-label={copy.entityKindLabel} className="text-xs">
              <SelectValue placeholder={copy.entityKindPlaceholder} />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {ENTITY_REF_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kindItems[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Meta row — the key chip (the handoff address) + required. */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-1.5" title={copy.keyHint}>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {copy.keyLabel}
          </span>
          <div className={cn(fieldUnderlineCls, "min-w-0")}>
            <input
              type="text"
              value={field.key}
              maxLength={64}
              spellCheck={false}
              aria-label={copy.keyLabel}
              onChange={(e) => onChange(applyKeyChange(field, e.target.value))}
              className={cn(
                "w-40 border-0 bg-transparent p-0 font-mono text-[11px] text-muted-foreground placeholder:text-muted-foreground/40",
                quietFieldCls,
              )}
            />
          </div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="text-xs text-muted-foreground">{copy.requiredLabel}</span>
          <Switch
            checked={field.required}
            onCheckedChange={(checked) => onChange({ ...field, required: checked })}
            aria-label={copy.requiredLabel}
          />
        </label>
      </div>

      {issues.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5" role="alert">
          {issues.map((msg) => (
            <p key={msg} className="text-[11px] text-red-500">
              {msg}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Capture row — one brain-record kind a fill may also write ──────────

/** Toggle + optional per-kind guidance. The instruction textarea only renders
 *  while the kind is enabled; its text survives toggling (lossless draft). */
function CaptureRow({
  label,
  enabled,
  instruction,
  placeholder,
  onToggle,
  onInstruction,
}: {
  label: string;
  enabled: boolean;
  instruction: string;
  placeholder: string;
  onToggle: () => void;
  onInstruction: (text: string) => void;
}) {
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(instructionRef, instruction);
  return (
    <div className="rounded-lg bg-muted/40 px-4 py-3 transition-colors focus-within:bg-muted/60">
      <label className="flex cursor-pointer items-center justify-between gap-2">
        <span className="text-sm text-foreground">{label}</span>
        <Switch checked={enabled} onCheckedChange={onToggle} aria-label={label} />
      </label>
      {enabled && (
        <div className={cn(fieldUnderlineCls, "mt-2")}>
          <textarea
            ref={instructionRef}
            value={instruction}
            rows={1}
            maxLength={2000}
            placeholder={placeholder}
            aria-label={`${label}: ${placeholder}`}
            onChange={(e) => onInstruction(e.target.value)}
            className={cn(
              "w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50",
              quietFieldCls,
            )}
          />
        </div>
      )}
    </div>
  );
}

// ── Records — the blueprint's typed output rows (schema → rows) ────────

function RecordsSection({
  workspaceId,
  blueprintId,
}: {
  workspaceId: string;
  blueprintId: string;
}) {
  const t = useT();
  const copy = t.brainPage.blueprints;
  const router = useRouter();

  const [records, setRecords] = useState<BlueprintRecordSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listBlueprintRecords(workspaceId, blueprintId)
      .then((rows) => {
        if (!cancelled) setRecords(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, blueprintId]);

  async function handleOpenPage(record: BlueprintRecordSummary) {
    setOpeningId(record.id);
    try {
      const { pageId } = await openBlueprintRecordPage(workspaceId, record.id);
      router.push(docPagePath(workspaceId, pageId));
    } catch {
      await confirmDialog({
        title: copy.generateErrorTitle,
        description: copy.recordOpenPageFailed,
        confirmLabel: copy.generateErrorOk,
      });
    } finally {
      setOpeningId(null);
    }
  }

  const sourceLabel: Record<BlueprintRecordSummary["sourceKind"], string> = {
    recording: copy.recordSourceRecording,
    brain: copy.recordSourceBrain,
    research: copy.recordSourceResearch,
    chat: copy.recordSourceChat,
    workflow: copy.recordSourceWorkflow,
  };

  return (
    <>
      <div className="mt-8 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">
          {copy.recordsTitle}
        </span>
      </div>
      {failed ? (
        <p className="mt-2 text-xs text-muted-foreground">{copy.recordsLoadFailed}</p>
      ) : records === null ? (
        <p className="mt-2 text-xs text-muted-foreground">…</p>
      ) : records.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{copy.recordsEmpty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-0.5">
          {records.map((record) => (
            <li
              key={record.id}
              className="group/record flex items-center gap-2 rounded px-1.5 py-1.5 hover:bg-muted/40"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {record.subject}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium",
                  record.status === "complete"
                    ? "border-border bg-muted/40 text-muted-foreground"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
                title={
                  record.status === "incomplete" && record.missing.length > 0
                    ? format(copy.recordMissingHint, { keys: record.missing.join(", ") })
                    : undefined
                }
              >
                {record.status === "complete"
                  ? copy.recordStatusComplete
                  : copy.recordStatusIncomplete}
              </span>
              <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                {sourceLabel[record.sourceKind]}
              </span>
              <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground md:inline">
                {new Date(record.updatedAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                aria-label={format(copy.recordOpenPageAria, { subject: record.subject })}
                title={copy.recordOpenPage}
                disabled={openingId === record.id}
                onClick={() => void handleOpenPage(record)}
                className={cn(
                  "shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity",
                  "hover:bg-muted hover:text-foreground group-hover/record:opacity-100",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  openingId === record.id && "opacity-60",
                )}
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Buttons — page-action bindings on this blueprint (mig 318) ─────────
// Every page this blueprint projects carries these buttons in its header;
// a click confirms and dispatches (workflow run / Autopilot goal). Authoring
// lives here because the blueprint IS the scope.

function PageActionsSection({
  workspaceId,
  blueprintId,
}: {
  workspaceId: string;
  blueprintId: string;
}) {
  const t = useT();
  const copy = t.brainPage.blueprintEditor.actionsSection;

  const [rows, setRows] = useState<PageActionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"workflow" | "goal">("workflow");
  const [workflowId, setWorkflowId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listBlueprintPageActions(workspaceId, blueprintId));
    } catch {
      setFailed(true);
    }
  }, [workspaceId, blueprintId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listWorkflows(workspaceId)
      .then(setWorkflows)
      .catch(() => setWorkflows([]));
  }, [workspaceId]);

  async function handleAdd() {
    if (!label.trim()) return;
    if (kind === "workflow" && !workflowId) return;
    setSaving(true);
    setError(null);
    const result = await createPageAction({
      workspaceId,
      scope: { blueprintId },
      label: label.trim(),
      action:
        kind === "workflow"
          ? { kind: "workflow", workflowId }
          : { kind: "goal", ...(outcome.trim() ? { outcome: outcome.trim() } : {}) },
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || copy.saveFailed);
      return;
    }
    setAdding(false);
    setLabel("");
    setWorkflowId("");
    setOutcome("");
    void load();
  }

  async function handleDelete(row: PageActionRow) {
    const confirmed = await confirmDialog({
      title: copy.deleteTitle,
      description: format(copy.deleteDescription, { label: row.label }),
      confirmLabel: copy.deleteConfirm,
      variant: "destructive",
    });
    if (!confirmed) return;
    await deletePageAction(row.id);
    void load();
  }

  async function handleToggle(row: PageActionRow, enabled: boolean) {
    const result = await updatePageAction(row.id, { enabled });
    if (result.ok) {
      setRows((prev) =>
        prev ? prev.map((r) => (r.id === row.id ? result.action : r)) : prev,
      );
    }
  }

  const workflowName = (id: string) =>
    workflows.find((w) => w.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <div className="mt-8 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">
          {copy.title}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{copy.hint}</p>
      {failed ? (
        <p className="mt-2 text-xs text-muted-foreground">{copy.loadFailed}</p>
      ) : rows === null ? (
        <p className="mt-2 text-xs text-muted-foreground">…</p>
      ) : rows.length === 0 && !adding ? (
        <p className="mt-2 text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-0.5">
          {rows.map((row) => (
            <li
              key={row.id}
              className="group/action flex items-center gap-2 rounded px-1.5 py-1.5 hover:bg-muted/40"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {row.label}
              </span>
              <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {row.action.kind === "workflow"
                  ? format(copy.kindWorkflowRow, {
                      name: workflowName(row.action.workflowId),
                    })
                  : copy.kindGoalRow}
              </span>
              <Switch
                checked={row.enabled}
                onCheckedChange={(v: boolean) => void handleToggle(row, v)}
                aria-label={copy.enabledAria}
              />
              <button
                type="button"
                aria-label={format(copy.deleteAria, { label: row.label })}
                title={copy.deleteConfirm}
                onClick={() => void handleDelete(row)}
                className={cn(
                  "shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity",
                  "hover:bg-muted hover:text-destructive group-hover/action:opacity-100",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                )}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={copy.labelPlaceholder}
            maxLength={64}
            className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchableSelect
              value={kind}
              onValueChange={(v) => setKind(v === "goal" ? "goal" : "workflow")}
              items={[
                { value: "workflow", label: copy.kindWorkflow },
                { value: "goal", label: copy.kindGoal },
              ]}
              aria-label={copy.kindAria}
              className="w-52"
            />
            {kind === "workflow" ? (
              <SearchableSelect
                value={workflowId}
                onValueChange={setWorkflowId}
                items={workflows.map((w) => ({ value: w.id, label: w.name }))}
                placeholder={copy.workflowPlaceholder}
                searchPlaceholder={copy.workflowSearch}
                emptyMessage={copy.workflowEmpty}
                aria-label={copy.workflowPlaceholder}
                className="w-64"
              />
            ) : (
              <input
                type="text"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                placeholder={copy.outcomePlaceholder}
                maxLength={2000}
                className="w-64 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving || !label.trim() || (kind === "workflow" && !workflowId)}
              onClick={() => void handleAdd()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {copy.save}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
          {copy.add}
        </button>
      )}
    </>
  );
}

// ── About — the quiet metadata rail card ───────────────────────────────

function AboutCard({
  template,
  sectionCount,
}: {
  template: CustomPageTemplate;
  sectionCount: number;
}) {
  const t = useT();
  const locale = useLocale();
  const copy = t.brainPage.blueprintEditor;
  const libraryCopy = t.brainPage.blueprints;

  const intlLocale = locale === "zh" ? "zh-Hant" : locale;
  const dateFmt = (iso: string) =>
    new Date(iso).toLocaleDateString(intlLocale, { dateStyle: "medium" });

  const kindItems: Record<BlueprintCaptureKind, string> = {
    company: copy.entityKindCompany,
    contact: copy.entityKindContact,
    deal: copy.entityKindDeal,
    task: copy.entityKindTask,
    memory: copy.captureKindMemory,
  };
  const capture = template.extraction?.capture ?? [];

  return (
    <section className="rounded-lg bg-muted/40 px-3 py-2.5">
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {copy.aboutHeading}
      </h3>
      <dl className="divide-y divide-border/40">
        <div className="flex items-center justify-between gap-3 py-1.5">
          <dt className="shrink-0 text-xs text-muted-foreground">
            {copy.sectionsLabel}
          </dt>
          <dd className="text-right text-xs tabular-nums">
            {sectionCount === 1
              ? libraryCopy.sectionsOne
              : format(libraryCopy.sectionsMany, { count: sectionCount })}
          </dd>
        </div>
        {capture.length > 0 && (
          <div className="flex flex-col gap-1.5 py-1.5">
            <dt className="text-xs text-muted-foreground">{copy.captureLabel}</dt>
            <dd className="flex flex-wrap gap-1">
              {capture.map((kind) => (
                <span
                  key={kind}
                  className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {kindItems[kind]}
                </span>
              ))}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 py-1.5">
          <dt className="shrink-0 text-xs text-muted-foreground">
            {copy.updatedLabel}
          </dt>
          <dd className="text-right text-xs">{dateFmt(template.updatedAt)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-1.5">
          <dt className="shrink-0 text-xs text-muted-foreground">
            {copy.createdLabel}
          </dt>
          <dd className="text-right text-xs">{dateFmt(template.createdAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

export default function BrainBlueprintEditorPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = use(params);
  return (
    <div className="h-full w-full overflow-y-auto">
      <BlueprintEditorInner templateId={templateId} />
    </div>
  );
}
