import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFastChecks, selectFastChecks } from '../testing/run-fast-checks.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

function patchPaths(patch) {
  if (typeof patch !== 'string') return []

  const lines = patch.trim().split(/\r?\n/)
  // Codex also accepts the literal EOF wrapper used by some model versions.
  if (/^<<(['"]?)EOF\1$/.test(lines[0]) && lines.at(-1) === 'EOF') {
    lines.shift()
    lines.pop()
  }
  if (lines.shift()?.trim() !== '*** Begin Patch' || lines.pop()?.trim() !== '*** End Patch') return []

  return lines.flatMap((line) => {
    const header = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line)
    return header ? [header[1]] : []
  })
}

function resolveEditedPath(path) {
  // Renamed and deleted paths can be missing, including their leaf directory.
  let ancestor = path
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), relative(ancestor, path))
    } catch (error) {
      const parent = dirname(ancestor)
      if (error.code !== 'ENOENT' || parent === ancestor) return null
      ancestor = parent
    }
  }
}

function changedFiles(payload) {
  if (payload?.hook_event_name !== 'PostToolUse') return []
  if (typeof payload.cwd !== 'string' || !isAbsolute(payload.cwd) || payload.cwd.includes('\0')) return []

  const { tool_name, tool_input } = payload
  let paths
  if (tool_name === 'apply_patch') {
    paths = patchPaths(tool_input?.command)
  } else if (tool_name === 'Edit' || tool_name === 'Write') {
    paths = [tool_input?.file_path]
  } else {
    return []
  }

  return [...new Set(paths.flatMap((path) => {
    if (typeof path !== 'string' || !path || path.includes('\0')) return []
    const edited = resolveEditedPath(resolve(payload.cwd, path))
    if (!edited) return []
    const file = relative(repoRoot, edited)
    return file && !isAbsolute(file) && file !== '..' && !file.startsWith(`..${sep}`) ? [file] : []
  }))]
}

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

const selected = selectFastChecks(changedFiles(readEvent()))
if (selected.length > 0) {
  let output = ''
  let errors = ''
  const status = runFastChecks(selected, {
    writeOutput: (text) => { output += text },
    writeError: (text) => { errors += text },
    timeoutMs: 25_000,
  })
  if (status !== 0) {
    const diagnostic = `${errors.trim().slice(-3500)}\n${output.trim().slice(-1000)}`.trim()
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: diagnostic || 'The fast check stopped. Rerun pnpm check:fast --all from the OSS checkout.',
      },
    })}\n`)
  }
}
