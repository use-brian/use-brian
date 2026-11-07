/** [COMP:api/context-scope-security-matrix] Complete historical upgrade, independently scheduled. */
import { test } from 'node:test'
import { assertHistoricalScopeUpgrade } from './context-scope-migration-upgrade.js'

test('fresh, 591 and predecessor migration lifecycles preserve data and enforce completion guards (602)', async () => {
  await assertHistoricalScopeUpgrade('602_procedural_skill_scope.sql', '2')
})
