/**
 * Canonical Agent Skills bundle compiler.
 *
 * Every folder source (brian-tools, GitHub, filesystem) is normalized through
 * this pure representation so registry loading and user import cannot drift.
 * SKILL.md remains untouched; ordinary relative Markdown links declare which
 * resources are reachable and cross-skill links derive graph edges.
 *
 * [COMP:skills/bundle]
 */

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { FRONTMATTER_RE, parseSkillMarkdown, parseYamlFrontmatter } from './loader.js'
import type {
  SkillBundle,
  SkillBundleIssue,
  SkillBundleLink,
  SkillBundleSource,
  SkillContent,
  SkillResource,
  SkillResourceKind,
} from './types.js'

const RESOURCE_ROOTS = new Map<string, SkillResourceKind>([
  ['references', 'reference'],
  ['assets', 'asset'],
  ['templates', 'template'],
  ['scripts', 'script'],
])

const MARKDOWN_LINK_RE = /(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g

export type SkillBundleFileInput = {
  path: string
  content: string
  description?: string
}

export type ParseSkillBundleInput = {
  skillMarkdown: string
  files?: readonly SkillBundleFileInput[]
  source?: SkillBundleSource
  skillSource?: SkillContent['source']
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Normalize a bundle-relative path and reject traversal/absolute paths. */
export function normalizeSkillResourcePath(raw: string): string | null {
  const unix = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!unix || unix.startsWith('/') || /^[a-zA-Z]:\//.test(unix)) return null
  const normalized = posix.normalize(unix)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) return null
  return normalized
}

export function skillResourceKindFromPath(path: string): SkillResourceKind | null {
  const root = path.split('/')[0]?.toLowerCase()
  return root ? (RESOURCE_ROOTS.get(root) ?? null) : null
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function descriptionFromContent(content: string): string | undefined {
  const fm = content.match(FRONTMATTER_RE)
  if (fm) {
    const meta = parseYamlFrontmatter(fm[1] ?? '')
    if (typeof meta.description === 'string' && meta.description.trim()) {
      return meta.description.trim().slice(0, 500)
    }
  }
  // Never synthesize the resource index from the resource body. The index is
  // injected with the root skill and therefore must remain metadata-only;
  // copying even a short first paragraph here defeats progressive disclosure.
  return undefined
}

/** Extract non-image Markdown link targets without rewriting the body. */
export function extractSkillMarkdownLinks(markdown: string): string[] {
  MARKDOWN_LINK_RE.lastIndex = 0
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = MARKDOWN_LINK_RE.exec(markdown)) !== null) {
    const target = (match[1] ?? match[2] ?? '').trim()
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    out.push(target.split('#')[0]!)
  }
  return out
}

function resourceFor(input: SkillBundleFileInput, issues: SkillBundleIssue[]): SkillResource | null {
  const path = normalizeSkillResourcePath(input.path)
  if (!path) {
    issues.push({
      code: 'invalid_resource_path',
      path: input.path,
      detail: `Resource path is not a safe skill-relative path: ${input.path}`,
    })
    return null
  }
  const kind = skillResourceKindFromPath(path)
  if (!kind) return null
  if (input.content.includes('\0')) {
    issues.push({
      code: 'binary_resource',
      path,
      detail: `Binary resource is not supported by the text-backed skill bundle: ${path}`,
    })
    return null
  }
  return {
    path,
    kind,
    name: basename(path),
    content: input.content,
    description: input.description?.trim() || descriptionFromContent(input.content),
    contentHash: sha256(input.content),
  }
}

