#!/usr/bin/env node
/**
 * Static import-graph harness for the chat path (M4 runtime separation,
 * docs/plans/oss-chat-m4-runtime-separation-plan.md section 5, step 1).
 *
 * Static mode answers "which workspace files and npm packages does an ordinary
 * chat turn load at module evaluation time?" from TypeScript source:
 *
 *   - every file is run through `ts.transpileModule`, so type-only and unused
 *     imports are elided exactly as the compiled `dist` elides them;
 *   - static `import` / `export ... from` / literal `require()` edges are
 *     followed; literal `import()` edges are recorded but NOT followed (they
 *     load at activation, which the runtime mode measures); non-literal
 *     `import(expr)` is reported as an unresolved dynamic import;
 *   - `@use-brian/*` specifiers resolve to the owning package's `src/`
 *     through its manifest (`exports`, then `main`), mapping the tsconfig
 *     `outDir` back to `rootDir`, so a subpath the manifest does not export is
 *     reported as unresolved, as Node would fail it;
 *   - anything else that is not a Node builtin is an npm package and is not
 *     traversed.
 *
 * Closure mode (`--closure <fileset>`) answers the M4 step-2 exit question:
 * does a file set's TYPE-INCLUSIVE closure (type-only imports, `import('x')`
 * type queries and dynamic imports included) stay inside the set (plus the
 * allowed globs)? It exits 1 when it escapes.
 *
 * Usage (run from anywhere; paths are relative to the OSS root, platform
 * paths carry a `plat:` prefix):
 *
 *   node scripts/testing/import-graph.mjs                       # gated `chat` entry set
 *   node scripts/testing/import-graph.mjs --entry-set m4-measure --label before --out m.json --report-only
 *   node scripts/testing/import-graph.mjs --entry packages/api/src/turn/kernel.ts --entry plat:apps/api/src/index.ts
 *   node scripts/testing/import-graph.mjs --closure 'packages/core/src/{engine,providers}/**' --allow 'packages/shared/src/**'
 *   node scripts/testing/import-graph.mjs --closure @runtime-files.txt
 *
 * Exit codes: 0 pass (or `--report-only`), 1 forbidden hit / closure escape,
 * 2 usage, config or missing-entry error (a moved seam fails loudly).
 *
 * [COMP:invariants/chat-import-graph]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OSS_ROOT = resolve(HERE, '../..')
const DEFAULT_CONFIG = join(HERE, 'import-graph.config.json')
const PLAT = 'plat:'
const CODE_EXT = /\.(?:[cm]?tsx?|[cm]?jsx?)$/
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

let tsModule = null
/** The `typescript` devDependency of the OSS root, resolved from that root so
 * the harness parses with the same compiler the packages build with. */
export function loadTypeScript(ossRoot = DEFAULT_OSS_ROOT) {
  if (tsModule) return tsModule
  try {
    tsModule = createRequire(join(ossRoot, 'package.json'))('typescript')
  } catch {
    // A fixture root has no install; fall back to this checkout's compiler.
    tsModule = createRequire(import.meta.url)('typescript')
  }
  return tsModule
}

// ── Globs ────────────────────────────────────────────────────────────────

/** Minimal deterministic glob → RegExp: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob) {
  return new RegExp(`^${globSource(glob)}$`)
}
function globSource(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) throw new Error(`unbalanced brace in glob ${glob}`)
      re += `(?:${glob.slice(i + 1, end).split(',').map(globSource).join('|')})`
      i = end
    } else re += escapeRe(c)
  }
  return re
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') }
export function matcher(globs) {
  const res = (globs ?? []).map((g) => [g, globToRegExp(g)])
  return (id) => res.find(([, re]) => re.test(id))?.[0] ?? null
}

// ── Workspace ────────────────────────────────────────────────────────────

/**
 * Index every workspace package manifest under `apps/*` and `packages/*` of
 * the OSS root and, when present, the platform root. Ids are OSS-relative
 * (`packages/api/src/x.ts`) or `plat:`-prefixed platform-relative.
 */
