/**
 * Skill reference parsing — extracts EXPLICIT entity references from skill
 * content for the `references_entity` derived edge
 * (`docs/architecture/engine/skill-system.md` §6).
 *
 * **Zero inference.** We only match literal `kind:uuid` tokens the author or the
 * Brain skill editor put in the content — never LLM-guessed relatedness. Both
 * the wikilink encoding `[[entity:<uuid>]]` and the markdown-mention encoding
 * `@[Acme](entity:<uuid>)` contain the canonical `kind:uuid` token, which is
 * what this matches. Recomputed on every skill edit, so references self-heal.
 *
 * Only the three graph node kinds that carry a `sensitivity` column are valid
 * targets (§5.4): `entity`, `memory`, `kb_chunk`. CRM-only rows are out of
 * scope for v1.
 *
 * [COMP:skills/edge-references]
 */

export type SkillReferenceKind = 'entity' | 'memory' | 'kb_chunk'

export type SkillReferences = {
  entity: string[]
  memory: string[]
  kb_chunk: string[]
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
// `entity:<uuid>` / `memory:<uuid>` / `kb_chunk:<uuid>` anywhere in the content,
// bounded so partial/overlapping hex runs don't match.
const REFERENCE_RE = new RegExp(`(?<![\\w-])(entity|memory|kb_chunk):(${UUID})(?![\\w-])`, 'gi')

/**
 * Parse a skill's content into deduped reference-target id lists, keyed by
 * node kind. Ids are normalized to lowercase (UUIDs are case-insensitive; the
 * DB stores them canonical-lowercase). Order preserved by first appearance.
 */
export function parseSkillReferences(content: string): SkillReferences {
  const out: SkillReferences = { entity: [], memory: [], kb_chunk: [] }
  if (!content) return out
  const seen = new Set<string>()
  for (const match of content.matchAll(REFERENCE_RE)) {
    const kind = match[1].toLowerCase() as SkillReferenceKind
    const id = match[2].toLowerCase()
    const key = `${kind}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out[kind].push(id)
  }
  return out
}
