import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseVerifyArguments, verifyProjectHarness } from '../verify-postgres.mjs'
test('inert verifier import; argument boundary is exact', async () => {
  assert.equal(parseVerifyArguments(['--pg-bin','/synthetic/pg18/bin']),'/synthetic/pg18/bin')
  for(const args of [[],['--pg-bin'],['--pg-bin','--other'],['--database-url','postgres://invalid'],['--pg-bin','/unused','extra']]) {
    assert.throws(()=>parseVerifyArguments(args),/Usage:/)
    await assert.rejects(verifyProjectHarness(args,{}),/Usage:/)
  }
})
test('nonlocal inherited selectors refuse before fixture creation', async () => {
  for(const key of ['DATABASE_URL','DATABASE_URL_APP','APP_DATABASE_URL']) {
    await assert.rejects(verifyProjectHarness(['--pg-bin','/never-executed'],{[key]:'postgres://nonlocal.invalid/synthetic'}),/refuses an inherited nonlocal database/)
  }
})
test('fresh, develop-tip and foundation-upgrade use exact boundaries and existing deadlines', async () => {
  const source=await readFile(new URL('../verify-postgres.mjs',import.meta.url),'utf8')
  assert.match(source,/\['fresh','develop-tip','upgrade'\]/)
  assert.match(source,/beforeApplyFile:'8335_project_harnesses.sql'/)
  assert.match(source,/beforeApplyFile:'8336_project_harness_verification.sql'/)
  assert.match(source,/8334_conversation_publication_lock.sql/)
  assert.match(source,/canonicalBefore/)
  assert.match(source,/ordinaryOwner:true/)
  assert.match(source,/PG_STATEMENT_TIMEOUT_MS:'15000'/)
  assert.match(source,/cleanRuntimeEnvironment\(env\)/)
  assert.match(source,/if\(fixture\) await fixture.dispose\(\)/)
})

test('committed ledger and no-ledger compiler markers reach the actual runner, not a mocked upgrade', async () => {
  const source=await readFile(new URL('../verify-postgres.mjs',import.meta.url),'utf8')
  assert.match(source,/if\(mode==='fresh'\) await verifyCandidateRefusal\(fixture,'ledger'\)/)
  assert.match(source,/if\(mode==='develop-tip'\) await verifyCandidateRefusal\(fixture,'effects'\)/)
  assert.match(source,/await runMigrations\(\{databaseUrl:fixture.adminUrl\}\)/)
  assert.match(source,/project_harness_candidate_upgrade_unsupported/)
  assert.match(source,/Refusal changed candidate state/)
})
