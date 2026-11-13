import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { needsHistoricalTests, selectCiScope } from '../testing/ci-scope.mjs'

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
        ['push', 'current', [1, 2, 3, 4, 5, 6, 7, 8]],
      ]) {
        const eventPath = join(directory, `${event}-event.json`)
        const outputPath = join(directory, `${event}-output`)
        writeFileSync(eventPath, JSON.stringify({ before: head, after: head }))
        execFileSync(process.execPath, [script], { cwd, env: { ...process.env,
          GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
        } })
        const output = Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map(line => line.split('=')))
        assert.equal(output.profile, profile)
        assert.equal(output.historical, String(profile === 'full'))
        assert.deepEqual(JSON.parse(output.shards), shards)
        assert.equal(Number(output.total), shards.length)
        assert.deepEqual(JSON.parse(output.matrix), { include: shards.map(shard => ({
          shard, timeoutMinutes: (profile === 'full' ? [9, 11] : [6, 8]).includes(shard) ? 45 : 20,
        })) })
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('runs exhaustive coverage on nightly/manual and unavailable or malformed history', () => {
    const unavailable = () => { throw new Error('Missing git history') }
    for (const event of ['schedule', 'workflow_dispatch', 'unknown', 'push', 'pull_request']) {
      assert.equal(selectCiScope(event, {}, unavailable).historical, true)
    }
    assert.equal(selectCiScope('push', { before: '0'.repeat(40), after: 'b'.repeat(40) }, () => '').historical, true)
    assert.equal(selectCiScope('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => 'apps/app-web/src/editor.tsx\0').historical, false)
  })
})
