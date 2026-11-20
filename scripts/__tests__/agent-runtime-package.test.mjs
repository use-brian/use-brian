/** [COMP:engine/agent-runtime] The agent-runtime package contract (M4 steps 1 and 3). */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { closureReport, createWorkspace, expandFileset } from '../testing/import-graph.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const json = (rel) => JSON.parse(readFileSync(new URL(rel, `file://${root}`), 'utf8'))

test('[COMP:engine/agent-runtime] manifest exports file subpaths only and depends on no product package', () => {
  const manifest = json('packages/agent-runtime/package.json')
  assert.equal(manifest.name, '@use-brian/agent-runtime')
  assert.equal(manifest.private, true)
  assert.equal(manifest.license, 'AGPL-3.0-only')
  assert.deepEqual(manifest.exports, {
    './package.json': './package.json',
    './*.js': { types: './dist/*.d.ts', default: './dist/*.js' },
  })
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })
  const workspaceDeps = deps.filter((d) => d.startsWith('@use-brian/'))
  assert.deepEqual(workspaceDeps, ['@use-brian/shared'])
})

test('[COMP:engine/agent-runtime] composite project referencing only shared; core and api depend on it', () => {
  const tsconfig = json('packages/agent-runtime/tsconfig.json')
  assert.equal(tsconfig.compilerOptions.composite, true)
  assert.deepEqual(tsconfig.references, [{ path: '../shared' }])
  for (const pkg of ['core', 'api']) {
    assert.equal(json(`packages/${pkg}/package.json`).dependencies['@use-brian/agent-runtime'], 'workspace:*', `${pkg} manifest`)
    assert.ok(json(`packages/${pkg}/tsconfig.json`).references.some((r) => r.path === '../agent-runtime'), `${pkg} tsconfig reference`)
  }
})

test('[COMP:engine/agent-runtime] the runtime source closure stays inside the package and shared', () => {
  const ws = createWorkspace({ ossRoot: root })
  const report = closureReport({ ws, fileset: expandFileset(ws, 'packages/agent-runtime/src/**'), allow: ['packages/shared/src/**'] })
  assert.ok(report.fileset.memberCount >= 1)
  assert.deepEqual(report.escapes, [])
  assert.equal(report.inside, true)
})

const RUNTIME_NPM = ['@anthropic-ai/sdk', '@openai/codex', '@openai/codex-catalog', 'ajv', 'ajv-formats', 'sharp', 'undici', 'zod']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/\.(ts|mts|mjs)$/.test(entry.name)) out.push(path)
  }
  return out
}

test('[COMP:engine/agent-runtime] no runtime source or test imports core, api or a path outside the package', () => {
  const src = join(root, 'packages/agent-runtime/src')
  const specifier = /(?:from\s+|import\s*\(\s*|vi\.(?:do)?mock\(\s*|import\s+|require(?:\.resolve)?\(\s*)['"]([^'"]+)['"]/g
  const escapes = []
  for (const file of walk(src)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(specifier)) {
      if (spec.startsWith('.')) {
        if (!resolve(dirname(file), spec).startsWith(src)) escapes.push(`${relative(root, file)} -> ${spec}`)
      } else if (spec.startsWith('@use-brian/') && !spec.startsWith('@use-brian/shared')) {
        escapes.push(`${relative(root, file)} -> ${spec}`)
      }
    }
  }
  assert.deepEqual(escapes, [])
  const manifest = json('packages/agent-runtime/package.json')
  assert.deepEqual(Object.keys(manifest.dependencies).filter((d) => !d.startsWith('@use-brian/')).sort(), RUNTIME_NPM)
})

test('[COMP:engine/agent-runtime] the old core path of every moved file is gone: no forwarding shim, no copy (M4 final cut)', () => {
  const ws = createWorkspace({ ossRoot: root })
  const members = expandFileset(ws, '@scripts/testing/runtime-file-set.txt', root).files
    .filter((id) => !/(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(id))
  assert.equal(members.length, 73)
  for (const member of members) {
    const rel = member.replace(/^packages\/agent-runtime\/src\//, '')
    assert.notEqual(rel, member, `${member} is outside packages/agent-runtime/src`)
    for (const ext of ['.ts', '.tsx']) {
      assert.ok(!existsSync(join(root, 'packages/core/src', rel.replace(/\.tsx?$/, ext))), `packages/core/src/${rel} still exists`)
    }
  }
})

test('[COMP:engine/agent-runtime] core publishes declaring-file subpaths, no dist/* export and no aggregate root barrel', () => {
  const manifest = json('packages/core/package.json')
  assert.ok(!('./dist/*' in manifest.exports), 'the ./dist/* export is deleted')
  assert.deepEqual(manifest.exports['./*.js'], { types: './dist/*.d.ts', default: './dist/*.js' })
  // The transitional root keeps named re-exports only (one per declaring file),
  // never `export *`, until its last importer moves and it is deleted.
  const rootIndex = join(root, 'packages/core/src/index.ts')
  if (existsSync(rootIndex)) {
    const code = readFileSync(rootIndex, 'utf8').split('\n').filter((line) => line.trim() && !/^\s*(\/\/|\/\*|\*)/.test(line))
    for (const line of code) assert.match(line, /^export (type )?\{ [^}]+ \} from '[^']+'$/, line)
  } else {
    assert.ok(!('.' in manifest.exports) && !manifest.main && !manifest.types, 'no root entry without src/index.ts')
  }
})