export function createWorkspace({ ossRoot = DEFAULT_OSS_ROOT, platformRoot = null } = {}) {
  const roots = [{ prefix: '', dir: resolve(ossRoot) }]
  if (platformRoot) roots.push({ prefix: PLAT, dir: resolve(platformRoot) })
  const packages = new Map()
  const byDir = []
  for (const root of roots) {
    for (const group of ['apps', 'packages']) {
      const groupDir = join(root.dir, group)
      if (!existsSync(groupDir)) continue
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(groupDir, entry.name)
        const manifestPath = join(dir, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const pkg = { name: manifest.name, dir, manifest, ...readOutDirs(dir), id: root.prefix + `${group}/${entry.name}` }
        // The platform root absorbs the OSS tree; the OSS copy wins a name tie.
        if (manifest.name && !packages.has(manifest.name)) packages.set(manifest.name, pkg)
        byDir.push(pkg)
      }
    }
  }
  byDir.sort((a, b) => b.dir.length - a.dir.length)
  return {
    roots,
    packages,
    /** Absolute path → harness id, or null outside both roots. */
    idOf(abs) {
      for (const root of [...roots].sort((a, b) => b.dir.length - a.dir.length)) {
        const rel = relative(root.dir, abs)
        if (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '') {
          // A platform-root path inside the absorbed OSS tree is an OSS id.
          if (root.prefix === PLAT && roots[0] && !relative(roots[0].dir, abs).startsWith('..')) continue
          return root.prefix + rel.split(sep).join('/')
        }
      }
      return null
    },
    absOf(id) {
      if (id.startsWith(PLAT)) {
        const plat = roots.find((r) => r.prefix === PLAT)
        if (!plat) throw new Error(`platform path ${id} needs --platform-root`)
        return join(plat.dir, id.slice(PLAT.length))
      }
      return join(roots[0].dir, id)
    },
    packageOf(abs) { return byDir.find((p) => abs === p.dir || abs.startsWith(p.dir + sep)) ?? null },
  }
}

