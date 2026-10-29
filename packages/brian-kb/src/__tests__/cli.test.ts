import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
let fixtureRoot: string
let executable: string
let workingDirectory: string
let targetDirectory: string
let warningsDirectory: string
let emptyDirectory: string
let quotedDirectory: string

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' }
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: workingDirectory,
    env: isolatedEnvironment(),
    encoding: 'utf8',
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

type JsonReport = {
  summary: { error: number; warning: number; info: number }
  findings: Array<{ source: string; check: string; severity: string }>
}

beforeAll(() => {
  fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'brian-kb-cli-')))
  const buildDirectory = path.join(fixtureRoot, 'compiled')
  // Compile the actual current package once. Never execute a potentially stale
  // repository dist or duplicate the argument parser in this regression.
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    '--project', path.join(packageRoot, 'tsconfig.json'),
    '--outDir', buildDirectory, '--declaration', 'false'], {
    cwd: packageRoot,
    env: isolatedEnvironment(),
    timeout: 20_000,
  })
  writeFileSync(path.join(buildDirectory, 'package.json'), '{"type":"module"}\n')
  executable = path.join(buildDirectory, 'cli.js')
  workingDirectory = path.join(fixtureRoot, 'working-directory')
  targetDirectory = path.join(fixtureRoot, 'explicit-target')
  warningsDirectory = path.join(fixtureRoot, 'warnings-target')
  emptyDirectory = path.join(fixtureRoot, 'empty-target')
  quotedDirectory = path.join(fixtureRoot, 'quoted-target')
  for (const directory of [workingDirectory, targetDirectory, warningsDirectory, emptyDirectory, quotedDirectory]) {
    mkdirSync(directory)
  }
  for (const [directory, entry] of [
    [workingDirectory, 'cwd-only'], [targetDirectory, 'target-only'], [warningsDirectory, 'warnings-only'],
  ]) {
    writeFileSync(path.join(directory, 'index.md'),
      `---\ntitle: Synthetic index\ndescription: Fixture orientation\ntags: [fixture]\nsensitivity: internal\n---\n[[${entry}]]\n`)
  }
  writeFileSync(path.join(workingDirectory, 'cwd-only.md'),
    '---\ntitle: Working directory\ndescription: Synthetic cwd entry\ntags: [fixture]\nsensitivity: invalid-cwd-tier\n---\n# Cwd\n')
  writeFileSync(path.join(targetDirectory, 'target-only.md'),
    '---\ntitle: Explicit target\ntags: [fixture]\nsensitivity: invalid-target-tier\n---\n# Target\n')
  writeFileSync(path.join(warningsDirectory, 'warnings-only.md'), '# Synthetic warning-only entry\n')
  writeFileSync(path.join(quotedDirectory, 'index.md'),
    '---\ntitle: Quoted scalar fixtures\ndescription: Synthetic orientation\ntags: [fixture]\nsensitivity: internal\n---\n[[quoted-single]]\n[[quoted-double]]\n')
  for (const [name, quote, eol] of [['quoted-single', "'", '\n'], ['quoted-double', '"', '\r\n']] as const) {
    writeFileSync(path.join(quotedDirectory, `${name}.md`),
      ['---', `title: ${quote}true${quote}`, `description: ${quote}123${quote}`, 'tags: [fixture]', 'sensitivity: internal', '---', '# Synthetic content', ''].join(eol))
  }
}, 30_000)

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('[COMP:knowledge/cli] executable lint directory and boolean flags', () => {
  it.each(['before', 'after'] as const)('JSON flag %s the directory audits only the explicit target', order => {
    const result = run(['lint', ...(order === 'before' ? ['--json', targetDirectory] : [targetDirectory, '--json'])])
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as JsonReport
    expect(report.summary.error).toBeGreaterThan(0)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.findings.every(finding => finding.source.startsWith(`${targetDirectory}${path.sep}`))).toBe(true)
    expect(result.stdout).toContain('target-only.md')
    expect(result.stdout).not.toContain('cwd-only.md')
  })

  it.each(['before', 'after'] as const)('quiet flag %s the directory filters the target findings', order => {
    const args = order === 'before'
      ? ['lint', '--json', '--quiet', targetDirectory]
      : ['lint', targetDirectory, '--json', '--quiet']
    const result = run(args)
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as JsonReport
    expect(report.summary.warning).toBeGreaterThan(0)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.findings.every(finding => finding.severity === 'error')).toBe(true)
    expect(report.findings.every(finding => finding.source.startsWith(`${targetDirectory}${path.sep}`))).toBe(true)
    expect(result.stdout).not.toContain('cwd-only.md')
  })

  it.each(['before', 'after'] as const)('strict flag %s the directory changes warning-only exit status', order => {
    const ordinary = run(['lint', warningsDirectory, '--json'])
    expect(ordinary.status).toBe(0)
    const result = run(order === 'before'
      ? ['lint', '--json', '--strict', warningsDirectory]
      : ['lint', warningsDirectory, '--json', '--strict'])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as JsonReport
    expect(report.summary.error).toBe(0)
    expect(report.summary.warning).toBeGreaterThan(0)
    expect(report.findings.every(finding => finding.source.startsWith(`${warningsDirectory}${path.sep}`))).toBe(true)
    expect(result.stdout).toContain('warnings-only.md')
    expect(result.stdout).not.toContain('cwd-only.md')
  })

  it('defaults to the process working directory when no directory is given', () => {
    const result = run(['lint', '--json'])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as JsonReport
    expect(report.findings.every(finding => finding.source.startsWith(`${workingDirectory}${path.sep}`))).toBe(true)
    expect(result.stdout).toContain('cwd-only.md')
    expect(result.stdout).not.toContain('target-only.md')
  })

  it.each(['before', 'after'] as const)('help %s a missing directory does not lint it', order => {
    const missing = path.join(fixtureRoot, 'missing')
    const result = run(order === 'before' ? ['lint', '--help', missing] : ['lint', missing, '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stderr).toBe('')
  })

  it('retains invocation errors for explicit missing and empty targets', () => {
    const missing = path.join(fixtureRoot, 'missing')
    const missingResult = run(['lint', '--json', missing])
    expect(missingResult.status).toBe(2)
    expect(missingResult.stderr).toContain(`path not found: ${missing}`)
    const emptyResult = run(['lint', '--json', emptyDirectory])
    expect(emptyResult.status).toBe(2)
    expect(emptyResult.stderr).toContain(`no .md files found in ${emptyDirectory}`)
  })

  it('retains the unknown-command error status', () => {
    const result = run(['unknown-command'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Unknown command: unknown-command')
  })

  it('preserves unrecognized-option parsing outside the documented boolean flags', () => {
    const result = run(['lint', '--unrecognized', targetDirectory, '--json'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('cwd-only.md')
    expect(result.stdout).not.toContain('target-only.md')
  })

  it('accepts LF and CRLF quoted numeric descriptions through the actual compiled CLI', () => {
    const result = run(['lint', '--json', '--strict', quotedDirectory])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as JsonReport
    expect(report.summary).toEqual({ error: 0, warning: 0, info: 0 })
    expect(report.findings).toEqual([])
    expect(result.stdout).not.toContain('missing-description')
  })
})
