/**
 * Pure helpers behind the skill-import dialog
 * (`components/brain/skill-import-dialog.tsx`): the parsed-result → creator
 * prefill mapping, the folder-import affordance predicate, and breadcrumb
 * segmentation. Kept out of the component so the seam the creator consumes
 * is unit-testable.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Importing skills
 * (GitHub / URL)" → "UI".  [COMP:app-web/brain-skill-import]
 */

import type {
  SkillImportGithubEntry,
  SkillImportResult,
} from "@/lib/api/skills";
import type { SkillImportPrefill } from "@/components/brain/skill-creator";

/** Map an import result onto the creator's `initialImport` prefill. */
export function toSkillImportPrefill(
  result: SkillImportResult,
): SkillImportPrefill {
  return {
    draft: {
      name: result.draft.name,
      description: result.draft.description,
      whenToUse: result.draft.whenToUse,
      content: result.draft.content,
    },
    supportFiles: result.supportFiles,
    importSource: result.importSource,
  };
}

/** A directory can be imported as an Agent Skills folder iff it holds a
 *  SKILL.md (case-insensitive) at its top level. */
export function folderHasSkillMd(
  entries: SkillImportGithubEntry[] | null,
): boolean {
  return (
    entries?.some(
      (e) => e.type === "file" && e.name.toLowerCase() === "skill.md",
    ) ?? false
  );
}

/** Breadcrumb segments for a repo path ("" → repository root → []). */
export function crumbsOf(path: string): string[] {
  return path ? path.split("/") : [];
}
