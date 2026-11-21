/** [COMP:ci/execution-topology] Clean Docker builds need the complete workspace compilation graph. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { copiedSources, imageMatrix, selectDockerScope, workspaceClosure, workspacePackages } from '../testing/docker-scope.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const packages = workspacePackages(root)

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
    for (const name of workspaceClosure(packages, appPackage)) {
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
    /run: pnpm (?:build|typecheck)\n|run: pnpm exec turbo run build --filter='\.\/packages\/\*'|run: >-\n          pnpm exec turbo run test\n/.test(step))
  assert.ok(compilationSteps.length >= 4, 'locate the API compilation steps before checking their budgets')
  for (const step of compilationSteps) {
    assert.match(step, /\n        env:\n          NODE_OPTIONS: --max-old-space-size=6144\n/)
  }
  const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8'))
  assert.ok(turbo.globalPassThroughEnv.includes('NODE_OPTIONS'))
})

test('[COMP:ci/execution-topology] selects actual Docker contexts and workspace consumers, and uses the full image set on uncertain or release inputs', () => {
  const event = { before: 'a'.repeat(40), after: 'b'.repeat(40), ref: 'refs/heads/develop' }
  const selected = (...paths) => selectDockerScope('push', event, () => paths.join('\0'))
  const names = scope => scope.matrix.include.map(item => item.image)
  assert.deepEqual(names(selected('apps/wa-connector/src/index.ts')), ['app-web', 'auth-web', 'wa-connector'])
  assert.deepEqual(names(selected('apps/wechat-desktop-bridge/src/index.ts')), ['app-web', 'auth-web', 'wechat-desktop-bridge'])
  assert.deepEqual(names(selected('packages/shared/src/model-registry.ts')),
    ['api', 'app-web', 'auth-web', 'browser-relay', 'discord-connector', 'doc-sync', 'feishu-connector', 'wechat-connector'])
  assert.deepEqual(names(selected('packages/api/migrations/9000_fictional.sql')), ['api', 'app-web', 'auth-web', 'browser-relay', 'doc-sync'])
  for (const path of ['pnpm-lock.yaml', 'patches/library.patch', 'apps/doc-sync/package.json', 'unrecognized-input.yml', 'apps/unrecognized/src/index.ts']) {
    assert.deepEqual(selected(path).matrix.include, imageMatrix, path)
  }
  const unavailable = () => { throw new Error('Missing base') }
  assert.deepEqual(selectDockerScope('push', event, unavailable).matrix.include, imageMatrix)
  assert.deepEqual(selectDockerScope('push', { ...event, ref: 'refs/tags/v1.2.3' }, unavailable).matrix.include, imageMatrix)
  assert.deepEqual(selectDockerScope('workflow_dispatch', {}, unavailable).matrix.include, imageMatrix)
  assert.throws(() => copiedSources('COPY ["source", "."]'), /Unknown Docker copy input/)
  assert.throws(() => copiedSources('RUN --network=none --mount=type=bind,source=other echo hello'), /Unknown Docker context input/)
})

test('[COMP:ci/execution-topology] the workflow scope step selects a changed app, unknown input, and both sides of renames', t => {
  const repository = mkdtempSync(join(tmpdir(), 'docker-scope-'))
  t.after(() => rmSync(repository, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' })
  const fixture = path => {
    const file = join(repository, path)
    mkdirSync(dirname(file), { recursive: true })
    return file
  }
  const old = fixture('apps/wa-connector/src/fixture.ts')
  const removed = fixture('apps/discord-connector/src/removed.ts')
  const moved = fixture('apps/feishu-connector/src/fixture.ts')
  git(['init', '--quiet'])
  const commit = () => {
    git(['add', '-A'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
    return git(['rev-parse', 'HEAD']).trim()
  }
  const scopeStep = (name, event) => {
    const eventPath = join(repository, '.git', 'fixture-event.json'), outputs = join(repository, '.git', 'fixture-outputs')
    writeFileSync(eventPath, JSON.stringify(event))
    rmSync(outputs, { force: true })
    execFileSync(process.execPath, [resolve(root, 'scripts/testing/docker-scope.mjs')], { cwd: repository, env: { ...process.env,
      GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputs } })
    const matrix = JSON.parse(readFileSync(outputs, 'utf8').trim().slice('matrix='.length))
    return matrix.include.map(item => item.image)
  }
  const push = (before, after) => scopeStep('push', { before, after, ref: 'refs/heads/develop' })
  writeFileSync(old, 'example')
  writeFileSync(removed, 'removed example')
  const before = commit()
  writeFileSync(old, 'example application update')
  const wa = commit()
  assert.deepEqual(push(before, wa), ['app-web', 'auth-web', 'wa-connector'])
  writeFileSync(fixture('.npmrc'), 'strict-peer-dependencies=true\n')
  const unknown = commit()
  assert.deepEqual(push(wa, unknown), imageMatrix.map(item => item.image))
  renameSync(old, moved)
  rmSync(removed)
  const after = commit()
  assert.deepEqual(scopeStep('pull_request', { pull_request: { head: { sha: after }, base: { sha: unknown } } }),
    ['app-web', 'auth-web', 'discord-connector', 'feishu-connector', 'wa-connector'])
})

test('[COMP:ci/execution-topology] validation and publication share the matrix without exposing registry writes on PRs', () => {
  const yaml = createRequire(new URL('../../apps/app-desktop/package.json', import.meta.url))('js-yaml')
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/docker-images.yml'), 'utf8'))
  const { validate, build, publish, scope } = workflow.jobs
  assert.equal(workflow.on.pull_request, null)
  assert.deepEqual(workflow.on.push, { branches: ['main', 'develop'], tags: ['v*'] })
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(validate.permissions, undefined)
  assert.equal(scope.permissions, undefined)
  assert.equal(validate.if, "github.event_name == 'pull_request'")
  assert.equal(scope.outputs.matrix, '${{ steps.images.outputs.matrix }}')
  assert.equal(scope.steps.find(step => step.id === 'images').run, 'node scripts/testing/docker-scope.mjs')
  for (const job of [validate, build, publish]) {
    assert.equal(job.strategy.matrix, '${{ fromJSON(needs.scope.outputs.matrix) }}')
  }
  for (const job of [build, publish]) assert.equal(job.if, "github.event_name != 'pull_request'")
  assert.deepEqual(publish.needs, ['scope', 'build'])
  assert.match(build.steps.find(step => step.id === 'build').with.outputs, /push-by-digest=true/)
  assert.equal(build.steps.find(step => step.uses === 'actions/upload-artifact@v4').with.name, 'digest-${{ matrix.image }}')
  assert.equal(publish.steps.find(step => step.uses === 'actions/download-artifact@v4').with.name, 'digest-${{ matrix.image }}')
  assert.match(publish.steps.find(step => step.name === 'Publish image tags').run, /docker buildx imagetools create[\s\S]*\$IMAGE@sha256:\$digest/)
})
