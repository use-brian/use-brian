// [COMP:api/configured-capture-authority] Read-only source profile for 8296.
// Frozen predecessor modules remain byte-identical; only this closed extension
// knows the four new private members and the item receipt structure.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource as predecessorSource, currentFunctionCount as predecessorCount,
 assertAuthenticationReadOnly as predecessorReadOnly } from './installation-authentication-8294.mjs'
import { configuredSignatures, configuredRendererSql, configuredAuthenticationSql, configuredReferenceCleanup,
 configuredSchemaAuthenticationSql, configuredSchemaCleanup } from './configured-task-publication.mjs'
const q=value=>"'"+value.replaceAll("'","''")+"'",sha=value=>createHash('sha256').update(value).digest('hex')
const once=(text,needle,value)=>{if(text.split(needle).length!==2)throw Error('configured_task_auth_source_transform_changed: '+needle.slice(0,80));return text.replace(needle,()=>value)}
const currentMigrationSha='55b915bd94214f96266e6da94165f454361d9351dc82d6dab537137b507d2baf'
export const currentFunctionCount=predecessorCount+configuredSignatures.length
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8296_','a8294_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,''),migration=await readFile(base+'/migrations/8296_configured_task_publication.sql')
 if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The current chain declares the final renderer as participation over the
 // previous fused renderer. Wrap that one complete current owner exactly once.
 const declarations=[...sql.matchAll(/CREATE FUNCTION pg_temp\.a8294_conversion_source_body\(routine text,parts jsonb,successor boolean\)[\s\S]*?AS (\$[a-z_]+\$)/g)]
 if(declarations.length!==1)throw Error('configured_task_auth_renderer_declaration_changed')
 const declaration=declarations[0][0],tag=declarations[0][1]
 sql=once(sql,declaration,declaration.replace('a8294_conversion_source_body','a8294_configured_pred_source_body'))
 sql=once(sql,'END '+tag+';','END '+tag+';\n'+configuredRendererSql('a8294_conversion_source_body','a8294_configured_pred_source_body'))
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8294_publication_expected_current)::text'
 sql=once(sql,receipt,configuredAuthenticationSql('a8294_configured_')+'\n'+configuredSchemaAuthenticationSql('a8294_configured_')+'\n'+receipt)
 const start=sql.indexOf(receipt),arrayStart=sql.indexOf('WHERE p.oid=ANY(ARRAY[',start),arrayEnd=sql.indexOf(']::oid[]))',arrayStart)
 if(start<0||arrayStart<0||arrayEnd<0)throw Error('configured_task_auth_digest_members_changed')
 sql=sql.slice(0,arrayEnd)+','+configuredSignatures.map(signature=>q('public.'+signature)+'::regprocedure').join(',')+sql.slice(arrayEnd)
 sql=once(sql,'+82)::int functions','+'+(82+configuredSignatures.length)+')::int functions')
 sql=sql.replaceAll('a8294_','a8296_');assertAuthenticationReadOnly(sql)
 const cleanup=source.cleanup.replaceAll('a8294_','a8296_')+'\n'+configuredReferenceCleanup('a8296_configured_')+'\n'+configuredSchemaCleanup('a8296_configured_')+'\nDROP FUNCTION pg_temp.a8296_configured_pred_source_body(text,jsonb,boolean);'
 return {...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8296_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8296_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8296_conversion_source_reference','a8296_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
