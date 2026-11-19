// [COMP:api/fused-admission] Reviewed successor of the 8287 recipe: fused admission owner (8289).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8287.mjs'
import {fileURLToPath} from 'node:url'
import {enrolledSignatures} from './registry-guard-successor.mjs'
import {completionSignatures} from './turn-completion.mjs'
import {pageClosureSignatures} from './page-closure.mjs'
import {captureSignature,fusedSignatures,fusedMemberSignatures,fusedRendererSql,genericTemplateSql,fusedAuthenticationSql,fusedReferenceCleanup} from './fused-admission.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('fused_admission_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='d0566b58861ffd12bfe4d1a2b91d4a80aaccae5a7d8abba7ca2af9b8186876b0'
// 75 compiled members and the generic owner join the registry.
export const currentFunctionCount=predecessorCount+fusedSignatures.length
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8289_','a8287_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8289_fused_admission.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The installed capture body is the fused wrapper and the guard roster carries the
 // 76 members; every consumer pin follows from the same renderer.
 const admission='CREATE FUNCTION pg_temp.a8287_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $admission_render$'
 sql=once(sql,admission,admission.replace('a8287_conversion_source_body','a8287_fused_pred_source_body'))
 sql=once(sql,'END $admission_render$;','END $admission_render$;\n'+fusedRendererSql('a8287_conversion_source_body','a8287_fused_pred_source_body'))
 // The capture body is no longer the predecessor body; it is verified, with the
 // guard, by the complete current-source comparison and the fused checks below.
 const poststate="'session_context_revision_allowed(uuid,uuid)') AND (actual.prosrc COLLATE \"C\") IS DISTINCT FROM (body COLLATE \"C\"))"
 sql=once(sql,poststate,poststate.replace("'session_context_revision_allowed(uuid,uuid)')",`'session_context_revision_allowed(uuid,uuid)',${lit(captureSignature)})`))
 // The generic owner is a template routine with the capture's parts.
 sql=once(sql,'DO $verify_current$',genericTemplateSql('a8287_')+'\nDO $verify_current$')
 const prior=[...enrolledSignatures,...completionSignatures,...pageClosureSignatures]
 const members=`p.oid=ANY(ARRAY[${prior.map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[])`
 // The generic owner is counted (and digested) through its expected-current row.
 sql=once(sql,members,`p.oid=ANY(ARRAY[${[...prior,...fusedMemberSignatures].map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[])`)
 sql=once(sql,`+${prior.length})::int functions`,`+${prior.length+fusedMemberSignatures.length})::int functions`)
 // Every member compiled from source and compared, the generic owner and the wrapper
 // against the renderer, the prefetch type and the compiled canonical bodies.
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8287_publication_expected_current)::text'
 sql=once(sql,receipt,fusedAuthenticationSql('a8287_f_','a8287_conversion_source_body','a8287_publication_successor_templates')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8287_','a8289_'))
 sql=sql.replaceAll('a8287_','a8289_')
 const cleanup=source.cleanup.replaceAll('a8287_','a8289_')+'\nDROP FUNCTION pg_temp.a8289_fused_pred_source_body(text,jsonb,boolean);\n'+fusedReferenceCleanup('a8289_f_')
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8289_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8289_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8289_conversion_source_reference','a8289_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
