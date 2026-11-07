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
    const buildSources = copiedSources(dockerfile.slice(buildStart, build))
    const appPackage = JSON.parse(readFileSync(resolve(root, `apps/${app}/package.json`), 'utf8')).name
    for (const name of workspaceClosure(appPackage)) {
      const { path } = packages.get(name)
      assert.ok(metadataSources.has(`${path}/package.json`), `${app}: missing ${name} manifest before install`)
      assert.ok(metadataSources.has(`${path}/tsconfig.json`), `${app}: missing ${name} TypeScript configuration before install`)
      assert.ok(buildSources.has(`${path}/src`), `${app}: missing ${name} sources before build`)
    }
  })
}
