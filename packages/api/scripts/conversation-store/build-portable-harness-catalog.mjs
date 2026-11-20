#!/usr/bin/env node
// Expected catalog provenance: ONLY a newly created, owned disposable cluster,
// replaying the shipped chain with all three extension recipes source-pinned.
// No URL/connection/catalog argument and no ambient database enrollment path.
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {createLocalFixture,assertLocalFixture} from '../../../../scripts/crm/local-fixture.mjs'
import {harnessMigrationPins,readPinnedHarnessScope,authenticateConversationInstallation} from './installation-authentication-8331.mjs'
import {readReviewedCrmCatalog} from './crm-release-catalog.mjs'
import {currentInstallationAuthenticationSource as predecessor} from './installation-authentication-8328.mjs'
import {authenticateCrmSuccessor} from './crm-release-catalog.mjs'
import {buildRoster} from './build-portable-restore-roster.mjs'
import {harnessClassificationFrom8328} from './portable-harness-review.mjs'
const pg=createRequire(import.meta.url)('pg')
const sha=value=>createHash('sha256').update(value).digest('hex')
const here=new URL('./',import.meta.url)
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url))
const {values}=parseArgs({options:{'pg-bin':{type:'string'},check:{type:'boolean'}}})
// Source verification precedes cluster creation. assertLocalFixture is also
// checked against the returned ownership marker, never caller connection data.
const scope=await readPinnedHarnessScope(sourceRoot)
if(scope.functions.length!==23||scope.tables.length!==8||scope.types.length!==0||scope.triggers.length!==1)
 throw Error('portable_harness_source_scope_changed')
const classification=JSON.parse(await readFile(new URL('portable-harness-classification-8331.json',here),'utf8'))
const reviewed=harnessClassificationFrom8328(await readFile(new URL('portable-restore-roster-8328.json',here),'utf8'))
if(JSON.stringify(classification)!==JSON.stringify(reviewed))throw Error('portable_harness_classification_changed')
const fixture=await createLocalFixture({pgBin:values['pg-bin'],ordinaryOwner:true})
try{
 await assertLocalFixture(fixture.env)
 const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
 try{
  const role=(await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
  if(!role||role.rolsuper||role.rolbypassrls)throw Error('portable_harness_fixture_owner_unsafe')
  const receipts=(await owner.query('SELECT name FROM public._migrations WHERE name=ANY($1::text[]) ORDER BY name COLLATE "C"',[Object.keys(harnessMigrationPins)])).rows.map(row=>row.name)
  if(JSON.stringify(receipts)!==JSON.stringify(Object.keys(harnessMigrationPins)))throw Error('portable_harness_fixture_receipts_missing')
  await authenticateCrmSuccessor(owner,await predecessor({sourceRoot}))
  await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  let inventory
  try{await owner.query('SET LOCAL search_path=pg_catalog,public');inventory=await readReviewedCrmCatalog(owner,scope);await owner.query('COMMIT')}
  catch(error){await owner.query('ROLLBACK');throw error}
  if(inventory.routines!==23||inventory.relations!==8||inventory.types!==0||inventory.triggers!==11)throw Error('portable_harness_expected_field_counts_changed')
  const artifact={format:1,migrations:harnessMigrationPins,scopeSha256:sha(JSON.stringify(scope)),inventory}
  const roster=await buildRoster(owner,classification)
  // Compute everything before changing either committed output.
  for(const [name,value] of [['portable-harness-catalog-8331.json',artifact],['portable-restore-roster.json',roster]]){
   const text=JSON.stringify(value,null,1)+'\n',path=new URL(name,here)
   if(values.check){if(await readFile(path,'utf8')!==text)throw Error('portable_harness_generated_artifact_stale: '+name)}
   else await writeFile(path,text)
   console.log(JSON.stringify({file:name,sha256:sha(text),counts:name.includes('catalog')?inventory:roster.counts}))
  }
  if(values.check)await authenticateConversationInstallation(owner,{sourceRoot})
 }finally{await owner.end()}
}finally{await fixture.dispose()}
