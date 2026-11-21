#!/usr/bin/env node
// [COMP:api/portable-restore] Two-installation portable restore proof driver.
//
//   node packages/api/src/application-platform/__tests__/fixtures/portable-restore-proof.mjs \
//     --pg-bin <PG18 bin> --evidence <new absolute directory>
//
// Creates two independent disposable ordinary-owner PostgreSQL 18 clusters
// through the maintained fixture owner. The target chain consumes object
// identifiers before its first migration so restored OIDs, executable pins and
// regprocedure bindings cannot coincide with the source. The source phase seeds
// and exports; the target phase runs the refusal matrix, import and real
// receiving checks. Both clusters are disposed; only non-secret receipts remain.
import {createHash} from 'node:crypto'
import {copyFile,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {createRequire} from 'node:module'

const ossRoot=fileURLToPath(new URL('../../../../../../',import.meta.url))
const apiRoot=join(ossRoot,'packages/api')
const pg=createRequire(join(apiRoot,'package.json'))('pg')
const {createLocalFixture,runCommand}=await import(join(ossRoot,'scripts/crm/local-fixture.mjs'))
const sha=value=>createHash('sha256').update(value).digest('hex')
const suite='src/application-platform/__tests__/portable-restore.integration.test.ts'
const historicalMemorySource='scripts/conversation-store/historical/8268_native_memory_query_write_lineage.sql'

function pinnedReleaseAssets(migrations){
 return ['src/migrations/renames.ts',
  ...Object.hasOwn(migrations,'8326_native_memory_query_write_contract.sql')?[historicalMemorySource]:[]]
}

async function migrationSnapshot(){
 const dir=join(apiRoot,'migrations'),names=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort()
 return Object.fromEntries(await Promise.all(names.map(async name=>[name,sha(await readFile(join(dir,name)))])))
}

async function receivingSources(pinnedAssets){
 const store='packages/api/scripts/conversation-store/'
 // Pin every source-owned profile, compiler, reviewed catalog/classification,
 // roster and review input (including the immutable 8334 predecessor).
 const reviewInputs=(await readdir(join(ossRoot,store))).filter(name=>/\.(mjs|json|sql)$/.test(name)).sort().map(name=>store+name)
 const files=[
  'packages/api/src/application-platform/__tests__/fixtures/portable-restore-proof.mjs',
  'packages/api/src/application-platform/__tests__/fixtures/portable-harness-history.ts',
  'packages/api/src/application-platform/__tests__/fixtures/portable-restore-families.ts',
  ...reviewInputs,
  'packages/api/src/application-platform/__tests__/portable-restore.integration.test.ts',
  'packages/api/src/db/__tests__/programmatic-intake-ready.integration.test.ts','packages/api/src/migrations/execution-sql.ts',
  ...pinnedAssets.map(file=>'packages/api/'+file),
  ...['portable-restore.mjs','portable-restore-seals.mjs','installation-release.mjs','build-portable-restore-roster.mjs',
   'installation-authentication-8297.mjs','installation-authentication-8298.mjs','installation-authentication-8300.mjs',
   'installation-authentication-8301.mjs','installation-authentication-8331.mjs','installation-authentication-8332.mjs',
   'installation-authentication-8333.mjs','installation-authentication-8334.mjs',
   'build-conversation-context-cost.mjs','conversation-context-cost.mjs','conversation-memory-lineage-cost.mjs'].map(name=>store+name),
 ]
 return Object.fromEntries(await Promise.all([...new Set(files)].map(async file=>[file,sha(await readFile(join(ossRoot,file)))])))
}

async function main(){
 const {values}=parseArgs({options:{'pg-bin':{type:'string'},evidence:{type:'string'},inventory:{type:'string'}}})
 if(!values['pg-bin']||!values.evidence)throw Error('Supply --pg-bin and a new absolute --evidence directory')
 const evidence=resolve(values.evidence);await mkdir(evidence,{mode:0o700})
 const work=join(evidence,'private');await mkdir(work,{mode:0o700})
 const before=await migrationSnapshot(),pinnedAssets=pinnedReleaseAssets(before),sourceBefore=await receivingSources(pinnedAssets)
 // Pin the exact migration set and the shipped source assets used to authenticate it.
 const sourceRoot=join(work,'shipped');await mkdir(join(sourceRoot,'migrations'),{recursive:true})
 for(const name of Object.keys(before))await copyFile(join(apiRoot,'migrations',name),join(sourceRoot,'migrations',name))
 for(const file of pinnedAssets){
  const target=join(sourceRoot,file)
  await mkdir(dirname(target),{recursive:true})
  await copyFile(join(apiRoot,file),target)
 }
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG}
 const phaseEnv={BRIAN_PORTABLE_RESTORE_STATE:join(work,'state'),BRIAN_PORTABLE_RESTORE_SOURCE_ROOT:sourceRoot+'/',CI:'true',NO_COLOR:'1'}
 if(Object.hasOwn(before,'8296_configured_task_publication.sql'))phaseEnv.BRIAN_PORTABLE_CONFIGURED_TASK_PROOF=join(work,'configured-task-proof.json')
 const vitest=(fixtureEnv,phase)=>runCommand('pnpm',['--dir','packages/api','exec','vitest','run','--config','vitest.integration.config.ts','--maxWorkers=1',suite],
  {cwd:ossRoot,env:{...fixtureEnv,...phaseEnv,BRIAN_PORTABLE_RESTORE_PHASE:phase},logPath:join(evidence,phase+'.log')})
 const receipt={schema:'portable-restore-proof-receipt-v1',startedAt:new Date().toISOString(),node:process.version,migrations:Object.keys(before).length,
  migrationSetSha256:sha(JSON.stringify(before)),sourceHashes:sourceBefore,phases:{}}
 let source,target
 try{
  source=await createLocalFixture({pgBin:values['pg-bin'],ordinaryOwner:true,env})
  if(values.inventory){
   const {buildRoster}=await import(join(apiRoot,'scripts/conversation-store/build-portable-restore-roster.mjs'))
   const owner=new pg.Client({connectionString:source.env.DATABASE_URL})
   await owner.connect()
   try{
    const inventory=JSON.parse(await readFile(resolve(values.inventory),'utf8'))
    const roster=await buildRoster(owner,inventory),text=JSON.stringify(roster,null,1)+'\n'
    phaseEnv.BRIAN_PORTABLE_RESTORE_ROSTER=join(evidence,'reviewed-roster.json')
    await writeFile(phaseEnv.BRIAN_PORTABLE_RESTORE_ROSTER,text,{mode:0o600,flag:'wx'})
    receipt.rosterSha256=sha(text)
   }finally{await owner.end()}
  }
  if(phaseEnv.BRIAN_PORTABLE_CONFIGURED_TASK_PROOF){
   await runCommand('pnpm',['--dir','packages/api','exec','vitest','run','--config','vitest.integration.config.ts','--maxWorkers=1',
    'src/db/__tests__/programmatic-intake-ready.integration.test.ts','-t','seals distinct outputs'],
    {cwd:ossRoot,env:{...source.env,...phaseEnv},logPath:join(evidence,'configured-task.log')})
   receipt.phases.configuredTask='passed'
  }
  await vitest(source.env,'source');receipt.phases.source='passed'
  // Runtime activation needs a migration prefix, so identifiers are consumed
  // right after the baseline: every later object gets a different OID.
  const boundary=Object.keys(before)[1]
  target=await createLocalFixture({pgBin:values['pg-bin'],ordinaryOwner:true,env,beforeApplyFile:boundary,beforeApply:async({adminUrl})=>{
   const client=new pg.Client({connectionString:adminUrl});await client.connect()
   try{for(let batch=0;batch<8;batch++)await client.query(`DO $burn$ BEGIN FOR i IN 1..400 LOOP EXECUTE format('CREATE TEMP TABLE portable_oid_burn_%s_%s(x int)',${batch},i);END LOOP;END $burn$`)}
   finally{await client.end()}
  }})
  await vitest({...target.env,BRIAN_PORTABLE_RESTORE_DISTINCT_OIDS:'1'},'target');receipt.phases.target='passed'
  const result=JSON.parse(await readFile(join(work,'state','target-receipt.json'),'utf8'))
  const exported=JSON.parse(await readFile(join(work,'state','archive','receipt.json'),'utf8'))
  receipt.export=exported;receipt.import=result.importReceipt;receipt.receivingProof=result.receivingProof
  receipt.admission={activation:result.admission.activation,importReceiptSha256:result.admission.importReceiptSha256,receivingProofSha256:result.admission.receivingProofSha256}
  receipt.refusals=result.refusals;receipt.status='passed'
 }catch(error){receipt.status='failed';receipt.error=String(error.message).slice(0,2000);process.exitCode=1}
 finally{
  try{await source?.dispose()}finally{await target?.dispose()}
  receipt.disposed=true
  receipt.migrationsUnchanged=JSON.stringify(await migrationSnapshot())===JSON.stringify(before)
  receipt.sourcesUnchanged=JSON.stringify(await receivingSources(pinnedAssets))===JSON.stringify(sourceBefore)
  await rm(work,{recursive:true,force:true})
  receipt.completedAt=new Date().toISOString()
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({status:receipt.status,error:receipt.error,refusals:receipt.refusals?.length,migrationsUnchanged:receipt.migrationsUnchanged}))
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
