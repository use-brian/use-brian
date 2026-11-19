// [COMP:api/native-turn-frame] Reviewed successor of the 8274 recipe: tuple-version guard witness.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly} from './installation-authentication-8274.mjs'
import {fileURLToPath} from 'node:url'
import {guardRendererSql,guardFastPath,enrolledAuthenticationSql,enrolledSignatures,witnessRelationCheckSql,witnessCurrencySql,refreshBody} from './registry-guard-successor.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('witness_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='e3fa2d4c7c7b5d2079d88dd48dc6a6d6f8e200bb961e912020bebeb381cb1849'
const preparationMigrationSha='df072f7844d6f3b295e02b781838b34662c60e6e6633fa073a5ecf9708d9a53e'
export const currentFunctionCount=309+enrolledSignatures.length
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8276_','a8274_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8276_registry_guard_successor.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const preparation=await readFile(base+'/migrations/8275_joint_native_preparation_acquisition.sql','utf8');if(sha(preparation)!==preparationMigrationSha)throw Error('installation_source_migration_changed')
 const start=preparation.indexOf('CREATE FUNCTION public.capture_conversation_preparation('),end=preparation.indexOf('END $function$;',start)+'END $function$;'.length
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The installed guard is the predecessor's rendered body plus the source-defined
 // fast path and the two enrolled roster names; every consumer pin follows from it.
 const typed='CREATE FUNCTION pg_temp.a8274_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $typed$'
 sql=once(sql,typed,typed.replace('a8274_conversion_source_body','a8274_registry_typed_source_body'))
 sql=once(sql,'END $typed$;','END $typed$;\n'+guardRendererSql('a8274_conversion_source_body','a8274_registry_typed_source_body'))
 // Independent full comparator: the same rendered body without the fast path.
 const full=`DO $a8274_full_guard$ DECLARE body text;BEGIN
 body:=pg_temp.a8274_conversion_source_body('native_turn_helpers_current()',(SELECT parts FROM pg_temp.a8274_publication_successor_templates WHERE signature='native_turn_helpers_current()'),true);
 IF strpos(body,${lit(guardFastPath)})<>7 THEN RAISE EXCEPTION 'installation_witness_fast_path_changed';END IF;
 EXECUTE format('CREATE FUNCTION pg_temp.a8274_full_guard() RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS %L',replace(body,${lit(guardFastPath)},''));
 EXECUTE format('CREATE FUNCTION pg_temp.a8274_r_refresh_reference() RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS %L',${lit(refreshBody)});
 IF pg_temp.a8274_full_guard() IS NOT TRUE THEN RAISE EXCEPTION 'installation_full_guard_refused';END IF;
END $a8274_full_guard$;`
 const enrolled=enrolledAuthenticationSql({prefix:'a8274_r_',preparationCreate:preparation.slice(start,end)})
 // The refresh reference is compiled above from quoted source text, not as DDL here.
 const enrolledWithoutRefresh=enrolled.replace(/CREATE FUNCTION pg_temp\.a8274_r_refresh_reference\(\)[\s\S]*?\$refresh\$;\n/,'')
 if(enrolledWithoutRefresh===enrolled)throw Error('witness_auth_source_transform_changed: refresh reference')
 const receipt='SELECT encode(sha256(convert_to(jsonb_agg(metadata ORDER BY signature COLLATE "C")::text,\'UTF8\')),\'hex\') local_digest,count(*)::int functions FROM pg_temp.a8274_publication_expected_current;'
 sql=once(sql,receipt,`${full}
${enrolledWithoutRefresh}
${witnessRelationCheckSql('a8274_r_')}
SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8274_publication_expected_current)::text
 ||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_proc p WHERE p.oid=ANY(ARRAY[${enrolledSignatures.map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[]))::text,'UTF8')),'hex') local_digest,
 ((SELECT count(*) FROM pg_temp.a8274_publication_expected_current)+${enrolledSignatures.length})::int functions,(${witnessCurrencySql}) witness_current;`)
 assertAuthenticationReadOnly(sql.replaceAll('a8274_','a8276_'))
 sql=sql.replaceAll('a8274_','a8276_')
 const cleanup=source.cleanup.replaceAll('a8274_','a8276_')+'\nDROP FUNCTION pg_temp.a8276_registry_typed_source_body(text,jsonb,boolean);\nDROP FUNCTION pg_temp.a8276_full_guard();\nDROP FUNCTION pg_temp.a8276_r_refresh_reference();\nDROP FUNCTION pg_temp.a8276_r_preparation_reference(uuid,jsonb,jsonb,jsonb);'
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8276_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8276_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8276_conversion_source_reference','a8276_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