function readOutDirs(dir) {
  let outDir = 'dist'
  let rootDir = 'src'
  const tsconfig = join(dir, 'tsconfig.json')
  if (existsSync(tsconfig)) {
    try {
      const ts = loadTypeScript()
      const parsed = ts.parseConfigFileTextToJson(tsconfig, readFileSync(tsconfig, 'utf8')).config ?? {}
      if (parsed.compilerOptions?.outDir) outDir = parsed.compilerOptions.outDir.replace(/^\.\//, '').replace(/\/$/, '')
      if (parsed.compilerOptions?.rootDir) rootDir = parsed.compilerOptions.rootDir.replace(/^\.\//, '').replace(/\/$/, '')
    } catch { /* defaults */ }
  }
  return { outDir, rootDir }
}

// ── Resolution ───────────────────────────────────────────────────────────

const CONDITIONS = ['import', 'node', 'module', 'default']
function pickTarget(target) {
  if (typeof target === 'string') return target
  if (Array.isArray(target)) { for (const t of target) { const r = pickTarget(t); if (r) return r } return null }
  if (target && typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) if (CONDITIONS.includes(key)) { const r = pickTarget(value); if (r) return r }
    if (target.types) return pickTarget(target.types)
  }
  return null
}

/** Node's exports-map algorithm, reduced to what workspace manifests use:
 * exact keys, then the longest-prefix `*` pattern. */
export function resolveExports(exportsField, subpath) {
  if (exportsField == null) return { found: false }
  if (typeof exportsField === 'string' || Array.isArray(exportsField) || !Object.keys(exportsField).some((k) => k.startsWith('.'))) {
    return subpath === '.' ? { found: true, target: pickTarget(exportsField) } : { found: false }
  }
  if (Object.hasOwn(exportsField, subpath)) return { found: true, target: pickTarget(exportsField[subpath]), key: subpath }
  let best = null
  for (const key of Object.keys(exportsField)) {
    const star = key.indexOf('*')
    if (star === -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      if (!best || prefix.length > best.prefix.length) best = { key, prefix, suffix }
    }
  }
  if (!best) return { found: false }
  const middle = subpath.slice(best.prefix.length, subpath.length - best.suffix.length)
  const target = pickTarget(exportsField[best.key])
  return { found: true, target: target?.split('*').join(middle) ?? null, key: best.key }
}

function fileCandidates(base) {
  const m = base.match(/^(.*?)(\.d\.ts|\.[cm]?jsx?|\.[cm]?tsx?)$/)
  const stem = m ? m[1] : base
  const ext = m ? m[2] : ''
  const out = []
  if (ext === '.js' || ext === '.jsx') out.push(`${stem}.ts`, `${stem}.tsx`, base)
  else if (ext === '.mjs') out.push(`${stem}.mts`, base)
  else if (ext === '.cjs') out.push(`${stem}.cts`, base)
  else if (ext === '.d.ts') out.push(`${stem}.ts`, `${stem}.tsx`, base)
  else if (ext) out.push(base)
  else out.push(base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`)
  if (!ext || ext === '.js') out.push(join(stem, 'index.ts'), join(stem, 'index.tsx'), join(stem, 'index.js'))
  return out
}
function firstFile(candidates) {
  for (const c of candidates) { try { if (statSync(c).isFile()) return c } catch { /* next */ } }
  return null
}

/** Resolve one specifier from `fromAbs`. Returns
 * `{kind:'file', abs}` | `{kind:'npm', name}` | `{kind:'builtin'}` | `{kind:'unresolved', reason}`. */
export function resolveSpecifier(ws, fromAbs, spec) {
  if (BUILTINS.has(spec) || spec.startsWith('node:')) return { kind: 'builtin' }
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const abs = firstFile(fileCandidates(resolve(dirname(fromAbs), spec)))
    return abs ? { kind: 'file', abs } : { kind: 'unresolved', reason: 'relative-not-found' }
  }
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const rest = parts.slice(spec.startsWith('@') ? 2 : 1).join('/')
  const pkg = ws.packages.get(name)
  if (!pkg) {
    if (name.startsWith('@use-brian/')) return { kind: 'unresolved', reason: 'unknown-workspace-package' }
    return { kind: 'npm', name }
  }
  const subpath = rest ? `./${rest}` : '.'
  let target
  if (pkg.manifest.exports != null) {
    const r = resolveExports(pkg.manifest.exports, subpath)
    if (!r.found || !r.target) return { kind: 'unresolved', reason: 'not-exported', package: name }
    target = r.target
  } else if (subpath === '.') {
    target = pkg.manifest.main ?? pkg.manifest.module ?? './index.js'
  } else {
    target = subpath
  }
  const t = target.replace(/^\.\//, '')
  const mapped = t === pkg.outDir || t.startsWith(`${pkg.outDir}/`) ? join(pkg.rootDir, t.slice(pkg.outDir.length + 1)) : t
  const abs = firstFile(fileCandidates(join(pkg.dir, mapped)))
  return abs ? { kind: 'file', abs } : { kind: 'unresolved', reason: 'target-not-found', package: name }
}

// ── Parsing ──────────────────────────────────────────────────────────────

function scriptKind(ts, file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

/**
 * Extract module references from one file.
 * mode 'runtime': from the transpiled JS (type-only/unused imports elided).
 * mode 'types':   from the original source, including type-only imports and
 *                 `import('x')` type queries.
 */
export function parseImports(ts, file, text, mode) {
  let code = text
  let kind = scriptKind(ts, file)
  if (mode === 'runtime' && /\.(?:[cm]?tsx?)$/.test(file)) {
    if (/\.d\.[cm]?ts$/.test(file)) return { refs: [], reexports: 0, statements: 0 }
    code = ts.transpileModule(text, {
      fileName: file,
      reportDiagnostics: false,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        isolatedModules: true,
        verbatimModuleSyntax: false,
        sourceMap: false,
      },
    }).outputText
    kind = ts.ScriptKind.JS
  }
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
  const refs = []
  let reexports = 0
  let statements = 0
  for (const st of sf.statements) {
    statements++
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      refs.push({ spec: st.moduleSpecifier.text, kind: st.importClause?.isTypeOnly ? 'type' : 'static' })
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      reexports++
      refs.push({ spec: st.moduleSpecifier.text, kind: st.isTypeOnly ? 'type' : 'static', reexport: true, star: !st.exportClause })
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) {
      refs.push({ spec: st.moduleReference.expression.text, kind: st.isTypeOnly ? 'type' : 'static' })
    } else if (mode === 'types' && ts.isModuleDeclaration(st) && ts.isStringLiteral(st.name)) {
      refs.push({ spec: st.name.text, kind: 'type' })
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0]
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) refs.push({ spec: arg.text, kind: 'dynamic' })
        else refs.push({ spec: null, kind: 'dynamic', expression: arg ? arg.getText(sf).slice(0, 200) : '' })
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && arg && ts.isStringLiteral(arg)) {
        refs.push({ spec: arg.text, kind: 'static' })
      }
    } else if (mode === 'types' && ts.isImportTypeNode(node)) {
      const lit = node.argument
      if (ts.isLiteralTypeNode(lit) && ts.isStringLiteral(lit.literal)) refs.push({ spec: lit.literal.text, kind: 'type' })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { refs, reexports, statements }
}

/** Lazily parsed module graph over one workspace. */
export function createGraph(ws, { mode = 'runtime', ts = loadTypeScript() } = {}) {
  const nodes = new Map()
  function node(abs) {
    let n = nodes.get(abs)
    if (n) return n
    n = { id: ws.idOf(abs) ?? abs, abs, edges: [], npm: [], unresolved: [], dynamicUnresolved: [], reexports: 0, statements: 0, reexportTargets: new Set() }
    nodes.set(abs, n)
    if (!CODE_EXT.test(abs)) return n
    const parsed = parseImports(ts, abs, readFileSync(abs, 'utf8'), mode)
    n.reexports = parsed.reexports
    n.statements = parsed.statements
    for (const ref of parsed.refs) {
      if (ref.spec == null) { n.dynamicUnresolved.push(ref.expression); continue }
      const r = resolveSpecifier(ws, abs, ref.spec)
      if (r.kind === 'builtin') continue
      if (r.kind === 'npm') n.npm.push({ name: r.name, kind: ref.kind })
      else if (r.kind === 'unresolved') n.unresolved.push({ specifier: ref.spec, reason: r.reason, kind: ref.kind })
      else {
        n.edges.push({ to: r.abs, kind: ref.kind, specifier: ref.spec })
        if (ref.reexport) n.reexportTargets.add(r.abs)
      }
    }
    return n
  }
  return { node, nodes }
}

/** Barrel = a module that is mostly re-exports (or an index with any). */
export function isBarrel(n) {
  if (n.reexports === 0) return false
  if (/^index\.[cm]?[jt]sx?$/.test(basename(n.abs))) return true
  return n.reexports >= 3 && n.reexports * 2 >= n.statements
}

// ── Static report ────────────────────────────────────────────────────────

/**
 * BFS from one entry over followed edge kinds. Returns parents for shortest
 * chains. `follow` decides which edge kinds are traversed.
 */
function bfs(graph, startAbs, follow) {
  const parent = new Map([[startAbs, null]])
  const order = [startAbs]
  for (let i = 0; i < order.length; i++) {
    const n = graph.node(order[i])
    for (const e of n.edges) {
      if (!follow.has(e.kind) || parent.has(e.to)) continue
      parent.set(e.to, order[i])
      order.push(e.to)
    }
  }
  return { parent, order }
}
function chainTo(graph, parent, abs) {
  const chain = []
  for (let cur = abs; cur != null; cur = parent.get(cur)) chain.push(graph.node(cur).id)
  return chain.reverse()
}

export function analyzeEntry(ws, graph, entryId, config) {
  const abs = ws.absOf(entryId)
  if (!existsSync(abs)) return { missing: true }
  const isForbiddenFile = matcher((config.forbidden?.files ?? []).map((f) => f.glob ?? f))
  const forbiddenNpm = new Set(config.forbidden?.npm ?? [])
  const allow = new Map((config.allow ?? []).map((a) => [a.path, a.reason]))
  const categories = Object.entries(config.categories ?? {}).map(([name, globs]) => [name, matcher(globs)])
  const { parent, order } = bfs(graph, abs, new Set(['static']))

  const forbiddenOf = (n) => (allow.has(n.id) ? null : isForbiddenFile(n.id))
  const files = []
  const npm = new Map()
  const forbiddenFiles = []
  const forbiddenNpmHits = []
  const frontier = []
  const barrels = []
  const dynamicImports = []
  const unresolvedDynamic = []
  const unresolved = []
  const allowed = []
  const counts = Object.fromEntries(categories.map(([name]) => [name, 0]))
  for (const a of order) {
    const n = graph.node(a)
    files.push(n.id)
    for (const [name, match] of categories) if (match(n.id)) counts[name]++
    if (allow.has(n.id)) allowed.push({ file: n.id, reason: allow.get(n.id) })
    const rule = forbiddenOf(n)
    const p = parent.get(a)
    if (rule) {
      const parentNode = p == null ? null : graph.node(p)
      const parentForbidden = parentNode ? forbiddenOf(parentNode) : null
      forbiddenFiles.push(parentForbidden ? { file: n.id, rule, via: parentNode.id } : { file: n.id, rule, chain: chainTo(graph, parent, a) })
    }
    for (const e of n.edges) {
      const to = graph.node(e.to)
      if (e.kind === 'static' && !rule && forbiddenOf(to)) frontier.push({ from: n.id, to: to.id })
      if (e.kind === 'dynamic') dynamicImports.push({ from: n.id, specifier: e.specifier, to: to.id })
    }
    for (const m of n.npm) {
      if (m.kind === 'dynamic') { dynamicImports.push({ from: n.id, specifier: m.name, npm: true }); continue }
      if (m.kind !== 'static') continue
      if (!npm.has(m.name)) npm.set(m.name, n.id)
      if (forbiddenNpm.has(m.name)) {
        if (!rule) frontier.push({ from: n.id, to: `npm:${m.name}` })
        if (!forbiddenNpmHits.some((h) => h.package === m.name)) {
          forbiddenNpmHits.push({ package: m.name, importer: n.id, chain: [...chainTo(graph, parent, a), `npm:${m.name}`] })
        }
      }
    }
    for (const expression of n.dynamicUnresolved) unresolvedDynamic.push({ from: n.id, expression })
    for (const u of n.unresolved) unresolved.push({ from: n.id, ...u })
    if (isBarrel(n)) barrels.push({ file: n.id, fanOut: n.reexportTargets.size, reexports: n.reexports })
  }
  const byFile = (a, b) => cmp(a.file, b.file)
  return {
    fileCount: files.length,
    files: files.sort(cmp),
    categories: counts,
    npmPackages: [...npm.keys()].sort(cmp),
    npmPackageCount: npm.size,
    forbidden: {
      fileCount: forbiddenFiles.length,
      files: forbiddenFiles.sort(byFile),
      npm: forbiddenNpmHits.sort((a, b) => cmp(a.package, b.package)),
    },
    frontierEdges: dedupe(frontier, (e) => `${e.from}→${e.to}`).sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
    barrels: barrels.sort((a, b) => b.fanOut - a.fanOut || byFile(a, b)),
    allowed: allowed.sort(byFile),
    dynamicImports: dedupe(dynamicImports, (d) => `${d.from}→${d.specifier}`).sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier)),
    unresolvedDynamicImports: unresolvedDynamic.sort((a, b) => cmp(a.from, b.from) || cmp(a.expression, b.expression)),
    unresolved: unresolved.sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier)),
  }
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0 }
function dedupe(list, key) { const seen = new Set(); return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true))) }

/** Same algorithm as `fingerprint()` in
 * packages/api/src/application-platform/__tests__/chat-architecture-cost.integration.test.ts. */
export function fingerprint(directory) {
  const hash = createHash('sha256')
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) { hash.update(relative(directory, child)); hash.update(readFileSync(child)) }
    }
  }
  visit(directory)
  return hash.digest('hex')
}

function gitState(dir) {
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { maxBuffer: 2 ** 30, encoding: 'buffer' })
  const head = git(['rev-parse', 'HEAD'])
  if (head.status !== 0) return null
  // The diff can exceed any sane buffer on a dirty platform tree: hash it in
  // a pipe. `git diff HEAD --binary` covers tracked changes; untracked files
  // are covered by statusHash (paths) and the per-package treeHashes (content).
  const diff = spawnSync('sh', ['-c', 'git -C "$1" diff HEAD --binary --no-ext-diff --ignore-submodules=all -- . | (sha256sum 2>/dev/null || shasum -a 256) | cut -d" " -f1', 'sh', dir], { encoding: 'utf8' })
  const status = git(['status', '--porcelain=v1', '-uall', '--ignore-submodules=all'])
  const sha = (b) => createHash('sha256').update(b ?? '').digest('hex')
  const statusText = status.stdout?.toString('utf8') ?? ''
  return {
    head: head.stdout.toString('utf8').trim(),
    diffHash: diff.status === 0 && /^[0-9a-f]{64}$/.test(diff.stdout.trim()) ? diff.stdout.trim() : null,
    statusHash: sha(statusText),
    dirty: statusText.trim().length > 0,
    changedPaths: statusText.split('\n').filter(Boolean).length,
  }
}

/** Recursively sort object keys so the JSON is byte-stable. */
export function sortedJson(value) {
  return JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v), 2) + '\n'
}

export function loadConfig(path = DEFAULT_CONFIG) {
  const config = JSON.parse(readFileSync(path, 'utf8'))
  return { config, hash: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

export function staticReport({ ws, config, entries, label = null, provenance = true, configMeta = null }) {
  const ts = loadTypeScript()
  const graph = createGraph(ws, { mode: 'runtime', ts })
  const out = {}
  const missing = []
  for (const entry of entries) {
    const r = analyzeEntry(ws, graph, entry, config)
    if (r.missing) missing.push(entry)
    else out[entry] = r
  }
  const touched = new Set()
  for (const r of Object.values(out)) for (const f of r.files) {
    const pkg = ws.packageOf(ws.absOf(f))
    if (pkg) touched.add(pkg)
  }
  const treeHashes = {}
  if (provenance) {
    for (const pkg of touched) {
      const src = join(pkg.dir, pkg.rootDir)
      if (existsSync(src)) treeHashes[`${pkg.id}/${pkg.rootDir}`] = fingerprint(src)
    }
  }
  const hits = Object.values(out).reduce((s, r) => s + r.forbidden.fileCount + r.forbidden.npm.length, 0)
  const source = {}
  if (provenance) {
    for (const root of ws.roots) source[root.prefix ? 'platform' : 'oss'] = gitState(root.dir)
  }
  return {
    tool: 'use-brian/scripts/testing/import-graph.mjs',
    schema: 1,
    mode: 'static',
    label,
    node: process.version,
    typescript: ts.version,
    method: 'ts.transpileModule per file (type-only and unused imports elided); static import/export-from/require followed; literal import() recorded, not followed; @use-brian/* resolved to src through manifests',
    config: configMeta,
    source,
    treeHashes,
    missingEntries: missing.sort(cmp),
    entries: out,
    summary: {
      entries: Object.fromEntries(Object.entries(out).map(([k, r]) => [k, {
        files: r.fileCount, npmPackages: r.npmPackageCount, forbiddenFiles: r.forbidden.fileCount,
        forbiddenNpm: r.forbidden.npm.map((h) => h.package), frontierEdges: r.frontierEdges.length,
        barrels: r.barrels.length, categories: r.categories,
      }])),
      forbiddenHits: hits,
      pass: hits === 0 && missing.length === 0,
    },
  }
}

// ── Closure mode ─────────────────────────────────────────────────────────

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(p, out)
    else if (entry.isFile() && CODE_EXT.test(entry.name)) out.push(p)
  }
  return out
}

/** Split a comma-separated glob list on top-level commas (not inside `{}`). */
export function splitGlobs(spec) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of spec) {
    if (c === '{') depth++
    else if (c === '}') depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Expand a fileset spec: comma-separated globs, or `@file` listing paths /
 * globs one per line (or a JSON array). */
export function expandFileset(ws, spec, cwd = process.cwd()) {
  let patterns
  if (spec.startsWith('@')) {
    const text = readFileSync(resolve(cwd, spec.slice(1)), 'utf8')
    patterns = text.trim().startsWith('[') ? JSON.parse(text) : text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  } else patterns = splitGlobs(spec)
  const match = matcher(patterns)
  const files = new Set()
  for (const pkg of new Set(ws.packages.values())) {
    for (const abs of walkFiles(join(pkg.dir, pkg.rootDir))) {
      const id = ws.idOf(abs)
      if (id && match(id)) files.add(id)
    }
  }
  return { patterns, files: [...files].sort(cmp) }
}

export function closureReport({ ws, fileset, allow = [], forbiddenNpm = [], includeTests = false }) {
  const ts = loadTypeScript()
  const graph = createGraph(ws, { mode: 'types', ts })
  const isTest = (id) => /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(id)
  const members = new Set(fileset.files.filter((f) => includeTests || !isTest(f)))
  const allowed = matcher(allow)
  const forbidden = new Set(forbiddenNpm)
  const escapes = []
  const npm = new Map()
  const unresolved = []
  for (const id of members) {
    const n = graph.node(ws.absOf(id))
    for (const e of n.edges) {
      const to = graph.node(e.to).id
      if (members.has(to)) continue
      if (allowed(to)) continue
      escapes.push({ from: id, to, kind: e.kind, specifier: e.specifier })
    }
    for (const m of n.npm) {
      if (!npm.has(m.name)) npm.set(m.name, { package: m.name, importers: new Set(), kinds: new Set() })
      npm.get(m.name).importers.add(id)
      npm.get(m.name).kinds.add(m.kind)
    }
    for (const u of n.unresolved) unresolved.push({ from: id, ...u })
  }
  const npmList = [...npm.values()].map((x) => ({ package: x.package, importers: [...x.importers].sort(cmp), kinds: [...x.kinds].sort(cmp) })).sort((a, b) => cmp(a.package, b.package))
  const forbiddenStatic = npmList.filter((x) => forbidden.has(x.package) && x.kinds.some((k) => k !== 'dynamic'))
  return {
    tool: 'use-brian/scripts/testing/import-graph.mjs',
    schema: 1,
    mode: 'closure',
    method: 'type-inclusive: import type, import("x") type queries, declare module, static and dynamic imports',
    fileset: { patterns: fileset.patterns, memberCount: members.size, members: [...members].sort(cmp) },
    allow,
    escapes: escapes.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
    escapeTargets: [...new Set(escapes.map((e) => e.to))].sort(cmp),
    npmPackages: npmList,
    forbiddenNpm: forbiddenStatic.map((x) => x.package),
    unresolved: unresolved.sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier)),
    inside: escapes.length === 0 && forbiddenStatic.length === 0,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { entries: [], allow: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const value = () => (inline !== undefined ? inline : argv[++i])
    switch (flag) {
      case '--config': opts.config = value(); break
      case '--entry': opts.entries.push(value()); break
      case '--entry-set': opts.entrySet = value(); break
      case '--label': opts.label = value(); break
      case '--out': opts.out = value(); break
      case '--oss-root': opts.ossRoot = value(); break
      case '--platform-root': opts.platformRoot = value(); break
      case '--no-platform': opts.noPlatform = true; break
      case '--report-only': opts.reportOnly = true; break
      case '--no-provenance': opts.noProvenance = true; break
      case '--closure': opts.closure = value(); break
      case '--allow': opts.allow.push(...splitGlobs(value())); break
      case '--include-tests': opts.includeTests = true; break
      case '--help': case '-h': opts.help = true; break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  return opts
}

function detectPlatformRoot(ossRoot) {
  const parent = resolve(ossRoot, '..')
  return existsSync(join(parent, 'packages/api-platform/package.json')) ? parent : null
}

export function main(argv = process.argv.slice(2)) {
  let opts
  try { opts = parseArgs(argv) } catch (err) { console.error(String(err.message)); return 2 }
  if (opts.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return 0 }
  const ossRoot = resolve(opts.ossRoot ?? DEFAULT_OSS_ROOT)
  const configPath = resolve(opts.config ?? join(ossRoot, 'scripts/testing/import-graph.config.json'))
  let config, configHash
  try { ({ config, hash: configHash } = loadConfig(configPath)) } catch (err) { console.error(`import-graph: cannot read config ${configPath}: ${err.message}`); return 2 }
  loadTypeScript(ossRoot)
  const platformRoot = opts.noPlatform ? null : (opts.platformRoot ? resolve(opts.platformRoot) : detectPlatformRoot(ossRoot))
  const ws = createWorkspace({ ossRoot, platformRoot })
  const write = (report) => {
    const text = sortedJson(report)
    if (opts.out) writeFileSync(resolve(opts.out), text)
    else process.stdout.write(text)
  }

  if (opts.closure) {
    const fileset = expandFileset(ws, opts.closure)
    if (fileset.files.length === 0) { console.error(`import-graph: --closure ${opts.closure} matched no files`); return 2 }
    const report = closureReport({ ws, fileset, allow: [...(config.closure?.allow ?? []), ...opts.allow], forbiddenNpm: config.forbidden?.npm ?? [], includeTests: opts.includeTests })
    write(report)
    console.error(`import-graph closure: ${report.fileset.memberCount} files, ${report.escapes.length} escaping edge(s) to ${report.escapeTargets.length} file(s), forbidden npm ${report.forbiddenNpm.join(', ') || 'none'} → ${report.inside ? 'INSIDE' : 'ESCAPES'}`)
    return report.inside || opts.reportOnly ? 0 : 1
  }

  const setName = opts.entrySet ?? config.defaultEntrySet ?? 'chat'
  let entries = opts.entries
  if (entries.length === 0) {
    entries = config.entrySets?.[setName]
    if (!entries) { console.error(`import-graph: unknown entry set ${setName}`); return 2 }
  }
  entries = entries.filter((e) => platformRoot || !e.startsWith(PLAT))
  const report = staticReport({
    ws, config, entries, label: opts.label ?? setName, provenance: !opts.noProvenance,
    configMeta: { path: relative(ossRoot, configPath).split(sep).join('/'), sha256: configHash, entrySet: opts.entries.length ? null : setName },
  })
  write(report)
  for (const [entry, s] of Object.entries(report.summary.entries)) {
    console.error(`import-graph ${entry}: ${s.files} files, ${s.npmPackages} npm, ${s.forbiddenFiles} forbidden files, forbidden npm [${s.forbiddenNpm.join(' ')}], ${s.frontierEdges} frontier edges`)
  }
  if (report.missingEntries.length) { console.error(`import-graph: missing entries ${report.missingEntries.join(', ')}`); return 2 }
  return report.summary.pass || opts.reportOnly ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
