// [COMP:tooling/push-preflight] Execute the maintained CI contract, refusing unknown syntax.
import { createRequire } from 'node:module'
import { globSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { command, cleanOutputs, cleanupDatabases, resetSnapshot } from './preflight-source.mjs'
import { acceptanceMatrix, acceptanceShards } from './department-isolation-report.mjs'

// Reuse the declared YAML dependency of the existing CI topology tooling.
const yaml = createRequire(new URL('../../apps/app-desktop/package.json', import.meta.url))('js-yaml')

export function expression(source, context) {
  if (typeof source === 'boolean') return source
  source = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const tokens = source.match(/'(?:[^']|'')*'|\|\||&&|==|!=|[>()!,]|\b\d+\b|[\w.-]+/g) ?? []
  if (tokens.join('') !== source.replace(/\s+/g, '').replace(/'[^']*'/g, match => match.replace(/\s/g, ''))) throw new Error(`Unsupported CI expression: ${source}`)
  let index = 0
  const atom = () => {
    const token = tokens[index++]
    if (token === '(') { const value = or(); if (tokens[index++] !== ')') throw new Error('Unclosed CI expression'); return value }
    if (token === '!') return !atom()
    if (token?.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (/^\d+$/.test(token ?? '')) return Number(token)
    if (token === 'true' || token === 'false') return token === 'true'
    if (['always', 'fromJSON'].includes(token) && tokens[index++] === '(') {
      const value = token === 'always' ? true : JSON.parse(or())
      if (tokens[index++] !== ')') throw new Error('Unclosed CI function')
      return value
    }
    let value = context
    for (const key of (token ?? '').split('.')) {
      if (!value || !Object.hasOwn(value, key)) throw new Error(`Unknown CI value: ${token}`)
      value = value[key]
    }
    return value
  }
  const comparison = () => {
    let value = atom()
    if (['==', '!=', '>'].includes(tokens[index])) {
      const operator = tokens[index++], right = atom()
      value = operator === '==' ? value === right : operator === '!=' ? value !== right : value > right
    }
    return value
  }
  const and = () => { let value = comparison(); while (tokens[index] === '&&') { index++; const right = comparison(); value = value && right } return value }
  const or = () => { let value = and(); while (tokens[index] === '||') { index++; const right = and(); value = value || right } return value }
  const value = or()
  if (index !== tokens.length) throw new Error(`Unsupported CI expression: ${source}`)
  return value
}
export function expand(value, context) {
  if (typeof value !== 'string') return value
  if (/^\$\{\{[\s\S]*\}\}$/.test(value)) return expression(value, context)
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source) => String(expression(source, context)))
}
export function workflowContext({ historical = true, sha = 'local-snapshot', branch = 'develop', runnerTemp = '/tmp/local-preflight' } = {}) {
  const profile = historical ? 'full' : 'current'
  const shards = acceptanceShards(profile)
  return { github: { event_name: 'push', head_ref: '', repository: 'local/snapshot', ref: `refs/heads/${branch}`, sha,
    event: { pull_request: { head: { repo: { full_name: 'local/snapshot' } } } } }, runner: { temp: runnerTemp }, matrix: {},
    needs: { 'ci-scope': { result: 'success', outputs: { historical: String(historical), profile,
      shards: JSON.stringify(shards), total: String(shards.length), matrix: JSON.stringify(acceptanceMatrix(profile)) } } } }
}

function jobBudgetMs(id, definition, context) {
  const minutes = expand(definition['timeout-minutes'] === undefined ? 30 : definition['timeout-minutes'], context)
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(minutes * 60_000))
    throw new Error(`Unsupported CI timeout: ${id}`)
  return minutes * 60_000
}

