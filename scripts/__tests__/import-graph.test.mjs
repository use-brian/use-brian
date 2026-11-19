/** [COMP:invariants/chat-import-graph] Static import-graph harness over a fixture workspace graph. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  closureReport, createWorkspace, expandFileset, fingerprint, globToRegExp, resolveExports, sortedJson, staticReport,
} from '../testing/import-graph.mjs'

const SCRIPT = fileURLToPath(new URL('../testing/import-graph.mjs', import.meta.url))
const pkg = (name, extra = {}) => JSON.stringify({ name, type: 'module', ...extra })
const tsconfig = JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } })
const EXPORTS = { './package.json': './package.json', './*.js': { types: './dist/*.d.ts', default: './dist/*.js' } }

const CONFIG = {
  defaultEntrySet: 'chat',
  entrySets: { chat: ['packages/api/src/turn/kernel.ts'], missing: ['packages/api/src/turn/gone.ts'] },
  forbidden: { files: [{ glob: 'packages/core/src/office/**' }], npm: ['sharp', 'pdfjs-dist'] },
  allow: [],
  closure: { allow: [] },
  categories: { core: ['packages/core/src/**'], office: ['packages/core/src/office/**'] },
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'import-graph-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

const GRAPH = {
  'package.json': pkg('fixture'),
  'scripts/testing/import-graph.config.json': JSON.stringify(CONFIG),
  'packages/core/package.json': pkg('@use-brian/core', { main: './dist/index.js', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, ...EXPORTS, './dist/*': './dist/*' } }),
  'packages/core/tsconfig.json': tsconfig,
  // Aggregate barrel: three re-exports, one of them heavy.
  'packages/core/src/index.ts': "export * from './engine/loop.js'\nexport * from './office/render.js'\nexport { helper } from './util.js'\n",
  // Type-only import of an office module must be elided at runtime.
  'packages/core/src/engine/loop.ts': "import type { Doc } from '../office/types.js'\nimport { helper } from '../util.js'\nexport const loop = (d: Doc) => helper(d)\n",
  'packages/core/src/office/types.ts': 'export interface Doc { id: string }\n',
  'packages/core/src/office/render.ts': "import sharp from 'sharp'\nimport { readFileSync } from 'node:fs'\nexport const render = () => [sharp, readFileSync]\n",
  // Unused value import is elided by transpileModule as well.
  'packages/core/src/util.ts': "import { render } from './office/render.js'\nexport const helper = (x: unknown) => x\n",
  'packages/api/package.json': pkg('@use-brian/api', { exports: EXPORTS }),
  'packages/api/tsconfig.json': tsconfig,
  'packages/api/src/turn/kernel.ts': [
    "import { loop } from '@use-brian/core/engine/loop.js'",
    "import { thing } from './mid.js'",
    "import { nope } from '@use-brian/api/not-exported'",
    'const name = String(Date.now())',
    "export const k = () => [loop, thing, nope, import('./lazy.js'), import(name)]",
    '',
  ].join('\n'),
  'packages/api/src/turn/mid.ts': "import { render } from '@use-brian/core'\nexport const thing = render\n",
  'packages/api/src/turn/lazy.ts': "import 'pdfjs-dist'\nexport {}\n",
}

function report(root, config = CONFIG) {
  const ws = createWorkspace({ ossRoot: root })
  return staticReport({ ws, config, entries: config.entrySets.chat, provenance: false })
}

test('[COMP:invariants/chat-import-graph] elides type-only and unused imports and does not follow import()', () => {
  const r = report(fixture(GRAPH)).entries['packages/api/src/turn/kernel.ts']
  assert.deepEqual(r.files, [
    'packages/api/src/turn/kernel.ts',
    'packages/api/src/turn/mid.ts',
    'packages/core/src/engine/loop.ts',
    'packages/core/src/index.ts',
    'packages/core/src/office/render.ts',
    'packages/core/src/util.ts',
  ])
  assert.ok(!r.files.includes('packages/core/src/office/types.ts'), 'type-only import elided')
  assert.ok(!r.files.includes('packages/api/src/turn/lazy.ts'), 'literal import() is recorded, not followed')
  assert.deepEqual(r.dynamicImports, [{ from: 'packages/api/src/turn/kernel.ts', specifier: './lazy.js', to: 'packages/api/src/turn/lazy.ts' }])
  assert.deepEqual(r.unresolvedDynamicImports, [{ from: 'packages/api/src/turn/kernel.ts', expression: 'name' }])
  assert.deepEqual(r.unresolved, [{ from: 'packages/api/src/turn/kernel.ts', specifier: '@use-brian/api/not-exported', reason: 'not-exported', kind: 'static' }])
  assert.deepEqual(r.npmPackages, ['sharp'], 'builtins are not npm packages; dynamic-only pdfjs-dist is not static')
  assert.deepEqual(r.categories, { core: 4, office: 1 })
})

test('[COMP:invariants/chat-import-graph] reports forbidden hits with the shortest chain, frontier edges and barrels', () => {
  const r = report(fixture(GRAPH)).entries['packages/api/src/turn/kernel.ts']
  assert.deepEqual(r.forbidden.files, [{
    file: 'packages/core/src/office/render.ts',
    rule: 'packages/core/src/office/**',
    chain: ['packages/api/src/turn/kernel.ts', 'packages/api/src/turn/mid.ts', 'packages/core/src/index.ts', 'packages/core/src/office/render.ts'],
  }])
  assert.deepEqual(r.forbidden.npm, [{
    package: 'sharp',
    importer: 'packages/core/src/office/render.ts',
    chain: ['packages/api/src/turn/kernel.ts', 'packages/api/src/turn/mid.ts', 'packages/core/src/index.ts', 'packages/core/src/office/render.ts', 'npm:sharp'],
  }])
  assert.deepEqual(r.frontierEdges, [{ from: 'packages/core/src/index.ts', to: 'packages/core/src/office/render.ts' }])
  assert.deepEqual(r.barrels, [{ file: 'packages/core/src/index.ts', fanOut: 3, reexports: 3 }])
})

test('[COMP:invariants/chat-import-graph] an allowlisted contract file is not a hit but its own imports still are', () => {
  const config = { ...CONFIG, allow: [{ path: 'packages/core/src/office/render.ts', reason: 'fixture contract' }] }
  const r = report(fixture(GRAPH), config)
  const entry = r.entries['packages/api/src/turn/kernel.ts']
  assert.deepEqual(entry.forbidden.files, [])
  assert.deepEqual(entry.allowed, [{ file: 'packages/core/src/office/render.ts', reason: 'fixture contract' }])
  assert.deepEqual(entry.forbidden.npm.map((h) => h.package), ['sharp'])
  assert.equal(r.summary.pass, false)
})

test('[COMP:invariants/chat-import-graph] CLI exits non-zero on a forbidden hit and on a missing entry', () => {
  const root = fixture(GRAPH)
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--oss-root', root, '--no-platform', '--no-provenance', ...args], { encoding: 'utf8' })
  const hit = run()
  assert.equal(hit.status, 1, hit.stderr)
  const parsed = JSON.parse(hit.stdout)
  assert.equal(parsed.summary.forbiddenHits, 2)
  assert.equal(run('--report-only').status, 0)
  assert.equal(run('--entry-set', 'missing').status, 2)
  const clean = fixture({ ...GRAPH, 'packages/api/src/turn/mid.ts': 'export const thing = 1\n' })
  const pass = spawnSync(process.execPath, [SCRIPT, '--oss-root', clean, '--no-platform', '--no-provenance'], { encoding: 'utf8' })
  assert.equal(pass.status, 0, pass.stderr)
  assert.equal(JSON.parse(pass.stdout).summary.pass, true)
})

test('[COMP:invariants/chat-import-graph] closure mode is type-inclusive and reports escapes', () => {
  const root = fixture(GRAPH)
  const ws = createWorkspace({ ossRoot: root })
  const engine = closureReport({ ws, fileset: expandFileset(ws, 'packages/core/src/engine/**'), forbiddenNpm: ['sharp'] })
  assert.equal(engine.inside, false)
  assert.deepEqual(engine.escapes.map((e) => [e.to, e.kind]), [
    ['packages/core/src/office/types.ts', 'type'],
    ['packages/core/src/util.ts', 'static'],
  ])
  const allowed = closureReport({ ws, fileset: expandFileset(ws, 'packages/core/src/{engine,office}/**,packages/core/src/util.ts'), forbiddenNpm: ['sharp'] })
  assert.deepEqual(allowed.escapes, [])
  assert.deepEqual(allowed.forbiddenNpm, ['sharp'])
  assert.equal(allowed.inside, false)
  const leaf = closureReport({ ws, fileset: expandFileset(ws, 'packages/core/src/office/types.ts') })
  assert.equal(leaf.inside, true)
  const cli = spawnSync(process.execPath, [SCRIPT, '--oss-root', root, '--no-platform', '--closure', 'packages/core/src/engine/**', '--allow', 'packages/core/src/{util.ts,office/**}'], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).inside, true)
})

test('[COMP:invariants/chat-import-graph] exports patterns, globs, fingerprints and sorted JSON are deterministic', () => {
  const exportsField = { '.': './dist/index.js', './*.js': { types: './dist/*.d.ts', default: './dist/*.js' }, './dist/*': './dist/*' }
  assert.equal(resolveExports(exportsField, './views/blocks.js').target, './dist/views/blocks.js')
  assert.equal(resolveExports(exportsField, './dist/views/blocks.js').target, './dist/views/blocks.js', 'longest prefix wins')
  assert.equal(resolveExports(exportsField, './views/blocks').found, false)
  assert.ok(globToRegExp('packages/core/src/{office,crm}/**').test('packages/core/src/crm/a/b.ts'))
  assert.ok(!globToRegExp('packages/core/src/files/{pdf-*,xlsx}.ts').test('packages/core/src/files/types.ts'))
  const root = fixture(GRAPH)
  const before = fingerprint(join(root, 'packages/core/src'))
  assert.equal(fingerprint(join(root, 'packages/core/src')), before)
  writeFileSync(join(root, 'packages/core/src/util.ts'), 'export const helper = 1\n')
  assert.notEqual(fingerprint(join(root, 'packages/core/src')), before)
  assert.equal(sortedJson({ b: 1, a: { d: 1, c: 2 } }), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n')
})
