/**
 * Pure logic behind the Brain's Skills view + skill editor
 * (docs/plans/brain-skill-management-ux.md §3.1, §3.3).
 *
 * Extracted from the components so the library's filter arithmetic and the
 * editor's changed-fields diff are unit-testable — app-web has no
 * component-render test setup, so components stay thin over these helpers.
 *
 * [COMP:app-web/brain-skills-view]
 */

import {
  BUILTIN_SKILL_GROUPS,
  UNSORTED_SKILL_GROUP,
  distinctSkillGroups,
  isBuiltinSkillGroup,
  normalizeSkillGroup,
  skillGroupKey,
  type BuiltinSkillGroup,
} from "@use-brian/shared/skill-groups";

import type {
  SkillInductionSource,
  SkillSensitivity,
  UpdateSkillInput,
  WorkspaceSkillSummary,
} from "@/lib/api/skills";

/** The library's three status buckets. `archived` rows never reach the
 *  client (the workspace list excludes them), so they don't get a bucket. */
export type SkillStatus = "active" | "suggested" | "stale";

/** Status of a skill row: Stale wins (a decayed skill needs re-review even
 *  if it was once activated), then activation decides Active vs Suggested. */
export function skillStatus(
  skill: Pick<WorkspaceSkillSummary, "state" | "activatedAt">,
): SkillStatus {
  if (skill.state === "stale") return "stale";
  return skill.activatedAt != null ? "active" : "suggested";
}

export type SkillLibraryFilter = {
  /** Case-insensitive needle over name + description. */
  search: string;
  /** Selected status chips; empty = all. */
  statuses: SkillStatus[];
  /** Selected induction-source chips; empty = all. */
  sources: SkillInductionSource[];
  /** Selected sensitivity chips; empty = all. */
  sensitivities: SkillSensitivity[];
};

// Library display order: Suggested first (they carry the inline Confirm and
// need the user's attention), then Active, then Stale; name within a bucket.
const STATUS_RANK: Record<SkillStatus, number> = {
  suggested: 0,
  active: 1,
  stale: 2,
};

/**
 * Filter + sort the workspace skills for the library pane. Each chip group
 * is an OR within itself and an AND across groups (the same arithmetic as
 * the Brain's primitive chips); search matches name or description.
 */
export function filterSkillsForLibrary(
  skills: WorkspaceSkillSummary[],
  filter: SkillLibraryFilter,
): WorkspaceSkillSummary[] {
  const needle = filter.search.trim().toLowerCase();
  const matched = skills.filter((skill) => {
    if (
      filter.statuses.length > 0 &&
      !filter.statuses.includes(skillStatus(skill))
    ) {
      return false;
    }
    if (
      filter.sources.length > 0 &&
      !filter.sources.includes(skill.inductionSource)
    ) {
      return false;
    }
    if (
      filter.sensitivities.length > 0 &&
      !filter.sensitivities.includes(skill.sensitivity)
    ) {
      return false;
    }
    if (needle) {
      return (
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle)
      );
    }
    return true;
  });
  return matched.sort(
    (a, b) =>
      STATUS_RANK[skillStatus(a)] - STATUS_RANK[skillStatus(b)] ||
      a.name.localeCompare(b.name),
  );
}

/** Whether any library filter is armed (search or any chip group). */
export function hasLibraryFilter(filter: SkillLibraryFilter): boolean {
  return (
    filter.search.trim().length > 0 ||
    filter.statuses.length > 0 ||
    filter.sources.length > 0 ||
    filter.sensitivities.length > 0
  );
}

/**
 * Split the skills for the LANDING (library-first pass, plan §11d): on the
 * unfiltered landing the Suggested rows are pinned into the amber
 * "Needs review" BAND and the main list shows everything else — the band
 * owns them, so they never render twice. The moment ANY filter or search is
 * armed the user is in browse mode: the band hides and the plain filtered
 * list takes over (so the topbar's "N suggested" chip → status filter shows
 * exactly the suggested rows as ordinary rows, once).
 */
export function partitionSkillsForLanding(
  skills: WorkspaceSkillSummary[],
  filter: SkillLibraryFilter,
): { band: WorkspaceSkillSummary[]; list: WorkspaceSkillSummary[] } {
  const filtered = filterSkillsForLibrary(skills, filter);
  if (hasLibraryFilter(filter)) return { band: [], list: filtered };
  return {
    band: filtered.filter((s) => skillStatus(s) === "suggested"),
    list: filtered.filter((s) => skillStatus(s) !== "suggested"),
  };
}

// ── Groups ───────────────────────────────────────────────────────
//
// `workspace_skills.category` is the library's GROUP, and it is an open
// vocabulary rather than an enum: four built-in names carry translated labels
// and anything else is a workspace-defined group displayed verbatim, the way
// a skill's own name is. `@use-brian/shared/skill-groups` owns the shape
// (normalize, fold, dedupe) so the client, the API and the skill loader
// cannot drift apart the way three hand-mirrored enums did.

// Re-exported so a component reaches for one import (`@/lib/skills-view`)
// rather than two. Only what a surface actually uses - the rest stays behind
// `@use-brian/shared/skill-groups`.
export {
  UNSORTED_SKILL_GROUP,
  distinctSkillGroups,
  normalizeSkillGroup,
  type BuiltinSkillGroup,
} from "@use-brian/shared/skill-groups";

/** One skill's group, in its stored display form. */
export function skillGroupOf(skill: { category?: string }): string {
  return normalizeSkillGroup(skill.category);
}

