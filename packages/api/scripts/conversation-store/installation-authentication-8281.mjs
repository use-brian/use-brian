// [COMP:api/native-turn-frame] Reviewed successor of the 8280 recipe: private-transcript floor (8281).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8280.mjs'
import {fileURLToPath} from 'node:url'
import {floorCheckSql} from './private-transcript-floor.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('private_floor_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='7b30be0c4ddcf68b285c9aea9bdc259da8d5608b5fd1e07ded94d38660f46fb7'
// The parent is outside the canonical registry: no member is added or removed.
export const currentFunctionCount=predecessorCount
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8281_','a8280_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8281_private_transcript_floor.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The private-transcript parent's exact successor body and reviewed metadata.
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8280_publication_expected_current)::text'
 sql=once(sql,receipt,floorCheckSql('a8280_f_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8280_','a8281_'))
 sql=sql.replaceAll('a8280_','a8281_')
 const cleanup=source.cleanup.replaceAll('a8280_','a8281_')
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8281_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8281_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8281_conversion_source_reference','a8281_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
