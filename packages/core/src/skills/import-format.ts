/**
 * Imported-skill dialect normalizer.
 *
 * Parses a skill file brought in from outside (GitHub / URL import) into the
 * Use Brian draft shape, detecting which dialect it was written in and
 * flagging — never rewriting — anything that will not carry over.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Importing skills
 * (GitHub / URL)" → "Dialect normalization".
 *
 * [COMP:skills/import-format]
 */

import { FRONTMATTER_RE, parseSkillMarkdown, parseYamlFrontmatter } from './loader.js'
import type { SkillMeta } from './types.js'

export type ImportDialect =
  | 'agent-skills'
  | 'slash-command'
  | 'cursor-rule'
  | 'generic-markdown'

export type ImportWarningCode =
  | 'foreign_tools'
  | 'arguments_placeholder'
  | 'ignored_metadata'
  | 'no_frontmatter'
  | 'description_truncated'
  | 'content_too_long'
  // Emitted by the folder-walk import service (packages/api), defined here so
  // every import warning shares one closed union the UI can localize.
  | 'scripts_not_executable'
  | 'unsupported_files'

export type ImportWarning = { code: ImportWarningCode; detail: string }

/** Mirrors what POST /api/skills accepts (minus workspace wiring). */
export type ImportedSkillDraft = {
  name: string
  slug: string
  description: string
  whenToUse?: string
  category: SkillMeta['category']
  requiresConnectors: string[]
  content: string
}

export type ParsedImport = {
  dialect: ImportDialect
  draft: ImportedSkillDraft
  warnings: ImportWarning[]
}

// Caps mirror the hand-validation in POST /api/skills (routes/skills.ts).
// Description is truncated to fit; content is only WARNED about — silently
// truncating a procedure corrupts it, so the user trims in the editor and
// the create route stays the enforcement point.
const DESCRIPTION_CAP = 250
const CONTENT_CAP = 5000
const NAME_CAP = 100

// Tool names that exist in Claude Code (and similar hosts) but not in this
// runtime. Deliberately excludes generic English words unless backticked in
// the body — the lint only fires on `ToolName` code spans, never prose, to
// keep false positives near zero. `Read`/`Write`/`Edit`/`Task` are omitted
// even backticked: too common in legitimate skill prose about documents.
const FOREIGN_TOOL_NAMES = [
  'Bash',
  'Grep',
  'Glob',
  'TodoWrite',
  'NotebookEdit',
  'WebFetch',
  'ExitPlanMode',
  'SlashCommand',
  'AskUserQuestion',
] as const

const FOREIGN_TOOL_RE = new RegExp(`\`(${FOREIGN_TOOL_NAMES.join('|')})\``, 'g')

// $ARGUMENTS (whole-input) and $1..$9 (positional) slash-command substitution.
const ARGUMENTS_RE = /\$ARGUMENTS\b|\$[1-9]\b/

// Frontmatter keys that identify a Claude Code slash command when `name` +
// `description` (the Agent Skills required pair) are absent.
const SLASH_COMMAND_KEYS = ['description', 'argument-hint', 'allowed-tools', 'model'] as const

/**
 * Parse an imported skill file into a draft + warnings.
 * Returns null when the input cannot be a skill at all (empty, binary,
 * or no usable body).
 */
export function parseImportedSkill(fileName: string, raw: string): ParsedImport | null {
  if (!raw || !raw.trim()) return null
  if (raw.includes('\u0000')) return null // binary sniff

  const fmMatch = raw.match(FRONTMATTER_RE)

  if (!fmMatch) {
    return parseGenericMarkdown(fileName, raw)
  }

  const [, yaml, body] = fmMatch
  const meta = parseYamlFrontmatter(yaml!)

  // Agent Skills spec (and Use Brian's own format, legacy flat included):
  // frontmatter carries both name and description — parseSkillMarkdown
  // already speaks this dialect in full.
  if (meta.name && meta.description) {
    return parseAgentSkills(raw, meta)
  }

  if (isCursorRule(fileName, meta)) {
    return parseCursorRule(fileName, meta, body ?? '')
  }

  if (SLASH_COMMAND_KEYS.some((k) => meta[k] !== undefined)) {
    return parseSlashCommand(fileName, meta, body ?? '')
  }

  // Frontmatter we don't recognize at all: treat the body as generic
  // markdown and report every dropped key.
  const parsed = parseGenericMarkdown(fileName, body ?? '', { hadFrontmatter: true })
  if (!parsed) return null
  const dropped = Object.keys(meta)
  if (dropped.length > 0) {
    parsed.warnings.push({
      code: 'ignored_metadata',
      detail: `Unrecognized frontmatter dropped: ${dropped.join(', ')}`,
    })
  }
  return parsed
}

