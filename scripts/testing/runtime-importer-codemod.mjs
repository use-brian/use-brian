#!/usr/bin/env node
/**
 * Importer codemod for the M4 runtime move
 * (docs/plans/oss-chat-m4-runtime-separation-plan.md, steps 4 and 7).
 *
 * Step 3 moved 73 files from packages/core/src to packages/agent-runtime/src
 * and left a one-line `export *` forwarding shim at each old path. Step 7
 * deletes the shims and the `@use-brian/core` root barrel once nothing
 * imports them. This script rewrites importers so they name
 * `@use-brian/agent-runtime/<path>.js` directly. It is idempotent: a second
 * run over the same tree finds nothing to change, so it can be re-run for
 * files that land late.
 *
 * Modes (dry run unless --write; paths are OSS-relative, platform paths carry
 * a `plat:` prefix; `--root` and `--exclude` take globs and may repeat):
 *
 *   core-relative   In packages/core/{src,scripts}: every relative specifier
 *                   that resolves to a shim (static import/export-from,
 *                   import(), import('x') type queries, declare module,
 *                   require, vi.mock/doMock/unmock/doUnmock/importActual/
 *                   importMock) becomes the runtime subpath. Shims are skipped.
 *   deep            In --root files: `@use-brian/core/<shim>.js`,
 *                   `@use-brian/core/dist/<shim>.js` and relative paths into a
 *                   core shim become the runtime subpath.
 *   root-barrel     In --root files: named imports/re-exports of moved symbols
 *                   from '@use-brian/core' move to the runtime module that
 *                   declares them (non-moved names stay on core; statements
 *                   are split), and `import('@use-brian/core').Name` type
 *                   queries of moved names are retargeted. Namespace, default,
 *                   `export *`, whole-module `typeof import(...)` and
 *                   vi.mock('@use-brian/core') factories are reported, never
 *                   rewritten (see `rootMocks` in the report).
 *   root-subpath    Step 7.2, in --root files: EVERY named import/re-export,
 *                   type query and destructured dynamic import of
 *                   '@use-brian/core' moves to the file that declares the name:
 *                   `@use-brian/agent-runtime/<path>.js` for moved names,
 *                   `@use-brian/core/<path>.js` otherwise (a name core
 *                   re-exports from another package maps to the core file
 *                   that re-exports it). `@use-brian/core/dist/<p>.js` becomes
 *                   `@use-brian/core/<p>.js` (runtime subpath for a shim).
 *                   Reported, never rewritten: namespace/default/`export *`
 *                   imports, whole-module type queries, root-declared or
 *                   ambiguous names and vi.mock('@use-brian/core') factories.
 *   tidy            Re-render named `@use-brian/agent-runtime/*` statements in
 *                   --files-from batch receipts (or --root files) in the
 *                   root-barrel form: `import type` for all-type groups, one
 *                   line when it fits.
 *   verify          Report every remaining edge into a shim path, by file,
 *                   across --root (default: both trees' source). With
 *                   --core-root also every '@use-brian/core' root reference
 *                   and `@use-brian/core/dist/*` specifier (the population
 *                   that blocks deleting core's ".", "./dist/*", main, types).
 *   self-test       Fixture-only checks of the resolver and the rewrites.
 *
 *   node scripts/testing/runtime-importer-codemod.mjs core-relative --write
 *   node scripts/testing/runtime-importer-codemod.mjs deep --root 'apps/doc-sync/src/**' --write
 *   node scripts/testing/runtime-importer-codemod.mjs root-barrel --root 'packages/api/src/**' \
 *     --exclude 'packages/api/src/{turn,routes,inter-assistant,mcp,db}/**' --exclude packages/api/src/boot.ts --write
 *   node scripts/testing/runtime-importer-codemod.mjs root-subpath --root 'apps/api/src/**' --write
 *   node scripts/testing/runtime-importer-codemod.mjs verify --json /tmp/remaining.json
 *   node scripts/testing/runtime-importer-codemod.mjs verify --core-root --json /tmp/root.json
 *
 * Exit codes: 0 done (or nothing to do), 1 verify found edges, 2 usage.
 *
 * [COMP:engine/agent-runtime]
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkspace, expandFileset, loadTypeScript, matcher, resolveSpecifier } from './import-graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OSS_ROOT = resolve(HERE, '../..')
const CORE_SRC = 'packages/core/src/'
const RUNTIME_SRC = 'packages/agent-runtime/src/'
const RUNTIME_PKG = '@use-brian/agent-runtime'
const CORE_PKG = '@use-brian/core'
const CODE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/
const MOCK_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'])

/**
 * Files the rewrite modes leave alone, each with the reason and the owner
 * action that releases it. `verify` still reports their edges, so step 7
 * (shim deletion) cannot pass while an entry remains.
 */
export const HOLD = new Map([
  // Empty. packages/core/src/workers/turn-routing.ts was released in the M4
  // boot-split session: its [COMP:core/turn-routing] neutrality test now admits
  // type-only `@use-brian/agent-runtime/` specifiers and core-relative rewrote
  // its one shim edge.
])

// ── Shim set ────────────────────────────────────────────────────────────

/** The 73 runtime files (runtime-file-set.txt) and the core shim path of each.
 * A shim must be exactly the one-line `export *` of its runtime path. */
export function loadShims(ws, ossRoot) {
  const members = expandFileset(ws, '@scripts/testing/runtime-file-set.txt', ossRoot).files
    .filter((id) => !/(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(id))
  const byCoreId = new Map()
  for (const id of members) {
    const rel = id.slice(RUNTIME_SRC.length)
    const coreId = CORE_SRC + rel
    const spec = `${RUNTIME_PKG}/${rel.replace(/\.tsx?$/, '.js')}`
    const abs = ws.absOf(coreId)
    const present = existsSync(abs)
    if (present) {
      const body = readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))
      if (body.length !== 1 || body[0].trim() !== `export * from '${spec}'`) throw new Error(`${coreId} is not the forwarding shim of ${id}`)
    }
    byCoreId.set(coreId, { coreId, runtimeId: id, spec, present })
  }
  return byCoreId
}

