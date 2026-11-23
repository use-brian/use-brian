// [COMP:corrections/row-history] Replay a real legacy chain through current migrations.
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createLocalFixture, parseLocalFixtureArguments, runCommand } from './local-fixture.mjs'

const apiRoot = fileURLToPath(new URL('../../packages/api/', import.meta.url))
const require = createRequire(join(apiRoot,'package.json'))
const vitest = join(dirname(require.resolve('vitest/package.json')),'vitest.mjs')
const command = [process.execPath,vitest,'run','--config','vitest.integration.config.ts',
  'src/application-platform/__tests__/native-memory-history-upgrade.integration.test.ts','--maxWorkers=1']
const options = parseLocalFixtureArguments([...process.argv.slice(2),'--',...command])
const directory = await mkdtemp(join(tmpdir(),'brian-memory-history-upgrade-'))
const checkpoint = join(directory,'history.json')
const run = (phase, env) => runCommand(command[0],command.slice(1),{
  cwd: apiRoot, inherit: true,
  env: { ...env, BRIAN_MEMORY_HISTORY_UPGRADE_PHASE: phase, BRIAN_MEMORY_HISTORY_UPGRADE_CHECKPOINT: checkpoint },
})
let fixture
try {
  fixture = await createLocalFixture({ ...options, beforeApplyFile: '8309_conversation_record_lineage.sql',
    beforeApply: ({ env }) => run('seed',env),
  })
  await run('read',fixture.env)
} finally {
  try { await fixture?.dispose() }
  finally { await rm(directory,{recursive:true,force:true}) }
}
