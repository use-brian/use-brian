// Source-owned 8337 profile: pinned recipes and fresh-disposable expected catalog.
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {currentInstallationAuthenticationSource as predecessor} from './installation-authentication-8334.mjs'
import {authenticateCrmSuccessor} from './crm-release-catalog.mjs'
import {harnessTables} from './portable-harness-review.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex')
export const harnessMigrationPins=Object.freeze({
 '8335_project_harnesses.sql':'ad859bba78d4ac91ce9b4a085974bcc09c193ad777efbbdaab311f34369583b6',
 '8336_project_harness_verification.sql':'caa51f17859088f5084edf10365503ee302d8e7c06057759438fa89d8204fa8b',
 '8337_project_chat_creation_admission.sql':'58d8f6fa3c31a9493d620a93731442dbedadff5d28578c128fd71ce0b7e9c3b6',
})
export async function readPinnedHarnessScope(sourceRoot){
 if(Object.values(harnessMigrationPins).some(pin=>!pin))throw Error('portable_8337_review_pending')
 const sources=await Promise.all(Object.entries(harnessMigrationPins).map(async([name,pin])=>{
  const bytes=await readFile(resolve(sourceRoot,'migrations',name))
  if(sha(bytes)!==pin)throw Error('portable_harness_migration_source_changed: '+name)
  return bytes.toString('utf8')
 }))
 // Enumeration is from EXACT pinned source, never the observed catalog. All
 // overloads and all triggers on the named relations are included by the reader.
 const functions=[...new Set(Array.from(sources.join('\n').matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.([a-z_0-9]+)\s*\(/gi),match=>match[1]))]
 functions.push('require_session_creation_admission') // DO-block splice in 8337
 return {functions:[...new Set(functions)].sort(),
  tables:[...harnessTables,'project_shared_scopes'].sort(),types:[],
  triggers:['zzzz_session_creation_admission'],
  closedPrefixes:{functions:['project_harness_','harness_execution_'],tables:['project_harness_']}}
}
export async function currentInstallationAuthenticationSource(options={}){
 const sourceRoot=options.sourceRoot??fileURLToPath(new URL('../../',import.meta.url))
 const scope=await readPinnedHarnessScope(sourceRoot)
 // Generated exclusively by build-portable-harness-catalog.mjs on a fresh
 // shipped-chain disposable fixture. Exact reviewed bytes; no live fallback.
 const artifactText=await readFile(new URL('portable-harness-catalog-8337.json',import.meta.url),'utf8')
 if(sha(artifactText)!=='64958ef782803ef5d837bea411a63a739476b562e9d1bfcb0e46140784c602cc')throw Error('portable_harness_reviewed_artifact_changed')
 const artifact=JSON.parse(artifactText)
 if(scope.functions.length!==23||scope.tables.length!==8||scope.types.length!==0||scope.triggers.length!==1
  ||artifact.inventory?.routines!==23||artifact.inventory?.relations!==8||artifact.inventory?.types!==0||artifact.inventory?.triggers!==11
  ||artifact.format!==1||artifact.scopeSha256!==sha(JSON.stringify(scope))
  ||JSON.stringify(artifact.migrations)!==JSON.stringify(harnessMigrationPins)
  ||! /^[a-f0-9]{64}$/.test(artifact.inventory?.sha256)
  ||['routines','relations','types','triggers'].some(key=>!Number.isSafeInteger(artifact.inventory[key])||artifact.inventory[key]<0))
  throw Error('portable_harness_reviewed_artifact_changed')
 const previous=await predecessor({sourceRoot})
 const sourceDigest=sha(JSON.stringify({predecessor:previous.sourceDigest,artifact}))
 return {...previous,sourceDigest,portableSuccessor:{scope,inventory:artifact.inventory,migrations:Object.keys(harnessMigrationPins)}}
}
export async function authenticateConversationInstallation(owner,options){
 return authenticateCrmSuccessor(owner,await currentInstallationAuthenticationSource(options))
}