export function runtimeSpecOf(runtimeId) {
  return `${RUNTIME_PKG}/${runtimeId.slice(RUNTIME_SRC.length).replace(/\.tsx?$/, '.js')}`
}

// ── File walking and edits ──────────────────────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile() && CODE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(p)
  }
  return out
}

/** Files under the static prefix of each root glob, filtered by the globs. */
function filesFor(ws, roots, excludes) {
  const include = matcher(roots)
  const exclude = matcher(excludes)
  const out = new Set()
  for (const glob of roots) {
    const prefix = glob.split('/').filter((_, i, a) => !/[*?{]/.test(a.slice(0, i + 1).join('/'))).join('/')
    const base = ws.absOf(prefix)
    const list = existsSync(base) && !CODE.test(base) ? walk(base) : [base]
    for (const abs of list) {
      const id = ws.idOf(abs)
      if (id && include(id) && !exclude(id)) out.add(abs)
    }
  }
  return [...out].sort()
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  for (let i = 1; i < sorted.length; i++) if (sorted[i].end > sorted[i - 1].start) throw new Error('overlapping edits')
  let out = text
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

function scriptKind(ts, file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

/** Every module-specifier string literal in a source file, with its role. */
export function specifierLiterals(ts, sf) {
  const out = []
  const add = (lit, role) => { if (lit && (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))) out.push({ lit, role }) }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, 'import')
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, 'export')
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, 'import-equals')
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) add(node.name, 'declare-module')
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, 'type-query')
    else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'dynamic')
      else if (ts.isIdentifier(callee) && callee.text === 'require') add(node.arguments[0], 'require')
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi' && MOCK_CALLS.has(callee.name.text)) add(node.arguments[0], `vi.${callee.name.text}`)
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'resolve') add(node.arguments[0], 'require.resolve')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function literalEdit(sf, lit, value) {
  const raw = lit.getText(sf)
  const q = raw[0]
  return { start: lit.getStart(sf), end: lit.end, text: `${q}${value}${q}` }
}

// ── Specifier mode (core-relative, deep) ────────────────────────────────

/** Map one specifier to its runtime subpath when it reaches a shim. */
function shimTarget(ws, shims, fromAbs, spec, { allowPackage }) {
  if (spec.startsWith('.')) {
    const r = resolveSpecifier(ws, fromAbs, spec)
    if (r.kind !== 'file') return null
    const hit = shims.get(ws.idOf(r.abs))
    return hit ? hit.spec : null
  }
  if (!allowPackage) return null
  const m = spec.match(/^@use-brian\/core\/(?:dist\/)?(.+)\.js$/)
  if (!m) return null
  const hit = shims.get(`${CORE_SRC}${m[1]}.ts`) ?? shims.get(`${CORE_SRC}${m[1]}.tsx`)
  return hit ? hit.spec : null
}

export function rewriteSpecifiers({ ws, shims, files, allowPackage, write, ts }) {
  const changed = []
  for (const abs of files) {
    const id = ws.idOf(abs)
    if (shims.has(id) || HOLD.has(id)) continue
    const text = readFileSync(abs, 'utf8')
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(ts, abs))
    const edits = []
    const roles = {}
    for (const { lit, role } of specifierLiterals(ts, sf)) {
      const target = shimTarget(ws, shims, abs, lit.text, { allowPackage })
      if (!target) continue
      edits.push(literalEdit(sf, lit, target))
      roles[role] = (roles[role] ?? 0) + 1
    }
    if (edits.length === 0) continue
    if (write) writeFileSync(abs, applyEdits(text, edits))
    changed.push({ file: id, edges: edits.length, roles })
  }
  return changed
}

// ── Export resolver (root-barrel mode) ──────────────────────────────────

/**
 * Resolve every name a module exports to where it is declared.
 * Result per name: {kind:'runtime', id, name} (declared in agent-runtime),
 * {kind:'local', id, name} (declared in core or elsewhere; `name` is the
 * name that module exports it under), {kind:'ambiguous'} or
 * {kind:'unknown'} (behind an npm `export *`). Shims forward to the runtime
 * file; runtime barrels are followed to the declaring module, so importers
 * get file-level subpaths, not barrels.
 *
 * `boundary(id)` (optional) marks modules whose names are attributed to the
 * file that re-exports them: a core file re-exporting `@use-brian/shared`
 * or an npm package is the subpath an importer of core can name.
 */
