import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CATALOGUE } from './readiness-catalogue.mjs'

export const SCHEMA = 'operations-readiness-v1'
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const digest = value => hash(JSON.stringify(value))
export const CASE_IDS = Object.freeze(Array.from({ length: 14 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`))
export const DEPENDENCY_IDS = Object.freeze(Array.from({ length: 9 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`))
const statuses = new Set(['passed', 'failed', 'blocked', 'not_run', 'not_applicable'])

export function validateCatalogue(catalogue) {
  if (digest(catalogue) !== digest(CATALOGUE)) throw new Error('catalogue_changed: required dependencies, suites and assertions are fixed')
  return catalogue
}

/** Bounded, shell-free child execution. No inherited credentials or stdin. */
export function command(executable, args, { cwd, env, timeoutMs = 180_000 } = {}) {
  const startedAt = new Date().toISOString()
  return new Promise(accept => {
    let output = '', timedOut = false, outputTruncated = false, done = false
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const finish = (exitCode, error) => {
      if (done) return
      done = true; clearTimeout(timer)
      accept({ command: [executable, ...args], exitCode, startedAt, endedAt: new Date().toISOString(), timedOut, outputTruncated, output, ...(error ? { error } : {}) })
    }
    const capture = b => { const s = output + b.toString(); outputTruncated ||= s.length > 2_000_000; output = s.slice(-2_000_000) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, timeoutMs)
    child.on('error', error => finish(1, error.code ?? 'spawn_failed'))
    child.on('close', code => finish(code ?? 1))
  })
}

async function git(root, args) {
  const r = await command('git', ['-C', root, ...args], { env: { PATH: process.env.PATH }, timeoutMs: 15_000 })
  if (r.exitCode || r.outputTruncated) throw new Error('source_inventory_failed')
  return r.output.trim()
}

/** Only an allowlisted source inventory. Never traverses ignored output or .env. */
export async function snapshot(ossRoot, platformRoot) {
  const repos = {}
  for (const [name, root] of [['oss', ossRoot], ['platform', platformRoot]]) {
    const files = {}
    const paths = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').sort()
    for (const path of paths) {
      if (path.split('/').some(p => p.startsWith('.') && !['.github'].includes(p))) continue
      const allowed = name === 'oss'
        ? /^(packages\/[^/]+\/(src|migrations)\/|apps\/[^/]+\/src\/|scripts\/|\.github\/workflows\/)/.test(path)
          || /(^|\/)(package\.json|pnpm-lock\.yaml|[^/]*config\.[^/]+)$/.test(path)
        : /^(scripts\/|packages\/repo-checks\/src\/|docs\/architecture\/|docs\/workflow\/(component-map|operations-v1-readiness)\.md$)/.test(path)
          || CATALOGUE.dependencies.some(d => path === d.plan) || ['package.json', 'pnpm-lock.yaml', 'vercel.json', 'turbo.json', 'pnpm-workspace.yaml'].includes(path)
      if (!allowed || !/\.(ts|tsx|js|mjs|cjs|json|sql|ya?ml|md|sh)$/.test(path)) continue
      try {
        const file = await realpath(join(root, path))
        if (!file.startsWith(`${await realpath(root)}${sep}`)) throw new Error('source_path_escape')
        const info = await stat(file)
        if (!info.isFile() || info.size > 16_000_000) throw new Error('source_file_bound')
        files[path] = hash(await readFile(file))
      } catch (error) { if (error.code === 'ENOENT') files[path] = null; else throw error }
    }
    repos[name] = { sha: await git(root, ['rev-parse', 'HEAD']), files }
  }
  return { ...repos, digest: digest(repos) }
}

export async function artifact(root, path) {
  root = await realpath(root)
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('evidence_path_escape')
  const file = await realpath(resolve(root, path))
  if (!file.startsWith(`${await realpath(root)}${sep}`)) throw new Error('evidence_path_escape')
  const info = await stat(file)
  if (!info.isFile() || !info.size || info.size > 32_000_000) throw new Error('evidence_file_bound')
  return { path: relative(root, file), bytes: info.size, sha256: hash(await readFile(file)) }
}

export function assessSuite(suite, receipt, currentDigest, artifacts) {
  const problems = []
  if (!receipt) return { status: 'not_run', reasons: ['suite_not_run'], assertions: [] }
  if (!statuses.has(receipt.status)) problems.push('unsupported_status')
  if (receipt.status !== 'passed') return { ...receipt, status: statuses.has(receipt.status) && receipt.status !== 'not_applicable' ? receipt.status : 'failed', reasons: [...(receipt.reasons ?? []), 'suite_not_passed'] }
  if (receipt.sourceDigest !== currentDigest) problems.push('stale_source')
  if (receipt.exitCode !== 0 || receipt.timedOut) problems.push('command_failed')
  if (!receipt.command?.length || !Number.isFinite(Date.parse(receipt.startedAt)) || Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt) || !Number.isFinite(Date.parse(receipt.endedAt))) problems.push('command_identity_missing')
  if (!receipt.artifact || !artifacts[receipt.artifact.path] || artifacts[receipt.artifact.path].sha256 !== receipt.artifact.sha256) problems.push('artifact_missing_or_changed')
  const assertions = receipt.assertions ?? []
  if (assertions.length < suite.minimum || assertions.some(a => a.status !== 'passed')) problems.push('assertions_missing_skipped_or_failed')
  for (const name of suite.assertions) if (!assertions.some(a => a.name === name || a.name.endsWith(` ${name}`))) problems.push(`assertion_missing:${name}`)
  return { ...receipt, status: problems.length ? 'failed' : 'passed', reasons: problems }
}

