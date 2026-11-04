// [COMP:api/session-legacy-history] Real legacy migration and native HTTP fixture.
import {join,dirname} from 'node:path'
import {createLocalFixture,parseLocalFixtureArguments,runCommand} from './local-fixture.mjs'
let fixture,seedFile
const args=['--filter','@use-brian/api','exec','vitest','run','--config','vitest.integration.config.ts',
 'src/db/__tests__/session-legacy-history.integration.test.ts','--maxWorkers=1']
const options=parseLocalFixtureArguments([...process.argv.slice(2),'--','pnpm',...args])
try {
 fixture=await createLocalFixture({...options,beforeApplyFile:'8203_private_legacy_history.sql',beforeApply:async({env})=>{
  seedFile=join(dirname(env.BRIAN_ASSURANCE_FIXTURE),'private-history-seed.json')
  await runCommand('pnpm',args,{env:{...env,BRIAN_PRIVATE_HISTORY_SEED:seedFile,BRIAN_PRIVATE_HISTORY_PREPARE:'1'},inherit:true})
 }})
 await runCommand('pnpm',args,{env:{...fixture.env,BRIAN_PRIVATE_HISTORY_SEED:seedFile},inherit:true})
} finally {await fixture?.dispose()}
