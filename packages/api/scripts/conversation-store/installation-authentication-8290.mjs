// [COMP:api/task-mutation-scope] Reviewed successor of the 8289 recipe: Project participation retirement (8290).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8289.mjs'
import {fileURLToPath} from 'node:url'
import {readSignatures,participationRendererSql,participationCheckSql} from './participation-read-retirement.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('participation_retirement_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='5fdaec0ab2468bc805c7163478d58e88b5c407efbc02a55fafdb5dc89a74b8d0'
// No member is added or removed: the successor replaces two members' bodies.
export const currentFunctionCount=predecessorCount
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8290_','a8289_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8290_participation_read_retirement.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // Both members render the successor body; every consumer pin follows from the same renderer.
 const fused='CREATE FUNCTION pg_temp.a8289_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fused_render$'
 sql=once(sql,fused,fused.replace('a8289_conversion_source_body','a8289_participation_pred_source_body'))
 sql=once(sql,'END $fused_render$;','END $fused_render$;\n'+participationRendererSql('a8289_conversion_source_body','a8289_participation_pred_source_body'))
 // The two members are no longer their predecessor bodies; they are verified by the
 // complete current-source comparison and the successor check below.
 const poststate=") AND (actual.prosrc COLLATE \"C\") IS DISTINCT FROM (body COLLATE \"C\"))"
 const anchor="IF ((expected->>'signature') NOT IN('native_turn_helpers_current()',"
 const at=sql.indexOf(anchor),end=sql.indexOf(poststate,at)
 if(at<0||end<0||sql.indexOf(anchor,at+1)>=0||sql.indexOf(poststate,end+1)>=0)throw Error('participation_retirement_auth_source_transform_changed: poststate')
 sql=sql.slice(0,end)+','+readSignatures.map(lit).join(',')+sql.slice(end)
 // The members' exact successor bodies, metadata and registry records.
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8289_publication_expected_current)::text'
 sql=once(sql,receipt,participationCheckSql('a8289_p_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8289_','a8290_'))
 sql=sql.replaceAll('a8289_','a8290_')
 const cleanup=source.cleanup.replaceAll('a8289_','a8290_')+'\nDROP FUNCTION pg_temp.a8290_participation_pred_source_body(text,jsonb,boolean);'
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8290_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8290_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8290_conversion_source_reference','a8290_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
