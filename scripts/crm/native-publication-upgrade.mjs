// [COMP:api/native-turn-frame] Exercise the exact authenticated upgrade boundary.
import { createLocalFixture, parseLocalFixtureArguments, runCommand } from './local-fixture.mjs'

const testCommand = ['pnpm', '--filter', '@use-brian/api', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
  'src/application-platform/__tests__/native-publication-invalidation.integration.test.ts',
  'src/application-platform/__tests__/native-turn-query-contract.integration.test.ts',
  'src/application-platform/__tests__/native-turn-annotation-upgrade.integration.test.ts', '--maxWorkers=1']
const options = parseLocalFixtureArguments([...process.argv.slice(2), '--', ...testCommand])
let fixture
let interrupted = false
const onInterrupt = () => { interrupted = true }
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onInterrupt)
try {
  fixture = await createLocalFixture({ ...options, beforeApplyFile: '8196_native_turn_annotation_publication.sql',
    beforeApply: async ({ env }) => {
      if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
      console.log('Running native publication and query compatibility at the 8195 upgrade boundary.')
      await runCommand(testCommand[0], testCommand.slice(1), {
        env: { ...env, BRIAN_NATIVE_PUBLICATION_UPGRADE_BOUNDARY: '8195' }, inherit: true,
      })
      if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
    },
  })
  if (interrupted) throw new Error('Disposable upgrade fixture interrupted')
} finally {
  try { await fixture?.dispose() }
  finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt) }
}
