/**
 * [COMP:api/boot-lazy] Boot composition: the eager boot graph excludes the
 * heavy implementation packages (M4 step 5, D13).
 *
 * The static import-graph harness (`use-brian/scripts/testing/import-graph.mjs`:
 * type-only imports elided as `dist` elides them, literal `import()` recorded
 * but not followed) gives exactly what loads at module evaluation. Asserted:
 *
 * - boot-wide: neither `boot.ts` nor the OSS entry statically reaches a
 *   heavy package, except the ones listed in `REMAINING` with their reason;
 *   a listed package that is no longer reached fails too, so the list stays
 *   exact;
 * - per tool step: none of the six tool-construction steps reaches one;
 * - every lazily loaded implementation is a dynamic edge of its seam;
 * - the synchronous first-use loaders (`createRequire`, for packages whose
 *   callers are synchronous) are only called inside a function, never at
 *   module evaluation (the harness cannot see them, so this is checked on the
 *   syntax tree).
 *
 * Spec: docs/architecture/platform/deployment.md -> "Boot composition" ->
 * "Lazy tool implementations". Receipt:
 * docs/plans/evidence/oss-chat-replacement/canonical-publication/m4-lazy-tool-implementations.md.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const OSS_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const HARNESS = new URL('../../../../../scripts/testing/import-graph.mjs', import.meta.url).href

/** Heavy implementation packages that must not load at boot. */
const HEAVY = [
  '@cantoo/pdf-lib', 'docx', 'linkedom', 'pptxgenjs', 'exceljs', 'sharp', 'imapflow', 'mailparser', 'nodemailer',
  'pdfjs-dist', 'unpdf', 'jszip', 'turndown', 'e2b', '@napi-rs/canvas', 'culori', '@tiptap/core',
] as const

/**
 * Heavy packages the boot graph still loads, each with its reason. Exact: a
 * package listed here that boot no longer reaches fails the test.
 */
const REMAINING: Record<string, string> = {
  '@tiptap/core':
    'the document model (@use-brian/doc-model schema.ts) builds its editor schema from tiptap extensions at module '
    + 'evaluation and exports them; it is the document contract shared with the browser editor, and the Feed, briefs, '
    + 'content-planning and doc auto-title modules that boot steps construct import it. Not a tool implementation.',
}

const STEPS = ['tools', 'office-tools', 'primitives', 'files', 'computer-use', 'workflow'] as const
const STEP = (name: string) => `packages/api/src/boot/${name}.register.ts`
const ENTRIES = ['packages/api/src/boot.ts', 'apps/api/src/index.ts'] as const

/** Implementations now loaded on first use: from -> to (OSS-relative), checked in `entry`'s graph. */
const LAZY_EDGES: ReadonlyArray<{ entry: string; from: string; to: string }> = [
  { entry: STEP('computer-use'), from: STEP('computer-use'), to: 'packages/core/src/sandbox/providers/e2b/runtime.ts' },
  { entry: STEP('computer-use'), from: 'packages/core/src/sandbox/tools.ts', to: 'packages/core/src/files/pdf-text.ts' },
  { entry: STEP('office-tools'), from: 'packages/core/src/office/tools.ts', to: 'packages/core/src/office/templates/compiler.ts' },
  { entry: STEP('office-tools'), from: 'packages/api/src/office/service.ts', to: 'packages/api/src/routes/office-releases.ts' },
  { entry: STEP('files'), from: STEP('files'), to: 'packages/api/src/files/ingest-file.ts' },
  { entry: STEP('files'), from: STEP('files'), to: 'packages/core/src/files/distill.ts' },
  { entry: STEP('files'), from: 'packages/core/src/workspace-files/render-pdf.ts', to: 'packages/core/src/doc/convert/to-pdf.ts' },
  // The provider module's own closure: mailbox-api.ts is light now (its clients load lazily) and other modules import it.
  { entry: 'packages/api/src/mcp/providers/mailbox.ts', from: 'packages/api/src/mcp/providers/mailbox.ts', to: 'packages/api/src/mailbox/mailbox-api.ts' },
  { entry: ENTRIES[0], from: 'packages/core/src/files/parsers.ts', to: 'packages/core/src/files/html.ts' },
]

