/**
 * Pure draft logic behind the blueprint detail editor
 * (`/w/[workspaceId]/brain/blueprints/[templateId]`). The page component stays
 * thin over these helpers so the contract rules are unit-testable (app-web has
 * no component-render test setup — the same pattern as `lib/skills-view.ts`).
 *
 * The one rule that matters: **key stability**. A field's `key` is a handoff
 * address (`{{lastRun.output.<key>}}`, `getBlueprintRecord` reads), so editing
 * an EXISTING field's heading must never rederive its key. Only a NEW field
 * derives its key from its heading (`fieldKeyFromHeading`), and only until the
 * author touches the key directly.
 *
 * Spec: docs/architecture/brain/structural-synthesis.md -> "The blueprint
 * detail editor".
 *
 * [COMP:web/blueprint-detail]
 */

import type {
  BlueprintCaptureKind,
  CustomPageTemplateSummary,
  EntityRefKind,
  ExtractionField,
  ExtractionFieldType,
  ExtractionSpec,
} from "@use-brian/doc-model";
import { BLUEPRINT_CAPTURE_KINDS } from "@use-brian/doc-model";
import { fieldKeyFromHeading } from "@use-brian/doc-model";
import type { CustomTemplateUpdateInput } from "@/lib/api/views";

/** Mirrors the server's `extractionFieldSchema` key rule (lowercase slug). */
const FIELD_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** One contract field as the editor holds it. `uid` is the React list identity
 *  (stable across key edits); `existing` marks fields loaded from the saved
 *  template, whose keys never auto-rederive. */
export type DraftField = {
  uid: string;
  key: string;
  /** The author edited the key directly — stop deriving it from the heading. */
  keyTouched: boolean;
  /** Loaded from the saved template (vs added in this session). */
  existing: boolean;
  heading: string;
  instruction: string;
  type: ExtractionFieldType;
  /** Enum-only; kept across type switches so flipping back is lossless. */
  options: string[];
  /** entityRef-only; "" = not chosen yet. */
  entityKind: EntityRefKind | "";
  required: boolean;
  outputType: "prose" | "list" | "table";
};

export type BlueprintDraft = {
  name: string;
  description: string;
  fields: DraftField[];
  /** Enabled capture kinds, kept in canonical BLUEPRINT_CAPTURE_KINDS order. */
  capture: BlueprintCaptureKind[];
  /** Per-kind capture guidance. Entries survive toggling a kind off (lossless
   *  editing); disabled kinds are dropped at the wire by `draftToExtraction`. */
  captureInstructions: Partial<Record<BlueprintCaptureKind, string>>;
};

/** Validation issue codes — the page maps these to dictionary strings. */
export type DraftIssue = {
  fieldUid?: string;
  code:
    | "name-required"
    | "fields-required"
    | "heading-required"
    | "instruction-required"
    | "key-invalid"
    | "key-duplicate"
    | "options-required"
    | "entity-kind-required";
};

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `bpf-${uidCounter}`;
}

function fieldFromSpec(field: ExtractionField, genId: () => string): DraftField {
  return {
    uid: genId(),
    key: field.key,
    keyTouched: false,
    existing: true,
    heading: field.heading,
    instruction: field.instruction,
    type: field.type,
    options: field.options ?? [],
    entityKind: field.entityKind ?? "",
    required: field.required ?? false,
    outputType: field.outputType ?? "prose",
  };
}

/** The editable draft for a loaded blueprint template. */
export function draftFromTemplate(
  template: Pick<CustomPageTemplateSummary, "name" | "description" | "extraction">,
  genId: () => string = nextUid,
): BlueprintDraft {
  return {
    name: template.name,
    description: template.description ?? "",
    fields: (template.extraction?.fields ?? []).map((f) => fieldFromSpec(f, genId)),
    capture: template.extraction?.capture ?? [],
    captureInstructions: { ...(template.extraction?.captureInstructions ?? {}) },
  };
}

/** Toggle a capture kind on/off, keeping canonical enum order. The kind's
 *  instruction text is intentionally KEPT when toggling off, so re-enabling
 *  is lossless; the wire mapping drops instructions of disabled kinds. */
export function toggleCaptureKind(
  draft: BlueprintDraft,
  kind: BlueprintCaptureKind,
): BlueprintDraft {
  const enabled = draft.capture.includes(kind);
  const capture = enabled
    ? draft.capture.filter((k) => k !== kind)
    : BLUEPRINT_CAPTURE_KINDS.filter((k) => k === kind || draft.capture.includes(k));
  return { ...draft, capture };
}

/** Set (or clear) the per-kind capture instruction text. */
export function setCaptureInstruction(
  draft: BlueprintDraft,
  kind: BlueprintCaptureKind,
  text: string,
): BlueprintDraft {
  return { ...draft, captureInstructions: { ...draft.captureInstructions, [kind]: text } };
}

