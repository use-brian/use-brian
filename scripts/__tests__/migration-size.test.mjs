// [COMP:invariants/migrations] Exercise the real pre-commit hook against a disposable index.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const guard = join(root, 'scripts/hooks/check-migration-size.mjs')
const dir = 'packages/api/migrations'
const limit = 65536
const historical = '8338_native_workspace_skill_receipts.sql'

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'migration-size-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  function run(command, args, status = 0) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stderr + result.stdout)
    return result.stderr + result.stdout
  }
  const git = (...args) => run('git', args)
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'Fixture')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', join(root, '.githooks'))
  mkdirSync(join(cwd, dir), { recursive: true })
  return { cwd, git, run, check: (mode, status) => run(process.execPath, [guard, mode], status) }
}

test('blocks oversized staged bytes in an actual commit even after a smaller working-tree edit', t => {
  const { cwd, git, run, check } = fixture(t)
  const migration = dir + '/9000_example.sql'
  writeFileSync(join(cwd, migration), 'é'.repeat(limit / 2) + '\n')
  assert.match(check('--edits', 1), /65537 working-tree bytes/)
  git('add', '--', migration)
  writeFileSync(join(cwd, migration), 'BEGIN; COMMIT;\n')
  check('--edits')
  assert.match(run('git', ['commit', '-m', 'fixture'], 1), /65537 staged bytes/)
  writeFileSync(join(cwd, migration), ' '.repeat(limit))
  git('add', '--', migration)
  git('commit', '-qm', 'boundary')
  check('--files')
})

test('the historical file passes only under its original name with its original content', t => {
  const { cwd, git, check } = fixture(t)
  const path = join(cwd, dir, historical)
  copyFileSync(join(root, dir, historical), path)
  git('add', '--', dir)
  git('commit', '-qm', 'original')
  check('--files')
  const copy = join(cwd, dir, '9000_generated.sql')
  renameSync(path, copy)
  assert.match(check('--files', 1), /9000_generated\.sql.*2964336/)
  git('add', '-A', '--', dir)
  assert.match(check('--staged', 1), /9000_generated\.sql/)
  writeFileSync(path, ' '.repeat(limit + 1))
  assert.match(check('--edits', 1), /8338_native_workspace_skill_receipts\.sql.*65537/)
})

test('checks hosted SQL, nested OSS edits, and generated files in a build without Git', t => {
  const { cwd, git, run, check } = fixture(t)
  const hosted = 'packages/api-platform/migrations'
  mkdirSync(join(cwd, hosted), { recursive: true })
  writeFileSync(join(cwd, hosted, '9998_hosted.sql'), ' '.repeat(limit + 1))
  assert.match(check('--edits', 1), /9998_hosted/)
  git('add', '--', hosted)
  assert.match(check('--staged', 1), /9998_hosted/)
  const nested = join(cwd, 'use-brian')
  mkdirSync(join(nested, dir), { recursive: true })
  run('git', ['-C', nested, 'init', '-q'])
  writeFileSync(join(nested, dir, '9999_open.sql'), ' '.repeat(limit + 1))
  assert.match(check('--edits', 1), /9999_open/)
  rmSync(join(cwd, '.git'), { recursive: true })
  const errors = check('--files', 1)
  assert.match(errors, /9998_hosted/)
  assert.match(errors, /9999_open/)
})

test('rejects SQL symlinks at commit and build boundaries', { skip: process.platform === 'win32' }, t => {
  const { cwd, git, check } = fixture(t)
  writeFileSync(join(cwd, 'generated'), ' '.repeat(limit + 1))
  symlinkSync('../../../generated', join(cwd, dir, '9000_link.sql'))
  git('add', '--', dir)
  assert.match(check('--staged', 1), /regular file/)
  assert.match(check('--files', 1), /regular file/)
})

test('denies a proposed oversized Codex add or Claude Write before the file exists', t => {
  const { cwd } = fixture(t)
  const path = dir + '/9000_proposed.sql'
  const body = 'é'.repeat(limit / 2)
  const patch = (path, text) => ({ command: ['*** Begin Patch', '*** Add File: ' + path, '+' + text, '*** End Patch'].join('\n') })
  for (const [tool_name, tool_input, status] of [
    ['apply_patch', patch(path, body), 2],
    ['Write', { file_path: join(cwd, path), content: body + '\n' }, 2],
    ['Write', { file_path: path, content: body }, 0],
    ['apply_patch', patch('example.sql', body), 0],
  ]) {
    const result = spawnSync(process.execPath, [guard, '--before-write'], {
      cwd, encoding: 'utf8', input: JSON.stringify({ cwd, hook_event_name: 'PreToolUse', tool_name, tool_input }),
    })
    assert.equal(result.status, status, result.stderr)
    if (status === 2) assert.match(result.stderr, /would be 65537 bytes/)
  }
})
