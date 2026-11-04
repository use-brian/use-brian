// [COMP:tooling/test-evidence] Discovery is evidence of selection, never execution.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm, mkdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const ossRoot = fileURLToPath(new URL('../../', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const testFile = path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
export function discoveryEnvironment(env = process.env) {
  return { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']
    .filter(key => env[key] !== undefined).map(key => [key, env[key]])),
  CI: 'true', NODE_ENV: 'test', BRIAN_TEST_NO_PAID: '1' }
}
async function command(file, args, cwd, env = discoveryEnvironment()) {
  const { stdout } = await execute(file, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
  return stdout
}
async function sourceIdentity(root) {
  const head = (await command('git', ['rev-parse', 'HEAD'], root)).trim()
  const diff = await command('git', ['diff', '--binary', 'HEAD', '--', '.', ':(exclude)use-brian'], root)
  const untracked = (await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter(Boolean).sort()
  const files = {}
  for (const path of untracked) files[path] = hash(await readFile(join(root, path)))
  return { head, dirty: Boolean(diff || untracked.length), fingerprint: hash(JSON.stringify({ head, diff, files })) }
}

// Recognize only maintained simple command forms. Never execute shell text.
export function runnerSegments(script) {
  return script.split(/\s*&&\s*/).map(segment => {
    const tokens = segment.trim().split(/\s+/)
    if (tokens[0] === 'vitest' && tokens[1] === 'run') {
      const args = []
      for (let i = 2; i < tokens.length; i++) {
        if (tokens[i] === '--passWithNoTests') continue
        if (tokens[i] === '--config' && tokens[i + 1] && /^[\w./-]+$/.test(tokens[i + 1])) { args.push(tokens[i], tokens[++i]); continue }
        if (!tokens[i].startsWith('-') && /^[\w./-]+$/.test(tokens[i])) { args.push(tokens[i]); continue }
        return { runner: 'manual', command: segment, reason: 'Unrecognized Vitest discovery options' }
      }
      return { runner: 'vitest', args, command: segment }
    }
    if (tokens[0] === 'node' && tokens.includes('--test')) {
      const prefix = tokens.slice(1, tokens.indexOf('--test'))
      const patterns = tokens.slice(tokens.indexOf('--test') + 1)
      if ((prefix.length === 0 || prefix.join(' ') === '--import tsx') && patterns.length && patterns.every(value => /^[\w./*?-]+$/.test(value) && !value.startsWith('-'))) {
        return { runner: 'node', patterns, command: segment }
      }
    }
    return { runner: 'manual', command: segment, reason: 'Build prerequisite or custom runner; not executed by discovery' }
  })
}

export function reconcile(files, discoveries) {
  return files.map(file => {
    const selectedBy = discoveries.filter(run => run.files?.includes(file.path)).map(run => ({ id: run.id, lane: run.lane, runner: run.runner }))
    return { ...file, selectedBy, discovery: selectedBy.length ? 'discovered' : 'unmapped', execution: 'not_run' }
  })
}

async function inventory({ platformRoot, triagePath } = {}) {
  const roots = [{ repository: 'oss', root: ossRoot }, ...(platformRoot ? [{ repository: 'platform', root: resolve(platformRoot) }] : [])]
  const triage = triagePath ? JSON.parse(await readFile(triagePath, 'utf8')).entries : []
  const startedAt = new Date().toISOString()
  const directory = await mkdtemp(join(tmpdir(), 'brian-test-inventory-'))
  const repositories = []
  try {
    for (const { repository, root } of roots) {
      const before = await sourceIdentity(root)
      const tracked = new Set((await command('git', ['ls-files', '-z'], root)).split('\0').filter(Boolean))
      const visible = [...new Set([...tracked, ...(await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter(Boolean)])].sort()
      const files = []
      for (const path of visible.filter(testFile)) {
        const contents = await readFile(join(root, path)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (contents === null) continue // tracked deletion is still captured by source identity
        const sha256 = hash(contents)
        const review = triage.find(entry => entry.repository === repository && entry.path === path)
        files.push({ path, sha256, tracked: tracked.has(path),
          review: review ? { id: review.id, decision: review.decision, sourceMatches: review.sha256 === sha256, journeys: review.journeys } : { decision: 'retain_pending_review' } })
      }
      const packages = [], discoveries = []
      for (const path of visible.filter(path => path === 'package.json' || /^(?:apps|packages)\/[^/]+\/package.json$/.test(path))) {
        const data = JSON.parse(await readFile(join(root, path), 'utf8'))
        const packageDir = dirname(path)
        const scripts = Object.entries(data.scripts ?? {}).filter(([name]) => name === 'test' || name.startsWith('test:'))
        packages.push({ path: packageDir, name: data.name, scripts: Object.fromEntries(scripts), sha256: hash(await readFile(join(root, path))) })
        for (const [scriptName, script] of scripts) {
          // Root turbo scripts only orchestrate the package scripts enumerated below.
          if (packageDir === '.' && script.startsWith('turbo run ')) continue
          for (const [index, segment] of runnerSegments(script).entries()) {
            const lane = scriptName === 'test' ? 'default' : scriptName === 'test:integration' ? 'integration' : scriptName
            const run = { id: `${repository}:${packageDir}:${scriptName}:${index}`, package: data.name, packageDir, lane, ...segment }
            const start = performance.now()
            try {
              if (segment.runner === 'vitest') {
                const resultPath = join(directory, `${discoveries.length}-${repository}.json`)
                await command('pnpm', ['exec', 'vitest', 'list', '--filesOnly', ...segment.args, `--json=${resultPath}`], join(root, packageDir))
                const result = JSON.parse(await readFile(resultPath, 'utf8'))
                if (!Array.isArray(result) || result.some(entry => typeof entry.file !== 'string')) throw new Error('Malformed Vitest file discovery')
                run.files = result.map(entry => relative(root, resolve(root, packageDir, entry.file))).sort()
              } else if (segment.runner === 'node') {
                run.files = [...new Set(segment.patterns.flatMap(pattern => [...globSync(pattern, { cwd: join(root, packageDir) })]).map(path => join(packageDir, path)))].sort()
                if (!run.files.length) throw new Error('Node test globs selected no files')
              }
              run.status = segment.runner === 'manual' ? 'review_required' : 'discovered'
            } catch (error) {
              // Do not copy stderr: third-party configs may accidentally print environment values.
              run.status = 'blocked'; run.reason = `Discovery failed (${error.code ?? error.name}); reproduce the recorded command locally`
            }
            run.discoveryMs = Math.round(performance.now() - start)
            discoveries.push(run)
          }
        }
      }
      const after = await sourceIdentity(root)
      repositories.push({ repository, before, after, stable: before.fingerprint === after.fingerprint, packages, discoveries, files: reconcile(files, discoveries) })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
  // Recheck every repo at the very end, including ones discovered earlier.
  for (const repo of repositories) {
    repo.after = await sourceIdentity(roots.find(entry => entry.repository === repo.repository).root)
    repo.stable = repo.before.fingerprint === repo.after.fingerprint
  }
  return { schemaVersion: 1, kind: 'file_discovery_not_execution', startedAt, finishedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    status: repositories.some(repo => !repo.stable || repo.discoveries.some(run => run.status === 'blocked')) ? 'blocked' : 'complete', repositories }
}

async function prepareReport(path) {
  if (!isAbsolute(path)) throw new Error('Report path must be absolute')
  if (await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error('Report already exists; use a new path to retain earlier evidence')
  await mkdir(dirname(path), { recursive: true })
}
export async function writeReport(path, report) {
  await prepareReport(path)
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {}
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i], value = process.argv[++i]
    if (!['--report', '--platform-root', '--triage'].includes(flag) || !value || value.startsWith('--')) throw new Error('Usage: inventory.mjs --report <absolute.json> [--platform-root <path>] [--triage <path>]')
    options[flag] = value
  }
  if (!options['--report'] || !isAbsolute(options['--report'])) throw new Error('--report requires an absolute path')
  await prepareReport(options['--report'])
  const report = await inventory({ platformRoot: options['--platform-root'], triagePath: options['--triage'] })
  await writeReport(options['--report'], report)
  console.log(JSON.stringify({ status: report.status, report: options['--report'], repositories: report.repositories.map(repo => ({ repository: repo.repository,
    files: repo.files.length, defaultDiscovered: repo.files.filter(file => file.selectedBy.some(run => run.lane === 'default')).length,
    unmapped: repo.files.filter(file => file.discovery === 'unmapped').length, stable: repo.stable })) }))
  if (report.status !== 'complete') process.exitCode = 1
}