export function compileWorkflow(source, context) {
  const workflow = yaml.load(source)
  if (!workflow?.jobs || !workflow.jobs['build-test']) throw new Error('Missing required CI aggregate build-test')
  if (workflow.env || workflow.defaults) throw new Error('Unsupported workflow environment/defaults; add explicit local support first')
  const jobs = []
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job['continue-on-error']) throw new Error(`Unsupported optional job: ${id}`)
    if (job.uses || job.container || job.services || job.env || job.defaults) throw new Error(`Unsupported CI execution environment: ${id}`)
    const needs = typeof job.needs === 'string' ? [job.needs] : job.needs ?? []
    if (needs.some(id => !workflow.jobs[id])) throw new Error(`Missing CI dependency for ${id}`)
    const matrix = expand(job.strategy?.matrix ?? {}, context)
    if (!matrix || Array.isArray(matrix) || typeof matrix !== 'object' || Object.hasOwn(matrix, 'exclude'))
      throw new Error(`Unsupported matrix for ${id}`)
    let variants = [{}]
    if (Object.hasOwn(matrix, 'include')) {
      if (Object.keys(matrix).length !== 1 || !Array.isArray(matrix.include) || !matrix.include.length ||
          matrix.include.some(variant => !variant || Array.isArray(variant) || typeof variant !== 'object' || !Object.keys(variant).length))
        throw new Error(`Unsupported include matrix for ${id}`)
      variants = matrix.include.map(variant => ({ ...variant }))
    } else {
      for (const [key, values] of Object.entries(matrix)) {
        const expanded = expand(values, context)
        if (!Array.isArray(expanded) || !expanded.length) throw new Error(`Empty or unsupported matrix: ${id}.${key}`)
        variants = variants.flatMap(variant => expanded.map(value => ({ ...variant, [key]: value })))
      }
    }
    for (const variant of variants) jobBudgetMs(id, job, { ...context, matrix: variant })
    jobs.push({ id, needs, definition: job, variants })
  }
  // A missing dependency on a required job cannot silently remove it from the gate.
  const reachable = new Set()
  function visit(id, stack = new Set()) {
    if (stack.has(id)) throw new Error('Cyclic CI dependencies')
    if (reachable.has(id)) return
    reachable.add(id)
    for (const need of jobs.find(job => job.id === id).needs) visit(need, new Set([...stack, id]))
  }
  visit('build-test')
  if (reachable.size !== jobs.length) throw new Error('CI job is disconnected from build-test')
  return jobs
}

