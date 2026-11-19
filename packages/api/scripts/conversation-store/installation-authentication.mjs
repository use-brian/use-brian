// [COMP:api/fused-admission] Reviewed successor of the 8290 recipe: fused admission plan-size successor (8294).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8290.mjs'
import {fileURLToPath} from 'node:url'
import {tuneReferenceSql,tuningCheckSql} from './fused-admission-tuning.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('fused_tuning_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='6107a119ebd420c92e1c8320249ad17453e9de2a0fbd82a65496c4748c9bbf20'
// No member is added or removed: 17 compiled helpers gain a function-level setting.
export const currentFunctionCount=predecessorCount
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8294_','a8290_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8294_fused_admission_plan_size.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The tuned helpers' references are compiled with the same setting; every other
 // field, the owner-only ACL and the registry record checks stay.
 sql=tuneReferenceSql(sql,'a8290_f_')
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8290_publication_expected_current)::text'
 sql=once(sql,receipt,tuningCheckSql('a8290_t_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8290_','a8294_'))
 sql=sql.replaceAll('a8290_','a8294_')
 const cleanup=source.cleanup.replaceAll('a8290_','a8294_')
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8294_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8294_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8294_conversion_source_reference','a8294_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