type Analysis = {
  missing?: boolean
  files: string[]
  npmPackages: string[]
  dynamicImports: Array<{ from: string; specifier: string; to?: string; npm?: boolean }>
}

const analyses = new Map<string, Analysis>()

beforeAll(async () => {
  const harness = await import(/* @vite-ignore */ HARNESS) as {
    createWorkspace(options: { ossRoot: string }): unknown
    createGraph(ws: unknown): unknown
    loadConfig(): { config: unknown }
    analyzeEntry(ws: unknown, graph: unknown, entry: string, config: unknown): Analysis
  }
  const ws = harness.createWorkspace({ ossRoot: OSS_ROOT })
  const graph = harness.createGraph(ws)
  const { config } = harness.loadConfig()
  for (const entry of new Set([...ENTRIES, ...STEPS.map(STEP), ...LAZY_EDGES.map((edge) => edge.entry)])) {
    analyses.set(entry, harness.analyzeEntry(ws, graph, entry, config))
  }
}, 180_000)

describe('[COMP:api/boot-lazy] the eager boot graph excludes the heavy implementation packages', () => {
  for (const entry of ENTRIES) {
    it(`${entry}: reaches no heavy package except the listed remainder`, () => {
      const analysis = analyses.get(entry)!
      expect(analysis.missing).toBeFalsy()
      const reached = HEAVY.filter((name) => analysis.npmPackages.includes(name))
      expect(reached, `${entry} statically reaches ${reached.join(', ')}`).toEqual(Object.keys(REMAINING).sort())
    })
  }

  for (const step of STEPS) {
    it(`${step}: reaches none of the heavy packages except the listed remainder`, () => {
      const analysis = analyses.get(STEP(step))!
      expect(analysis.missing).toBeFalsy()
      const loaded = HEAVY.filter((name) => analysis.npmPackages.includes(name) && !(name in REMAINING))
      expect(loaded, `${step} statically reaches ${loaded.join(', ')}`).toEqual([])
    })
  }

  it('the tool step no longer loads the chat route module', () => {
    expect(analyses.get(STEP('tools'))!.files).not.toContain('packages/api/src/routes/chat.ts')
  })

  it('every lazily loaded implementation is a dynamic edge of its seam (loads on first use, not at boot)', () => {
    for (const edge of LAZY_EDGES) {
      const analysis = analyses.get(edge.entry)!
      expect(analysis.files, `${edge.from} must stay in the eager graph`).toContain(edge.from)
      expect(analysis.files, `${edge.to} is eager again`).not.toContain(edge.to)
      expect(analysis.dynamicImports, `${edge.from} -> ${edge.to}`).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: edge.from, to: edge.to })]),
      )
    }
  })

  it('synchronous first-use loaders of heavy packages run only inside a function', () => {
    const ts = createRequire(join(OSS_ROOT, 'package.json'))('typescript') as typeof import('typescript')
    const heavy = (spec: string) => HEAVY.some((name) => spec === name || spec.startsWith(`${name}/`))
    const offenders: string[] = []
    let sites = 0
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') return []
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : []
    })
    for (const root of ['packages/core/src', 'packages/api/src', 'packages/agent-runtime/src']) {
      for (const file of walk(join(OSS_ROOT, root))) {
        const text = readFileSync(file, 'utf8')
        if (!text.includes('createRequire')) continue
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
        const visit = (node: import('typescript').Node) => {
          if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword
            && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!) && heavy(node.arguments[0]!.text)) {
            sites++
            let inside = false
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (ts.isFunctionLike(parent)) { inside = true; break }
            }
            if (!inside) offenders.push(`${relative(OSS_ROOT, file)}: ${node.getText(source).slice(0, 80)}`)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    expect(sites).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
