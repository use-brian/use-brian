/** [COMP:api/application-management] Fixed source-owned reference composition. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe,it} from 'node:test'
import {applicationModules,resolveApplicationModules} from '../application-modules.js'

describe('[COMP:api/application-management] explicit reference composition',()=>{
 it('keeps normal composition empty and immutable without importing a reference factory',async()=>{
  assert.equal(await resolveApplicationModules([]),applicationModules)
  assert.equal(await resolveApplicationModules(['--admin-only']),applicationModules)
  assert.equal(applicationModules.length,0);assert.equal(Object.isFrozen(applicationModules),true)
  const source=await readFile(new URL('../application-modules.ts',import.meta.url),'utf8')
  assert.doesNotMatch(source,/^import .*purchasing/m)
  assert.ok(source.indexOf("if (!argv.includes('--admin-only'))")<source.indexOf("await import('./reference-application-modules.js')"))
 })
 it('rejects nonadministrative reference selection before dotenv or provider preference work',async()=>{
  await assert.rejects(resolveApplicationModules(['--reference-applications']),/requires --admin-only/)
  const source=await readFile(new URL('../index.ts',import.meta.url),'utf8')
  assert.ok(source.indexOf('await resolveApplicationModules(process.argv)')<source.indexOf('dotenv.config()'))
  assert.ok(source.indexOf('await resolveApplicationModules(process.argv)')<source.indexOf('await loadLocalProviderPreference()'))
 })
 it('loads only the fixed shipped reference and preserves its factory identity and contract',async()=>{
  const reference=await import('../reference-application-modules.js')
  const modules=await resolveApplicationModules(['--admin-only','--reference-applications'])
  assert.deepEqual(modules.map(module=>module.key),['purchasing'])
  assert.equal(modules[0],reference.referenceApplicationModules[0]);assert.equal(Object.isFrozen(modules),true)
  assert.equal(modules[0].application.version,'1')
  assert.deepEqual(modules[0].application.dependencies,['records','native'])
  assert.deepEqual(modules[0].application.commands,['create_request','submit_request','approve_order'])
 })
})
