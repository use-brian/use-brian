/**
 * Pure helpers for the teamspace-sectioned sidebar
 * (docs/architecture/features/teamspaces.md). No DB/IO/React — the drop-id
 * encoding for a section HEADER drop zone, kept separate from the component
 * so the (risky) routing logic unit-tests without mounting the sidebar.
 *
 * A dragged page dropped ONTO a section header files it at that teamspace's
 * root. The id is `section::<teamspaceId | __private__>` — deliberately
 * disjoint from the row drop scheme (`<uuid>::onto|after`, parsed by
 * `parseDropId`): no row id starts with `section::`, and `parseSectionDropId`
 * returns null for anything without the prefix, so the two never collide.
 *
 * [COMP:app-web/teamspace-sections]
 */

/** The Private section's stand-in key (pages with `teamspaceId === null` have
 *  no teamspace id to key collapse-state / drop-ids by). */
export const PRIVATE_SECTION_KEY = "__private__";

const SECTION_DROP_PREFIX = "section::";

/** Encode a section header's dnd-kit droppable id. `null` → Private. */
export function sectionDropId(teamspaceId: string | null): string {
  return `${SECTION_DROP_PREFIX}${teamspaceId ?? PRIVATE_SECTION_KEY}`;
}

/**
 * Decode a section-header drop id, or `null` when `raw` is a row drop id (or
 * anything else). A decoded `teamspaceId` of `null` means the Private section.
 */
export function parseSectionDropId(
  raw: string,
): { teamspaceId: string | null } | null {
  if (!raw.startsWith(SECTION_DROP_PREFIX)) return null;
  const key = raw.slice(SECTION_DROP_PREFIX.length);
  return { teamspaceId: key === PRIVATE_SECTION_KEY ? null : key };
}
