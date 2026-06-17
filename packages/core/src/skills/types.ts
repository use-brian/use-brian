/**
 * Skill system types.
 *
 * Skills are prompt bundles with YAML frontmatter that teach the assistant
 * specific workflows. The model discovers skills from a compact listing
 * and invokes them on-demand via the useSkill tool.
 *
 * [COMP:skills/types]
 */

export type SkillMeta = {
  id: string
  name: string
  description: string
  whenToUse?: string
  category: 'productivity' | 'communication' | 'research' | 'custom'
  requiresConnectors: string[]
  /**
   * If set, this skill is only listed for assistants where `app_type` matches.
   * Today: `'distribution'` for skills that need a connected distribution
   * platform (X / Threads). Skills without this field are listed for all
   * assistants regardless of kind/app_type. Frontmatter key:
   * `applies_to_app_type` (top-level) or `metadata.applies_to_app_type`.
   */
  appliesToAppType?: 'distribution'
  source: 'builtin' | 'user' | 'community'
  authorId?: string
  authorName?: string
}

export type SkillContent = SkillMeta & {
  /** Full markdown body (after frontmatter). */
  content: string
}
