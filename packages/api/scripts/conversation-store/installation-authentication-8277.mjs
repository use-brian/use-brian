// [COMP:api/native-turn-frame] Reviewed successor of the 8276 recipe: durable completion header (8277).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8276.mjs'
import {fileURLToPath} from 'node:url'
import {enrolledSignatures} from './registry-guard-successor.mjs'
import {completionRendererSql,completionAuthenticationSql,completionReferenceCleanup,completionSignatures,outcomeSignature} from './turn-completion.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('completion_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='9531458b8f0dcce872f2debff5efdda58ac898a5793d48bd147e2bfe54b77aaa'
export const currentFunctionCount=predecessorCount+completionSignatures.length
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8277_','a8276_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8277_durable_turn_completions.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The installed classifier is the source successor body; it is verified with the
 // guard and publication contract by the complete current-source comparison.
 const poststate=`NOT IN('native_turn_helpers_current()','native_turn_publication_contract()') AND (actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C"))`
 sql=once(sql,poststate,poststate.replace("'native_turn_publication_contract()')",`'native_turn_publication_contract()',${lit(outcomeSignature)})`))
 // The installed guard is the 8276 rendered body with the four members in its
 // roster; every consumer pin follows from it through the same renderer.
 const witness='CREATE FUNCTION pg_temp.a8276_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $witness$'
 sql=once(sql,witness,witness.replace('a8276_conversion_source_body','a8276_witness_source_body'))
 sql=once(sql,'END $witness$;','END $witness$;\n'+completionRendererSql('a8276_conversion_source_body','a8276_witness_source_body'))
 const members=`p.oid=ANY(ARRAY[${enrolledSignatures.map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[])`
 sql=once(sql,members,`p.oid=ANY(ARRAY[${[...enrolledSignatures,...completionSignatures].map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[])`)
 const count=`+${enrolledSignatures.length})::int functions`
 sql=once(sql,count,`+${enrolledSignatures.length+completionSignatures.length})::int functions`)
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8276_publication_expected_current)::text'
 sql=once(sql,receipt,completionAuthenticationSql('a8276_c_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8276_','a8277_'))
 sql=sql.replaceAll('a8276_','a8277_')
 const cleanup=source.cleanup.replaceAll('a8276_','a8277_')+'\nDROP FUNCTION pg_temp.a8277_witness_source_body(text,jsonb,boolean);\n'+completionReferenceCleanup('a8277_c_')
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8277_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8277_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8277_conversion_source_reference','a8277_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