export function createExportResolver(ws, shims, ts = loadTypeScript(), { boundary } = {}) {
  const memo = new Map()
  const inProgress = new Set()
  function exportsOf(abs) {
    if (memo.has(abs)) return memo.get(abs)
    if (inProgress.has(abs)) return new Map()
    inProgress.add(abs)
    const result = compute(abs)
    inProgress.delete(abs)
    memo.set(abs, result)
    return result
  }
  function target(fromAbs, spec) {
    const r = resolveSpecifier(ws, fromAbs, spec)
    return r.kind === 'file' ? r.abs : null
  }
  function compute(abs) {
    const id = ws.idOf(abs) ?? abs
    const shim = shims.get(id)
    if (shim) return exportsOf(ws.absOf(shim.runtimeId))
    const isRuntime = id.startsWith(RUNTIME_SRC)
    const local = (name) => (isRuntime ? { kind: 'runtime', id, name } : { kind: 'local', id, name })
    // A re-export across the boundary resolves to this file, under the name it exports.
    const crossed = (fromAbs) => Boolean(boundary) && (!fromAbs || boundary(ws.idOf(fromAbs) ?? fromAbs))
    const via = (fromAbs, res, exported) => (crossed(fromAbs) && res.kind !== 'runtime' ? local(exported) : res)
    const text = readFileSync(abs, 'utf8')
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(ts, abs))
    const explicit = new Map()
    const imports = new Map() // local binding → {abs, name} | {namespace}
    const stars = []
    const hasExport = (st) => st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    const bindingNames = (b, out = []) => {
      if (ts.isIdentifier(b)) out.push(b.text)
      else for (const el of b.elements ?? []) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out)
      return out
    }
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
        const t = target(abs, st.moduleSpecifier.text)
        const c = st.importClause
        if (c.name) imports.set(c.name.text, { abs: t, name: 'default' })
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { namespace: true })
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) imports.set(el.name.text, { abs: t, name: (el.propertyName ?? el.name).text })
        }
      }
    }
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st)) {
        const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? target(abs, st.moduleSpecifier.text) : null
        if (!st.exportClause) {
          if (st.moduleSpecifier) stars.push(from)
          continue
        }
        if (ts.isNamespaceExport(st.exportClause)) { explicit.set(st.exportClause.name.text, local(st.exportClause.name.text)); continue }
        for (const el of st.exportClause.elements) {
          const exported = el.name.text
          const orig = (el.propertyName ?? el.name).text
          if (st.moduleSpecifier) {
            explicit.set(exported, via(from, from ? (exportsOf(from).get(orig) ?? { kind: 'unknown' }) : { kind: 'unknown' }, exported))
          } else {
            const imp = imports.get(orig)
            if (imp?.namespace) explicit.set(exported, local(exported))
            else if (imp) explicit.set(exported, via(imp.abs, imp.abs ? (exportsOf(imp.abs).get(imp.name) ?? { kind: 'unknown' }) : { kind: 'unknown' }, exported))
            else explicit.set(exported, local(exported))
          }
        }
      } else if (ts.isExportAssignment(st)) {
        explicit.set('default', local('default'))
      } else if (hasExport(st)) {
        const isDefault = st.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        if (isDefault) { explicit.set('default', local('default')); continue }
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) for (const n of bindingNames(d.name)) explicit.set(n, local(n))
        else if (st.name && ts.isIdentifier(st.name)) explicit.set(st.name.text, local(st.name.text))
      }
    }
    const out = new Map(explicit)
    const starSeen = new Map()
    for (const from of stars) {
      if (!from) { out.set('*unknown*', { kind: 'unknown' }); continue }
      for (const [name, found] of exportsOf(from)) {
        if (name === 'default' || explicit.has(name)) continue
        const res = name === '*unknown*' ? found : via(from, found, name)
        const prev = starSeen.get(name)
        if (!prev) { starSeen.set(name, res); out.set(name, res); continue }
        if (!sameResolution(prev, res)) out.set(name, { kind: 'ambiguous' })
      }
    }
    return out
  }
  return { exportsOf }
}

function sameResolution(a, b) {
  return a.kind === b.kind && a.id === b.id && a.name === b.name
}

/** name → {module, name} for every moved name of the core root barrel. */
export function movedRootSymbols(ws, shims, ts) {
  // After the final cut there is no root: no name can come from it, and
  // `verify --core-root` reports any remaining '@use-brian/core' specifier.
  if (!existsSync(ws.absOf(`${CORE_SRC}index.ts`))) return { moved: new Map(), kept: new Map(), unknownStar: false }
  const resolver = createExportResolver(ws, shims, ts)
  const root = resolver.exportsOf(ws.absOf(`${CORE_SRC}index.ts`))
  const moved = new Map()
  const kept = new Map()
  for (const [name, res] of root) {
    if (name === '*unknown*') continue
    if (res.kind === 'runtime') moved.set(name, { module: runtimeSpecOf(res.id), name: res.name })
    else kept.set(name, res.kind)
  }
  return { moved, kept, unknownStar: root.has('*unknown*') }
}

/** `@use-brian/core/<path>.js` for a core source id. */
export function coreSpecOf(coreId) {
  return `${CORE_PKG}/${coreId.slice(CORE_SRC.length).replace(/\.tsx?$/, '.js')}`
}

const outsideCore = (id) => !id.startsWith(CORE_SRC) && !id.startsWith(RUNTIME_SRC)

/**
 * name → {module, name} for EVERY name of the core root barrel (step 7.2):
 * moved names go to their declaring runtime file, core names to their
 * declaring core file as `@use-brian/core/<path>.js`. A name core re-exports
 * from another package (`@use-brian/shared`, an npm package) resolves to the
 * core file that re-exports it, so importers keep their core dependency.
 * Names that cannot be named by a file subpath (declared in the root barrel
 * itself, ambiguous or behind an unenumerable `export *`) are `unresolved`
 * and stay on the root.
 */
export function rootSubpathSymbols(ws, shims, ts) {
  const resolver = createExportResolver(ws, shims, ts, { boundary: outsideCore })
  const rootId = `${CORE_SRC}index.ts`
  if (!existsSync(ws.absOf(rootId))) return { map: new Map(), unresolved: new Map(), unknownStar: false }
  const root = resolver.exportsOf(ws.absOf(rootId))
  const map = new Map()
  const unresolved = new Map()
  for (const [name, res] of root) {
    if (name === '*unknown*') continue
    if (res.kind === 'runtime') map.set(name, { module: runtimeSpecOf(res.id), name: res.name })
    else if (res.kind === 'local' && res.id !== rootId && res.id.startsWith(CORE_SRC) && /\.tsx?$/.test(res.id) && !/\.d\.ts$/.test(res.id)) {
      map.set(name, { module: coreSpecOf(res.id), name: res.name })
    } else unresolved.set(name, res.kind === 'local' ? `local:${res.id}` : res.kind)
  }
  return { map, unresolved, unknownStar: root.has('*unknown*') }
}

/** `@use-brian/core/dist/<p>.js` → the runtime subpath (shim) or `@use-brian/core/<p>.js`. */
function distTarget(ws, shims, spec) {
  const m = spec.match(/^@use-brian\/core\/dist\/(.+)\.js$/)
  if (!m) return null
  const hit = shims.get(`${CORE_SRC}${m[1]}.ts`) ?? shims.get(`${CORE_SRC}${m[1]}.tsx`)
  if (hit) return hit.spec
  return existsSync(ws.absOf(`${CORE_SRC}${m[1]}.ts`)) || existsSync(ws.absOf(`${CORE_SRC}${m[1]}.tsx`)) ? `${CORE_PKG}/${m[1]}.js` : null
}

