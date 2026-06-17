/**
 * High-level entry parser — the canonical `parseMarkdownFile` consumed by the
 * sync worker. Mirrors the behaviour that was previously in
 * packages/core/src/knowledge/parser.ts.
 *
 * Pure deterministic extraction. No LLM.
 */

import { readFrontmatter } from './frontmatter.js'
import { isSensitivity, type ParsedEntry, type Sensitivity } from './types.js'

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g
const HEADING_RE = /^#\s+(.+)$/m

export function parseMarkdownFile(filePath: string, rawContent: string): ParsedEntry {
  const path = normalisePath(filePath)

  const { frontmatter, body: rawBody } = readFrontmatter(rawContent)
  const body = rawBody.trim()

  const title =
    (typeof frontmatter.title === 'string' ? frontmatter.title : null)
    ?? extractFirstHeading(body)
    ?? fileNameToTitle(filePath)

  const summary = typeof frontmatter.description === 'string' ? frontmatter.description : null
  const tags = extractTags(frontmatter.tags)

  const related: string[] = []
  if (Array.isArray(frontmatter.related)) {
    for (const r of frontmatter.related) {
      if (typeof r === 'string') related.push(r)
    }
  }
  for (const m of body.matchAll(WIKILINK_RE)) {
    const link = m[1].split('|')[0].trim()
    if (link) related.push(link)
  }
  for (const m of body.matchAll(MD_LINK_RE)) {
    const href = m[2].replace(/\.md(#.*)?$/, '').trim()
    if (href && !href.startsWith('http')) related.push(href)
  }

  const rawSensitivity = frontmatter.sensitivity
  let sensitivity: Sensitivity = 'internal'
  if (rawSensitivity !== undefined) {
    if (isSensitivity(rawSensitivity)) {
      sensitivity = rawSensitivity
    } else {
      console.warn(
        `[kb-parser] invalid sensitivity=${JSON.stringify(rawSensitivity)} in ${filePath}, defaulting to internal`,
      )
    }
  }

  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!['description', 'tags', 'title', 'related', 'sensitivity'].includes(key)) {
      metadata[key] = value
    }
  }

  return { path, title, summary, content: body, tags, related, sensitivity, metadata }
}

// ── helpers ──────────────────────────────────────────────────

export function normalisePath(filePath: string): string {
  return filePath
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/index$/i, '')
    || 'index'
}

export function extractFirstHeading(body: string): string | null {
  const match = body.match(HEADING_RE)
  return match ? match[1].trim() : null
}

export function fileNameToTitle(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath
  return name
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function extractTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}
