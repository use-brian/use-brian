/**
 * Lint checks — each a pure function of (entry, index) → Finding[].
 * Same 11 checks whether run by the CLI (against filesystem) or the sync
 * worker (against GitHub-fetched entries).
 */

import { isNestedObject } from './frontmatter.js'
import {
  resolveMdLinkToEntry,
  resolveWikilinkToEntry,
} from './kb-index.js'
import {
  SENSITIVITY_RANK,
  SENSITIVITY_VALUES,
  type Finding,
  type LintEntry,
  type LintIndex,
  type Sensitivity,
} from './types.js'

export type { Finding, Severity } from './types.js'

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws-secret-access-key', re: /\baws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}\b/i },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'stripe-secret-key', re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'generic-api-key-assignment', re: /\b(api[_-]?key|secret[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{24,}["']?/i },
]

export function runAllChecks(index: LintIndex): Finding[] {
  const findings: Finding[] = []
  for (const entry of index.entries) {
    findings.push(...checkFrontmatterFields(entry))
    findings.push(...checkFilenameShape(entry))
    findings.push(...checkNestedFrontmatter(entry))
    findings.push(...checkWikilinks(entry, index))
    findings.push(...checkMdLinks(entry, index))
    findings.push(...checkCrossTierBodyLinks(entry, index))
    findings.push(...checkMixedTierIndex(entry, index))
    findings.push(...checkSecrets(entry))
  }
  findings.push(...checkMissingIndices(index))
  findings.push(...checkOrphans(index))
  return findings
}

function getSensitivity(entry: LintEntry): Sensitivity {
  const v = entry.frontmatter.sensitivity
  if (v === 'public' || v === 'internal' || v === 'confidential') return v
  return 'internal'
}

// ── per-entry checks ─────────────────────────────────────────

function checkFrontmatterFields(entry: LintEntry): Finding[] {
  const out: Finding[] = []
  if (!entry.hasFrontmatter) {
    out.push({
      source: entry.source,
      check: 'missing-frontmatter',
      severity: 'warning',
      message: 'Entry has no YAML frontmatter — parser will fall back to filename-as-title and null summary.',
      hint: 'Add at minimum: title, description, tags, sensitivity.',
    })
    return out
  }

  const { frontmatter } = entry
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
    out.push({
      source: entry.source,
      check: 'missing-description',
      severity: 'warning',
      message: 'Missing or empty `description`. This is what browseKnowledge/searchKnowledge show in listings.',
    })
  }
  const tags = frontmatter.tags
  if (!Array.isArray(tags) || tags.length === 0) {
    out.push({
      source: entry.source,
      check: 'missing-tags',
      severity: 'warning',
      message: 'Missing or empty `tags`. Tags get FTS weight and help retrieval.',
    })
  }
  if (frontmatter.sensitivity === undefined) {
    out.push({
      source: entry.source,
      check: 'missing-sensitivity',
      severity: 'warning',
      message: 'No `sensitivity` set. Parser defaults to internal; be explicit to avoid silent decisions.',
    })
  } else if (typeof frontmatter.sensitivity !== 'string' || !SENSITIVITY_VALUES.includes(frontmatter.sensitivity as Sensitivity)) {
    out.push({
      source: entry.source,
      check: 'invalid-sensitivity',
      severity: 'error',
      message: `Invalid sensitivity value: ${JSON.stringify(frontmatter.sensitivity)}. Parser will fall back to \`internal\` and log a warning.`,
      hint: `Use one of: ${SENSITIVITY_VALUES.join(', ')}.`,
    })
  }
  return out
}

function checkFilenameShape(entry: LintEntry): Finding[] {
  const out: Finding[] = []
  const basename = entry.source.split('/').pop() ?? entry.source
  if (/^\d{4}-\d{2}-\d{2}/.test(basename)) {
    out.push({
      source: entry.source,
      check: 'date-prefix-filename',
      severity: 'warning',
      message: 'Filename starts with a date prefix; prefer `status: deprecated` / `last_reviewed` metadata over path-encoded dates.',
    })
  } else if (/^\d+[-_]/.test(basename)) {
    out.push({
      source: entry.source,
      check: 'numeric-prefix-filename',
      severity: 'warning',
      message: 'Filename starts with a numeric prefix; becomes part of the KB path and is brittle to reordering.',
      hint: 'Strip the prefix.',
    })
  }
  return out
}

function checkNestedFrontmatter(entry: LintEntry): Finding[] {
  const out: Finding[] = []
  for (const [key, value] of Object.entries(entry.frontmatter)) {
    if (isNestedObject(value)) {
      out.push({
        source: entry.source,
        check: 'nested-frontmatter',
        severity: 'warning',
        message: `Frontmatter key \`${key}\` contains a nested object. The parser only reads flat scalars + arrays; nested fields are lost.`,
        hint: 'Flatten to scalar keys or an array.',
      })
    }
  }
  return out
}

function checkWikilinks(entry: LintEntry, index: LintIndex): Finding[] {
  const out: Finding[] = []
  for (const link of entry.wikilinks) {
    const resolved = resolveWikilinkToEntry(link.target, entry, index)
    if (!resolved) {
      out.push({
        source: entry.source,
        line: link.lineNumber,
        check: 'unresolved-wikilink',
        severity: 'error',
        message: `Wikilink \`${link.raw}\` does not resolve to any entry.`,
        hint: 'Resolution is: exact path → relative → filename search.',
      })
    }
  }
  return out
}

