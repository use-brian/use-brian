/**
 * Low-level YAML frontmatter parser. Returns raw frontmatter + body without
 * doing any field-level typing (parseMarkdownFile does that). Lint consumes
 * this directly to inspect keys the high-level parser would drop (nested
 * objects, unknown values).
 *
 * Supports: scalars, inline + block arrays, booleans, numbers, quoted strings.
 * Nested objects are captured as `Record<string, unknown>` for lint to flag.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function readFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
  hasFrontmatter: boolean
} {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { frontmatter: {}, body: content, hasFrontmatter: false }
  return {
    frontmatter: parseYamlSubset(match[1]),
    body: content.slice(match[0].length),
    hasFrontmatter: true,
  }
}

export function isNestedObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function parseYamlSubset(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = raw.split('\n')
  let currentKey: string | null = null

  for (const line of lines) {
    // Indented continuation decides whether an empty-value key is array or nested object.
    if (currentKey && /^\s/.test(line)) {
      const trimmed = line.trim()
      const arrayItem = trimmed.match(/^-\s+(.+)$/)
      if (arrayItem) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = []
        ;(result[currentKey] as string[]).push(arrayItem[1].trim())
        continue
      }
      const subKv = trimmed.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/)
      if (subKv) {
        if (!isNestedObject(result[currentKey])) result[currentKey] = {}
        ;(result[currentKey] as Record<string, unknown>)[subKv[1]] = subKv[2].trim()
        continue
      }
      continue
    }

    const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/)
    if (!kv) { currentKey = null; continue }
    const key = kv[1].trim()
    let value = kv[2].trim()
    currentKey = key

    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      continue
    }
    if (!value) {
      result[key] = []
      continue
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value === 'true') { result[key] = true; continue }
    if (value === 'false') { result[key] = false; continue }
    const num = Number(value)
    if (!isNaN(num) && value !== '') { result[key] = num; continue }
    result[key] = value
  }

  return result
}
