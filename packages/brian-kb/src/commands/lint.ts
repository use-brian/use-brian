/**
 * `kb lint` — CLI command. Thin wrapper around walkKbFromFs + runAllChecks + report.
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'
import { walkKbFromFs } from '../lib/kb-index.js'
import { runAllChecks } from '../lib/checks.js'
import { report } from '../lib/report.js'

export async function runLintCommand(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const target = positional[0] ?? '.'
  const absTarget = path.resolve(target)

  try {
    const s = await stat(absTarget)
    if (!s.isDirectory()) {
      process.stderr.write(`kb lint: ${target} is not a directory.\n`)
      process.exit(2)
    }
  } catch {
    process.stderr.write(`kb lint: path not found: ${target}\n`)
    process.exit(2)
  }

  const index = await walkKbFromFs(absTarget)
  if (index.entries.length === 0) {
    process.stderr.write(`kb lint: no .md files found in ${target}.\n`)
    process.exit(2)
  }

  const findings = runAllChecks(index)
  const exit = report(findings, {
    format: flags.json ? 'json' : 'human',
    quiet: Boolean(flags.quiet),
    strict: Boolean(flags.strict),
  })
  process.exit(exit)
}
