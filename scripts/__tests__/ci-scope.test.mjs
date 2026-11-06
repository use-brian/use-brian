import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
  it('runs exhaustive coverage on nightly/manual and unavailable or malformed history', () => {
    const unavailable = () => { throw new Error('Missing git history') }
    for (const event of ['schedule', 'workflow_dispatch', 'unknown', 'push', 'pull_request']) {
      assert.equal(selectCiScope(event, {}, unavailable).historical, true)
    }
    assert.equal(selectCiScope('push', { before: '0'.repeat(40), after: 'b'.repeat(40) }, () => '').historical, true)
    assert.equal(selectCiScope('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => 'apps/app-web/src/editor.tsx\0').historical, false)
  })
})
