import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// [COMP:ci/execution-topology] Unknown comparison inputs select more coverage.
export function needsHistoricalTests(paths) {
  return paths.some(path => /^(packages\/api\/(migrations|scripts|src\/(db|migrations|context-scope|workspace-access|security|application-platform))\/|apps\/api\/|scripts\/(crm|testing|test-department-isolation)|packages\/shared\/src\/department-isolation|\.github\/workflows\/)/.test(path)
    || /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig(?:\.[\w-]+)?\.json)$/.test(path))
}

export function selectCiScope(eventName, event, git) {
  if (['schedule', 'workflow_dispatch'].includes(eventName)) return { historical: true, reason: eventName }
  try {
    let base, head
    if (eventName === 'pull_request') {
      head = event.pull_request.head.sha
      base = git(['merge-base', event.pull_request.base.sha, head]).trim()
    } else if (eventName === 'push') {
      base = event.before; head = event.after
    }
    if (![base, head].every(value => /^[a-f0-9]{40}$/.test(value ?? '') && !/^0+$/.test(value))) throw new Error('Missing revision')
    // --no-renames includes both sides of a rename; -z preserves unusual paths.
    const paths = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean)
    const historical = needsHistoricalTests(paths)
    return { historical, reason: historical ? 'database-inputs-changed' : 'current-schema-only' }
  } catch { return { historical: true, reason: 'comparison-unavailable' } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const scope = selectCiScope(process.env.GITHUB_EVENT_NAME,
    JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    args => execFileSync('git', args, { encoding: 'utf8' }))
  console.log(JSON.stringify(scope))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `historical=${scope.historical}\nprofile=${scope.historical ? 'full' : 'current'}\nshards=${scope.historical ? '[1,2,3,4]' : '[1,2,3]'}\ntotal=${scope.historical ? 4 : 3}\n`)
}
