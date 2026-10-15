import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CASE_IDS, DEPENDENCY_IDS } from '../readiness-contract.mjs'
import { LANES, materializeFixture, preparePilotConfig, validateInactiveConfig } from '../pilot-config.mjs'
const fixture = JSON.parse(await readFile(new URL('../fixtures/v1-pilot.json', import.meta.url)))

describe('[COMP:operations/v1-readiness] inactive pilot preparation', () => {
  it('V09 preparation is idempotent, keeps four native drafts inactive and retains unresolved owner inputs', () => {
    const config = preparePilotConfig()
    assert.deepEqual(config, preparePilotConfig())
    assert.deepEqual(config.recipes.map(r => r.lane), LANES)
    assert.deepEqual(validateInactiveConfig(config), { status: 'passed', readyToActivate: false, writes: 0, liveValidated: false })
    for (const recipe of config.recipes) {
      assert.equal(recipe.enabled, false)
      assert.equal(recipe.planeBinding, null)
      assert.ok(recipe.unresolvedBindings.includes('approvalSettings'))
      assert.ok(recipe.unresolvedBindings.includes('taskAllowance'))
      for (const action of ['start', 'pause', 'recover', 'disable', 'revoke']) assert.ok(recipe.controls[action].length > 30)
    }
    assert.equal(config.monthlyUsdReference, 1000); assert.equal(config.hardStopUsd, null)
    assert.deepEqual(fixture.requiredCases, CASE_IDS); assert.deepEqual(fixture.requiredDependencies, DEPENDENCY_IDS)
  })
  it('V07 V09 planes cannot silently substitute a personal installation for company work', () => {
    const recipe = preparePilotConfig().recipes[0]
    assert.throws(() => materializeFixture(recipe, { ...fixture.personal, plane: 'company' }), /plane_mismatch/)
    assert.notEqual(materializeFixture(recipe, fixture.company).contextProjectId, materializeFixture(recipe, fixture.personal).contextProjectId)
  })
  it('V09 rejects invented owner bindings, enabled schedules and missing native fixture bindings', () => {
    for (const mutate of [c => { c.readyToActivate = true }, c => { c.recipes[0].enabled = true }, c => { c.planes[0].bindings.memberId = 'invented' }, c => { c.recipes.pop() }]) {
      const c = preparePilotConfig(); mutate(c); assert.throws(() => validateInactiveConfig(c), /inactive_config_changed/)
    }
    assert.throws(() => materializeFixture(preparePilotConfig().recipes[0], { ...fixture.company, assistantId: null }), /binding_missing/)
  })
})
