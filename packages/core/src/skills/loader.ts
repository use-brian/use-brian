/**
 * Skill loader — parses markdown frontmatter and loads built-in skills.
 *
 * Built-in skills are .md files in ./builtin/ with YAML frontmatter.
 * User/community skills are loaded from the database at runtime (not here).
 *
 * [COMP:skills/loader]
 */

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { SkillContent, SkillMeta } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = join(__dirname, 'builtin')

// ── Frontmatter parser ────────────────────────────────────────

// Exported for the import normalizer (import-format.ts), which needs to
// split + read frontmatter for dialects that lack the name/description
// fields parseSkillMarkdown requires.
export const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/

/**
 * Parse a skill markdown file into metadata + content.
 * Returns null if the file lacks valid frontmatter.
 */
export function parseSkillMarkdown(
  raw: string,
  source: SkillMeta['source'] = 'builtin',
): SkillContent | null {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return null

  const [, yaml, content] = match
  const meta = parseYamlFrontmatter(yaml!)

  // Support both old flat format (id, when_to_use, category at top level)
  // and Agent Skills Spec format (name as id, metadata.* for extensions)
  const metadata = (meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata))
    ? meta.metadata as Record<string, unknown>
    : {}

  const name = String(meta.name ?? '')
  const id = String(meta.id ?? name) // 'id' for backward compat, else 'name' per spec
  const description = String(meta.description ?? '')
  if (!id || !name || !description) return null

  // Extension fields: check metadata.* first (spec), then top-level (legacy)
  const whenToUse = metadata.when_to_use ?? meta.when_to_use
  const category = metadata.category ?? meta.category
  const requiresConnectors = metadata.requires_connectors ?? meta.requires_connectors
  const authorName = metadata.author ?? meta.author
  const appliesToAppTypeRaw = metadata.applies_to_app_type ?? meta.applies_to_app_type
  const appliesToAppType = appliesToAppTypeRaw === 'distribution' ? 'distribution' : undefined

  // requires_connectors can be comma-separated string (spec) or array (legacy)
  const connectors = typeof requiresConnectors === 'string'
    ? requiresConnectors.split(',').map((s: string) => s.trim()).filter(Boolean)
    : parseStringArray(requiresConnectors)

  return {
    id,
    name,
    description: description.slice(0, 1024),
    whenToUse: whenToUse ? String(whenToUse) : undefined,
    category: validateCategory(category) ?? 'custom',
    requiresConnectors: connectors,
    appliesToAppType,
    source,
    authorName: authorName ? String(authorName) : undefined,
    content: content!.trim(),
  }
}

// ── Simple YAML-like frontmatter parser ───────────────────────
// Handles flat key-value pairs, simple arrays, and one level of nesting
// (for metadata: blocks). Not a full YAML parser.

export function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let currentKey = ''
  let currentArray: string[] | null = null
  let currentMap: Record<string, string> | null = null

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // Check indentation — indented lines belong to current block
    const indent = line.length - line.trimStart().length

    // Indented key-value: belongs to current map (e.g. metadata block)
    if (indent >= 2 && currentMap && currentKey) {
      // Could be "  key: value" (map entry) or "  - value" (array item)
      if (trimmed.startsWith('- ') && currentArray) {
        currentArray.push(trimmed.slice(2).trim())
        continue
      }
      const colonIdx = trimmed.indexOf(':')
      if (colonIdx > 0) {
        const subKey = trimmed.slice(0, colonIdx).trim()
        const subValue = trimmed.slice(colonIdx + 1).trim()
        if (subValue) {
          currentMap[subKey] = subValue
        }
      }
      continue
    }

    // Array item at top level: "  - value"
    if (trimmed.startsWith('- ') && currentArray && !currentMap) {
      currentArray.push(trimmed.slice(2).trim())
      continue
    }

    // Flush previous block
    if (currentArray && currentKey && !currentMap) {
      result[currentKey] = currentArray
      currentArray = null
    }
    if (currentMap && currentKey) {
      result[currentKey] = currentMap
      currentMap = null
    }

    // Top-level key-value: "key: value"
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()

    if (!value) {
      // Start of a nested block (array or map) — we'll determine which
      // based on the next indented line. Default to map for 'metadata'.
      currentKey = key
      currentArray = []
      currentMap = {}
    } else {
      result[key] = value
      currentKey = key
    }
  }

  // Flush trailing block
  if (currentMap && currentKey && Object.keys(currentMap).length > 0) {
    result[currentKey] = currentMap
  } else if (currentArray && currentKey && currentArray.length > 0) {
    result[currentKey] = currentArray
  }

  return result
}

