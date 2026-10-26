import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Codifies the audit grep documented in
 * `docs/architecture/integrations/mcp.md` → "Drift sweep — 'all built-ins'
 * lists". A hardcoded `Set` or array of connector IDs that means "every
 * official built-in" has shadowed the registry multiple times. This test
 * walks the source tree and asserts every hit is either:
 *
 *   (a) Provider-family-specific (intentionally narrow) — name matches
 *       PROVIDER_FAMILY_NARROW_SYMBOLS or has a `// drift-sweep:
 *       intentionally-narrow:<reason>` comment.
 *   (b) Derived from `OFFICIAL_CONNECTORS` — same line references the
 *       registry (compile-time-derived).
 *   (c) Allowlisted as a known drift candidate awaiting a follow-up PR
 *       — in PLANNED_FOLLOWUP_ALLOWLIST below or has a `// drift-sweep:
 *       planned-followup:<id>` comment.
 *
 * Anything else fails the test until it's classified.
 *
 * Lives in tests (not the runtime route) because the route ships compiled
 * JS to the api-admin container and does not see source files.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const SCAN_ROOTS = ['packages', 'apps']
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.turbo', '.git', 'coverage', '__tests__',
])
const FILE_EXTS = ['.ts', '.tsx']

const ALL_BUILTINS_PATTERNS: ReadonlyArray<RegExp> = [
  // new Set(["gmail", ...]) | new Set(['gcal', ...])
  /new\s+Set\s*\(\s*\[\s*['"](gmail|gcal|notion|gdrive|github|fathom)['"]/,
  // ["gmail", ...] | ['gcal', ...] — array literal that begins with a built-in id
  /[^a-zA-Z_$]\[\s*['"](gmail|gcal|notion|gdrive|github|fathom)['"]\s*,/,
]

const PROVIDER_FAMILY_NARROW_SYMBOLS = new Set([
  'GOOGLE_CONNECTORS',
  'GOOGLE_PROVIDERS',
  'PAT_CONNECTORS',
  'CONFIGURABLE_CONNECTORS',
])

const PLANNED_FOLLOWUP_ALLOWLIST = new Set([
  // Controls the "remove" button on the connector settings page (moved
  // from settings/connectors to studio/connectors during the company-
  // brain UI revamp; the file body was copied unchanged). Pre-existing
  // on revamp/workspace; surfaced by Wave 1 of the admin-ui-revamp
  // Drift Sweep. Follow-up PR derives from
  // OFFICIAL_CONNECTORS.filter((c) => !c.oauth_required).
  'apps/web/src/app/(app)/studio/connectors/page.tsx',
  // app-web consolidation port of the same connectors page (the line was
  // copied verbatim from the allowlisted apps/web instance above). The
  // @use-brian/shared subpath dep is now in place (app-web imports
  // OFFICIAL_CONNECTOR_TOOLS / OFFICIAL_OAUTH_SCOPES / MINI_APPS from the
  // ./builtin-connectors + ./mini-apps subpaths; OFFICIAL_CONNECTORS is
  // reachable via ./connector-registry), so the derive is now mechanically
  // possible. What remains is behavior-sensitive: the `["gmail","gcal",
  // "github"]` list is the "built-ins that disconnect rather than delete"
  // Remove-button policy, NOT a registry mirror, so reshaping it from
  // OFFICIAL_CONNECTORS needs design intent + browser QA. Deferred to the same
  // follow-up as the apps/web copy — tracked in
  // docs/architecture/features/doc.md §5b.
  'apps/app-web/src/app/w/[workspaceId]/studio/connectors/page.tsx',
])

type Hit = {
  path: string
  lineNumber: number
  line: string
  classification: 'narrow' | 'derived' | 'planned-followup' | 'unclassified'
  reason: string
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: { name: string; isDir: boolean }[]
  try {
    const items = await readdir(dir, { withFileTypes: true })
    entries = items.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDir) {
      out.push(...(await walk(full)))
    } else if (FILE_EXTS.some((ext) => e.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}


/** A top-level canonical source parser vocabulary, never an all-connectors list. */
function isKnowledgeSourceTypeEnum(node: ts.ArrayLiteralExpression, source: ts.SourceFile): boolean {
  if (node.elements.length !== 2 || !node.elements.every(ts.isStringLiteral)
    || node.elements.map(element => (element as ts.StringLiteral).text).sort().join(',') !== 'github,local') return false
  const call = node.parent
  if (!ts.isCallExpression(call) || call.arguments[0] !== node || call.arguments.length !== 1
    || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'enum'
    || !ts.isIdentifier(call.expression.expression)) return false
  const namespace = call.expression.expression.text
  const imported = source.statements.some(statement => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'zod'
    && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some(binding => (binding.propertyName?.text ?? binding.name.text) === 'z' && binding.name.text === namespace))
  if (!imported) return false
  const field = call.parent
  if (!ts.isPropertyAssignment(field) || field.name.getText(source).replace(/['"]/g, '') !== 'sourceType'
    || !ts.isObjectLiteralExpression(field.parent)) return false
  const shape = field.parent, object = shape.parent
  if (!ts.isCallExpression(object) || object.arguments[0] !== shape
    || !ts.isPropertyAccessExpression(object.expression) || object.expression.name.text !== 'object'
    || !ts.isIdentifier(object.expression.expression) || object.expression.expression.text !== namespace) return false
  const fields = new Set(shape.properties.filter(ts.isPropertyAssignment).map(property => property.name.getText(source).replace(/['"]/g, '')))
  if (!['id', 'repo', 'branch', 'rootPath'].every(name => fields.has(name))) return false
  // Restrict the exception to top-level parser declarations; nested/shadowed namespaces stay checked.
  for (let ancestor: ts.Node = node; ancestor !== source; ancestor = ancestor.parent) {
    if (!ancestor.parent || ts.isFunctionLike(ancestor) || ts.isBlock(ancestor) || ts.isClassLike(ancestor)) return false
  }
  return true
}

function withoutKnowledgeSourceTypeEnums(text: string): string {
  if (!text.includes('sourceType') || !text.includes('github') || !text.includes('local')) return text
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true), spans: Array<[number, number]> = []
  function inspect(node: ts.Node): void {
    if (ts.isArrayLiteralExpression(node) && isKnowledgeSourceTypeEnum(node, source)) spans.push([node.getStart(source), node.end])
    ts.forEachChild(node, inspect)
  }
  inspect(source)
  for (const [start, end] of spans.reverse()) text = text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ') + text.slice(end)
  return text
}

function classify(absPath: string, line: string): { kind: Hit['classification']; reason: string } {
  for (const sym of PROVIDER_FAMILY_NARROW_SYMBOLS) {
    if (line.includes(sym)) return { kind: 'narrow', reason: `references ${sym}` }
  }
  if (line.includes('drift-sweep: intentionally-narrow')) {
    return { kind: 'narrow', reason: 'inline narrow tag' }
  }
  if (line.includes('OFFICIAL_CONNECTORS')) {
    return { kind: 'derived', reason: 'references OFFICIAL_CONNECTORS' }
  }
  if (line.includes('drift-sweep: planned-followup')) {
    return { kind: 'planned-followup', reason: 'inline followup tag' }
  }
  const rel = relative(REPO_ROOT, absPath)
  if (PLANNED_FOLLOWUP_ALLOWLIST.has(rel)) {
    return { kind: 'planned-followup', reason: 'in PLANNED_FOLLOWUP_ALLOWLIST' }
  }
  return { kind: 'unclassified', reason: 'no narrow symbol, no derivation, no allowlist hit' }
}

describe('[COMP:admin/drift-sweep] all-builtins hardcoded-Set grep audit', () => {
  it('classifies the canonical source enum without hiding other fields, namespaces or same-line lists', () => {
    const shape = "id:z.string(),sourceType:z.enum(['github','local']),repo:z.string(),branch:z.string(),rootPath:z.string()"
    const parser = "import {z} from 'zod'; const values=z.object({" + shape + "})"
    const hit = (text: string) => ALL_BUILTINS_PATTERNS.some(pattern => pattern.test(withoutKnowledgeSourceTypeEnums(text)))
    expect(hit(parser)).toBe(false)
    expect(hit(parser.replace(/\bz\b/g, 'schema').replace('{schema}', '{z as schema}'))).toBe(false)
    for (const content of [
      parser + "; const BUILTIN_IDS=['github','local']",
      parser.replace('sourceType:', 'connectorType:'),
      parser.replace("from 'zod'", "from 'other'"),
      "import {z} from 'zod'; function parse(z){return z.object({" + shape + "})}",
      parser.replace("['github','local']", "['gmail','gcal']"),
    ]) expect(hit(content), content).toBe(true)
  })

  // Walks the whole packages/ + apps/ tree; the consolidation grew apps/app-web
  // substantially, so the default 5s is too tight under parallel test load.
  it('every hit is either provider-family-narrow, derived from OFFICIAL_CONNECTORS, or an allowlisted follow-up', { timeout: 30000 }, async () => {
    const allHits: Hit[] = []
    for (const root of SCAN_ROOTS) {
      const files = await walk(join(REPO_ROOT, root))
      for (const f of files) {
        const stats = await stat(f)
        if (stats.size > 5_000_000) continue // skip pathological files
        const text = await readFile(f, 'utf8')
        const lines = withoutKnowledgeSourceTypeEnums(text).split('\n')
        lines.forEach((line, idx) => {
          for (const pat of ALL_BUILTINS_PATTERNS) {
            if (pat.test(line)) {
              const { kind, reason } = classify(f, line)
              allHits.push({
                path: relative(REPO_ROOT, f),
                lineNumber: idx + 1,
                line: line.trim().slice(0, 200),
                classification: kind,
                reason,
              })
              break
            }
          }
        })
      }
    }

    const unclassified = allHits.filter((h) => h.classification === 'unclassified')

    if (unclassified.length > 0) {
      const msg = [
        '',
        'Drift Sweep — "all built-ins" hardcoded-Set audit found unclassified hits.',
        '',
        'Per docs/architecture/integrations/mcp.md → "Drift sweep — \'all built-ins\' lists",',
        'each hit must be either:',
        '  - provider-family-narrow (GOOGLE_CONNECTORS / PAT_CONNECTORS / CONFIGURABLE_CONNECTORS, or a',
        '    `// drift-sweep: intentionally-narrow:<reason>` comment on the line), or',
        '  - derived from OFFICIAL_CONNECTORS (same line references the registry), or',
        '  - allowlisted as a known follow-up (PLANNED_FOLLOWUP_ALLOWLIST or',
        '    `// drift-sweep: planned-followup:<id>` comment).',
        '',
        ...unclassified.map((h) => `  ${h.path}:${h.lineNumber}  ${h.line}`),
        '',
      ].join('\n')
      throw new Error(msg)
    }

    // Sanity: the audit found *something* (otherwise the grep is broken).
    expect(allHits.length).toBeGreaterThan(0)
  })
})