function confined(path, roots) {
  const absolute = resolve(path)
  if (!roots.some(root => { const rel = relative(root, absolute); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) })) throw new Error('Artifact path escapes the owned preflight directories')
  return absolute
}
async function upload(step, context, root, artifacts) {
  const name = expand(step.with?.name, context)
  if (!/^[\w.-]+$/.test(name ?? '') || artifacts.has(name)) throw new Error('Invalid or duplicate artifact name')
  const patterns = String(expand(step.with?.path ?? '', context)).replaceAll('/tmp/department-isolation-', `${context.runner.temp}/department-isolation-`).split('\n').filter(Boolean)
  const files = patterns.flatMap(pattern => [...globSync(pattern, { cwd: root })]).map(path => confined(isAbsolute(path) ? path : join(root, path), [root, context.runner.temp]))
  if (!files.length) {
    if (step.with?.['if-no-files-found'] === 'warn' || step.with?.['if-no-files-found'] === 'ignore') return
    throw new Error(`Required artifact is missing: ${name}`)
  }
  const directory = join(artifacts.directory, name)
  await mkdir(directory)
  const names = new Set()
  for (const path of files) {
    const name = path.split(/[\\/]/).at(-1)
    if (names.has(name)) throw new Error('Artifact basenames collide; explicit archive required')
    names.add(name); await cp(path, join(directory, name), { recursive: true, dereference: false })
  }
  artifacts.set(name, directory)
}
async function download(step, context, root, artifacts) {
  if (step.with?.['run-id'] || step.with?.repository || step.with?.['github-token']) throw new Error('Cross-run artifact reuse is unsupported')
  const name = expand(step.with?.name, context), pattern = expand(step.with?.pattern, context)
  const matcher = pattern ? new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null
  const matches = [...artifacts].filter(([candidate]) => name ? candidate === name : matcher?.test(candidate))
  if (!matches.length) throw new Error(`Required artifact unavailable: ${name ?? pattern}`)
  const destination = confined(expand(step.with?.path ?? root, context), [root, context.runner.temp])
  await mkdir(destination, { recursive: true })
  for (const [artifactName, directory] of matches) {
    const target = name || step.with?.['merge-multiple'] ? destination : join(destination, artifactName)
    for (const file of await readdir(directory)) {
      const path = join(target, file)
      if (await lstat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error('Artifact restore would overwrite an existing file')
      await mkdir(target, { recursive: true }); await cp(join(directory, file), path, { recursive: true })
    }
  }
}

export async function executeWorkflow({ source, root, context, env, directory, logs, pgBin, signal, run = command }) {
  const jobs = compileWorkflow(source, context), results = [], done = new Map()
  const artifacts = new Map(); artifacts.directory = join(directory, 'artifacts'); await mkdir(artifacts.directory)
  while (done.size < jobs.length) {
    const job = jobs.find(job => !done.has(job.id) && job.needs.every(id => done.has(id)))
    if (!job) throw new Error('CI dependencies cannot be scheduled')
    const when = job.definition.if === undefined || expression(job.definition.if, context)
    if (!when) { done.set(job.id, { result: 'skipped', durationMs: 0 }); context.needs[job.id] = { ...context.needs[job.id], result: 'skipped' }; continue }
    const durations = []
    for (const [variantIndex, matrix] of job.variants.entries()) {
      const record = { id: job.id, matrix, status: 'running', steps: [], budgetMs: jobBudgetMs(job.id, job.definition, { ...context, matrix }) }
      results.push(record)
      console.log(`Preflight: ${job.id} ${JSON.stringify(matrix)}`)
      const started = performance.now()
      const temp = join(directory, `job-${job.id}-${variantIndex}`); await mkdir(temp)
      const jobEnv = { ...env, HOME: join(temp, 'home'), TMPDIR: temp, RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'outputs'), GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: join(directory, 'event.json'), GITHUB_SHA: context.github.sha }
      const local = { ...context, matrix, runner: { temp } }
      const invoke = async (file, args, extra = {}) => run(file, args, { cwd: root, env: jobEnv, signal,
        timeoutMs: record.budgetMs - (performance.now() - started), ...extra })
      try {
        const preparationStarted = performance.now()
        await mkdir(jobEnv.HOME)
        await resetSnapshot(root, { env: jobEnv, signal, timeoutMs: record.budgetMs })
        await cleanOutputs(root, { dependencies: true })
        record.preparationMs = Math.round(performance.now() - preparationStarted)
        for (const [stepIndex, step] of job.definition.steps.entries()) {
          if (step.if !== undefined && !expression(step.if, local)) continue
          if (signal?.aborted) throw new Error('Preflight interrupted')
          if (performance.now() - started >= record.budgetMs) throw new Error('CI job exceeded its budget including preparation')
          const stepRecord = { name: step.name ?? step.id ?? step.uses ?? `step-${stepIndex}`, status: 'running' }
          record.steps.push(stepRecord)
          const stepStarted = performance.now()
          const priorEnv = { ...jobEnv }
          const log = join(logs, `${job.id}-${variantIndex}-${stepIndex}.log`); stepRecord.log = log
          try {
            if (step['continue-on-error'] !== undefined && typeof step['continue-on-error'] !== 'boolean') throw new Error('Unsupported conditional continue-on-error')
            if (step['working-directory'] || step.shell || step.timeout || step['timeout-minutes']) throw new Error('Unsupported step execution override')
            for (const [key, value] of Object.entries(step.env ?? {})) jobEnv[key] = String(expand(value, local))
            if (step.uses === 'actions/upload-artifact@v4') await upload(step, local, root, artifacts)
            else if (step.uses === 'actions/download-artifact@v4') await download(step, local, root, artifacts)
            else if (step.uses === 'actions/checkout@v4') {
              if (step.with?.ref || step.with?.repository || step.with?.submodules) throw new Error('Unsupported checkout override')
              stepRecord.provisioning = 'owned Git snapshot'
            } else if (step.uses === 'actions/setup-node@v4') {
              if (Number(step.with?.['node-version']) !== Number(process.versions.node.split('.')[0])) throw new Error('Local Node major differs from CI; select the CI Node version')
              stepRecord.provisioning = `local ${process.version}`
            } else if (step.uses === 'pnpm/action-setup@v4') {
              const version = (await invoke('pnpm', ['--version'], { log })).output.trim()
              const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
              if (`pnpm@${version}` !== manifest.packageManager) throw new Error('Local pnpm differs from packageManager')
              stepRecord.provisioning = `local pnpm@${version}`
            } else if (step.uses) throw new Error(`Unsupported required action: ${step.uses}`)
            else if (step.name === 'Install PostgreSQL 18 with required extensions') {
              const version = (await invoke(pgBin ? join(pgBin, 'postgres') : 'postgres', ['--version'], { log })).output
              if (!/PostgreSQL\) 18\./.test(version)) throw new Error('Select PostgreSQL 18 with --pg-bin')
              const sharedir = (await invoke(pgBin ? join(pgBin, 'pg_config') : 'pg_config', ['--sharedir'])).output.trim()
              for (const extension of ['vector', 'pg_trgm']) await readFile(join(sharedir, 'extension', `${extension}.control`))
              stepRecord.provisioning = 'local PostgreSQL 18 with required extensions'
            } else if (typeof step.run === 'string') {
              let script = expand(step.run, local)
              if (job.id === 'department-isolation-shards') script = script.replace('--pg-bin /usr/lib/postgresql/18/bin', pgBin ? `--pg-bin '${pgBin.replaceAll("'", "'\\''")}'` : '')
              // Absolute CI receipt paths live inside this job's private runner directory.
              script = script.replaceAll('/tmp/department-isolation-', `${temp}/department-isolation-`)
              stepRecord.command = ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script]
              await invoke('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { log })
              if (job.id === 'ci-scope') {
                const outputs = Object.fromEntries((await readFile(jobEnv.GITHUB_OUTPUT, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
                if (JSON.stringify(outputs) !== JSON.stringify(context.needs['ci-scope'].outputs)) throw new Error('Executed CI scope differs from the preflight plan')
              }
            } else throw new Error('CI step has no supported action or command')
            stepRecord.status = 'passed'
          } catch (error) {
            stepRecord.status = step['continue-on-error'] === true ? 'optional_failure' : 'failed'; stepRecord.error = error.message
            if (step['continue-on-error'] !== true) throw error
          } finally {
            stepRecord.durationMs = Math.round(performance.now() - stepStarted)
            for (const key of Object.keys(jobEnv)) if (!Object.hasOwn(priorEnv, key)) delete jobEnv[key]
            Object.assign(jobEnv, priorEnv)
          }
        }
        if (performance.now() - started > record.budgetMs) throw new Error('CI job exceeded its budget including reporting')
        record.status = 'passed'
      } catch (error) {
        record.status = 'failed'; record.error = error.message
        error.jobs = results; throw error
      } finally {
        record.durationMs = Math.round(performance.now() - started)
        await cleanupDatabases(temp, pgBin, jobEnv)
      }
      durations.push(record.durationMs)
    }
    done.set(job.id, { result: 'success', durationMs: Math.max(...durations) })
    context.needs[job.id] = { ...context.needs[job.id], result: 'success' }
  }
  const paths = new Map()
  for (const job of jobs) {
    const compute = id => {
      if (paths.has(id)) return paths.get(id)
      const item = jobs.find(job => job.id === id)
      const duration = done.get(id).durationMs + Math.max(0, ...item.needs.map(compute))
      paths.set(id, duration); return duration
    }
    compute(job.id)
  }
  return { jobs: results, status: 'passed', criticalPathMs: paths.get('build-test'), hostedOnly: ['runner provisioning time and queueing', 'GitHub permissions', 'Docker publication and remote services'] }
}