function validateCategory(v: unknown): SkillMeta['category'] | null {
  const valid = new Set(['productivity', 'communication', 'research', 'custom'])
  return typeof v === 'string' && valid.has(v) ? v as SkillMeta['category'] : null
}

function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

// ── Built-in skill loading ────────────────────────────────────

let builtinCache: SkillContent[] | null = null

/**
 * Load all built-in skills from the builtin/ directory.
 * Results are cached after first call.
 */
export function loadBuiltinSkills(): SkillContent[] {
  if (builtinCache) return builtinCache

  const skills: SkillContent[] = []
  let files: string[]
  try {
    files = readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.md'))
  } catch {
    // Directory doesn't exist (e.g. in test environment)
    builtinCache = []
    return builtinCache
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(BUILTIN_DIR, file), 'utf-8')
      const skill = parseSkillMarkdown(raw, 'builtin')
      if (skill) skills.push(skill)
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by id for deterministic ordering
  skills.sort((a, b) => a.id.localeCompare(b.id))
  builtinCache = skills
  return builtinCache
}

/** Reset the built-in cache (for testing). */
export function _resetBuiltinCache(): void {
  builtinCache = null
}

// ── Mustache pointer expansion (V2 — `{{kind:name}}`) ─────────

/**
 * Matches `{{reference:foo}}`, `{{template:bar.yaml}}`, `{{script:baz.sh}}`.
 * Captures the kind and the file name. Whitespace inside the braces is
 * tolerated; the inner colon is the discriminator.
 *
 * Names are intentionally permissive — file paths carry slashes
 * and dots; the validator at write time rejects newlines and `}`. The runtime
 * resolver does an exact match against the `(skill_id, kind, name)` UNIQUE
 * key, so any disallowed character will simply miss and render the
 * "missing" comment.
 *
 * Spec: `docs/architecture/engine/skill-system.md` →
 *   "Support files — DB-backed adaptation".
 *
 * [COMP:skills/pointer-expansion]
 */
export const POINTER_RE = /\{\{\s*(reference|template|script)\s*:\s*([^{}\r\n]+?)\s*\}\}/g

/** Pointer kinds the resolver understands. Mirrors the DB CHECK constraint. */
export type SkillFilePointerKind = 'reference' | 'template' | 'script'

/**
 * The minimal store shape the pointer expander needs. The real
 * implementation in `packages/api/src/db/workspace-skill-files-store.ts`
 * carries additional methods (list / upsert / delete) the loader does not
 * touch — so the loader binds to the narrowest possible port to stay easy
 * to test and keep `packages/core` free of DB driver imports.
 */
export type SkillFileLookup = {
  getByPointer(
    workspaceSkillId: string,
    pointer: { kind: SkillFilePointerKind; name: string },
  ): Promise<{ kind: SkillFilePointerKind; name: string; content: string } | null>
}

/**
 * Parse every pointer occurrence in `body` and return them in order. Used by
 * the write-time validator inside `skill_manage` — pointing the regex at the
 * same constant keeps the runtime and validator semantics in lock-step.
 */
export function extractPointers(
  body: string,
): Array<{ kind: SkillFilePointerKind; name: string; raw: string }> {
  // Reset lastIndex on the shared regex so we don't carry state between calls.
  POINTER_RE.lastIndex = 0
  const out: Array<{ kind: SkillFilePointerKind; name: string; raw: string }> = []
  let match: RegExpExecArray | null
  while ((match = POINTER_RE.exec(body)) !== null) {
    out.push({
      kind: match[1] as SkillFilePointerKind,
      name: match[2]!.trim(),
      raw: match[0],
    })
  }
  return out
}

/**
 * Expand every Mustache pointer in a skill body against the given lookup.
 *
 * Substitution rules per spec:
 *
 *   * `reference` and `template`: replace the pointer with the file's raw
 *     content inline. The loader treats the body as the source of truth at
 *     `useSkill` invocation time, so any subsequent edit to the file will
 *     re-surface on the next read.
 *
 *   * `script`: render as an HTML comment line plus the script content. The
 *     V2 invariant is content-only — the agent decides what to do with the
 *     script via the existing tool-security model; the loader does not
 *     execute. The comment header makes the inlined block self-describing
 *     for the model.
 *
 *   * Missing target: render `<!-- support file 'kind:name' missing -->`.
 *     The model can see something was expected and skipped, and the comment
 *     remains valid markdown so downstream parsers do not choke.
 *
 * Returns a new content string; never mutates the input. If `body` has no
 * pointers, the input is returned unchanged.
 */