/** A blank field appended by "Add field" — markdown, key derives from the
 *  heading as the author types it. */
export function newDraftField(genId: () => string = nextUid): DraftField {
  return {
    uid: genId(),
    key: "",
    keyTouched: false,
    existing: false,
    heading: "",
    instruction: "",
    type: "markdown",
    options: [],
    entityKind: "",
    required: false,
    outputType: "prose",
  };
}

/** Heading edit — a NEW, untouched-key field re-derives its key; an existing
 *  field's key never moves (the key-stability rule). */
export function applyHeadingChange(field: DraftField, heading: string): DraftField {
  const next = { ...field, heading };
  if (!field.existing && !field.keyTouched) {
    next.key = heading.trim() ? fieldKeyFromHeading(heading) : "";
  }
  return next;
}

/** Direct key edit — pins the key (heading edits stop deriving it). */
export function applyKeyChange(field: DraftField, key: string): DraftField {
  return { ...field, key, keyTouched: true };
}

/** Move a field one slot up or down; out-of-range moves are no-ops. */
export function moveField(
  fields: DraftField[],
  uid: string,
  direction: "up" | "down",
): DraftField[] {
  const index = fields.findIndex((f) => f.uid === uid);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= fields.length) return fields;
  const next = [...fields];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Client-side mirror of the server's `extractionFieldSchema` rules, so a bad
 *  contract fails before the wire with a per-field message. */
export function validateDraft(draft: BlueprintDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!draft.name.trim()) issues.push({ code: "name-required" });
  if (draft.fields.length === 0) issues.push({ code: "fields-required" });
  const seen = new Set<string>();
  for (const field of draft.fields) {
    if (!field.heading.trim()) issues.push({ fieldUid: field.uid, code: "heading-required" });
    if (!field.instruction.trim())
      issues.push({ fieldUid: field.uid, code: "instruction-required" });
    if (!FIELD_KEY_PATTERN.test(field.key) || field.key.length > 64) {
      issues.push({ fieldUid: field.uid, code: "key-invalid" });
    } else if (seen.has(field.key)) {
      issues.push({ fieldUid: field.uid, code: "key-duplicate" });
    } else {
      seen.add(field.key);
    }
    if (field.type === "enum" && field.options.filter((o) => o.trim()).length < 2) {
      issues.push({ fieldUid: field.uid, code: "options-required" });
    }
    if (field.type === "entityRef" && !field.entityKind) {
      issues.push({ fieldUid: field.uid, code: "entity-kind-required" });
    }
  }
  return issues;
}

/** The wire spec a valid draft persists. Type-irrelevant state (options on a
 *  non-enum, kind on a non-entityRef) is dropped at this boundary, as are
 *  capture instructions for kinds that are not enabled or are blank. */
export function draftToExtraction(draft: BlueprintDraft): ExtractionSpec {
  const captureInstructions = Object.fromEntries(
    draft.capture
      .map((kind) => [kind, draft.captureInstructions[kind]?.trim() ?? ""] as const)
      .filter(([, text]) => text.length > 0),
  );
  return {
    fields: draft.fields.map((f) => ({
      key: f.key,
      heading: f.heading.trim(),
      instruction: f.instruction.trim(),
      type: f.type,
      ...(f.type === "enum"
        ? { options: f.options.map((o) => o.trim()).filter(Boolean) }
        : {}),
      ...(f.type === "entityRef" && f.entityKind ? { entityKind: f.entityKind } : {}),
      required: f.required,
      ...(f.type === "markdown" ? { outputType: f.outputType } : {}),
    })),
    capture: draft.capture,
    ...(Object.keys(captureInstructions).length > 0 ? { captureInstructions } : {}),
  };
}

/** The dirty diff — only changed keys ride the PATCH; `{}` means clean (Save
 *  stays disabled). Extraction compares structurally against the saved spec. */
export function buildTemplatePatch(
  template: Pick<CustomPageTemplateSummary, "name" | "description" | "extraction">,
  draft: BlueprintDraft,
): CustomTemplateUpdateInput {
  const patch: CustomTemplateUpdateInput = {};
  if (draft.name.trim() && draft.name.trim() !== template.name) {
    patch.name = draft.name.trim();
  }
  const savedDescription = template.description ?? "";
  if (draft.description.trim() !== savedDescription.trim()) {
    patch.description = draft.description.trim() || null;
  }
  const nextExtraction = draftToExtraction(draft);
  if (JSON.stringify(nextExtraction) !== JSON.stringify(template.extraction)) {
    patch.extraction = nextExtraction;
  }
  return patch;
}
