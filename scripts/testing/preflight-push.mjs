// [COMP:tooling/push-preflight] Local evidence is source-bound and never publishes.
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { command, environment, git, identity, sameIdentity, snapshot, saveReceipt, cleanOutputs, cleanupDatabases } from './preflight-source.mjs'
import { compileWorkflow, executeWorkflow, expression, workflowContext } from './preflight-workflow.mjs'
import { needsHistoricalTests } from './ci-scope.mjs'

export async function publicationPlan(root, kind, comparisonBase) {
  const input = await identity(root)
  const base = comparisonBase === undefined ? input.base : comparisonBase
  const changed = new Set([...git(root, ['diff', '--name-only', '-z', 'HEAD']).toString().split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0')].filter(Boolean))
  if (base) for (const path of git(root, ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']).toString().split('\0').filter(Boolean)) changed.add(path)
  let historical = base === null || needsHistoricalTests([...changed]), ciBase = base
  if (kind === 'oss' && !['develop', 'main'].includes(input.branch)) {
    if (input.reviewBase) {
      const mergeBase = git(root, ['merge-base', input.reviewBase, 'HEAD']).toString().trim()
      const reviewPaths = git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, 'HEAD']).toString().split('\0').filter(Boolean)
      if (!historical && needsHistoricalTests(reviewPaths)) { historical = true; ciBase = mergeBase }
      for (const path of reviewPaths) changed.add(path)
    } else { historical = true; ciBase = null }
  }
  let checks
  if (kind === 'oss') {
    const unsupported = [...changed].find(path => (/^\.github\/workflows\/.+\.ya?ml$/.test(path) && path !== '.github/workflows/ci.yml') || /(^|\/)(?:Dockerfile(?:\.[^/]+)?|\.dockerignore)$/.test(path))
    if (unsupported) throw new Error(`Changed workflow/container definition needs a maintained local validator: ${unsupported}`)
    const context = workflowContext({ historical })
    checks = compileWorkflow(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'), context)
      .filter(job => job.definition.if === undefined || expression(job.definition.if, context))
      .flatMap(job => job.variants.map(matrix => ({ id: job.id, matrix })))
  } else if (kind === 'platform') checks = ['install', 'api-deploy', 'check', 'build', 'typecheck', 'test', 'smoke'].map(id => ({ id }))
  else {
    const manifest = await readFile(join(root, 'package.json'), 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (manifest) {
      const scripts = ['preflight:push', 'check', 'test'].filter(name => manifest.scripts?.[name])
      if (!scripts.length) throw new Error(`Executable companion has no maintained preflight/check/test: ${root}`)
      checks = ['install', ...scripts].map(id => ({ id }))
    } else {
      const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0')
      if (files.some(path => /\.(?:[cm]?[jt]sx?|py|sh|go|rs|sql)$|(^|\/)(?:Dockerfile|Makefile)$/.test(path))) throw new Error(`Executable companion needs a maintained preflight/check/test command: ${root}`)
      checks = [{ id: 'documentation' }]
    }
  }
  return { input, kind, historical, ciBase, checks }
}

async function contextsFor(repositories) {
  const contexts = []
  for (const repo of repositories.filter(repo => repo.kind === 'platform')) {
    for (const candidate of ['../industry-brain/brian-kb', '../brian-kb']) {
      const root = resolve(repo.root, candidate)
      if (!await lstat(join(root, '.git')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) continue
      contexts.push({ role: 'kb-pairing', input: await identity(root) }); break
    }
  }
  return contexts
}

export async function verifyReceipt(path, expectedRepositories) {
  const report = JSON.parse(await readFile(path, 'utf8'))
  if (report.kind !== 'push_preflight' || report.version !== 1 || report.status !== 'passed' || !report.repositories?.length) throw new Error('No complete successful push preflight receipt')
  const roots = report.repositories.map(repo => `${repo.kind}:${repo.input.root}`).sort()
  if (expectedRepositories && JSON.stringify(roots) !== JSON.stringify(expectedRepositories.map(repo => `${repo.kind}:${resolve(repo.root)}`).sort())) throw new Error('Preflight receipt does not cover the publication repositories')
  for (const repo of report.repositories) {
    const current = await identity(repo.input.root)
    // A successful earlier push may advance its tracking ref to exactly the
    // verified HEAD. Any other comparison-ref movement requires a new preflight.
    const allowed = { ...current, base: current.base === repo.input.head ? repo.input.base : current.base }
    if (!sameIdentity(repo.input, allowed)) throw new Error(`Stale preflight receipt: ${repo.input.root}`)
    const plan = await publicationPlan(repo.input.root, repo.kind, repo.input.base)
    const expected = plan.checks.map(check => JSON.stringify(check)).sort()
    const actual = (repo.verification?.jobs ?? []).filter(job => job.status === 'passed').map(job => JSON.stringify({ id: job.id, ...(job.matrix ? { matrix: job.matrix } : {}) })).sort()
    if (repo.verification?.status !== 'passed' || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Incomplete preflight coverage: ${repo.input.root}`)
  }
  const contexts = await contextsFor(report.repositories.map(repo => ({ root: repo.input.root, kind: repo.kind })))
  if (contexts.length !== (report.contexts ?? []).length) throw new Error('Preflight context coverage changed')
  for (const [index, context] of contexts.entries()) {
    const before = report.contexts[index]
    const current = { ...context.input, base: context.input.base === before.input.head ? before.input.base : context.input.base }
    if (context.role !== before.role || !sameIdentity(before.input, current)) throw new Error('Preflight context source changed')
  }
  return report
}

async function documentationCheck(root, base, log) {
  const start = base ?? git(root, ['hash-object', '-w', '-t', 'tree', '--stdin']).toString().trim()
  await command('git', ['diff', '--check', start, 'HEAD'], { cwd: root, log })
  const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(path => path.endsWith('.md'))
  for (const path of new Set(files)) {
    const text = await readFile(join(root, path), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (text === null) continue
    for (const match of text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      const link = match[1] ?? match[2]
      if (/^(?:[a-z][\w+.-]*:|#|\/)/i.test(link)) continue
      const target = decodeURIComponent(link.split('#')[0])
      if (!target) continue
      if (!await lstat(resolve(root, dirname(path), target)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error(`Missing documentation link: ${path} -> ${target}`)
    }
  }
}

export async function runPreflight({ repositories, reportPath, pgBin, signal }) {
  if (!isAbsolute(reportPath)) throw new Error('--report requires an absolute path')
  for (const repo of repositories) {
    const rel = relative(resolve(repo.root), reportPath)
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Preflight reports must remain outside the source checkout')
  }
  let plans
  try { plans = await Promise.all(repositories.map(repo => publicationPlan(resolve(repo.root), repo.kind))) }
  catch (error) {
    const failed = { version: 1, kind: 'push_preflight', status: 'failed', repositories: [], error: error.message, finishedAt: new Date().toISOString() }
    await saveReceipt(reportPath, failed); return failed
  }
  const report = { version: 1, kind: 'push_preflight', status: 'running', startedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch }, repositories: plans,
    contexts: await contextsFor(repositories) }
  const directory = await mkdtemp(join(tmpdir(), 'brian-push-preflight-'))
  let env
  const logs = `${reportPath}.logs`; await mkdir(logs, { recursive: true })
  await saveReceipt(reportPath, report)
  try {
    const store = (await command('pnpm', ['store', 'path', '--silent'], { cwd: repositories[0].root })).output.trim()
    env = environment(directory, store)
    await mkdir(env.HOME); await mkdir(env.TMPDIR)
    for (const context of report.contexts) {
      const mount = join(directory, 'industry-brain', 'brian-kb')
      await mkdir(dirname(mount), { recursive: true })
      const frozen = await snapshot(context.input.root, mount, env)
      if (!sameIdentity(context.input, frozen)) throw new Error('Preflight context changed during preparation')
    }
    // Snapshot every participant before any checks run. The platform receives the
    // live OSS snapshot, never the optional superproject pin.
    for (const [index, plan] of plans.entries()) {
      const started = performance.now()
      plan.snapshot = join(directory, `repo-${index}`)
      const input = await snapshot(plan.input.root, plan.snapshot, env)
      if (!sameIdentity(plan.input, input)) throw new Error('Source moved after preflight planning')
      plan.snapshotMs = Math.round(performance.now() - started)
    }
    const oss = plans.find(plan => plan.kind === 'oss')
    for (const platform of plans.filter(plan => plan.kind === 'platform')) {
      if (!oss) throw new Error('Platform preflight requires its live OSS checkout')
      await rm(join(platform.snapshot, 'use-brian'), { recursive: true, force: true })
      await snapshot(oss.input.root, join(platform.snapshot, 'use-brian'), env)
    }
    // Platform checks run first so existing repository failures stop publication
    // before paying for the complete OSS workflow.
    for (const plan of [...plans].sort((a, b) => (a.kind === 'platform' ? -1 : b.kind === 'platform' ? 1 : 0))) {
      const root = plan.snapshot
      const repoDirectory = join(directory, `execution-${plans.indexOf(plan)}`); await mkdir(repoDirectory)
      const repoLogs = join(logs, String(plans.indexOf(plan))); await mkdir(repoLogs)
      if (plan.kind === 'oss') {
        const sha = git(root, ['rev-parse', 'HEAD']).toString().trim()
        await writeFile(join(repoDirectory, 'event.json'), JSON.stringify({ before: plan.ciBase ?? '0'.repeat(40), after: sha }))
        const context = workflowContext({ historical: plan.historical, sha, branch: plan.input.branch })
        try {
          plan.verification = await executeWorkflow({ source: await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'),
            root, context, env, directory: repoDirectory, logs: repoLogs, pgBin, signal })
        } catch (error) { plan.verification = { status: 'failed', jobs: error.jobs ?? [], error: error.message }; throw error }
      } else {
        const jobs = []; plan.verification = { status: 'running', jobs }
        if (plan.checks.some(check => check.id !== 'documentation')) await cleanOutputs(root)
        for (const check of plan.checks) {
          const record = { ...check, status: 'running' }; jobs.push(record)
          record.log = join(repoLogs, `${check.id.replaceAll(':', '-')}.log`)
          console.log(`Preflight: ${plan.kind}/${check.id}`)
          const started = performance.now()
          try {
            if (check.id === 'documentation') await documentationCheck(root, plan.input.base, record.log)
            else {
              const args = check.id === 'install' ? ['install', '--frozen-lockfile']
                : check.id === 'api-deploy' ? ['verify:api-deploy'] : [check.id]
              record.command = ['pnpm', ...args]
              await command('pnpm', args, { cwd: root, env, signal, log: record.log, timeoutMs: 30 * 60_000 })
            }
            record.status = 'passed'
          } catch (error) {
            record.status = 'failed'; record.error = error.message
            if (!await lstat(record.log).catch(issue => issue.code === 'ENOENT' ? null : Promise.reject(issue))) await writeFile(record.log, error.message, { mode: 0o600 })
            throw error
          }
          finally { record.durationMs = Math.round(performance.now() - started) }
        }
        plan.verification.status = 'passed'
      }
      await saveReceipt(reportPath, report)
    }
    for (const plan of plans) if (!sameIdentity(plan.input, await identity(plan.input.root))) throw new Error('Source changed during verification; rerun the preflight')
    for (const context of report.contexts) if (!sameIdentity(context.input, await identity(context.input.root))) throw new Error('Context changed during verification; rerun the preflight')
    report.status = 'passed'
  } catch (error) { report.status = 'failed'; report.error = error.message }
  finally {
    // Keep only provenance, logs and measured outcomes in the durable receipt.
    for (const plan of plans) delete plan.snapshot
    try {
      for (const name of await readdir(directory)) {
        if (!name.startsWith('execution-')) continue
        const execution = join(directory, name)
        for (const child of await readdir(execution)) if (child.startsWith('job-')) await cleanupDatabases(join(execution, child), pgBin, env)
      }
      if (env) await cleanupDatabases(env.TMPDIR, pgBin, env)
      await rm(directory, { recursive: true, force: true })
    } catch (error) { report.status = 'failed'; report.cleanupError = error.message }
    report.finishedAt = new Date().toISOString()
    await saveReceipt(reportPath, report)
  }
  return report
}

export async function main(repositories, argv = process.argv.slice(2)) {
  const options = {}, companions = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--') continue
    if (flag === '--plan') { options.plan = true; continue }
    if (!['--report', '--verify', '--pg-bin', '--repo'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: preflight:push --report /absolute/receipt.json [--pg-bin DIR] [--repo PATH] | --plan | --verify /absolute/receipt.json')
    if (flag === '--repo') companions.push({ root: resolve(argv[++i]), kind: 'companion' })
    else options[flag] = argv[++i]
  }
  repositories = [...repositories, ...companions]
  if (new Set(repositories.map(repo => resolve(repo.root))).size !== repositories.length) throw new Error('Duplicate publication repository')
  if (options['--verify']) { await verifyReceipt(options['--verify'], repositories); console.log('Push preflight receipt is current and complete'); return }
  if (options.plan) { console.log(JSON.stringify({ repositories: await Promise.all(repositories.map(repo => publicationPlan(repo.root, repo.kind))), contexts: await contextsFor(repositories) }, null, 2)); return }
  if (!options['--report']) throw new Error('--report is required; --plan never permits a push')
  const abort = new AbortController(), stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const report = await runPreflight({ repositories, reportPath: resolve(options['--report']), pgBin: options['--pg-bin'], signal: abort.signal })
    console.log(JSON.stringify({ status: report.status, report: resolve(options['--report']), error: report.error, cleanupError: report.cleanupError }))
    if (report.status !== 'passed') process.exitCode = 1
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main([{ root: fileURLToPath(new URL('../../', import.meta.url)), kind: 'oss' }])
}