// ── Dialect handlers ──────────────────────────────────────────

function parseAgentSkills(raw: string, meta: Record<string, unknown>): ParsedImport | null {
  const skill = parseSkillMarkdown(raw, 'user')
  if (!skill || !skill.content) return null

  const warnings: ImportWarning[] = []
  const description = capDescription(skill.description, warnings)

  const draft: ImportedSkillDraft = {
    name: skill.name.slice(0, NAME_CAP),
    slug: slugify(skill.id) || slugify(skill.name) || 'imported-skill',
    description,
    whenToUse: skill.whenToUse ?? deriveWhenToUse(description),
    category: skill.category,
    requiresConnectors: skill.requiresConnectors,
    content: skill.content,
  }

  lintForeignTools(meta, draft.content, warnings)
  lintArguments(draft.content, warnings)
  lintContentLength(draft.content, warnings)

  return { dialect: 'agent-skills', draft, warnings }
}

function parseSlashCommand(
  fileName: string,
  meta: Record<string, unknown>,
  body: string,
): ParsedImport | null {
  const content = body.trim()
  if (!content) return null

  const warnings: ImportWarning[] = []
  const name = deriveName(meta, content, fileName)
  const description = capDescription(
    typeof meta.description === 'string' && meta.description
      ? meta.description
      : firstParagraph(content) || name,
    warnings,
  )

  const dropped = ['argument-hint', 'model'].filter((k) => meta[k] !== undefined)
  if (dropped.length > 0) {
    warnings.push({
      code: 'ignored_metadata',
      detail: `Slash-command metadata has no equivalent here and was dropped: ${dropped.join(', ')}`,
    })
  }

  const draft: ImportedSkillDraft = {
    name,
    slug: slugify(name) || slugFromFileName(fileName),
    description,
    whenToUse: deriveWhenToUse(description),
    category: 'custom',
    requiresConnectors: [],
    content,
  }

  lintForeignTools(meta, content, warnings)
  lintArguments(content, warnings)
  lintContentLength(content, warnings)

  return { dialect: 'slash-command', draft, warnings }
}

function parseCursorRule(
  fileName: string,
  meta: Record<string, unknown>,
  body: string,
): ParsedImport | null {
  const content = body.trim()
  if (!content) return null

  const warnings: ImportWarning[] = []
  const name = deriveName(meta, content, fileName)
  const description = capDescription(
    typeof meta.description === 'string' && meta.description
      ? meta.description
      : firstParagraph(content) || name,
    warnings,
  )

  const dropped = ['globs', 'alwaysApply'].filter((k) => meta[k] !== undefined)
  if (dropped.length > 0) {
    warnings.push({
      code: 'ignored_metadata',
      detail: `Cursor rule metadata has no equivalent here and was dropped: ${dropped.join(', ')}`,
    })
  }

  const draft: ImportedSkillDraft = {
    name,
    slug: slugify(name) || slugFromFileName(fileName),
    description,
    whenToUse: deriveWhenToUse(description),
    category: 'custom',
    requiresConnectors: [],
    content,
  }

  lintForeignTools(meta, content, warnings)
  lintArguments(content, warnings)
  lintContentLength(content, warnings)

  return { dialect: 'cursor-rule', draft, warnings }
}

function parseGenericMarkdown(
  fileName: string,
  body: string,
  opts: { hadFrontmatter?: boolean } = {},
): ParsedImport | null {
  const content = body.trim()
  if (!content) return null

  const warnings: ImportWarning[] = []
  if (!opts.hadFrontmatter) {
    warnings.push({
      code: 'no_frontmatter',
      detail: 'No frontmatter found; the name and description were derived from the file body.',
    })
  }

  const name = deriveName({}, content, fileName)
  const description = capDescription(firstParagraph(content) || name, warnings)

  const draft: ImportedSkillDraft = {
    name,
    slug: slugify(name) || slugFromFileName(fileName),
    description,
    whenToUse: deriveWhenToUse(description),
    category: 'custom',
    requiresConnectors: [],
    content,
  }

  lintForeignTools({}, content, warnings)
  lintArguments(content, warnings)
  lintContentLength(content, warnings)

  return { dialect: 'generic-markdown', draft, warnings }
}

