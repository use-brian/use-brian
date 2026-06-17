/**
 * Build a LintIndex from either a filesystem directory (CLI use) or a set of
 * pre-fetched entries (sync worker use). Both produce the same shape so the
 * check suite doesn't know or care which side called it.
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { readFrontmatter } from './frontmatter.js'
import { normalisePath } from './parser.js'
import type { LintEntry, LintIndex, MdLink, Wikilink } from './types.js'

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g
const FENCED_CODE_RE = /^\s*```/
const INDENTED_CODE_RE = /^    /

/** Input to buildLintIndex — one entry per KB file. */
export type LintInputEntry = {
  /** Source identifier. For CLI: filesystem path. For sync: `${owner}/${repo}:${path}`. */
  source: string
  /** Relative path within the KB (e.g. "products/vault/fees.md" or "products/vault/index.md"). */
  relativePath: string
  /** Raw file content (full, including frontmatter). */
  rawContent: string
}

export function buildLintIndex(inputs: LintInputEntry[]): LintIndex {
  const entries: LintEntry[] = inputs
    .filter((input) => input.relativePath.toLowerCase() !== 'readme.md')
    .map((input) => {
      const { frontmatter, body, hasFrontmatter } = readFrontmatter(input.rawContent)
      const kbPath = normalisePath(input.relativePath)
      const isIndex = /(^|\/)index\.md$/i.test(input.relativePath)
      const bodyWithoutCode = stripCodeBlocks(body)
      return {
        source: input.source,
        kbPath,
        isIndex,
        frontmatter,
        hasFrontmatter,
        body,
        wikilinks: extractWikilinks(bodyWithoutCode),
        mdLinks: extractMdLinks(bodyWithoutCode),
      }
    })

  const byKbPath = new Map<string, LintEntry>()
  for (const e of entries) byKbPath.set(e.kbPath, e)

  const byFilename = new Map<string, LintEntry[]>()
  for (const e of entries) {
    const leaf = e.kbPath.split('/').pop() ?? e.kbPath
    const bucket = byFilename.get(leaf) ?? []
    bucket.push(e)
    byFilename.set(leaf, bucket)
  }

  return { entries, byKbPath, byFilename }
}

/** Walk a filesystem directory and collect `.md` files as LintInputEntry[]. */
export async function walkKbFromFs(root: string): Promise<LintIndex> {
  const absRoot = path.resolve(root)
  const files = await walkMarkdownFiles(absRoot)
  const inputs: LintInputEntry[] = []
  for (const filePath of files) {
    const relativePath = path.relative(absRoot, filePath)
    const rawContent = await readFile(filePath, 'utf8')
    inputs.push({ source: filePath, relativePath, rawContent })
  }
  return buildLintIndex(inputs)
}

// ── lint entry resolver helpers (rich variants, used by checks) ──

/**
 * Resolve a wikilink target to a LintEntry. Same three-step algorithm as the
 * canonical string-level resolver in wikilink-resolver.ts but returns the
 * entry object so checks can inspect sensitivity, frontmatter, etc.
 */
export function resolveWikilinkToEntry(
  target: string,
  fromEntry: LintEntry,
  index: LintIndex,
): LintEntry | null {
  const normalised = normaliseLinkTarget(target)

  const exact = index.byKbPath.get(normalised)
  if (exact) return exact

  if (normalised.includes('..') || !normalised.includes('/')) {
    const fromDir = fromEntry.isIndex && fromEntry.kbPath !== 'index'
      ? fromEntry.kbPath
      : dirOf(fromEntry.kbPath) ?? ''
    const resolved = resolveRelative(fromDir, normalised)
    const match = index.byKbPath.get(resolved)
    if (match) return match
  }

  const leaf = normalised.split('/').pop() ?? normalised
  const candidates = index.byFilename.get(leaf)
  if (candidates && candidates.length > 0) return candidates[0]
  return null
}

export function resolveMdLinkToEntry(
  target: string,
  fromEntry: LintEntry,
  index: LintIndex,
): LintEntry | null {
  const cleaned = normaliseLinkTarget(target.replace(/#.*$/, ''))
  const fromDir = fromEntry.isIndex && fromEntry.kbPath !== 'index'
    ? fromEntry.kbPath
    : dirOf(fromEntry.kbPath) ?? ''
  const resolved = resolveRelative(fromDir, cleaned)
  return index.byKbPath.get(resolved) ?? null
}

// ── internals ──────────────────────────────────────────────────

function normaliseLinkTarget(target: string): string {
  return target
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/index$/i, '')
}

function dirOf(kbPath: string): string | undefined {
  if (kbPath === 'index' || !kbPath.includes('/')) return ''
  return kbPath.slice(0, kbPath.lastIndexOf('/'))
}

function resolveRelative(fromDir: string, target: string): string {
  const parts = fromDir ? fromDir.split('/') : []
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

function stripCodeBlocks(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCED_CODE_RE.test(line)) {
      inFence = !inFence
      out.push('')
      continue
    }
    if (inFence || INDENTED_CODE_RE.test(line)) {
      out.push('')
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '')
}

function extractWikilinks(body: string): Wikilink[] {
  const out: Wikilink[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineCode(lines[i])
    for (const match of line.matchAll(WIKILINK_RE)) {
      const inner = match[1]
      const [target, alias] = inner.split('|').map((s) => s.trim())
      out.push({ raw: match[0], target, alias, lineNumber: i + 1 })
    }
  }
  return out
}

function extractMdLinks(body: string): MdLink[] {
  const out: MdLink[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineCode(lines[i])
    for (const match of line.matchAll(MD_LINK_RE)) {
      const [, text, target] = match
      if (target.startsWith('http://') || target.startsWith('https://')) continue
      out.push({ raw: match[0], text, target, lineNumber: i + 1 })
    }
  }
  return out
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdownFiles(full)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}
