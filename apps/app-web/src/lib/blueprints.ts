/**
 * Pure logic behind the Brain's Blueprints library + the blueprint pickers
 * (recording upload, workflow step). A BLUEPRINT is a page template that
 * carries an `extraction` spec — the synthesis engine can fill it from a
 * source (a recording, the brain, a research gather). A template with no
 * extraction spec is a plain skeleton, not a blueprint.
 *
 * Extracted from the components so the library's filter + the picker-item
 * builder are unit-testable — app-web has no component-render test setup, so
 * components stay thin over these helpers (the same pattern as
 * `lib/skills-view.ts`).
 *
 * Spec: docs/architecture/brain/structural-synthesis.md -> "The blueprint
 * object" / "One SearchableSelect picker appears in three places".
 *
 * [COMP:web/blueprints-library]
 */

import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import type { Block } from "@/lib/api/views";
import { newBlockId } from "@/lib/api/views";
import type { SearchableSelectItem } from "@/components/ui/searchable-select";

/**
 * Built-in blueprints have been removed — the blueprint gallery is
 * workspace-authored only. This set is kept (empty) so any "all built-ins"
 * reasoning resolves to nothing rather than a hardcoded list.
 * See structural-synthesis.md -> "The blueprint object".
 */
export const BUILTIN_BLUEPRINT_SLUGS = [] as const;
export type BuiltinBlueprintSlug = (typeof BUILTIN_BLUEPRINT_SLUGS)[number];

/** A page template is a BLUEPRINT iff it carries a non-null extraction spec. */
export function isBlueprint(template: CustomPageTemplateSummary): boolean {
  return template.extraction != null;
}

/**
 * The blueprint subset of a workspace's page-template list, name-sorted. The
 * list API returns ALL templates (skeletons + blueprints); the library + the
 * pickers want only the ones the synthesis engine can fill, so we filter on
 * `extraction != null` client-side (the backend list carries `extraction`).
 */
export function filterBlueprints(
  templates: CustomPageTemplateSummary[],
): CustomPageTemplateSummary[] {
  return templates
    .filter(isBlueprint)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Section count of a blueprint's extraction spec (0 when it has no spec). */
export function blueprintSectionCount(
  template: CustomPageTemplateSummary,
): number {
  return template.extraction?.sections.length ?? 0;
}

/**
 * Build the `SearchableSelect` items for a blueprint picker: the workspace
 * blueprints (value = template id, label = template name), name-sorted. There
 * are no built-in blueprints — the gallery is workspace-authored only. The
 * caller prepends its own "ingest only / no page" sentinel item.
 *
 * Appears in all three picker sites (recording upload, workflow step, chat),
 * so it lives here once. See structural-synthesis.md.
 */
export function buildBlueprintPickerItems(
  workspaceBlueprints: CustomPageTemplateSummary[],
): SearchableSelectItem[] {
  return filterBlueprints(workspaceBlueprints).map((t) => ({
    value: t.id,
    label: t.name,
  }));
}

// ── Recording upload picker: workspace-default selection ladder (migration 291) ──
//
// The upload picker (recording-upload-button) follows
// `explicit pick ?? workspace default ?? none` (decision D3). These pure
// helpers carry that logic so they unit-test without a component render harness.
//
// Two sentinels mirror the component: `RECORDING_INGEST_ONLY` is an explicit
// "no page" pick (submitted as omit); the empty string is the UNSET placeholder
// used ONLY when no workspace default exists, so the picker prompts a choice
// rather than silently defaulting to ingest-only.

/** Sentinel for an explicit "ingest only / no page" pick. */
export const RECORDING_INGEST_ONLY = "__ingest_only__";
/** Sentinel for "not yet chosen" — the placeholder state when no default is set. */
export const RECORDING_UNSET = "";

/**
 * The picker's initial selection given the workspace default. A non-null
 * default pre-selects that blueprint id (auto-apply, §1.1); a null default
 * leaves the picker UNSET so a placeholder prompts an explicit choice (§1.2,
 * never a silent ingest-only default).
 */
export function initialRecordingBlueprint(
  workspaceDefault: string | null,
): string {
  return workspaceDefault ?? RECORDING_UNSET;
}

/**
 * Map a picker selection to the `blueprintSlug` submitted to `/process`. A real
 * blueprint id submits verbatim; both the explicit `RECORDING_INGEST_ONLY` pick
 * and the `RECORDING_UNSET` placeholder submit `undefined` (Pipeline B only —
 * omit the slug).
 */
export function recordingBlueprintToSlug(
  selection: string,
): string | undefined {
  if (selection === RECORDING_INGEST_ONLY || selection === RECORDING_UNSET) {
    return undefined;
  }
  return selection;
}

/**
 * The block seed for a brand-new, blank blueprint doc: one heading + one empty
 * `extraction_slot` directive. Authoring is WYSIWYG — `blocksToExtractionSpec`
 * (core) pairs each slot with its preceding heading to derive the spec, so a
 * blueprint needs at least one heading/slot pair to be fillable. The author
 * renames the heading + types the "what to extract" instruction into the
 * rendered slot panel. `genId` mints fresh block ids (defaults to the SDK's
 * `newBlockId`). See structural-synthesis.md -> "Extraction-slot block".
 */
export function blankBlueprintBlocks(genId: () => string = newBlockId): Block[] {
  return [
    { kind: "heading", id: genId(), level: 2, text: "" },
    { kind: "extraction_slot", id: genId(), instruction: "" },
  ];
}
