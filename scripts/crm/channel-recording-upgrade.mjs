// [COMP:api/channel-recording] Genuine pre-8135 upgrade fixture for the channel
// recording privacy suite: seed fixtures/channel-recording-upgrade.sql at the 8135
// beforeApply boundary of a fresh ordinary-owner disposable PG18 cluster as the
// ordinary owner, finish the chain through the maintained runner, run the suite,
// dispose. Never targets an ambient or personal database.
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {createLocalFixture,parseLocalFixtureArguments,runCommand} from './local-fixture.mjs'
const pg=createRequire(new URL('../../packages/api/package.json',import.meta.url))('pg')
const args=['--filter','@use-brian/api','exec','vitest','run','--config','vitest.integration.config.ts',
 'src/__tests__/channel-recording-privacy.integration.test.ts','--maxWorkers=1']
const options=parseLocalFixtureArguments([...process.argv.slice(2),'--','pnpm',...args])
const seed=await readFile(new URL('../../packages/api/src/__tests__/fixtures/channel-recording-upgrade.sql',import.meta.url),'utf8')
let fixture
try {
 fixture=await createLocalFixture({...options,beforeApplyFile:'8135_channel_recording_privacy_hold.sql',beforeApply:async({adminUrl})=>{
  const client=new pg.Client({connectionString:adminUrl})
  await client.connect()
  try{await client.query(seed)}finally{await client.end()}
  console.log('seeded pre-8135 channel recording fixture')
 }})
 await runCommand('pnpm',args,{env:fixture.env,inherit:true})
} finally {await fixture?.dispose()}
