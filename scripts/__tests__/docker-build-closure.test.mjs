/** [COMP:ci/execution-topology] Clean Docker builds need the complete workspace compilation graph. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const packages = new Map()
for (const directory of ['apps', 'packages']) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    const manifest = resolve(root, path, 'package.json')
    if (entry.isDirectory() && existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
      packages.set(metadata.name, { path, metadata })
    }
  }
}

function workspaceClosure(name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  const { metadata } = packages.get(name)
  const dependencies = { ...metadata.dependencies, ...metadata.devDependencies, ...metadata.optionalDependencies }
  for (const [dependency, version] of Object.entries(dependencies)) {
    if (version.startsWith('workspace:')) workspaceClosure(dependency, seen)
  }
  return seen
}

function copiedSources(stage) {
  return new Set(stage.split('\n')
    .filter(line => line.startsWith('COPY ') && !line.startsWith('COPY --from='))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1)))
}

for (const app of ['api', 'doc-sync', 'browser-relay']) {
  test(`[COMP:ci/execution-topology] ${app} Docker build copies its workspace compilation closure`, () => {
    const dockerfile = readFileSync(resolve(root, `apps/${app}/Dockerfile`), 'utf8')
    const install = dockerfile.indexOf('RUN pnpm install --frozen-lockfile')
    const buildStart = dockerfile.indexOf('FROM deps AS build')
    const build = dockerfile.indexOf('RUN pnpm --filter ', buildStart)
    assert.ok(install >= 0 && buildStart > install && build > buildStart)
    const metadataSources = copiedSources(dockerfile.slice(0, install))
    const buildStage = dockerfile.slice(buildStart, build)
    const buildSources = copiedSources(buildStage)
    assert.match(buildStage, /^ENV NODE_OPTIONS=--max-old-space-size=6144$/m, 'clean API compilation needs its builder-only heap budget')
    const appPackage = JSON.parse(readFileSync(resolve(root, `apps/${app}/package.json`), 'utf8')).name
    for (const name of workspaceClosure(appPackage)) {
      const { path } = packages.get(name)
      assert.ok(metadataSources.has(`${path}/package.json`), `${app}: missing ${name} manifest before install`)
      assert.ok(metadataSources.has(`${path}/tsconfig.json`), `${app}: missing ${name} TypeScript configuration before install`)
      assert.ok(buildSources.has(`${path}/src`), `${app}: missing ${name} sources before build`)
    }
  })
}

test('[COMP:ci/execution-topology] CI compilation heap budget reaches Turbo child tasks', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  const compilationSteps = workflow.split(/\n      - /).filter(step =>
    /run: pnpm (?:build|typecheck)\n|run: pnpm exec turbo run build --filter="@use-brian\/api-open\^\.\.\."|run: >-\n          pnpm exec turbo run test\n/.test(step))
  assert.ok(compilationSteps.length >= 4, 'locate the API compilation steps before checking their budgets')
  for (const step of compilationSteps) {
    assert.match(step, /\n        env:\n          NODE_OPTIONS: --max-old-space-size=6144\n/)
  }
  const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8'))
  assert.ok(turbo.globalPassThroughEnv.includes('NODE_OPTIONS'))
})
