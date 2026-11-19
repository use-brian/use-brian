// [COMP:api/native-turn-frame] Reviewed successor of the 8277 recipe: Page source-family adapter (8278).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8277.mjs'
import {fileURLToPath} from 'node:url'
import {enrolledSignatures} from './registry-guard-successor.mjs'
import {completionSignatures} from './turn-completion.mjs'
import {pageClosureRendererSql,pageClosureAuthenticationSql,pageClosureReferenceCleanup,pageClosureSignatures} from './page-closure.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('page_closure_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='9fa28fcbb7aa3c2654c1c2a097512cc79beb2e6062bbc759d397241985722920'
export const currentFunctionCount=predecessorCount+pageClosureSignatures.length
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8278_','a8277_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8278_page_closure_adapter.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The installed guard is the 8277 rendered body with the Page closure member in
 // its roster; every consumer pin follows from it through the same renderer.
 const completion='CREATE FUNCTION pg_temp.a8277_conversion_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $completion_render$'
 sql=once(sql,completion,completion.replace('a8277_conversion_source_body','a8277_completion_source_body'))
 sql=once(sql,'END $completion_render$;','END $completion_render$;\n'+pageClosureRendererSql('a8277_conversion_source_body','a8277_completion_source_body'))
 const prior=[...enrolledSignatures,...completionSignatures]
 const members=`p.oid=ANY(ARRAY[${prior.map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[])`
 sql=once(sql,members,`p.oid=ANY(ARRAY[${[...prior,...pageClosureSignatures].map(s=>lit('public.'+s)+'::regprocedure').join(',')}]::oid[])`)
 const count=`+${prior.length})::int functions`
 sql=once(sql,count,`+${prior.length+pageClosureSignatures.length})::int functions`)
 // The member is compiled from source and compared; the Page principal reader's
 // successor body (not a registry member) is compared with source as well.
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8277_publication_expected_current)::text'
 sql=once(sql,receipt,pageClosureAuthenticationSql('a8277_p_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8277_','a8278_'))
 sql=sql.replaceAll('a8277_','a8278_')
 const cleanup=source.cleanup.replaceAll('a8277_','a8278_')+'\nDROP FUNCTION pg_temp.a8278_completion_source_body(text,jsonb,boolean);\n'+pageClosureReferenceCleanup('a8278_p_')
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8278_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8278_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8278_conversion_source_reference','a8278_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
