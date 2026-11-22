// [COMP:invariants/migrations] Shared by the editor, Git pre-commit and CI.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const limit = 64 * 1024
const dirs = ['packages/api/migrations', 'packages/api-platform/migrations']
const pathspecs = dirs.map(dir => `:(top,glob)${dir}/*.sql`)
// Exact paths and Git blobs over the limit at OSS commit 343db5b37. Keep this snapshot frozen.
const snapshot = readFileSync(new URL('./legacy-oversized-migrations.txt', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
if (createHash('sha256').update(snapshot).digest('hex') !== 'ef82432e242c2d5dcccad7961e7589c4e2af4590647f475a02b65d7d342d0ef2') {
  throw new Error('The historical migration size exceptions changed')
}
const legacy = new Map(snapshot.trimEnd().split('\n').map(line => [line.slice(41), line.slice(0, 40)]))

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 })
}

function paths(args) {
  return git([...args, '-z', '--', ...pathspecs]).split('\0').filter(Boolean)
}

function violation(path, reason) {
  process.stderr.write(`Migration size guard: ${JSON.stringify(path)} ${reason}. Keep new SQL within ${limit} bytes (64 KiB); write the change as a delta and reuse versioned verification artifacts.\n`)
  process.exitCode = 1
}

function checkIndex() {
  // Read the index selected by Git, including the temporary index for a partial commit.
  const pending = []
  for (const entry of paths(['ls-files', '--stage'])) {
    const tab = entry.indexOf('\t')
    const path = entry.slice(tab + 1)
    const [mode, oid, stage] = entry.slice(0, tab).split(' ')
    if (stage !== '0' || !['100644', '100755'].includes(mode)) {
      violation(path, 'must be a resolved regular file')
    } else if (legacy.get(path) !== oid) {
      pending.push({ path, oid })
    }
  }
  if (!pending.length) return
  const stats = git(['cat-file', '--batch-check=%(objecttype) %(objectsize)'],
    pending.map(file => file.oid).join('\n') + '\n').trimEnd().split('\n')
  for (const [index, { path }] of pending.entries()) {
    const match = /^blob (\d+)$/.exec(stats[index])
    if (!match) throw new Error(`Cannot inspect staged migration ${JSON.stringify(path)}`)
    if (Number(match[1]) > limit) violation(path, `is ${match[1]} staged bytes`)
  }
}

function checkEdits() {
  const changed = new Set([
    ...paths(['ls-files', '--modified', '--others']),
    ...paths(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMT']),
  ])
  for (const path of changed) checkFile(path, path)
}

function checkFile(path, migrationPath) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return // Deleted or renamed away.
  if (!stat.isFile()) return violation(path, 'must be a regular file')
  if (stat.size <= limit) return
  if (legacy.has(migrationPath) && matchesLegacy(migrationPath, readFileSync(path))) return
  violation(path, `is ${stat.size} working-tree bytes`)
}

function matchesLegacy(path, bytes) {
  // Reproduce the Git blob ID when inspecting a proposed write or a Git-free build.
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === legacy.get(path)
}

function checkProposedWrite(event) {
  if (event.hook_event_name !== 'PreToolUse' || typeof event.cwd !== 'string') return
  function inspect(path, content) {
    if (typeof path !== 'string' || !path.endsWith('.sql') || typeof content !== 'string') return
    const file = relative(process.cwd(), resolve(event.cwd, path)).split(sep).join('/')
    const ownPath = file.startsWith('use-brian/') && existsSync('use-brian/.git') ? file.slice('use-brian/'.length) : file
    if (!dirs.includes(dirname(ownPath).split(sep).join('/'))) return
    const bytes = Buffer.from(content)
    if (bytes.length <= limit || (legacy.has(ownPath) && matchesLegacy(ownPath, bytes))) return
    violation(file, `would be ${bytes.length} bytes`)
    process.exitCode = 2 // PreToolUse consumes stderr and cancels the edit.
  }

  const input = event.tool_input
  if (event.tool_name === 'Write') inspect(input?.file_path, input?.content)
  if (event.tool_name !== 'apply_patch') return
  const patch = typeof input === 'string' ? input : input?.command ?? input?.patch
  if (typeof patch !== 'string') return
  const lines = patch.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('*** Add File: ')) continue
    const path = lines[index].slice('*** Add File: '.length)
    const added = []
    while (lines[index + 1]?.startsWith('+')) added.push(lines[++index].slice(1))
    inspect(path, added.length ? added.join('\n') + '\n' : '')
  }
}

function checkFiles() {
  const roots = existsSync('use-brian/packages/api/migrations') ? ['', 'use-brian/'] : ['']
  for (const root of roots) {
    for (const dir of dirs) {
      if (!existsSync(root + dir)) continue
      for (const name of readdirSync(root + dir)) {
        if (name.endsWith('.sql')) checkFile(root + dir + '/' + name, dir + '/' + name)
      }
    }
  }
}

try {
  const [mode, ...extra] = process.argv.slice(2)
  if (extra.length || !['--staged', '--edits', '--files', '--before-write'].includes(mode)) throw new Error('Expected --staged, --edits, --files or --before-write')
  if (mode === '--files') {
    checkFiles()
  } else {
    process.chdir(git(['rev-parse', '--show-toplevel']).trimEnd())
    if (mode === '--staged') checkIndex()
    else if (mode === '--before-write') checkProposedWrite(JSON.parse(readFileSync(0, 'utf8')))
    else {
      checkEdits()
      if (existsSync('use-brian/.git') && existsSync('use-brian/packages/api/migrations')) {
        process.chdir('use-brian')
        checkEdits()
      }
    }
  }
} catch (error) {
  console.error(`Migration size guard failed: ${error.message}`)
  process.exitCode = 1
}
