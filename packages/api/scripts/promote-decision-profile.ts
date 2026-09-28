/** Promote recorded classifier evidence. Dry-run unless --apply is present. */
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { runPromoteDecisionProfileCli } from '../src/decision-promotion-cli.js'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

void (async () => {
  const apply = process.argv.slice(2).includes('--apply')
  if (!apply) return runPromoteDecisionProfileCli(process.argv.slice(2))
  const [{ createDecisionEvaluationProfileStore }, { getPool }] = await Promise.all([
    import('../src/db/decision-evaluation-profiles.js'),
    import('../src/db/client.js'),
  ])
  try {
    return await runPromoteDecisionProfileCli(process.argv.slice(2), {
      store: createDecisionEvaluationProfileStore(),
    })
  } finally {
    await getPool().end()
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
