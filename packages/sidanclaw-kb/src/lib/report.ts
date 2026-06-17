/**
 * CLI-side formatting of lint findings. Not consumed by the sync worker
 * (which logs findings through the API's regular logger).
 */

import type { Finding, Severity } from './types.js'

export type ReportOptions = {
  format: 'human' | 'json'
  quiet: boolean
  strict: boolean
}

const SEVERITY_LABEL: Record<Severity, string> = { error: 'error', warning: 'warn', info: 'info' }

const COLOR = {
  reset: '\x1b[0m',
  error: '\x1b[31m',
  warning: '\x1b[33m',
  info: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
}

export type ExitCode = 0 | 1

export function report(findings: Finding[], opts: ReportOptions): ExitCode {
  const visible = opts.quiet ? findings.filter((f) => f.severity === 'error') : findings
  const counts = countBySeverity(findings)

  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify({ summary: counts, findings: visible }, null, 2) + '\n')
  } else {
    printHuman(visible, counts)
  }

  if (counts.error > 0) return 1
  if (opts.strict && counts.warning > 0) return 1
  return 0
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

function printHuman(findings: Finding[], counts: Record<Severity, number>): void {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR
  const c = useColor ? COLOR : Object.fromEntries(Object.keys(COLOR).map((k) => [k, ''])) as typeof COLOR

  if (findings.length === 0) {
    process.stdout.write(`${c.bold}✓ kb lint: no findings${c.reset}\n`)
    writeSummary(c, counts)
    return
  }

  const bySource = new Map<string, Finding[]>()
  for (const f of findings) {
    const bucket = bySource.get(f.source) ?? []
    bucket.push(f)
    bySource.set(f.source, bucket)
  }

  for (const [source, fileFindings] of bySource) {
    process.stdout.write(`\n${c.bold}${source}${c.reset}\n`)
    for (const f of fileFindings) {
      const label = SEVERITY_LABEL[f.severity]
      const color = c[f.severity]
      const location = f.line !== undefined ? `:${f.line}` : ''
      process.stdout.write(
        `  ${color}${label}${c.reset} ${c.dim}${f.check}${location}${c.reset}\n` +
        `    ${f.message}\n`,
      )
      if (f.hint) process.stdout.write(`    ${c.dim}→ ${f.hint}${c.reset}\n`)
    }
  }
  process.stdout.write('\n')
  writeSummary(c, counts)
}

function writeSummary(c: typeof COLOR, counts: Record<Severity, number>): void {
  const parts: string[] = []
  if (counts.error > 0) parts.push(`${c.error}${counts.error} error${counts.error === 1 ? '' : 's'}${c.reset}`)
  if (counts.warning > 0) parts.push(`${c.warning}${counts.warning} warning${counts.warning === 1 ? '' : 's'}${c.reset}`)
  if (counts.info > 0) parts.push(`${c.info}${counts.info} info${c.reset}`)
  if (parts.length === 0) parts.push(`${c.dim}clean${c.reset}`)
  process.stdout.write(`${c.bold}Summary:${c.reset} ${parts.join(', ')}\n`)
}