// ── Root-barrel rewrite ─────────────────────────────────────────────────

function styleOf(text) {
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  const inner = open >= 0 ? text.slice(open + 1, close) : ''
  const multiline = inner.includes('\n')
  const indent = multiline ? (inner.match(/\n([ \t]+)\S/)?.[1] ?? '  ') : ''
  return {
    multiline,
    indent,
    trailingComma: multiline && /,\s*$/.test(inner),
    padded: !multiline && /^\s/.test(inner),
    semicolon: /;\s*$/.test(text),
    quote: text.includes(`"${CORE_PKG}"`) ? '"' : "'",
  }
}

function renderNamed(keyword, typeOnly, specs, module, style) {
  const head = `${keyword}${typeOnly ? ' type' : ''}`
  const q = style.quote
  const semi = style.semicolon ? ';' : ''
  if (style.multiline) {
    const body = specs.map((s) => `${style.indent}${s}`).join(',\n') + (style.trailingComma ? ',' : '')
    return `${head} {\n${body}\n} from ${q}${module}${q}${semi}`
  }
  const pad = style.padded ? ' ' : ''
  return `${head} {${pad}${specs.join(', ')}${pad}} from ${q}${module}${q}${semi}`
}

const LINE = 100

/** A new runtime statement: `import type` when every name is a type, one
 * line when it fits, otherwise the original statement's multi-line style. */
function renderRuntime(keyword, typeOnly, specs, module, style) {
  const allTypes = !typeOnly && specs.every((s) => s.startsWith('type '))
  const names = allTypes ? specs.map((s) => s.slice('type '.length)) : specs
  const flat = renderNamed(keyword, typeOnly || allTypes, names, module, { ...style, multiline: false, padded: style.multiline ? true : style.padded })
  if (flat.length <= LINE || !style.multiline) return flat
  return renderNamed(keyword, typeOnly || allTypes, names, module, style)
}

/** Rewrite one file's root-barrel imports. Returns null when nothing moves. */
export function rewriteRootBarrel(ts, file, text, moved) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file))
  const edits = []
  const notes = { namespace: 0, default: 0, starExport: 0, wholeModuleTypeQuery: 0, dynamic: 0, rootMock: [] }
  let movedSpecifiers = 0
  let statements = 0
  for (const st of sf.statements) {
    const isImport = ts.isImportDeclaration(st)
    const isExport = ts.isExportDeclaration(st)
    if (!isImport && !isExport) continue
    if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== CORE_PKG) continue
    let elements
    let typeOnly
    if (isImport) {
      const c = st.importClause
      if (!c) continue
      if (c.name) { notes.default++; continue }
      if (!c.namedBindings || ts.isNamespaceImport(c.namedBindings)) { notes.namespace++; continue }
      elements = c.namedBindings.elements
      typeOnly = c.isTypeOnly
    } else {
      if (!st.exportClause) { notes.starExport++; continue }
      if (ts.isNamespaceExport(st.exportClause)) { notes.namespace++; continue }
      elements = st.exportClause.elements
      typeOnly = st.isTypeOnly
    }
    const keep = []
    const byModule = new Map()
    for (const el of elements) {
      const orig = (el.propertyName ?? el.name).text
      const hit = moved.get(orig)
      if (!hit) { keep.push(el.getText(sf)); continue }
      const local = el.name.text
      const typeKw = el.isTypeOnly ? 'type ' : ''
      const spec = hit.name === local ? `${typeKw}${local}` : `${typeKw}${hit.name} as ${local}`
      if (!byModule.has(hit.module)) byModule.set(hit.module, [])
      byModule.get(hit.module).push(spec)
      movedSpecifiers++
    }
    if (byModule.size === 0) continue
    statements++
    const original = st.getText(sf)
    const style = styleOf(original)
    const keyword = isImport ? 'import' : 'export'
    const parts = []
    if (keep.length) parts.push(renderNamed(keyword, typeOnly, keep, CORE_PKG, style))
    for (const module of [...byModule.keys()].sort()) parts.push(renderRuntime(keyword, typeOnly, byModule.get(module), module, style))
    edits.push({ start: st.getStart(sf), end: st.end, text: parts.join('\n') })
  }
  // Type queries and calls anywhere in the file.
  const visit = (node) => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) && node.argument.literal.text === CORE_PKG) {
      const q = node.qualifier
      const first = q ? (ts.isIdentifier(q) ? q : leftmost(ts, q)) : null
      if (!first) notes.wholeModuleTypeQuery++
      else {
        const hit = moved.get(first.text)
        if (hit) {
          edits.push(literalEdit(sf, node.argument.literal, hit.module))
          if (hit.name !== first.text) edits.push({ start: first.getStart(sf), end: first.end, text: hit.name })
          movedSpecifiers++
        }
      }
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === CORE_PKG) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        // `const { a, b } = await import('@use-brian/core')`: retarget only
        // when every destructured name is moved to one runtime module.
        const decl = ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent : null
        const names = decl && ts.isObjectBindingPattern(decl.name) && decl.name.elements.every((el) => !el.dotDotDotToken && (el.propertyName ?? el.name) && ts.isIdentifier(el.propertyName ?? el.name))
          ? decl.name.elements.map((el) => (el.propertyName ?? el.name).text) : null
        const hits = names?.map((n) => moved.get(n))
        const modules = new Set(hits?.map((h) => h?.module))
        if (hits && hits.every((h, i) => h && h.name === names[i]) && modules.size === 1) {
          edits.push(literalEdit(sf, node.arguments[0], [...modules][0]))
          movedSpecifiers += names.length
        } else if (hits?.some(Boolean)) notes.dynamic++
      }
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi' && (callee.name.text === 'mock' || callee.name.text === 'doMock')) {
        notes.rootMock.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, overridesMoved: mockFactoryKeys(ts, node).filter((k) => moved.has(k)) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (edits.length === 0) return { text: null, movedSpecifiers: 0, statements: 0, notes }
  return { text: applyEdits(text, edits), movedSpecifiers, statements, notes }
}

