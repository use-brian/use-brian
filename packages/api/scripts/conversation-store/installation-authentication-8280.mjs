// [COMP:api/native-turn-frame] Reviewed successor of the 8278 recipe: query-domain visibility (8280).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8278.mjs'
import {fileURLToPath} from 'node:url'
import {domainSignature,domainRendererSql,domainCheckSql} from './query-domain-visibility.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('query_domain_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='f27960cfbf5bc9b22cefd1c2b7627008a2ec2b2d52d0dd57ea2a0d375f1bc75c'
// No member is added or removed: the successor replaces one member's body.
export const currentFunctionCount=predecessorCount
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8280_','a8278_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8280_query_domain_visibility.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The installed domain member is the source successor body; it is verified, with
 // the guard and publication contract, by the complete current-source comparison.
 const poststate=`NOT IN('native_turn_helpers_current()','native_turn_publication_contract()','native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean)') AND (actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C"))`
 sql=once(sql,poststate,poststate.replace("'native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean)')",`'native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean)',${lit(domainSignature)})`))
 // Every consumer pin of the member follows from the same renderer.
 const page='CREATE FUNCTION pg_temp.a8278_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $page_closure_render$'
 sql=once(sql,page,page.replace('a8278_conversion_source_body','a8278_page_closure_source_body'))
 sql=once(sql,'END $page_closure_render$;','END $page_closure_render$;\n'+domainRendererSql('a8278_conversion_source_body','a8278_page_closure_source_body'))
 // The member's exact successor body, metadata, ACL and registry record.
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8278_publication_expected_current)::text'
 sql=once(sql,receipt,domainCheckSql('a8278_d_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8278_','a8280_'))
 sql=sql.replaceAll('a8278_','a8280_')
 const cleanup=source.cleanup.replaceAll('a8278_','a8280_')+'\nDROP FUNCTION pg_temp.a8280_page_closure_source_body(text,jsonb,boolean);'
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8280_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8280_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8280_conversion_source_reference','a8280_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
