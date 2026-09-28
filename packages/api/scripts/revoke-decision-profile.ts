/** Revoke classifier authority without rewriting its evidence. */
import dotenv from 'dotenv'
import { resolve } from 'node:path'
import { runRevokeDecisionProfileCli } from '../src/decision-promotion-cli.js'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

void (async () => {
  const apply = process.argv.slice(2).includes('--apply')
  if (!apply) return runRevokeDecisionProfileCli(process.argv.slice(2))
  const [{ createDecisionEvaluationProfileStore }, { getPool }] = await Promise.all([
    import('../src/db/decision-evaluation-profiles.js'),
    import('../src/db/client.js'),
  ])
  try {
    return await runRevokeDecisionProfileCli(process.argv.slice(2), {
      store: createDecisionEvaluationProfileStore(),
    })
  } finally {
    await getPool().end()
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
