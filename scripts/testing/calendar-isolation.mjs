// [COMP:ci/execution-topology] One real history followed by independent failure cases.
import { isDeepStrictEqual } from 'node:util'
import { cloneLocalFixture } from '../crm/local-fixture.mjs'

const controls = [
  'withdraws a disconnected account',
  "withholds the post-Calendar provider request after a 'recording media ancestor' hold",
  "withholds the post-Calendar provider request after a 'historical message' hold",
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
  const started = performance.now()
  const prefix = await runTests({ ...env, BRIAN_CALENDAR_STAGE: 'history' }, history, 'history')
  const { selected, names } = calendarPartition(prefix, history)
  if (selected.some(row => row.status !== 'passed')) throw new Error('Calendar checkpoint tests did not pass')

  // Each control starts from the same committed state. Running the copies
  // together can make the shared cluster miss the unchanged SQL deadline.
  console.log(`Calendar history passed in ${Math.round((performance.now() - started) / 1000)}s. Running ${controls.length} controls in order.`)
  async function runControl(pattern, index) {
    const clone = await cloneLocalFixture(env, { fromCurrent: true })
    try {
      const rows = await runTests({
        ...clone.env, CONTEXT_SCOPE_TEST_DATABASE_URL: clone.adminUrl, BRIAN_CALENDAR_STAGE: 'control',
      }, pattern, `control-${index + 1}`)
      return calendarPartition(rows, pattern, names).selected
    } finally { await clone.dispose() }
  }
  const failures = []
  const actual = [...selected]
  for (const [index, pattern] of controls.entries()) {
    try {
      actual.push(...await runControl(pattern, index))
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
  if (!isDeepStrictEqual(actual.map(row => row.fullName).sort(), names)) {
    throw new Error('Calendar shard did not account for every test exactly once')
  }
  return actual
}
