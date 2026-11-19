// [COMP:api/native-turn-frame] Populated upgrade with the ordinary schema owner.
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createLocalFixture,runCommand,validateAmbientDatabase} from '../../../../scripts/crm/local-fixture.mjs'
validateAmbientDatabase(process.env)
const directory=await mkdtemp(join(tmpdir(),'brian-conversation-upgrade-'))
const cwd=fileURLToPath(new URL('../../',import.meta.url)),state=join(directory,'state.json')
let fixture
async function run(env,phase){
 await runCommand(process.execPath,[join(cwd,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.integration.config.ts',
  'src/application-platform/__tests__/conversation-publication-upgrade.integration.test.ts','--maxWorkers=1'],
 {cwd,env:{...env,CI:'true',NO_COLOR:'1',BRIAN_CONVERSATION_UPGRADE_PHASE:phase,BRIAN_CONVERSATION_UPGRADE_STATE:state},inherit:true})
}
try{
 fixture=await createLocalFixture({pgBin:process.argv[2],ordinaryOwner:true,
  beforeApplyFile:'8269_canonical_conversation_publication.sql',beforeApply:async({env})=>run(env,'before')})
 await run(fixture.env,'after')
}finally{await fixture?.dispose();await rm(directory,{recursive:true,force:true})}
