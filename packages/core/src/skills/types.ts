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
  /** Structural-synthesis Phase 2: the v2 blueprint (page-template id) this skill
   *  fills. When set, invoking the skill steers its output into that blueprint
   *  (see `useSkill` in `tool.ts`). Built-in skills never carry one. */
  blueprintId?: string
  /** Resource-loading contract. V1 expands legacy Mustache pointers eagerly;
   * v2 returns a compact resource index and reads files on demand. */
  bundleVersion?: 1 | 2
  /** Native Agent Skills resources available to this skill. Their bodies are
   * never placed in the listing and are not included in `useSkill` for v2. */
  resources?: SkillResource[]
  /** Deterministic digest of SKILL.md + sorted resource content hashes. */
  sourceDigest?: string
  /** Source locator retained for catalog install + upstream diff. */
  bundleSource?: SkillBundleSource
}

export type SkillResourceKind = 'reference' | 'asset' | 'template' | 'script'

export type SkillResource = {
  /** Normalized path relative to the skill root. */
  path: string
  kind: SkillResourceKind
  /** Basename retained for the legacy support-file editor/pointer surface. */
  name: string
  content: string
  description?: string
  contentHash: string
}

export type SkillBundleLink = {
  sourcePath: string
  targetPath: string
  relation: 'contains' | 'references' | 'uses_skill'
  /** Populated for `uses_skill` links. */
  targetSkillSlug?: string
}

export type SkillBundleSource = {
  kind: 'brian-tools' | 'github' | 'url' | 'paste' | 'filesystem'
  owner?: string
  repo?: string
  path?: string
  ref?: string | null
  sha?: string | null
  url?: string
}

export type SkillBundleIssue = {
  code: 'invalid_resource_path' | 'missing_resource' | 'orphaned_resource' | 'binary_resource'
  detail: string
  path?: string
}

export type SkillBundle = {
  skill: SkillContent
  resources: SkillResource[]
  links: SkillBundleLink[]
  sourceDigest: string
  issues: SkillBundleIssue[]
  source?: SkillBundleSource
}