/** Compile root markdown + folder files into the canonical SkillBundle IR. */
export function parseSkillBundle(input: ParseSkillBundleInput): SkillBundle | null {
  const parsed = parseSkillMarkdown(input.skillMarkdown, input.skillSource ?? 'community')
  if (!parsed) return null

  const issues: SkillBundleIssue[] = []
  const byPath = new Map<string, SkillResource>()
  for (const file of input.files ?? []) {
    const resource = resourceFor(file, issues)
    if (resource) byPath.set(resource.path, resource)
  }
  const resources = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  const links: SkillBundleLink[] = resources.map((r) => ({
    sourcePath: 'SKILL.md',
    targetPath: r.path,
    relation: 'contains',
  }))

  const referenced = new Set<string>()
  for (const target of extractSkillMarkdownLinks(parsed.content)) {
    const crossSkill = target.match(/^\.\.\/([^/]+)\/SKILL\.md$/i)
    if (crossSkill) {
      links.push({
        sourcePath: 'SKILL.md',
        targetPath: target,
        relation: 'uses_skill',
        targetSkillSlug: crossSkill[1]!,
      })
      continue
    }
    const normalized = normalizeSkillResourcePath(posix.join(posix.dirname('SKILL.md'), target))
    if (!normalized || !skillResourceKindFromPath(normalized)) continue
    if (!byPath.has(normalized)) {
      issues.push({
        code: 'missing_resource',
        path: normalized,
        detail: `SKILL.md links to a resource that is not in the bundle: ${normalized}`,
      })
      continue
    }
    referenced.add(normalized)
    links.push({ sourcePath: 'SKILL.md', targetPath: normalized, relation: 'references' })
  }

  for (const resource of resources) {
    if (!referenced.has(resource.path)) {
      issues.push({
        code: 'orphaned_resource',
        path: resource.path,
        detail: `Resource is not linked directly from SKILL.md: ${resource.path}`,
      })
    }
  }

  const digestInput = [
    `SKILL.md\0${sha256(input.skillMarkdown)}`,
    ...resources.map((r) => `${r.path}\0${r.contentHash}`),
  ].join('\n')
  const sourceDigest = sha256(digestInput)
  const skill: SkillContent = {
    ...parsed,
    bundleVersion: 2,
    resources,
    sourceDigest,
    bundleSource: input.source,
  }
  return { skill, resources, links, sourceDigest, issues, source: input.source }
}

export function formatSkillResourceIndex(skill: SkillContent): string {
  if (skill.bundleVersion !== 2 || !skill.resources?.length) return ''
  const rows = [...skill.resources]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) => `- \`${r.path}\` (${r.kind})${r.description ? `: ${r.description}` : ''}`)
  return [
    '## Available skill resources',
    '',
    'Read only the resources needed for this request with `readSkillResource`. ' +
      'Use `searchSkillResources` when the relevant path is unclear.',
    '',
    ...rows,
  ].join('\n')
}

/** Root instructions exactly as the model should receive them. */
export function formatSkillInstructions(skill: SkillContent): string {
  const index = formatSkillResourceIndex(skill)
  return index ? `${skill.content}\n\n${index}` : skill.content
}

export function findSkillResource(skill: SkillContent, rawPath: string): SkillResource | null {
  const path = normalizeSkillResourcePath(rawPath)
  if (!path) return null
  return skill.resources?.find((resource) => resource.path === path) ?? null
}

export function searchSkillResourceContent(
  skill: SkillContent,
  query: string,
  limit = 5,
): Array<SkillResource & { score: number; excerpt: string }> {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1)
  if (terms.length === 0) return []
  return (skill.resources ?? [])
    .map((resource) => {
      const path = resource.path.toLowerCase()
      const description = (resource.description ?? '').toLowerCase()
      const content = resource.content.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (path.includes(term)) score += 8
        if (description.includes(term)) score += 4
        const first = content.indexOf(term)
        if (first >= 0) score += 1
      }
      const firstTerm = terms.map((term) => content.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
      const start = Math.max(0, firstTerm - 120)
      const excerpt = resource.content.slice(start, start + 360).replace(/\s+/g, ' ').trim()
      return { ...resource, score, excerpt }
    })
    .filter((resource) => resource.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(limit, 10)))
}
