// [COMP:api/native-turn-frame] Reviewed successor of the 8281 recipe: Page-derived title payload admission (8286).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8281.mjs'
import {fileURLToPath} from 'node:url'
import {admissionSignature,admissionRendererSql,admissionCheckSql} from './title-revision-admission.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('title_admission_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='c601a5145d310b8381c69b88958f8c1f54215805d2c95761ff5ad09afae9c2f7'
// No member is added or removed: the successor replaces one member's body.
export const currentFunctionCount=predecessorCount
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8286_','a8281_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8286_title_revision_admission.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The installed member is the source successor body; it is verified, with the
 // guard and publication contract, by the complete current-source comparison.
 const poststate=`NOT IN('native_turn_helpers_current()','native_turn_publication_contract()','native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean)','conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])') AND (actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C"))`
 sql=once(sql,poststate,poststate.replace("'conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])')",`'conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])',${lit(admissionSignature)})`))
 // Every consumer pin of the member follows from the same renderer.
 const domain='CREATE FUNCTION pg_temp.a8281_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $domain_render$'
 sql=once(sql,domain,domain.replace('a8281_conversion_source_body','a8281_domain_source_body'))
 sql=once(sql,'END $domain_render$;','END $domain_render$;\n'+admissionRendererSql('a8281_conversion_source_body','a8281_domain_source_body'))
 // The member's exact successor body, metadata, two-role ACL and registry record.
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8281_publication_expected_current)::text'
 sql=once(sql,receipt,admissionCheckSql('a8281_t_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8281_','a8286_'))
 sql=sql.replaceAll('a8281_','a8286_')
 const cleanup=source.cleanup.replaceAll('a8281_','a8286_')+'\nDROP FUNCTION pg_temp.a8286_domain_source_body(text,jsonb,boolean);'
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8286_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8286_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8286_conversion_source_reference','a8286_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
