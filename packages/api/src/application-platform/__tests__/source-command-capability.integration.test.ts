import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {sourceSetupInput} from '../source-onboarding.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/source-service-binding] retired normal source command authoring',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it.each(['command_v1',null,'unknown'])('refuses the retired key rather than coercing it (%s)',async effectBinding=>{
  const input={instanceId:randomUUID(),tenant:'fictional-source',audience:'https://source.example',recordId:'record-1',fields:['description'],effectBinding}
  expect(sourceSetupInput.safeParse(input).success).toBe(false)
  const client=await getAppPool().connect()
  try{await client.query('BEGIN');await expect(client.query('SELECT application_prepare_source_setup($1,$2,$3)',[randomUUID(),randomUUID(),input])).rejects.toMatchObject({code:'42501'})}
  finally{await client.query('ROLLBACK');client.release()}
 })
})
