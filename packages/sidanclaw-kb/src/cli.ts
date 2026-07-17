#!/usr/bin/env node
import { runLintCommand } from './commands/lint.js'

type ParsedArgs = {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

const HELP = `kb — Use Brian knowledge base CLI

Usage:
  kb lint [<dir>] [flags]    Audit a KB directory

Flags for lint:
  --json                     Machine-readable output for CI
  --quiet                    Suppress warnings and info; errors only
  --strict                   Exit non-zero on warnings (default: errors only)

To start a new KB, use the template directly:
  https://github.com/use-brian/brian-kb-template  ("Use this template")

To ingest content from any existing source (Notion, Confluence, Google Docs,
markdown tree, pasted email, meeting transcript), invoke the kb-author skill
in a Use Brian chat — the model is the universal adapter.

Docs: https://github.com/use-brian/use-brian/tree/main/packages/sidanclaw-kb
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command || args.flags.help || args.command === '--help' || args.command === '-h') {
    process.stdout.write(HELP)
    return
  }

  switch (args.command) {
    case 'lint':
      await runLintCommand(args.positional, args.flags)
      break
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}`)
      process.exit(2)
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