function leftmost(ts, q) {
  let cur = q
  while (ts.isQualifiedName(cur)) cur = cur.left
  return ts.isIdentifier(cur) ? cur : null
}

/** Property keys of the object a vi.mock factory returns (best effort). */
function mockFactoryKeys(ts, call) {
  const factory = call.arguments[1]
  if (!factory) return []
  const keys = new Set()
  const collect = (obj) => {
    for (const p of obj.properties) {
      if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.add(p.name.text)
    }
  }
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) collect(n)
    ts.forEachChild(n, visit)
  }
  visit(factory)
  return [...keys].sort()
}

export function rewriteRootBarrelFiles({ ws, files, moved, write, ts }) {
  const changed = []
  const notes = []
  for (const abs of files) {
    const id = ws.idOf(abs)
    if (HOLD.has(id)) continue
    const text = readFileSync(abs, 'utf8')
    if (!text.includes(CORE_PKG)) continue
    const r = rewriteRootBarrel(ts, abs, text, moved)
    const n = r.notes
    if (n.namespace || n.default || n.starExport || n.dynamic || n.rootMock.length) notes.push({ file: id, ...n })
    if (!r.text) continue
    if (write) writeFileSync(abs, r.text)
    changed.push({ file: id, specifiers: r.movedSpecifiers, statements: r.statements })
  }
  return { changed, notes }
}

// ── Root-subpath rewrite (step 7.2) ──────────────────────────────────────

/** Every named import/re-export, type query and destructured dynamic import
 * of '@use-brian/core' moves to the declaring file's subpath (the
 * `rootSubpathSymbols` map), and `@use-brian/core/dist/<p>.js` becomes
 * `@use-brian/core/<p>.js` (or the runtime subpath of a shim). Namespace,
 * default and `export *` imports, whole-module type queries, unresolved names
 * and `vi.mock('@use-brian/core')` factories are reported, never rewritten.
 * Idempotent. */
export function rewriteRootSubpathFiles({ ws, shims, files, map, write, ts }) {
  const changed = []
  const notes = []
  for (const abs of files) {
    const id = ws.idOf(abs)
    if (HOLD.has(id) || shims.has(id)) continue
    const original = readFileSync(abs, 'utf8')
    if (!original.includes(CORE_PKG)) continue
    const r = rewriteRootBarrel(ts, abs, original, map)
    let text = r.text ?? original
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(ts, abs))
    const distEdits = []
    const distUnresolved = []
    for (const { lit } of specifierLiterals(ts, sf)) {
      if (!lit.text.startsWith(`${CORE_PKG}/dist/`)) continue
      const t = distTarget(ws, shims, lit.text)
      if (t) distEdits.push(literalEdit(sf, lit, t))
      else distUnresolved.push(lit.text)
    }
    if (distEdits.length) text = applyEdits(text, distEdits)
    const unresolved = remainingRootNames(ts, abs, text)
    const n = r.notes
    if (n.namespace || n.default || n.starExport || n.wholeModuleTypeQuery || n.dynamic || n.rootMock.length || distUnresolved.length || unresolved.length) {
      notes.push({ file: id, ...n, ...(distUnresolved.length ? { distUnresolved } : {}), ...(unresolved.length ? { unresolvedNames: unresolved } : {}) })
    }
    if (text === original) continue
    if (write) writeFileSync(abs, text)
    changed.push({ file: id, specifiers: r.movedSpecifiers, statements: r.statements, distEdges: distEdits.length })
  }
  return { changed, notes }
}

/** Names still imported or re-exported by name from the core root. */
function remainingRootNames(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file))
  const out = []
  for (const st of sf.statements) {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== CORE_PKG) continue
    const b = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : st.exportClause
    if (b && (ts.isNamedImports(b) || ts.isNamedExports(b))) for (const el of b.elements) out.push((el.propertyName ?? el.name).text)
  }
  return out
}

// ── Tidy (canonical form of runtime statements in already-rewritten files) ──

/** Re-render named import/export statements from `@use-brian/agent-runtime/*`
 * in the given files with the root-barrel renderer (`import type` for
 * all-type groups, one line when it fits). Idempotent. */
export function tidyRuntimeStatements({ ws, files, write, ts }) {
  const changed = []
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8')
    if (!text.includes(RUNTIME_PKG)) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(ts, abs))
    const edits = []
    for (const st of sf.statements) {
      const isImport = ts.isImportDeclaration(st)
      if (!isImport && !ts.isExportDeclaration(st)) continue
      if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith(`${RUNTIME_PKG}/`)) continue
      const bindings = isImport ? st.importClause?.namedBindings : st.exportClause
      if (!bindings || (isImport && (st.importClause.name || !ts.isNamedImports(bindings))) || (!isImport && !ts.isNamedExports(bindings))) continue
      const original = st.getText(sf)
      const typeOnly = isImport ? st.importClause.isTypeOnly : st.isTypeOnly
      const next = renderRuntime(isImport ? 'import' : 'export', typeOnly, bindings.elements.map((el) => el.getText(sf)), st.moduleSpecifier.text, { ...styleOf(original), quote: original.includes(`"${RUNTIME_PKG}`) ? '"' : "'" })
      if (next !== original) edits.push({ start: st.getStart(sf), end: st.end, text: next })
    }
    if (!edits.length) continue
    if (write) writeFileSync(abs, applyEdits(text, edits))
    changed.push({ file: ws.idOf(abs), statements: edits.length })
  }
  return changed
}

// ── Verify ──────────────────────────────────────────────────────────────

/** Every remaining reference to a shim path: relative, deep package or
 * dist subpath, plus root-barrel imports of moved names. With `coreRoot`,
 * also every reference to the core root itself (`core-root`: import,
 * export-from, type query, dynamic import, vi.mock target) and every
 * `@use-brian/core/dist/*` specifier (`core-dist`), the population that
 * blocks deleting core's ".", "./dist/*", main and types (step 7). */
