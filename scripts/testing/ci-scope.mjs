import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceMatrices, acceptanceShards } from './department-isolation-report.mjs'
import { compareChangedPaths } from './git-changes.mjs'

// [COMP:ci/execution-topology] Unknown comparison inputs select more coverage.
export function needsHistoricalTests(paths) {
  return paths.some(path => /^(packages\/api\/(migrations|scripts|src\/(db|migrations|context-scope|workspace-access|security|application-platform))\/|apps\/api\/|scripts\/(crm|testing|test-department-isolation)|packages\/shared\/src\/department-isolation|\.github\/workflows\/)/.test(path)
    || /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig(?:\.[\w-]+)?\.json)$/.test(path))
}

function proposedCoverage(paths) {
  const full = { profile: 'full', jobs: null }
  if (!paths.length || needsHistoricalTests(paths)) return full
  const markdown = path => /^(?:(?:README|CONTRIBUTING|SECURITY|CLA)\.md|docs\/.+\.md)$/s.test(path)
  if (paths.every(markdown)) return { profile: 'markdown', jobs: ['build-typecheck'] }
  if (paths.every(path => markdown(path) || /^apps\/app-web\/(?:src|app)\/.+\.(?:ts|tsx|css)$/s.test(path))) {
    return { profile: 'app-web', jobs: ['build-typecheck', 'app-web-tests', 'heavyweight-tests', 'offline-continuity', 'department-isolation-shards'] }
  }
  return full
}

export function selectCiScope(eventName, event, git) {
  const exhaustive = reason => ({ historical: true, reason, proposed: proposedCoverage([]), changedPathCount: null })
  if (['schedule', 'workflow_dispatch'].includes(eventName)) return exhaustive(eventName)
  try {
    const { base, head, paths } = compareChangedPaths(eventName, event, git)
    const historical = needsHistoricalTests(paths)
    return { historical, reason: historical ? 'database-inputs-changed' : 'current-schema-only', base, head,
      proposed: proposedCoverage(paths), changedPathCount: paths.length }
  } catch { return exhaustive('comparison-unavailable') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let event
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) } catch { /* Full coverage without event metadata. */ }
  const compareCalendarArm = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event?.inputs?.compare_calendar_arm === 'true'
  const scope = selectCiScope(process.env.GITHUB_EVENT_NAME, event,
    args => execFileSync('git', args, { encoding: 'utf8' }))
  console.log(JSON.stringify(scope))
  const profile = scope.historical ? 'full' : 'current'
  const shards = acceptanceShards(profile)
  const matrices = acceptanceMatrices(profile, { compareCalendarArm })
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `historical=${scope.historical}\nprofile=${profile}\nshards=${JSON.stringify(shards)}\ntotal=${shards.length}\nmatrix=${JSON.stringify(matrices.remaining)}\ncalendar=${JSON.stringify(matrices.calendar)}\n`)
  if (process.env.RUNNER_TEMP) {
    try {
      writeFileSync(join(process.env.RUNNER_TEMP, 'ci-change-impact.json'), `${JSON.stringify({
        revision: process.env.GITHUB_SHA ?? null, event: process.env.GITHUB_EVENT_NAME, ...scope,
      }, null, 2)}\n`)
    } catch (error) { console.warn(`Unable to write change-impact report: ${error.message}`) }
  }
}
