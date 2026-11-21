import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function secondsBetween(from, to) {
  if (!from || !to) return null
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) && ms >= 0 ? ms / 1_000 : null
}

// [COMP:ci/execution-topology] Summarize a completed Actions attempt from its timestamps.
export function summarizeCiTiming(run, listing) {
  if (run.status !== 'completed' || !Array.isArray(listing.jobs) || listing.jobs.length !== listing.total_count
    || listing.jobs.some(job => job.run_id !== run.id || job.run_attempt !== run.run_attempt)) {
    throw new Error('Expected a completed CI attempt and its complete job list')
  }
  const attemptStart = run.run_started_at ?? run.created_at
  const jobs = listing.jobs.filter(job => job.conclusion !== 'skipped').map(job => ({
    name: job.name,
    conclusion: job.conclusion,
    runnerLabels: job.labels,
    eligibleAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    beforeEligibleSeconds: secondsBetween(attemptStart, job.created_at),
    queueSeconds: secondsBetween(job.created_at, job.started_at),
    runnerSeconds: secondsBetween(job.started_at, job.completed_at),
    steps: (job.steps ?? []).filter(step => step.conclusion !== 'skipped').map(step => ({
      name: step.name, conclusion: step.conclusion, seconds: secondsBetween(step.started_at, step.completed_at),
    })),
  })).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
  const required = jobs.find(job => job.name === 'build-test')
  const acceptance = jobs.filter(job => /^Department isolation \(\d+\/\d+\)/.test(job.name))
  return {
    runId: run.id,
    attempt: run.run_attempt,
    revision: run.head_sha,
    conclusion: run.conclusion,
    workflowToGateSeconds: secondsBetween(run.created_at, required?.completedAt),
    attemptToGateSeconds: secondsBetween(attemptStart, required?.completedAt),
    runnerSeconds: jobs.reduce((sum, job) => sum + (job.runnerSeconds ?? 0), 0),
    jobsWithoutRunnerTiming: jobs.filter(job => job.runnerSeconds === null).length,
    lastBeforeGate: required ? jobs.find(job => job !== required && Date.parse(job.completedAt) <= Date.parse(required.eligibleAt))?.name ?? null : null,
    departmentShardsByCompletion: acceptance.map(job => job.name),
    jobs,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [runPath, jobsPath] = process.argv.slice(2)
  if (!runPath || !jobsPath) throw new Error('Usage: node scripts/testing/ci-timing.mjs run.json jobs.json')
  const [run, jobs] = [runPath, jobsPath].map(path => JSON.parse(readFileSync(path, 'utf8')))
  console.log(JSON.stringify(summarizeCiTiming(run, jobs), null, 2))
}