// ── Detection helpers ─────────────────────────────────────────

function isCursorRule(fileName: string, meta: Record<string, unknown>): boolean {
  if (fileName.toLowerCase().endsWith('.mdc')) return true
  return meta.globs !== undefined || meta.alwaysApply !== undefined
}

// ── Field derivation ──────────────────────────────────────────

function deriveName(meta: Record<string, unknown>, body: string, fileName: string): string {
  if (typeof meta.name === 'string' && meta.name.trim()) {
    return meta.name.trim().slice(0, NAME_CAP)
  }
  const h1 = body.match(/^#\s+(.+)$/m)
  if (h1?.[1]?.trim()) return h1[1].trim().slice(0, NAME_CAP)
  return titleCase(fileNameBase(fileName)).slice(0, NAME_CAP) || 'Imported skill'
}

/** First non-heading, non-list, non-fence paragraph, newlines collapsed. */
function firstParagraph(body: string): string | null {
  for (const block of body.split(/\n\s*\n/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    if (/^(#|```|>|[-*+]\s|\d+\.\s|\|)/.test(trimmed)) continue
    return trimmed.replace(/\s+/g, ' ')
  }
  return null
}

/**
 * Pull an explicit trigger sentence out of a description when the dialect
 * has no when_to_use of its own. Agent Skills descriptions conventionally
 * embed "Use when ..." — copy (never move) that sentence.
 */
export function deriveWhenToUse(description: string): string | undefined {
  const match = description.match(/\buse\s+(?:this\s+|it\s+)?(?:skill\s+)?when\b[^.!?]*[.!?]?/i)
  return match ? match[0].trim() : undefined
}

function capDescription(description: string, warnings: ImportWarning[]): string {
  const trimmed = description.trim()
  if (trimmed.length <= DESCRIPTION_CAP) return trimmed
  warnings.push({
    code: 'description_truncated',
    detail: `Description shortened from ${trimmed.length} to ${DESCRIPTION_CAP} characters.`,
  })
  return trimmed.slice(0, DESCRIPTION_CAP)
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
}

function slugFromFileName(fileName: string): string {
  return slugify(fileNameBase(fileName)) || 'imported-skill'
}

function fileNameBase(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName
  return base.replace(/\.(md|mdc|markdown)$/i, '')
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Lints ─────────────────────────────────────────────────────

function lintForeignTools(
  meta: Record<string, unknown>,
  content: string,
  warnings: ImportWarning[],
): void {
  const names = new Set<string>()

  const allowedTools = meta['allowed-tools'] ?? meta.allowed_tools
  if (typeof allowedTools === 'string') {
    for (const t of allowedTools.split(',')) {
      const name = t.trim().replace(/\(.*\)$/, '') // "Bash(git:*)" → "Bash"
      if (name) names.add(name)
    }
  } else if (Array.isArray(allowedTools)) {
    for (const t of allowedTools) {
      if (typeof t === 'string' && t.trim()) names.add(t.trim().replace(/\(.*\)$/, ''))
    }
  }

  FOREIGN_TOOL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FOREIGN_TOOL_RE.exec(content)) !== null) {
    names.add(match[1]!)
  }

  if (names.size > 0) {
    warnings.push({
      code: 'foreign_tools',
      detail: `References tools from the source environment that do not exist here: ${[...names].sort().join(', ')}. Rewrite or remove those instructions before saving.`,
    })
  }
}

function lintArguments(content: string, warnings: ImportWarning[]): void {
  if (ARGUMENTS_RE.test(content)) {
    warnings.push({
      code: 'arguments_placeholder',
      detail: 'Contains $ARGUMENTS-style placeholders; there is no argument substitution here, so they will appear literally.',
    })
  }
}

function lintContentLength(content: string, warnings: ImportWarning[]): void {
  if (content.length > CONTENT_CAP) {
    warnings.push({
      code: 'content_too_long',
      detail: `Body is ${content.length} characters; the limit is ${CONTENT_CAP}. Trim it in the editor before saving.`,
    })
  }
}