export function verify({ ws, shims, files, moved, ts, coreRoot = false }) {
  const edges = []
  for (const abs of files) {
    const id = ws.idOf(abs)
    if (shims.has(id)) continue
    const text = readFileSync(abs, 'utf8')
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(ts, abs))
    for (const { lit, role } of specifierLiterals(ts, sf)) {
      const t = shimTarget(ws, shims, abs, lit.text, { allowPackage: true })
      if (t) edges.push({ file: id, kind: 'shim-path', role, specifier: lit.text, ...(HOLD.has(id) ? { hold: HOLD.get(id) } : {}) })
      else if (coreRoot && lit.text === CORE_PKG) edges.push({ file: id, kind: 'core-root', role })
      else if (coreRoot && lit.text.startsWith(`${CORE_PKG}/dist/`)) edges.push({ file: id, kind: 'core-dist', role, specifier: lit.text })
    }
    if (moved && text.includes(CORE_PKG)) {
      const r = rewriteRootBarrel(ts, abs, text, moved)
      if (r.movedSpecifiers) edges.push({ file: id, kind: 'root-barrel-moved-symbol', specifiers: r.movedSpecifiers })
    }
  }
  return edges
}

// ── Self-test ───────────────────────────────────────────────────────────

function selfTest(ts) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-codemod-'))
  const put = (rel, body) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body) }
  put('package.json', '{"name":"fixture","type":"module"}')
  put('packages/agent-runtime/package.json', JSON.stringify({ name: RUNTIME_PKG, exports: { './*.js': { types: './dist/*.d.ts', default: './dist/*.js' } } }))
  put('packages/core/package.json', JSON.stringify({ name: CORE_PKG, exports: { '.': './dist/index.js', './*.js': './dist/*.js', './dist/*': './dist/*' } }))
  put('scripts/testing/runtime-file-set.txt', 'packages/agent-runtime/src/engine/a.ts\npackages/agent-runtime/src/engine/index.ts\n')
  put('packages/agent-runtime/src/engine/a.ts', 'export const raw = 1\nexport interface Opt { x: 1 }\nconst inner = 2\nexport { inner as renamed }\n')
  put('packages/agent-runtime/src/engine/index.ts', "export * from './a.js'\n")
  put('packages/core/src/engine/a.ts', `// M4 forwarding shim\nexport * from '${RUNTIME_PKG}/engine/a.js'\n`)
  put('packages/core/src/engine/index.ts', `// M4 forwarding shim\nexport * from '${RUNTIME_PKG}/engine/index.js'\n`)
  put('packages/core/src/engine/composed.ts', "import { raw } from './a.js'\nexport const queryLoop = () => raw\n")
  put('packages/core/src/domain.ts', "export const domainValue = 3\nexport { raw as aliased } from './engine/a.js'\n")
  put('packages/core/src/index.ts', "export * from './engine/index.js'\nexport { queryLoop } from './engine/composed.js'\nexport * from './domain.js'\n")
  put('packages/core/src/user.test.ts', "import { raw } from './engine/a.js'\nimport type { Opt } from \"./engine/index.js\"\nvi.mock('./engine/a.js')\ntype T = typeof import('./engine/a.js')\n")
  put('packages/api/src/x.ts', `import { queryLoop, raw, type Opt, domainValue, aliased as al, renamed } from '${CORE_PKG}'\nimport {\n  raw as r2,\n  domainValue as d2,\n} from '${CORE_PKG}';\nimport { domainValue as d3, type Opt as T2 } from '${CORE_PKG}'\nexport type { Opt as O } from '${CORE_PKG}'\ntype Q = import('${CORE_PKG}').Opt\nvi.mock('${CORE_PKG}', () => ({ raw: 1, queryLoop: 2 }))\nconst { raw: r3 } = await import('${CORE_PKG}')\nconst { raw: r4, domainValue: d4 } = await import('${CORE_PKG}')\n`)
  const ws = createWorkspace({ ossRoot: dir })
  const shims = loadShims(ws, dir)
  const check = (cond, msg) => { if (!cond) throw new Error(`self-test: ${msg}`) }
  check(shims.size === 2, 'two shims')
  const { moved } = movedRootSymbols(ws, shims, ts)
  check(moved.get('raw')?.module === `${RUNTIME_PKG}/engine/a.js`, 'raw resolves through the runtime barrel to its declaring module')
  check(moved.get('renamed')?.name === 'renamed', 'local export alias keeps its exported name')
  check(moved.get('aliased')?.name === 'raw', 'a core rename of a moved name maps back to the runtime name')
  check(!moved.has('queryLoop') && !moved.has('domainValue'), 'core-declared names stay on core')
  const files = [ws.absOf('packages/core/src/user.test.ts')]
  const first = rewriteSpecifiers({ ws, shims, files, allowPackage: false, write: true, ts })
  check(first.length === 1 && first[0].edges === 4, `core-relative rewrites 4 edges (got ${JSON.stringify(first)})`)
  const after = readFileSync(files[0], 'utf8')
  check(after.includes(`vi.mock('${RUNTIME_PKG}/engine/a.js')`) && after.includes(`"${RUNTIME_PKG}/engine/index.js"`), 'mock target and quote style kept')
  check(rewriteSpecifiers({ ws, shims, files, allowPackage: false, write: true, ts }).length === 0, 'core-relative is idempotent')
  const api = ws.absOf('packages/api/src/x.ts')
  const r = rewriteRootBarrelFiles({ ws, files: [api], moved, write: true, ts })
  const out = readFileSync(api, 'utf8')
  check(out.includes(`import { queryLoop, domainValue } from '${CORE_PKG}'\nimport { raw, type Opt, raw as al, renamed } from '${RUNTIME_PKG}/engine/a.js'`), `single-line split:\n${out}`)
  check(out.includes(`import {\n  domainValue as d2,\n} from '${CORE_PKG}';\nimport { raw as r2 } from '${RUNTIME_PKG}/engine/a.js';`), `multi-line split keeps the core statement's style, short runtime statement on one line:\n${out}`)
  check(out.includes(`import type { Opt as T2 } from '${RUNTIME_PKG}/engine/a.js'`), `all-type group becomes import type:\n${out}`)
  check(out.includes(`export type { Opt as O } from '${RUNTIME_PKG}/engine/a.js'`), 'type re-export moves')
  check(out.includes(`import('${RUNTIME_PKG}/engine/a.js').Opt`), 'type query moves')
  check(out.includes(`const { raw: r3 } = await import('${RUNTIME_PKG}/engine/a.js')`) && out.includes(`const { raw: r4, domainValue: d4 } = await import('${CORE_PKG}')`) && r.notes[0].dynamic === 1, 'destructured dynamic import moves only when every name moves to one module')
  check(out.includes(`vi.mock('${CORE_PKG}'`) && r.notes[0].rootMock[0].overridesMoved.join() === 'raw', 'root mock reported with its moved overrides, not rewritten')
  check(rewriteRootBarrelFiles({ ws, files: [api], moved, write: true, ts }).changed.length === 0, 'root-barrel is idempotent')
  check(tidyRuntimeStatements({ ws, files: [api], write: false, ts }).length === 0, 'root-barrel output is already in tidy form')
  check(verify({ ws, shims, files: [...files, api], moved, ts }).length === 0, 'verify finds nothing after the rewrites')
  // root-subpath (step 7.2): every root name to its declaring file.
  put('packages/shared/package.json', JSON.stringify({ name: '@use-brian/shared', exports: { '.': './src/index.ts' } }))
  put('packages/shared/src/index.ts', 'export const sharedThing = 1\n')
  put('packages/core/src/boundary.ts', "export { sharedThing } from '@use-brian/shared'\nexport { domainValue as dv } from './domain.js'\n")
  put('packages/core/src/index.ts', "export * from './engine/index.js'\nexport { queryLoop } from './engine/composed.js'\nexport * from './domain.js'\nexport * from './boundary.js'\nexport const rootOwn = 4\n")
  put('packages/api/src/y.ts', `import { queryLoop, raw, type Opt, domainValue, dv, sharedThing, rootOwn } from '${CORE_PKG}'\nimport * as core from '${CORE_PKG}'\nimport { domainValue as d5 } from '${CORE_PKG}/dist/domain.js'\nimport type { Opt as O2 } from '${CORE_PKG}/dist/engine/a.js'\ntype Q2 = import('${CORE_PKG}').queryLoop\nconst { queryLoop: q3 } = await import('${CORE_PKG}')\nvi.mock('${CORE_PKG}', async (orig) => ({ ...(await orig()), domainValue: 9 }))\n`)
  const ws2 = createWorkspace({ ossRoot: dir })
  const sub = rootSubpathSymbols(ws2, shims, ts)
  check(sub.map.get('queryLoop')?.module === `${CORE_PKG}/engine/composed.js`, 'composed core name goes to its declaring core file')
  check(sub.map.get('raw')?.module === `${RUNTIME_PKG}/engine/a.js`, 'moved name goes to the runtime')
  check(sub.map.get('dv')?.module === `${CORE_PKG}/domain.js` && sub.map.get('dv').name === 'domainValue', 'core alias maps back to the declared name')
  check(sub.map.get('sharedThing')?.module === `${CORE_PKG}/boundary.js`, 'cross-package re-export maps to the core file that re-exports it')
  check(!sub.map.has('rootOwn') && sub.unresolved.get('rootOwn') === 'local:packages/core/src/index.ts', 'a root-declared name is unresolved')
  const y = ws2.absOf('packages/api/src/y.ts')
  const rs = rewriteRootSubpathFiles({ ws: ws2, shims, files: [y], map: sub.map, write: true, ts })
  const yo = readFileSync(y, 'utf8')
  check(yo.includes(`import { rootOwn } from '${CORE_PKG}'\n`), `unresolved name stays on the root:\n${yo}`)
  check(yo.includes(`import { sharedThing } from '${CORE_PKG}/boundary.js'`) && yo.includes(`import { domainValue, domainValue as dv } from '${CORE_PKG}/domain.js'`) && yo.includes(`import { queryLoop } from '${CORE_PKG}/engine/composed.js'`) && yo.includes(`import { raw, type Opt } from '${RUNTIME_PKG}/engine/a.js'`), `named split by declaring file:\n${yo}`)
  check(yo.includes(`import { domainValue as d5 } from '${CORE_PKG}/domain.js'`) && yo.includes(`import type { Opt as O2 } from '${RUNTIME_PKG}/engine/a.js'`), `dist subpaths rewritten:\n${yo}`)
  check(yo.includes(`import('${CORE_PKG}/engine/composed.js').queryLoop`) && yo.includes(`await import('${CORE_PKG}/engine/composed.js')`), `type query and dynamic import move:\n${yo}`)
  check(yo.includes(`import * as core from '${CORE_PKG}'`) && yo.includes(`vi.mock('${CORE_PKG}'`), 'namespace import and root mock are not rewritten')
  const yn = rs.notes[0]
  check(yn.namespace === 1 && yn.rootMock[0].overridesMoved.join() === 'domainValue' && yn.unresolvedNames.join() === 'rootOwn', `notes report namespace, mock overrides and unresolved names: ${JSON.stringify(yn)}`)
  check(rs.changed[0].distEdges === 2, 'two dist edges')
  check(rewriteRootSubpathFiles({ ws: ws2, shims, files: [y], map: sub.map, write: true, ts }).changed.length === 0, 'root-subpath is idempotent')
  const rootEdges = verify({ ws: ws2, shims, files: [y], moved, ts, coreRoot: true })
  check(rootEdges.filter((e) => e.kind === 'core-root').length === 3 && !rootEdges.some((e) => e.kind === 'core-dist' || e.kind === 'shim-path'), `verify --core-root reports the 3 remaining root references: ${JSON.stringify(rootEdges)}`)
  return 'runtime-importer-codemod self-test: pass'
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: argv[0], roots: [], excludes: [], write: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') opts.write = true
    else if (a === '--root') opts.roots.push(argv[++i])
    else if (a === '--exclude') opts.excludes.push(argv[++i])
    else if (a === '--json') opts.json = argv[++i]
    else if (a === '--files-from') (opts.filesFrom ??= []).push(argv[++i])
    else if (a === '--oss-root') opts.ossRoot = argv[++i]
    else if (a === '--core-root') opts.coreRoot = true
    else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

