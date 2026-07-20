/**
 * Shared types for the kb parser + lint.
 *
 * Sensitivity is duplicated from packages/core/src/security/sensitivity.ts
 * by convention — the canonical runtime helpers (accumulator, canRead, maxSensitivity)
 * stay in core since they're used cross-domain by memory + sessions. The type
 * itself is a trivial enum; document any future changes in both places.
 */

export type Sensitivity = 'public' | 'internal' | 'confidential'

export const SENSITIVITY_VALUES: readonly Sensitivity[] = ['public', 'internal', 'confidential'] as const

export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
}

export function isSensitivity(v: unknown): v is Sensitivity {
  return typeof v === 'string' && v in SENSITIVITY_RANK
}

// ── Parser output shape (canonical — what the sync worker consumes) ──

export type ParsedEntry = {
  path: string
  title: string
  summary: string | null
  content: string
  tags: string[]
  /** Raw related references (wikilinks + frontmatter `related` + md-links). Resolved to UUIDs in sync pass 2. */
  related: string[]
  sensitivity: Sensitivity
  metadata: Record<string, unknown>
}

// ── Lint-side richer types (used by checks) ──

export type Wikilink = {
  raw: string
  target: string
  alias?: string
  lineNumber: number
}

export type MdLink = {
  raw: string
  text: string
  target: string
  lineNumber: number
}

/** A KB entry enriched for lint purposes — preserves frontmatter, body, and structured link references. */
export type LintEntry = {
  /** Source identifier: filesystem path for CLI use, `repo:commit/path` for sync use. */
  source: string
  /** Normalised KB path (e.g. "products/vault/fees" with index suffix stripped). */
  kbPath: string
  /** Whether the source file was named `index.md` (relevant for mixed-tier index checks). */
  isIndex: boolean
  frontmatter: Record<string, unknown>
  hasFrontmatter: boolean
  body: string
  wikilinks: Wikilink[]
  mdLinks: MdLink[]
}

export type LintIndex = {
  entries: LintEntry[]
  byKbPath: Map<string, LintEntry>
  byFilename: Map<string, LintEntry[]>
}

// ── Lint findings ──

export type Severity = 'error' | 'warning' | 'info'

export type Finding = {
  source: string
  line?: number
  check: string
  severity: Severity
  message: string
  hint?: string
}
