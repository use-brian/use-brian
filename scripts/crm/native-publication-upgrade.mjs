// [COMP:api/native-turn-frame] Exercise the exact authenticated upgrade boundary.
import { createLocalFixture, parseLocalFixtureArguments, runCommand } from './local-fixture.mjs'

const graphProfile = process.argv.includes('--graph')
const compactProfile = process.argv.includes('--compact')
const pageProfile = process.argv.includes('--page')
const cohortProfile = process.argv.includes('--cohorts')
if ([graphProfile, compactProfile, pageProfile, cohortProfile].filter(Boolean).length > 1) throw new Error('Choose one native publication upgrade profile.')
const testBase = ['pnpm', '--filter', '@use-brian/api', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts']
const testCommand = [...testBase, ...(cohortProfile ? [
  'src/application-platform/__tests__/native-turn-cohort-upgrade.integration.test.ts',
] : pageProfile ? [
  'src/application-platform/__tests__/native-turn-page-upgrade.integration.test.ts',
] : compactProfile ? [
  'src/application-platform/__tests__/native-turn-compact-upgrade.integration.test.ts',
] : graphProfile ? [
  'src/application-platform/__tests__/native-turn-graph-upgrade.integration.test.ts',
] : [
  'src/application-platform/__tests__/native-publication-invalidation.integration.test.ts',
  'src/application-platform/__tests__/native-turn-query-contract.integration.test.ts',
  'src/application-platform/__tests__/native-turn-annotation-upgrade.integration.test.ts',
]), '--maxWorkers=1']
const options = parseLocalFixtureArguments([...process.argv.slice(2).filter(arg => !['--graph', '--compact', '--page', '--cohorts'].includes(arg)), '--', ...testCommand])
let fixture
let interrupted = false
const onInterrupt = () => { interrupted = true }
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onInterrupt)
try {
  fixture = await createLocalFixture({ ...options, beforeApplyFile: cohortProfile
    ? '8201_native_turn_publication_cohorts.sql' : pageProfile
    ? '8200_native_turn_page_completion.sql' : compactProfile
      ? '8199_native_turn_compact_requirements.sql' : graphProfile
      ? '8198_native_turn_graph_representation.sql' : '8196_native_turn_annotation_publication.sql',
    beforeApply: async ({ env }) => {
      if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
      console.log(cohortProfile ? 'Running exact publication cohort authentication at the 8200 upgrade boundary.'
        : pageProfile ? 'Running sealed Page authentication at the 8199 upgrade boundary.'
        : compactProfile ? 'Running native compact authentication at the 8198 upgrade boundary.'
        : graphProfile ? 'Running native graph authentication at the 8197 upgrade boundary.'
        : 'Running native publication and query compatibility at the 8195 upgrade boundary.')
      await runCommand(testCommand[0], testCommand.slice(1), {
        env: { ...env, ...(cohortProfile ? { BRIAN_NATIVE_COHORT_UPGRADE_BOUNDARY: '8200' }
          : pageProfile ? { BRIAN_NATIVE_PAGE_UPGRADE_BOUNDARY: '8199' }
          : compactProfile ? { BRIAN_NATIVE_COMPACT_UPGRADE_BOUNDARY: '8198' }
          : graphProfile ? { BRIAN_NATIVE_GRAPH_UPGRADE_BOUNDARY: '8197' }
          : { BRIAN_NATIVE_PUBLICATION_UPGRADE_BOUNDARY: '8195' }) }, inherit: true,
      })
      if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
    },
  })
  if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
  if (graphProfile || compactProfile || pageProfile || cohortProfile) {
    const runtime = [...testBase, ...(cohortProfile ? [
      'src/application-platform/__tests__/native-turn-cohorts.integration.test.ts',
      'src/application-platform/__tests__/native-turn-page-completion.integration.test.ts',
      'src/application-platform/__tests__/native-host-observation.integration.test.ts',
      'src/application-platform/__tests__/native-turn-compact.integration.test.ts',
      'src/application-platform/__tests__/native-turn-query-acquisition.integration.test.ts',
      'src/application-platform/__tests__/native-turn-publication.integration.test.ts',
      'src/application-platform/__tests__/native-turn-annotation.integration.test.ts',
      'src/application-platform/__tests__/attended-history.integration.test.ts',
    ] : [pageProfile ? 'src/application-platform/__tests__/native-turn-page-completion.integration.test.ts'
      : compactProfile ? 'src/application-platform/__tests__/native-turn-compact.integration.test.ts'
      : 'src/application-platform/__tests__/native-turn-graph.integration.test.ts']), '--maxWorkers=1']
    await runCommand(runtime[0], runtime.slice(1), { env: fixture.env, inherit: true })
    if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
  }
} finally {
  try { await fixture?.dispose() }
  finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt) }
}