/**
 * How a group renders. A built-in resolves through the dictionary; anything
 * else is user data and shows exactly as it was written - untranslated, for
 * the same reason a skill's name is.
 */
export function skillGroupLabel(
  group: string,
  labels: Record<BuiltinSkillGroup, string>,
): string {
  return isBuiltinSkillGroup(group) ? labels[group] : group;
}

export type SkillCategoryGroup = {
  category: string;
  skills: WorkspaceSkillSummary[];
};

/**
 * Bucket skills by group, dropping empty buckets.
 *
 * Order is ALPHABETICAL by the label the reader sees, with the unsorted sink
 * always last - one rule for a set nobody can enumerate in advance, and it
 * sorts in the reader's own language because it sorts the translated label.
 * (The old fixed enum order died with the enum: privileging three legacy
 * names above a workspace's own groups would have been arbitrary.) Order
 * WITHIN a bucket is the incoming order, so whatever `filterSkillsForLibrary`
 * sorted by - status, then name - still holds.
 *
 * `labelOf` resolves a group to its display label; pass nothing when the
 * caller has no dictionary and the stored form is the label.
 */
export function groupSkillsByCategory(
  skills: WorkspaceSkillSummary[],
  labelOf: (group: string) => string = (group) => group,
): SkillCategoryGroup[] {
  const buckets = new Map<string, SkillCategoryGroup>();
  for (const skill of skills) {
    const category = skillGroupOf(skill);
    const key = skillGroupKey(category);
    const bucket = buckets.get(key);
    if (bucket) bucket.skills.push(skill);
    else buckets.set(key, { category, skills: [skill] });
  }
  return [...buckets.values()].sort((a, b) => {
    const aUnsorted = a.category === UNSORTED_SKILL_GROUP;
    const bUnsorted = b.category === UNSORTED_SKILL_GROUP;
    if (aUnsorted !== bUnsorted) return aUnsorted ? 1 : -1;
    return labelOf(a.category).localeCompare(labelOf(b.category));
  });
}

/**
 * The groups a picker offers: every built-in, plus every group the library
 * already uses, in the order `groupSkillsByCategory` renders them. Offering
 * what the library already has is what keeps a free-text field from forking
 * into near-synonyms - typing a new name stays possible, but reusing one is
 * the shorter path.
 */
export function skillGroupOptions(
  skills: Pick<WorkspaceSkillSummary, "category">[],
): string[] {
  const inUse = groupSkillsByCategory(
    skills as WorkspaceSkillSummary[],
  ).map((g) => g.category);
  return distinctSkillGroups([...BUILTIN_SKILL_GROUPS, ...inUse]);
}

/** The editor's Instructions drafts — always strings (inputs), trimmed on
 *  diff so whitespace-only edits never count as changes. */
export type SkillInstructionsDraft = {
  name: string;
  description: string;
  whenToUse: string;
  content: string;
  /** The group, free text. Normalized on save by `buildSkillPatch`. */
  category: string;
};

/** How many skills are awaiting confirmation — the Brain topbar's amber
 *  "N suggested" jump chip. Counts through `skillStatus`, so a stale row
 *  that never activated is NOT suggested (stale wins). */
export function suggestedSkillCount(
  skills: Pick<WorkspaceSkillSummary, "state" | "activatedAt">[],
): number {
  return skills.filter((s) => skillStatus(s) === "suggested").length;
}

/** The skill editor route — `/w/<workspaceId>/brain/skills/<skillRowId>`. */
const SKILL_EDITOR_PATH_RE = /^\/w\/[^/]+\/brain\/skills\/([^/?#]+)/;

/**
 * The workspace-skill row id when `pathname` is the Brain skill editor
 * route, else `null`. The floating assistant dock derives it per pathname
 * change (the `pageIdFromPathname` recipe) and sends it as
 * `viewingSkillRowId` on `/api/chat`, so the model knows which skill the
 * user is looking at — "this skill" resolves server-side, RLS-scoped.
 */
export function skillRowIdFromPathname(
  pathname: string | null | undefined,
): string | null {
  if (!pathname) return null;
  const match = SKILL_EDITOR_PATH_RE.exec(pathname);
  return match ? match[1] : null;
}

/**
 * The PATCH body for an Instructions save: only the fields that actually
 * changed (trim-compared against the loaded skill). An empty object means
 * "nothing to save" — the editor disables its Save button on that. The D2
 * trust stamp is server-side; this only decides what to send.
 */
export function buildSkillPatch(
  skill: Pick<
    WorkspaceSkillSummary,
    "name" | "description" | "whenToUse" | "content" | "category"
  >,
  draft: SkillInstructionsDraft,
): UpdateSkillInput {
  const patch: UpdateSkillInput = {};
  const name = draft.name.trim();
  if (name && name !== skill.name) patch.name = name;
  const description = draft.description.trim();
  if (description !== skill.description) patch.description = description;
  const whenToUse = draft.whenToUse.trim();
  if (whenToUse !== (skill.whenToUse ?? "")) patch.whenToUse = whenToUse;
  const content = draft.content.trim();
  if (content && content !== skill.content) patch.content = content;
  // Compared through `skillGroupKey`, so re-typing a group with different
  // capitalisation is not a change, while a genuinely different group is. The
  // stored form is the draft's, normalized - the user's spelling wins.
  const category = normalizeSkillGroup(draft.category);
  if (skillGroupKey(category) !== skillGroupKey(skillGroupOf(skill))) {
    patch.category = category;
  }
  return patch;
}