export async function expandPointers(
  workspaceSkillId: string,
  body: string,
  lookup: SkillFileLookup,
): Promise<string> {
  const pointers = extractPointers(body)
  if (pointers.length === 0) return body

  // Resolve every pointer in parallel — the DB primary-key lookup is cheap
  // and parallelism keeps the cost bounded by the network RTT, not the
  // pointer count.
  const resolved = await Promise.all(
    pointers.map(async (p) => {
      const row = await lookup.getByPointer(workspaceSkillId, { kind: p.kind, name: p.name })
      return { pointer: p, row }
    }),
  )

  // Substitute each pointer in left-to-right order. Multiple pointers can
  // share the same `raw` string (same `{{kind:name}}` appearing twice) — by
  // advancing a cursor we ensure each occurrence in the source maps to its
  // own resolved row, even if the rows happen to be identical.
  let cursor = 0
  let out = ''
  for (const { pointer, row } of resolved) {
    const idx = body.indexOf(pointer.raw, cursor)
    if (idx === -1) {
      // Should not happen — extractPointers found this match. Defensive
      // fallback so a regex/string drift can't silently lose content.
      continue
    }
    out += body.slice(cursor, idx)
    out += renderPointer(pointer, row)
    cursor = idx + pointer.raw.length
  }
  out += body.slice(cursor)
  return out
}

function renderPointer(
  pointer: { kind: SkillFilePointerKind; name: string },
  row: { kind: SkillFilePointerKind; name: string; content: string } | null,
): string {
  if (!row) {
    return `<!-- support file '${pointer.kind}:${pointer.name}' missing -->`
  }
  if (pointer.kind === 'script') {
    // Script bodies are rendered as inline instructions; the comment header
    // tells the model which file it's reading so it can refer to it by name
    // when describing what it did.
    return `<!-- script: ${row.name} -->\n${row.content}`
  }
  // reference + template render their raw content.
  return row.content
}

/**
 * Public re-export wrapper to keep the call site narrow: callers pass a
 * `SkillContent` and the loader hands them back a new content-expanded
 * copy. Inputs that don't carry a `rowId` (e.g. built-in skills, which live
 * on disk and have no DB row) are passed through unchanged.
 *
 * The function takes a `workspaceSkillId` explicitly so callers building
 * `SkillContent` from the workspace store (which has both the slug and the
 * row UUID) can thread the UUID through without re-stuffing it into the
 * `SkillContent.id` field — that field is the slug, used by `useSkill`
 * resolution.
 */
export async function expandSkillPointers(
  skill: SkillContent,
  workspaceSkillId: string | null,
  lookup: SkillFileLookup | null,
): Promise<SkillContent> {
  if (!workspaceSkillId || !lookup) return skill
  const expanded = await expandPointers(workspaceSkillId, skill.content, lookup)
  if (expanded === skill.content) return skill
  return { ...skill, content: expanded }
}

// ── State filter helper ─────────────────────────────────────────

/**
 * Skill state — mirrors the `workspace_skills.state` enum. Re-exported here
 * because the loader's state filter operates on app-shape skill objects that
 * carry the state, but `SkillContent` (the legacy disk-only shape) does not.
 * Callers building `SkillContent` from the DB store should attach the state
 * via the `WorkspaceSkill` row.
 *
 * Spec: `docs/architecture/engine/skill-system.md` → S12.
 */
export type SkillLifecycleState = 'active' | 'stale' | 'archived'

/**
 * Filter a list of skill-shaped rows by lifecycle state. The default keeps
 * `active` and `stale` (matches the curator's eligibility set in the spec).
 * Pass an explicit state list to broaden or narrow the filter — e.g.
 * `['active']` for the listing the user sees, `['archived']` for the
 * "recently archived" UI surface.
 *
 * Operates on any object carrying a `state: SkillLifecycleState` field, so
 * both `WorkspaceSkill` and ad-hoc shapes can flow through.
 */
export function filterByState<T extends { state: SkillLifecycleState }>(
  skills: T[],
  states: readonly SkillLifecycleState[] = ['active', 'stale'],
): T[] {
  const allow = new Set(states)
  return skills.filter((s) => allow.has(s.state))
}