const DEFAULT_VERIFY_ROOTS = [
  'packages/*/src/**', 'packages/*/scripts/**', 'apps/*/src/**', 'apps/*/scripts/**',
  'plat:packages/*/src/**', 'plat:apps/*/src/**',
]

export function main(argv = process.argv.slice(2)) {
  let opts
  try { opts = parseArgs(argv) } catch (err) { console.error(err.message); return 2 }
  const ts = loadTypeScript(opts.ossRoot ?? DEFAULT_OSS_ROOT)
  if (opts.mode === 'self-test') { console.log(selfTest(ts)); return 0 }
  if (!['core-relative', 'deep', 'root-barrel', 'root-subpath', 'tidy', 'verify'].includes(opts.mode)) {
    console.error('usage: runtime-importer-codemod.mjs <core-relative|deep|root-barrel|root-subpath|tidy|verify|self-test> [--root glob]... [--exclude glob]... [--files-from batch.json]... [--write] [--core-root] [--json out]')
    return 2
  }
  const ossRoot = resolve(opts.ossRoot ?? DEFAULT_OSS_ROOT)
  const parent = resolve(ossRoot, '..')
  const platformRoot = existsSync(join(parent, 'packages/api-platform/package.json')) ? parent : null
  const ws = createWorkspace({ ossRoot, platformRoot })
  const shims = loadShims(ws, ossRoot)
  let report
  if (opts.mode === 'core-relative') {
    const roots = opts.roots.length ? opts.roots : ['packages/core/src/**', 'packages/core/scripts/**']
    const changed = rewriteSpecifiers({ ws, shims, files: filesFor(ws, roots, opts.excludes), allowPackage: false, write: opts.write, ts })
    report = { mode: opts.mode, write: opts.write, roots, files: changed.length, edges: changed.reduce((s, c) => s + c.edges, 0), changed }
  } else if (opts.mode === 'deep') {
    if (!opts.roots.length) { console.error('deep needs --root'); return 2 }
    const changed = rewriteSpecifiers({ ws, shims, files: filesFor(ws, opts.roots, opts.excludes), allowPackage: true, write: opts.write, ts })
    report = { mode: opts.mode, write: opts.write, roots: opts.roots, excludes: opts.excludes, files: changed.length, edges: changed.reduce((s, c) => s + c.edges, 0), changed }
  } else if (opts.mode === 'tidy') {
    const fromBatches = (opts.filesFrom ?? []).flatMap((f) => JSON.parse(readFileSync(resolve(f), 'utf8')).changed.map((c) => ws.absOf(c.file)))
    const files = [...new Set([...fromBatches, ...(opts.roots.length ? filesFor(ws, opts.roots, opts.excludes) : [])])].sort()
    if (!files.length) { console.error('tidy needs --files-from or --root'); return 2 }
    const changed = tidyRuntimeStatements({ ws, files, write: opts.write, ts })
    report = { mode: opts.mode, write: opts.write, inputs: files.length, files: changed.length, statements: changed.reduce((s, c) => s + c.statements, 0), changed }
  } else if (opts.mode === 'root-barrel') {
    if (!opts.roots.length) { console.error('root-barrel needs --root'); return 2 }
    const { moved, unknownStar } = movedRootSymbols(ws, shims, ts)
    const { changed, notes } = rewriteRootBarrelFiles({ ws, files: filesFor(ws, opts.roots, opts.excludes), moved, write: opts.write, ts })
    report = {
      mode: opts.mode, write: opts.write, roots: opts.roots, excludes: opts.excludes, movedRootSymbols: moved.size, unknownStar,
      files: changed.length, specifiers: changed.reduce((s, c) => s + c.specifiers, 0), statements: changed.reduce((s, c) => s + c.statements, 0),
      changed, notes,
    }
  } else if (opts.mode === 'root-subpath') {
    if (!opts.roots.length) { console.error('root-subpath needs --root'); return 2 }
    const { map, unresolved, unknownStar } = rootSubpathSymbols(ws, shims, ts)
    const { changed, notes } = rewriteRootSubpathFiles({ ws, shims, files: filesFor(ws, opts.roots, opts.excludes), map, write: opts.write, ts })
    report = {
      mode: opts.mode, write: opts.write, roots: opts.roots, excludes: opts.excludes, rootSymbols: map.size, unresolvedRootSymbols: Object.fromEntries(unresolved), unknownStar,
      files: changed.length, specifiers: changed.reduce((s, c) => s + c.specifiers, 0), statements: changed.reduce((s, c) => s + c.statements, 0),
      distEdges: changed.reduce((s, c) => s + c.distEdges, 0), changed, notes,
    }
  } else {
    const roots = opts.roots.length ? opts.roots : DEFAULT_VERIFY_ROOTS.filter((r) => platformRoot || !r.startsWith('plat:'))
    const { moved } = movedRootSymbols(ws, shims, ts)
    const edges = verify({ ws, shims, files: filesFor(ws, roots, opts.excludes), moved, ts, coreRoot: Boolean(opts.coreRoot) })
    const byFile = [...new Set(edges.map((e) => e.file))]
    const count = (kind) => edges.filter((e) => e.kind === kind)
    report = {
      mode: 'verify', roots, excludes: opts.excludes, coreRoot: Boolean(opts.coreRoot),
      shimPathEdges: count('shim-path').length, rootBarrelFiles: count('root-barrel-moved-symbol').length,
      ...(opts.coreRoot ? { coreRootFiles: new Set(count('core-root').map((e) => e.file)).size, coreRootRefs: count('core-root').length, coreDistEdges: count('core-dist').length } : {}),
      files: byFile.length, edges,
    }
  }
  const text = JSON.stringify(report, null, 2) + '\n'
  if (opts.json) writeFileSync(resolve(opts.json), text)
  const summary = { ...report }
  delete summary.changed; delete summary.notes; delete summary.edges
  console.error(JSON.stringify(summary))
  if (opts.mode === 'verify') return report.edges.length ? 1 : 0
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
