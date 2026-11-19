// [COMP:api/native-turn-frame] Reviewed typed successor of the immutable8273 recipe.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly} from './installation-authentication-8273.mjs'
import {fileURLToPath} from 'node:url'
import {executableRecordShapeSql,executableProjection} from './executable-record.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('executable_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='bb50ec5bcfcbb4a4c2f75ffb40f5de6441b8d3a21ce99c1d32783754b9479d0d'
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8274_','a8273_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const migration=await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/8274_inputtable_executable_contracts.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The type and registry column must be authenticated before any cast, reader,
 // reference DDL or row decoding may invoke this inputtable representation.
 const typeCheck=`DO $input_shape$ BEGIN IF ${executableRecordShapeSql} IS NOT TRUE THEN RAISE EXCEPTION 'installation_executable_type_shape_changed';END IF;END $input_shape$;`
 sql=once(sql,'ADD COLUMN contract pg_catalog.pg_proc;','ADD COLUMN contract public.native_executable_contract_v1;')
 const check="  IF ((expected->>'signature') NOT IN('native_turn_helpers_current()','native_turn_publication_contract()') AND (actual.prosrc COLLATE \"C\") IS DISTINCT FROM (body COLLATE \"C\"))"
 sql=once(sql,check,"  IF expected->>'signature'='native_turn_helpers_current()' THEN expected_metadata:=jsonb_set(expected_metadata,'{prolang}',to_jsonb((SELECT oid FROM pg_language WHERE lanname='plpgsql')));END IF;\n"+check)
 const declaration='CREATE FUNCTION pg_temp.a8273_conversion_source_body(routine text,parts jsonb,successor boolean)'
 sql=once(sql,declaration,'CREATE FUNCTION pg_temp.a8273_typed_original_source_body(routine text,parts jsonb,successor boolean)')
 const wrapper=`CREATE FUNCTION pg_temp.a8273_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $typed$
DECLARE body text;BEGIN
 body:=pg_temp.a8273_typed_original_source_body(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF(length(body)-length(replace(body,'p IS NOT DISTINCT FROM h.contract','')))/length('p IS NOT DISTINCT FROM h.contract')<>1 THEN RAISE EXCEPTION 'executable_root_comparison_source_changed';END IF;
  body:=${lit('BEGIN\n IF '+executableRecordShapeSql+' IS NOT TRUE THEN RETURN false;END IF;\n RETURN (')}||replace(body,'p IS NOT DISTINCT FROM h.contract',${lit(executableProjection('p')+' IS NOT DISTINCT FROM h.contract')})||${lit(');\nEND')};
 END IF;RETURN body;
END $typed$;`
 sql=once(sql,'DO $conversion_enroll_functions$',wrapper+'\nDO $conversion_enroll_functions$')
 sql=once(sql,'h.contract IS NOT DISTINCT FROM actual',executableProjection('actual')+' IS NOT DISTINCT FROM h.contract')
 sql=once(sql,'p IS DISTINCT FROM h.contract',executableProjection('p')+' IS DISTINCT FROM h.contract')
 sql=typeCheck+'\n'+sql
 assertAuthenticationReadOnly(sql)
 sql=sql.replaceAll('a8273_','a8274_')
 const cleanup=source.cleanup.replaceAll('a8273_','a8274_')+'\nDROP FUNCTION pg_temp.a8274_typed_original_source_body(text,jsonb,boolean);'
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==309||!/^[a-f0-9]{64}$/.test(row.local_digest))throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8274_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8274_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8274_conversion_source_reference','a8274_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
