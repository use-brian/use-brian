import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'

const route = 'packages/api/src/routes/teamspaces.ts'

function fixture(t) {
  const platform = mkdtempSync(join(tmpdir(), 'fast checks '))
  const oss = join(platform, 'use-brian')
  const adapter = join(oss, 'scripts/hooks/after-edit-fast-checks.mjs')
  const calls = join(oss, 'calls.jsonl')
  mkdirSync(join(oss, 'scripts/hooks'), { recursive: true })
  mkdirSync(join(oss, 'scripts/testing'), { recursive: true })
  copyFileSync(new URL('../hooks/after-edit-fast-checks.mjs', import.meta.url), adapter)
  writeFileSync(join(oss, 'scripts/testing/run-fast-checks.mjs'), String.raw`
    import { appendFileSync } from 'node:fs'
    let paths
    export function selectFastChecks(files) {
      paths = files
      return files.includes(${JSON.stringify(route)}) ? ['teamspaces-contract'] : []
    }

    export function runFastChecks(selected, { writeError }) {
      appendFileSync(new URL('../../calls.jsonl', import.meta.url), JSON.stringify({ paths, selected }) + '\n')
      if (process.env.BRIAN_TEST_FAST_CHECK_FAIL) {
        writeError('Missing memberCount. Rerun pnpm check:fast --check teamspaces-contract.')
        return 1
      }
      return 0
    }
  `)
  t.after(() => rmSync(platform, { recursive: true, force: true }))

  function run(payload, fail = false) {
    const result = spawnSync(process.execPath, [adapter], {
      cwd: platform,
      encoding: 'utf8',
      input: typeof payload === 'string' ? payload : JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: platform,
        ...payload,
      }),
      env: { ...process.env, BRIAN_TEST_FAST_CHECK_FAIL: fail ? '1' : '' },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }

  return { platform, oss, calls, run }
}

describe('[COMP:tooling/fast-checks] coding-agent post-edit feedback', () => {
  test('Claude Edit passes the OSS-relative path and returns the shared diagnostic', (t) => {
    const { oss, calls, run } = fixture(t)
    const edited = join(oss, route)
    const feedback = JSON.parse(run({
      tool_name: 'Edit',
      tool_input: { file_path: edited, new_string: 'replacement' },
      tool_response: 'Edit completed',
    }, true))
    assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), {
      paths: [route],
      selected: ['teamspaces-contract'],
    })
    assert.deepEqual(feedback, {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Missing memberCount. Rerun pnpm check:fast --check teamspaces-contract.',
      },
    })
  })

  test('Codex apply_patch batches paths and handles moves, deletes and literal patch content', (t) => {
    const { oss, calls, run } = fixture(t)
    const moved = 'packages/api/teamspaces backup.ts'
    const added = 'test file $(echo not-shell).ts'
    assert.equal(run({
      tool_name: 'apply_patch',
      tool_input: { command: [
        "<<'EOF'",
        '*** Begin Patch',
        `*** Update File: use-brian/${route}`,
        `*** Move to: use-brian/${moved}`,
        `*** Add File: ${join(oss, added)}`,
        '+*** Update File: use-brian/this is file content.ts',
        '*** Delete File: use-brian/removed.ts',
        '*** Update File: apps/api/src/routes/teamspaces.ts',
        '@@',
        '-before',
        '+after',
        '*** End Patch',
        'EOF',
      ].join('\n') },
      tool_response: 'Success. Updated the following files:',
    }), '')
    assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), {
      paths: [route, moved, added, 'removed.ts'],
      selected: ['teamspaces-contract'],
    })
  })

  test('unrelated, out-of-checkout, failed and unsupported edits never launch the driver', (t) => {
    const { platform, oss, calls, run } = fixture(t)
    const outside = join(platform, 'out-of-checkout.ts')
    const symlink = join(oss, route)
    writeFileSync(outside, '')
    mkdirSync(dirname(symlink), { recursive: true })
    symlinkSync(outside, symlink)

    for (const payload of [
      'invalid JSON',
      { tool_name: 'Write', tool_input: { file_path: 'use-brian/README.md', content: route } },
      { tool_name: 'Write', tool_input: { file_path: `use-brian/../${route}` } },
      { tool_name: 'Write', tool_input: { file_path: join(platform, 'use-brian-other', route) } },
      { tool_name: 'Write', tool_input: { file_path: symlink } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: `use-brian/${route}` } },
      { tool_name: 'Bash', tool_input: { file_path: `use-brian/${route}` } },
      { tool_name: 'apply_patch', tool_input: { command: `*** Update File: use-brian/${route}` } },
    ]) {
      assert.equal(run(payload), '')
    }
    assert.equal(existsSync(calls), false)
  })
})