export function parseVitest(suite, raw, execution, sourceDigest, proof) {
  const row = raw?.testResults?.find(r => r.name?.replaceAll('\\', '/').endsWith(`/${suite.file}`))
  return { ...execution, output: undefined, sourceDigest, artifact: proof,
    status: row?.status === 'passed' && raw.success === true && execution.exitCode === 0 ? 'passed' : 'failed',
    reasons: row ? [] : ['suite_result_missing'], assertions: (row?.assertionResults ?? []).map(a => ({ name: a.fullName ?? a.title, status: a.status })) }
}

export function aggregate(catalogue, receipts, source, artifacts, caseEvidence = {}) {
  validateCatalogue(catalogue)
  const suites = Object.fromEntries(catalogue.suites.map(s => [s.file, assessSuite(s, receipts[s.file], source.digest, artifacts)]))
  const dependencies = Object.fromEntries(catalogue.dependencies.map(d => {
    const failures = d.suites.filter(f => suites[f].status !== 'passed')
    return [d.id, { ...d, status: failures.length ? 'blocked' : 'passed', reasons: failures.map(f => `${f}:${suites[f].status}`), sourceDigest: source.digest }]
  }))
  const cases = Object.fromEntries(catalogue.cases.map(c => {
    const spec = caseEvidence[c.id]
    return [c.id, { ...c, ...assessSuite({ minimum: 1, assertions: spec?.requiredAssertions ?? [] }, spec, source.digest, artifacts) }]
  }))
  const localReady = Object.values(dependencies).every(r => r.status === 'passed') && Object.values(cases).every(r => r.status === 'passed')
  return { schema: SCHEMA, catalogueHash: digest(catalogue), source, suites, dependencies, cases,
    verdicts: { codeHarness: 'not_checked', localReadiness: localReady ? 'ready' : 'not_ready', liveActivation: 'not_checked' }, exitCode: localReady ? 0 : 1 }
}

export async function verifyArtifacts(root, proofs) {
  const verified = {}
  for (const proof of proofs) {
    try { const actual = await artifact(root, proof.path); if (actual.sha256 === proof.sha256 && actual.bytes === proof.bytes) verified[proof.path] = actual } catch {}
  }
  return verified
}
