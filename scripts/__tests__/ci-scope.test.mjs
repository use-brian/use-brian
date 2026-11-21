import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { needsHistoricalTests, selectCiScope } from '../testing/ci-scope.mjs'
import { summarizeCiTiming } from '../testing/ci-timing.mjs'

describe('[COMP:ci/execution-topology] historical coverage selection', () => {
  it('includes database sources, tooling, tests, dependencies and renamed/deleted inputs', () => {
    for (const path of ['packages/api/migrations/9000_fixture.sql', 'packages/api/src/db/access.ts',
      'packages/api/src/context-scope/policy.ts', 'packages/api/src/application-platform/fixture.ts',
      'apps/api/src/__tests__/session-schema.integration.test.ts', 'scripts/crm/local-fixture.mjs',
      'scripts/testing/ci-scope.mjs', '.github/workflows/ci.yml', 'pnpm-lock.yaml', 'packages/core/package.json',
      'tsconfig.json', 'apps/api/tsconfig.build.json']) {
      assert.equal(needsHistoricalTests([path]), true, path)
    }
    assert.equal(needsHistoricalTests(['apps/app-web/src/editor.tsx', 'docs/example.md']), false)
  })
  it('compares the entire push range and the PR merge base, retaining NUL-separated names', () => {
    const before = 'a'.repeat(40), after = 'b'.repeat(40), mergeBase = 'c'.repeat(40)
    const commands = []
    const git = args => { commands.push(args); return args[0] === 'merge-base' ? mergeBase : 'docs/one\nfile.md\0packages/api/migrations/deleted.sql\0' }
    assert.equal(selectCiScope('push', { before, after }, git).historical, true)
    assert.deepEqual(commands[0], ['diff', '--name-only', '--no-renames', '-z', before, after])
    commands.length = 0
    assert.equal(selectCiScope('pull_request', { pull_request: { base: { sha: before }, head: { sha: after } } }, git).historical, true)
    assert.deepEqual(commands[1].slice(-2), [mergeBase, after])
  })
  it('emits the complete production matrix from the same topology used by acceptance receipts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'brian-ci-scope-'))
    const cwd = fileURLToPath(new URL('../../', import.meta.url))
    const script = fileURLToPath(new URL('../testing/ci-scope.mjs', import.meta.url))
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    try {
      for (const [event, profile, shards] of [
        ['schedule', 'full', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
        ['workflow_dispatch', 'full', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
        ['push', 'current', [1, 2, 3, 4, 5, 6, 7, 8]],
      ]) {
        const eventPath = join(directory, `${event}-event.json`)
        const outputPath = join(directory, `${event}-output`)
        writeFileSync(eventPath, JSON.stringify({ before: head, after: head, inputs: { compare_calendar_arm: 'true' } }))
        execFileSync(process.execPath, [script], { cwd, env: { ...process.env, RUNNER_TEMP: directory,
          GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_SHA: head,
        } })
        const output = Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map(line => line.split('=')))
        assert.equal(output.profile, profile)
        assert.equal(output.historical, String(profile === 'full'))
        assert.deepEqual(JSON.parse(output.shards), shards)
        assert.equal(Number(output.total), shards.length)
        const longest = profile === 'full' ? [11, 9] : [8, 6]
        const order = [...longest, ...shards.filter(shard => !longest.includes(shard))]
        const expected = order.map(shard => ({
          shard, timeoutMinutes: longest.includes(shard) ? 45 : 20, runner: 'ubuntu-latest',
          labelSuffix: '', artifactName: `department-isolation-shard-${shard}`,
        }))
        const [calendar, ...remaining] = expected
        const comparison = event === 'workflow_dispatch' ? [{ ...calendar, runner: 'ubuntu-24.04-arm',
          labelSuffix: ' ARM64 comparison', artifactName: 'calendar-comparison-arm64' }] : []
        assert.deepEqual(JSON.parse(output.calendar).include, [...comparison, calendar])
        assert.deepEqual(JSON.parse(output.matrix).include, remaining)
        const report = JSON.parse(readFileSync(join(directory, 'ci-change-impact.json'), 'utf8'))
        assert.equal(report.revision, head)
        assert.equal(report.event, event)
        assert.deepEqual(report.proposed, { profile: 'full', jobs: null })
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('bounds PostgreSQL key downloads and retries TLS/read failures without disabling verification', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const install = workflow.match(/name: Install PostgreSQL 18 with required extensions\n([\s\S]*?)(?=\n      - )/)?.[1]
    assert.ok(install, 'PostgreSQL installation step must exist')
    assert.match(install, /sudo curl --fail --show-error --location \\/)
    assert.match(install, /--retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 180/)
    assert.match(install, /--connect-timeout 15 --max-time 60/)
    assert.match(install, /https:\/\/www\.postgresql\.org\/media\/keys\/ACCC4CF8\.asc/)
    assert.doesNotMatch(install, /--insecure|(?:^|\s)-k(?:\s|$)|--allow-unauthenticated|trusted=yes/)
    assert.match(install, /signed-by=\/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc/)
    assert.match(install, /sudo apt-get install -y postgresql-18 postgresql-18-pgvector/)
  })

  it('runs exhaustive coverage on nightly/manual and unavailable or malformed history', () => {
    const unavailable = () => { throw new Error('Missing git history') }
    for (const event of ['schedule', 'workflow_dispatch', 'unknown', 'push', 'pull_request']) {
      assert.equal(selectCiScope(event, {}, unavailable).historical, true)
    }
    assert.equal(selectCiScope('push', { before: '0'.repeat(40), after: 'b'.repeat(40) }, () => '').historical, true)
    assert.equal(selectCiScope('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => 'apps/app-web/src/editor.tsx\0').historical, false)
  })

  it('proposes focused coverage only for Markdown and isolated app-web source, including its desktop and authority-UI consumers', () => {
    const event = { before: 'a'.repeat(40), after: 'b'.repeat(40) }
    const scope = (...paths) => selectCiScope('push', event, () => [...paths, ''].join('\0'))
    assert.deepEqual(scope('docs/multiline\nfile.md', 'README.md').proposed, { profile: 'markdown', jobs: ['build-typecheck'] })
    assert.deepEqual(scope('apps/app-web/src/editor.tsx', 'README.md').proposed,
      { profile: 'app-web', jobs: ['build-typecheck', 'app-web-tests', 'heavyweight-tests', 'offline-continuity', 'department-isolation-shards'] })
    for (const paths of [[], ['packages/shared/src/permissions.ts'], ['scripts/testing/ci-scope.mjs'],
      ['pnpm-lock.yaml'], ['apps/app-web/package.json'], ['apps/app-web/next.config.mjs'],
      ['packages/api/src/security/old.ts', 'apps/app-web/src/new.ts']]) {
      assert.deepEqual(scope(...paths).proposed, { profile: 'full', jobs: null }, paths.join(', '))
    }
  })

  it('separates waiting for job eligibility, queued time, and parallel runner time for the same attempt', () => {
    const at = seconds => new Date(Date.UTC(2026, 10, 21, 0, 0, seconds)).toISOString()
    const run = { id: 15, run_attempt: 2, status: 'completed', conclusion: 'success', created_at: at(0), run_started_at: at(10) }
    const job = (name, eligible, start, end, extra) => ({ name, run_id: 15, run_attempt: 2,
      status: 'completed', created_at: at(eligible), started_at: at(start), completed_at: at(end), conclusion: 'success', ...extra })
    const jobs = [job('database-test-dependencies', 10, 20, 30),
      job('Department isolation (6/8)', 30, 31, 52),
      job('Department isolation (8/8)', 12, 14, 55, { steps: [{ name: 'Run no-credential acceptance', started_at: at(20), completed_at: at(54) }] }),
      job('Department isolation acceptance', 55, 57, 58),
      job('build-test', 58, 59, 61),
      job('Embedded database tests', 10, 10, 10, { conclusion: 'skipped' })]
    const timing = summarizeCiTiming(run, { total_count: jobs.length, jobs })
    assert.equal(timing.workflowToGateSeconds, 61)
    assert.equal(timing.attemptToGateSeconds, 51)
    assert.equal(timing.runnerSeconds, 75)
    assert.equal(timing.lastBeforeGate, 'Department isolation acceptance')
    assert.deepEqual(timing.departmentShardsByCompletion, ['Department isolation (8/8)', 'Department isolation (6/8)'])
    const calendar = timing.jobs.find(item => item.name === 'Department isolation (8/8)')
    assert.equal(calendar.beforeEligibleSeconds, 2)
    assert.equal(calendar.queueSeconds, 2)
    assert.equal(calendar.runnerSeconds, 41)
    assert.equal(calendar.steps[0].seconds, 34)
    assert.throws(() => summarizeCiTiming(run, { total_count: jobs.length + 1, jobs }), /complete job list/)
    assert.throws(() => summarizeCiTiming({ ...run, run_attempt: 3 }, { total_count: jobs.length, jobs }), /complete job list/)
    const staleSnapshot = jobs.map(item => item.name === 'build-test' ? { ...item, status: 'queued' } : item)
    assert.throws(() => summarizeCiTiming(run, { total_count: staleSnapshot.length, jobs: staleSnapshot }), /complete job list/)
  })
})