function checkMdLinks(entry: LintEntry, index: LintIndex): Finding[] {
  const out: Finding[] = []
  for (const link of entry.mdLinks) {
    if (link.target.startsWith('/') || link.target.includes('packages/') || link.target.includes('src/')) continue
    const resolved = resolveMdLinkToEntry(link.target, entry, index)
    if (!resolved) {
      out.push({
        source: entry.source,
        line: link.lineNumber,
        check: 'unresolved-md-link',
        severity: 'error',
        message: `Markdown link \`${link.raw}\` points to \`${link.target}\` but no such entry exists.`,
        hint: 'Either rename the link, remove it, or ingest the target.',
      })
    }
  }
  return out
}

function checkCrossTierBodyLinks(entry: LintEntry, index: LintIndex): Finding[] {
  const out: Finding[] = []
  const sourceTier = getSensitivity(entry)

  const check = (targetEntry: LintEntry, linkRaw: string, line: number, linkKind: 'wikilink' | 'markdown-link') => {
    const targetTier = getSensitivity(targetEntry)
    if (SENSITIVITY_RANK[targetTier] > SENSITIVITY_RANK[sourceTier]) {
      out.push({
        source: entry.source,
        line,
        check: 'cross-tier-body-link',
        severity: 'warning',
        message: `${linkKind} \`${linkRaw}\` in a \`${sourceTier}\` entry references a \`${targetTier}\` target. The path string is visible in body text even though related_ids is filtered.`,
        hint: 'Prefer `frontmatter.related[]` when crossing tiers, or raise this entry\'s sensitivity.',
      })
    }
  }

  for (const link of entry.wikilinks) {
    const resolved = resolveWikilinkToEntry(link.target, entry, index)
    if (resolved) check(resolved, link.raw, link.lineNumber, 'wikilink')
  }
  for (const link of entry.mdLinks) {
    const resolved = resolveMdLinkToEntry(link.target, entry, index)
    if (resolved) check(resolved, link.raw, link.lineNumber, 'markdown-link')
  }
  return out
}

function checkMixedTierIndex(entry: LintEntry, index: LintIndex): Finding[] {
  if (!entry.isIndex) return []
  const out: Finding[] = []
  const indexTier = getSensitivity(entry)

  const check = (target: LintEntry, linkRaw: string, line: number) => {
    const childTier = getSensitivity(target)
    if (SENSITIVITY_RANK[childTier] > SENSITIVITY_RANK[indexTier]) {
      out.push({
        source: entry.source,
        line,
        check: 'mixed-tier-index',
        severity: 'error',
        message: `Index entry (\`${indexTier}\`) lists \`${target.kbPath}\` (\`${childTier}\`) by name. The higher-tier name leaks to lower-cleared readers via body text.`,
        hint: `Raise this index's sensitivity to \`${childTier}\`, or remove that child from the body listing.`,
      })
    }
  }

  for (const link of entry.wikilinks) {
    const resolved = resolveWikilinkToEntry(link.target, entry, index)
    if (resolved) check(resolved, link.raw, link.lineNumber)
  }
  for (const link of entry.mdLinks) {
    const resolved = resolveMdLinkToEntry(link.target, entry, index)
    if (resolved) check(resolved, link.raw, link.lineNumber)
  }
  return out
}

function checkSecrets(entry: LintEntry): Finding[] {
  const out: Finding[] = []
  const lines = entry.body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        out.push({
          source: entry.source,
          line: i + 1,
          check: `secret:${name}`,
          severity: 'error',
          message: `Line matches ${name} pattern — looks like a committed secret.`,
          hint: 'Remove the value, rotate the key, and commit a follow-up. Sensitivity gates readers; it does not protect leaked secrets.',
        })
      }
    }
  }
  return out
}

// ── global checks ────────────────────────────────────────────

function checkMissingIndices(index: LintIndex): Finding[] {
  const out: Finding[] = []
  const dirsWithEntries = new Set<string>()
  for (const e of index.entries) {
    if (!e.isIndex) {
      const parent = e.kbPath.includes('/') ? e.kbPath.slice(0, e.kbPath.lastIndexOf('/')) : ''
      dirsWithEntries.add(parent)
    }
  }

  for (const dir of dirsWithEntries) {
    const indexKey = dir === '' ? 'index' : dir
    if (!index.byKbPath.has(indexKey)) {
      out.push({
        source: dir === '' ? '<root>' : dir,
        check: 'missing-directory-index',
        severity: 'warning',
        message: `Directory \`${dir || '<root>'}\` has entries but no \`index.md\`. Browsers see children with no orientation.`,
        hint: 'Add an index.md with a short "what is this folder" summary.',
      })
    }
  }
  return out
}

function checkOrphans(index: LintIndex): Finding[] {
  const out: Finding[] = []
  const linkedTargets = new Set<string>()

  for (const entry of index.entries) {
    const related = entry.frontmatter.related
    if (Array.isArray(related)) {
      for (const r of related) {
        const match = resolveWikilinkToEntry(String(r), entry, index)
        if (match) linkedTargets.add(match.kbPath)
      }
    }
    for (const link of entry.wikilinks) {
      const match = resolveWikilinkToEntry(link.target, entry, index)
      if (match) linkedTargets.add(match.kbPath)
    }
    for (const link of entry.mdLinks) {
      const match = resolveMdLinkToEntry(link.target, entry, index)
      if (match) linkedTargets.add(match.kbPath)
    }
  }

  for (const entry of index.entries) {
    if (entry.kbPath === 'index') continue
    if (entry.isIndex) continue
    if (!linkedTargets.has(entry.kbPath)) {
      out.push({
        source: entry.source,
        check: 'orphan',
        severity: 'info',
        message: `Entry \`${entry.kbPath}\` is not linked from any other entry. It will only surface via search.`,
        hint: 'Consider linking from the parent index.md or a related entry.',
      })
    }
  }
  return out
}
