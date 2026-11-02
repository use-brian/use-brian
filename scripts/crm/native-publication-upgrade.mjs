// [COMP:api/native-turn-frame] Exercise the exact authenticated upgrade boundary.
import { createLocalFixture, parseLocalFixtureArguments, runCommand } from './local-fixture.mjs'

const graphProfile = process.argv.includes('--graph')
const testBase = ['pnpm', '--filter', '@use-brian/api', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts']
const testCommand = [...testBase, ...(graphProfile ? [
  'src/application-platform/__tests__/native-turn-graph-upgrade.integration.test.ts',
] : [
  'src/application-platform/__tests__/native-publication-invalidation.integration.test.ts',
  'src/application-platform/__tests__/native-turn-query-contract.integration.test.ts',
  'src/application-platform/__tests__/native-turn-annotation-upgrade.integration.test.ts',
]), '--maxWorkers=1']
const options = parseLocalFixtureArguments([...process.argv.slice(2).filter(arg => arg !== '--graph'), '--', ...testCommand])
let fixture
let interrupted = false
const onInterrupt = () => { interrupted = true }
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onInterrupt)
try {
  fixture = await createLocalFixture({ ...options, beforeApplyFile: graphProfile
    ? '8198_native_turn_graph_representation.sql' : '8196_native_turn_annotation_publication.sql',
    beforeApply: async ({ env }) => {
      if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
      console.log(graphProfile ? 'Running native graph authentication at the 8197 upgrade boundary.'
        : 'Running native publication and query compatibility at the 8195 upgrade boundary.')
      await runCommand(testCommand[0], testCommand.slice(1), {
        env: { ...env, ...(graphProfile ? { BRIAN_NATIVE_GRAPH_UPGRADE_BOUNDARY: '8197' }
          : { BRIAN_NATIVE_PUBLICATION_UPGRADE_BOUNDARY: '8195' }) }, inherit: true,
      })
      if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
    },
  })
  if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
  if (graphProfile) {
    const runtime = [...testBase, 'src/application-platform/__tests__/native-turn-graph.integration.test.ts', '--maxWorkers=1']
    await runCommand(runtime[0], runtime.slice(1), { env: fixture.env, inherit: true })
    if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
  }
} finally {
  try { await fixture?.dispose() }
  finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt) }
}
