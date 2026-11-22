// [COMP:ci/execution-topology] One real history followed by independent failure cases.
import { availableParallelism } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { cloneLocalFixture } from '../crm/local-fixture.mjs'

const controls = [
  'withdraws a disconnected account',
  "withholds the second provider request after a 'recording media ancestor' hold",
  "withholds the second provider request after a 'historical message' hold",
]
const history = `^(?!.*(?:${controls.join('|')})).*$`

// Vitest lists tests excluded by -t as skipped. Keep the selected worker's
// actual result for each name, including any genuine skip or failure.
export function calendarPartition(assertions, pattern, expectedNames) {
  const names = assertions.map(row => row.fullName).sort()
  if (new Set(names).size !== names.length || (expectedNames && !isDeepStrictEqual(names, expectedNames))) {
    throw new Error('Calendar workers collected different or duplicate tests')
  }
  const match = new RegExp(pattern)
  const selected = assertions.filter(row => match.test(row.fullName))
  if (!selected.length || (pattern !== history && selected.length !== 1)) {
    throw new Error(`Calendar partition did not collect its expected cases: ${pattern}`)
  }
  return { selected, names }
}

export async function runCalendarIsolation(env, runTests) {
  const workers = Math.min(controls.length, availableParallelism())
  if (workers === 1) return runTests(env)
  const started = performance.now()
  const prefix = await runTests({ ...env, BRIAN_CALENDAR_STAGE: 'history' }, history, 'history')
  const { selected, names } = calendarPartition(prefix, history)
  if (selected.some(row => row.status !== 'passed')) throw new Error('Calendar checkpoint tests did not pass')

  // The prefix process has closed its pools. Each worker changes a different
  // copy of exactly that committed state, including the second delivered reply.
  console.log(`Calendar history passed in ${Math.round((performance.now() - started) / 1000)}s. Running ${controls.length} controls on ${workers} workers.`)
  async function runControl(pattern, index) {
    const clone = await cloneLocalFixture(env, { fromCurrent: true })
    try {
      const rows = await runTests({
        ...clone.env, CONTEXT_SCOPE_TEST_DATABASE_URL: clone.adminUrl, BRIAN_CALENDAR_STAGE: 'control',
      }, pattern, `control-${index + 1}`)
      return calendarPartition(rows, pattern, names).selected
    } finally { await clone.dispose() }
  }
  const outcomes = []
  for (let first = 0; first < controls.length; first += workers) {
    const batch = controls.slice(first, first + workers)
    outcomes.push(...await Promise.allSettled(batch.map((pattern, i) => runControl(pattern, first + i))))
  }
  const failures = outcomes.filter(outcome => outcome.status === 'rejected')
  if (failures.length) throw new Error(failures.map(outcome => outcome.reason.message).join('; '))
  const actual = selected.concat(...outcomes.map(outcome => outcome.value))
  if (!isDeepStrictEqual(actual.map(row => row.fullName).sort(), names)) {
    throw new Error('Calendar shard did not account for every test exactly once')
  }
  return actual
}
