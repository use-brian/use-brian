import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MIGRATION_OWNER_GROUPS, MIGRATION_OWNER_SCENARIOS } from '../../apps/api/src/__tests__/migration-owner-groups.ts'

test('[COMP:ci/execution-topology] scenario workers execute a disjoint, complete partition, including future tests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-groups-'))
  const fixture = join(directory, 'fixture.test.mjs')
  const helper = new URL('../../apps/api/src/__tests__/migration-owner-groups.ts', import.meta.url).href
  const titles = [...Object.keys(MIGRATION_OWNER_SCENARIOS), 'prefix prerequisite', 'future scenario']
  const source = readFileSync(new URL('../../apps/api/src/__tests__/migration-owner-role.test.ts', import.meta.url), 'utf8')
  for (const title of Object.keys(MIGRATION_OWNER_SCENARIOS)) assert.ok(source.includes(title), title)
  writeFileSync(fixture, `import {describe} from 'node:test';import {migrationOwnerTest as it} from ${JSON.stringify(helper)};
    describe('parent',()=>{for(const title of ${JSON.stringify(titles)})it(title,()=>console.log('executed:'+title))})`)
  const execute = group => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    if (group) env.BRIAN_TEST_MIGRATION_OWNER_GROUP = group
    else delete env.BRIAN_TEST_MIGRATION_OWNER_GROUP
    const result = spawnSync(process.execPath, ['--test', fixture], { encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return [...result.stdout.matchAll(/^\s*# executed:(.*)$/gm)].map(match => match[1])
  }
  try {
    assert.deepEqual(execute().sort(), titles.sort())
    const partitions = MIGRATION_OWNER_GROUPS.map(execute)
    assert.deepEqual(partitions.flat().sort(), titles.sort())
    assert.ok(partitions.slice(0, 4).every(partition => partition.length === 1))
    assert.deepEqual(partitions[4].sort(), ['future scenario', 'prefix prerequisite'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
